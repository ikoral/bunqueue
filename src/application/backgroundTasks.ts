/**
 * Background Tasks - Periodic maintenance operations
 * Stall detection, cleanup, recovery, DLQ maintenance
 */

import type { Job, JobId } from '../domain/types/job';
import { calculateBackoff } from '../domain/types/job';
import { FailureReason } from '../domain/types/dlq';
import { StallAction, getStallAction, incrementStallCount } from '../domain/types/stall';
import { EventType } from '../domain/types/queue';
import type { WebhookEvent } from '../domain/types/webhook';
import { queueLog } from '../shared/logger';
import { shardIndex, processingShardIndex, SHARD_COUNT } from '../shared/hash';
import { withWriteLock } from '../shared/lock';
import * as dlqOps from './dlqManager';
import { checkExpiredLocks } from './lockManager';
import { cleanup } from './cleanupTasks';
import type { BackgroundContext, LockContext } from './types';
import type { CronScheduler } from '../infrastructure/scheduler/cronScheduler';

/** Background task handles for cleanup */
export interface BackgroundTaskHandles {
  cleanupInterval: ReturnType<typeof setInterval>;
  timeoutInterval: ReturnType<typeof setInterval>;
  depCheckInterval: ReturnType<typeof setInterval>;
  stallCheckInterval: ReturnType<typeof setInterval>;
  dlqMaintenanceInterval: ReturnType<typeof setInterval>;
  lockCheckInterval: ReturnType<typeof setInterval>;
  cronScheduler: CronScheduler;
}

/**
 * Start all background tasks
 * Returns handles that can be used to stop tasks later
 */
export function startBackgroundTasks(
  ctx: BackgroundContext,
  cronScheduler: CronScheduler
): BackgroundTaskHandles {
  const cleanupInterval = setInterval(() => {
    cleanup(ctx);
  }, ctx.config.cleanupIntervalMs);

  const timeoutInterval = setInterval(() => {
    checkJobTimeouts(ctx);
  }, ctx.config.jobTimeoutCheckMs);

  const depCheckInterval = setInterval(() => {
    processPendingDependencies(ctx).catch((err: unknown) => {
      queueLog.error('Dependency check failed', { error: String(err) });
    });
  }, ctx.config.dependencyCheckMs);

  const stallCheckInterval = setInterval(() => {
    checkStalledJobs(ctx);
  }, ctx.config.stallCheckMs);

  const dlqMaintenanceInterval = setInterval(() => {
    performDlqMaintenance(ctx);
  }, ctx.config.dlqMaintenanceMs);

  // Lock expiration check runs at same interval as stall check
  const lockCheckInterval = setInterval(() => {
    checkExpiredLocks(getLockContext(ctx)).catch((err: unknown) => {
      queueLog.error('Lock expiration check failed', { error: String(err) });
    });
  }, ctx.config.stallCheckMs);

  cronScheduler.start();

  return {
    cleanupInterval,
    timeoutInterval,
    depCheckInterval,
    stallCheckInterval,
    dlqMaintenanceInterval,
    lockCheckInterval,
    cronScheduler,
  };
}

/**
 * Stop all background tasks
 */
export function stopBackgroundTasks(handles: BackgroundTaskHandles): void {
  clearInterval(handles.cleanupInterval);
  clearInterval(handles.timeoutInterval);
  clearInterval(handles.depCheckInterval);
  clearInterval(handles.stallCheckInterval);
  clearInterval(handles.dlqMaintenanceInterval);
  clearInterval(handles.lockCheckInterval);
  handles.cronScheduler.stop();
}

/** Extract lock context from background context */
function getLockContext(ctx: BackgroundContext): LockContext {
  return {
    jobIndex: ctx.jobIndex,
    jobLocks: ctx.jobLocks,
    clientJobs: ctx.clientJobs,
    processingShards: ctx.processingShards,
    processingLocks: ctx.processingLocks,
    shards: ctx.shards,
    shardLocks: ctx.shardLocks,
    eventsManager: ctx.eventsManager,
  };
}

// ============ Job Timeouts ============

function checkJobTimeouts(ctx: BackgroundContext): void {
  const now = Date.now();
  for (const procShard of ctx.processingShards) {
    for (const [jobId, job] of procShard) {
      if (job.timeout && job.startedAt && now - job.startedAt > job.timeout) {
        ctx.fail(jobId, 'Job timeout exceeded').catch((err: unknown) => {
          queueLog.error('Failed to mark timed out job as failed', {
            jobId: String(jobId),
            error: String(err),
          });
        });
      }
    }
  }
}

// ============ Stall Detection ============

/**
 * Check for stalled jobs and handle them
 * Uses two-phase detection (like BullMQ) to prevent false positives
 */
