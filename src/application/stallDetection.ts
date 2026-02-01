/**
 * Stall Detection - Job stall detection and recovery
 * Uses two-phase detection (like BullMQ) to prevent false positives
 */

import type { Job } from '../domain/types/job';
import { calculateBackoff } from '../domain/types/job';
import { FailureReason } from '../domain/types/dlq';
import { StallAction, getStallAction, incrementStallCount } from '../domain/types/stall';
import { EventType } from '../domain/types/queue';
import type { WebhookEvent } from '../domain/types/webhook';
import { queueLog } from '../shared/logger';
import { shardIndex, processingShardIndex, SHARD_COUNT } from '../shared/hash';
import { withWriteLock } from '../shared/lock';
import type { BackgroundContext } from './types';

/**
 * Check for stalled jobs and handle them
 * Uses two-phase detection to prevent false positives
 */
export function checkStalledJobs(ctx: BackgroundContext): void {
  const now = Date.now();
  const confirmedStalled: Array<{ job: Job; action: StallAction }> = [];

  // Phase 1: Check jobs that were candidates from previous cycle
  for (const jobId of ctx.stalledCandidates) {
    const procIdx = processingShardIndex(String(jobId));
    const job = ctx.processingShards[procIdx].get(jobId);

    if (!job) {
      ctx.stalledCandidates.delete(jobId);
      continue;
    }

    const stallConfig = ctx.shards[shardIndex(job.queue)].getStallConfig(job.queue);
    if (!stallConfig.enabled) {
      ctx.stalledCandidates.delete(jobId);
      continue;
    }

    const action = getStallAction(job, stallConfig, now);
    if (action !== StallAction.Keep) {
      confirmedStalled.push({ job, action });
    }

    ctx.stalledCandidates.delete(jobId);
  }

  // Phase 2: Mark current processing jobs as candidates for NEXT check
  for (let i = 0; i < SHARD_COUNT; i++) {
    const procShard = ctx.processingShards[i];

    for (const [jobId, job] of procShard) {
      const stallConfig = ctx.shards[shardIndex(job.queue)].getStallConfig(job.queue);
      if (!stallConfig.enabled) continue;

      const action = getStallAction(job, stallConfig, now);
      if (action !== StallAction.Keep) {
        ctx.stalledCandidates.add(jobId);
      }
    }
  }

  // Process confirmed stalled jobs
  for (const { job, action } of confirmedStalled) {
    handleStalledJob(job, action, ctx).catch((err: unknown) => {
      queueLog.error('Failed to handle stalled job', {
        jobId: String(job.id),
        error: String(err),
      });
    });
  }
}

/**
 * Handle a stalled job based on the action
 * Uses proper locking to prevent race conditions
 */
async function handleStalledJob(
  job: Job,
  action: StallAction,
  ctx: BackgroundContext
): Promise<void> {
  const idx = shardIndex(job.queue);
  const procIdx = processingShardIndex(String(job.id));

  // Broadcast events before acquiring locks (non-blocking)
  ctx.eventsManager.broadcast({
    eventType: EventType.Stalled,
    queue: job.queue,
    jobId: job.id,
    timestamp: Date.now(),
    data: { stallCount: job.stallCount + 1, action },
  });
  void ctx.webhookManager.trigger('stalled' as WebhookEvent, String(job.id), job.queue, {
    data: { stallCount: job.stallCount + 1, action },
  });

  // Acquire processing lock first, then shard lock
  await withWriteLock(ctx.processingLocks[procIdx], async () => {
    // Verify job is still in processing (might have been handled already)
    if (!ctx.processingShards[procIdx].has(job.id)) {
      return;
    }

    await withWriteLock(ctx.shardLocks[idx], () => {
      const shard = ctx.shards[idx];

      if (action === StallAction.MoveToDlq) {
        moveStalliedJobToDlq(job, ctx, shard, procIdx, idx);
      } else {
        retryStalliedJob(job, ctx, shard, procIdx, idx);
      }
    });
  });
}

/** Move stalled job to DLQ */
function moveStalliedJobToDlq(
  job: Job,
  ctx: BackgroundContext,
  shard: BackgroundContext['shards'][number],
  procIdx: number,
  _idx: number
): void {
  queueLog.warn('Job exceeded max stalls, moving to DLQ', {
    jobId: String(job.id),
    queue: job.queue,
    stallCount: job.stallCount,
  });

  ctx.processingShards[procIdx].delete(job.id);
  shard.releaseJobResources(job.queue, job.uniqueKey, job.groupId);

  const entry = shard.addToDlq(
    job,
    FailureReason.Stalled,
    `Job stalled ${job.stallCount + 1} times`
  );
  ctx.jobIndex.set(job.id, { type: 'dlq', queueName: job.queue });
  ctx.storage?.saveDlqEntry(entry);
}

/** Retry stalled job */
function retryStalliedJob(
  job: Job,
  ctx: BackgroundContext,
  shard: BackgroundContext['shards'][number],
  procIdx: number,
  idx: number
): void {
  incrementStallCount(job);
  job.attempts++;
  job.startedAt = null;
  job.runAt = Date.now() + calculateBackoff(job);
  job.lastHeartbeat = Date.now();

  queueLog.warn('Job stalled, retrying', {
    jobId: String(job.id),
    queue: job.queue,
    stallCount: job.stallCount,
    attempt: job.attempts,
  });

  ctx.processingShards[procIdx].delete(job.id);
  shard.releaseJobResources(job.queue, job.uniqueKey, job.groupId);

  shard.getQueue(job.queue).push(job);
  const isDelayed = job.runAt > Date.now();
  shard.incrementQueued(job.id, isDelayed, job.createdAt, job.queue, job.runAt);
  ctx.jobIndex.set(job.id, { type: 'queue', shardIdx: idx, queueName: job.queue });
  ctx.storage?.updateForRetry(job);
}