function checkStalledJobs(ctx: BackgroundContext): void {
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
        queueLog.warn('Job exceeded max stalls, moving to DLQ', {
          jobId: String(job.id),
          queue: job.queue,
          stallCount: job.stallCount,
        });

        ctx.processingShards[procIdx].delete(job.id);
        shard.releaseConcurrency(job.queue);

        const entry = shard.addToDlq(
          job,
          FailureReason.Stalled,
          `Job stalled ${job.stallCount + 1} times`
        );
        ctx.jobIndex.set(job.id, { type: 'dlq', queueName: job.queue });
        ctx.storage?.saveDlqEntry(entry);
      } else {
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
        shard.releaseConcurrency(job.queue);

        shard.getQueue(job.queue).push(job);
        const isDelayed = job.runAt > Date.now();
        shard.incrementQueued(job.id, isDelayed, job.createdAt, job.queue, job.runAt);
        ctx.jobIndex.set(job.id, { type: 'queue', shardIdx: idx, queueName: job.queue });
        ctx.storage?.updateForRetry(job);
      }
    });
  });
}

// ============ DLQ Maintenance ============

function performDlqMaintenance(ctx: BackgroundContext): void {
  const dlqCtx = {
    shards: ctx.shards,
    jobIndex: ctx.jobIndex,
    storage: ctx.storage,
  };

  for (const queueName of ctx.queueNamesCache) {
    try {
      const retried = dlqOps.processAutoRetry(queueName, dlqCtx);
      if (retried > 0) {
        queueLog.info('DLQ auto-retry completed', { queue: queueName, retried });
      }

      const purged = dlqOps.purgeExpiredDlq(queueName, dlqCtx);
      if (purged > 0) {
        queueLog.info('DLQ purge completed', { queue: queueName, purged });
      }
    } catch (err) {
      queueLog.error('DLQ maintenance failed', { queue: queueName, error: String(err) });
    }
  }
}

// ============ Recovery ============

export function recover(ctx: BackgroundContext): void {
  if (!ctx.storage) return;

  const now = Date.now();
  for (const job of ctx.storage.loadPendingJobs()) {
    const idx = shardIndex(job.queue);
    const shard = ctx.shards[idx];
    shard.getQueue(job.queue).push(job);
    ctx.jobIndex.set(job.id, { type: 'queue', shardIdx: idx, queueName: job.queue });
    const isDelayed = job.runAt > now;
    shard.incrementQueued(job.id, isDelayed, job.createdAt, job.queue, job.runAt);
    ctx.registerQueueName(job.queue);
  }

  // Load DLQ entries
  const dlqEntries = ctx.storage.loadDlq();
  let dlqCount = 0;
  for (const [queue, entries] of dlqEntries) {
    const idx = shardIndex(queue);
    const shard = ctx.shards[idx];
    for (const entry of entries) {
      let dlq = shard.dlq.get(queue);
      if (!dlq) {
        dlq = [];
        shard.dlq.set(queue, dlq);
      }
      dlq.push(entry);
      shard.incrementDlq();
      dlqCount++;
    }
    ctx.registerQueueName(queue);
  }
  if (dlqCount > 0) {
    queueLog.info('Loaded DLQ entries', { count: dlqCount });
  }
}

// ============ Dependency Processing ============

/**
 * Process pending dependency checks
 * Uses reverse index for O(m) where m = jobs waiting on completed deps
 */
export async function processPendingDependencies(ctx: BackgroundContext): Promise<void> {
  if (ctx.pendingDepChecks.size === 0) return;

  const completedIds = Array.from(ctx.pendingDepChecks);
  ctx.pendingDepChecks.clear();

  const jobsToCheckByShard = new Map<number, Set<JobId>>();

  for (const completedId of completedIds) {
    for (let i = 0; i < SHARD_COUNT; i++) {
      const waitingJobIds = ctx.shards[i].getJobsWaitingFor(completedId);
      if (waitingJobIds && waitingJobIds.size > 0) {
        let shardJobs = jobsToCheckByShard.get(i);
        if (!shardJobs) {
          shardJobs = new Set();
          jobsToCheckByShard.set(i, shardJobs);
        }
        for (const jobId of waitingJobIds) {
          shardJobs.add(jobId);
        }
      }
    }
  }

  await Promise.all(
    Array.from(jobsToCheckByShard.entries()).map(async ([i, jobIdsToCheck]) => {
      const shard = ctx.shards[i];
      const jobsToPromote: Job[] = [];

      for (const jobId of jobIdsToCheck) {
        const job = shard.waitingDeps.get(jobId);
        if (job?.dependsOn.every((dep) => ctx.completedJobs.has(dep))) {
          jobsToPromote.push(job);
        }
      }

      if (jobsToPromote.length > 0) {
        await withWriteLock(ctx.shardLocks[i], () => {
          const now = Date.now();
          for (const job of jobsToPromote) {
            if (shard.waitingDeps.has(job.id)) {
              shard.waitingDeps.delete(job.id);
              shard.unregisterDependencies(job.id, job.dependsOn);
              shard.getQueue(job.queue).push(job);
              const isDelayed = job.runAt > now;
              shard.incrementQueued(job.id, isDelayed, job.createdAt, job.queue, job.runAt);
              ctx.jobIndex.set(job.id, { type: 'queue', shardIdx: i, queueName: job.queue });
            }
          }
          if (jobsToPromote.length > 0) {
            shard.notify();
          }
        });
      }
    })
  );
}
