/**
 * Ack/Fail Operations
 * Job acknowledgement and failure handling
 */

import { type Job, type JobId, calculateBackoff, canRetry } from '../../domain/types/job';
import { type JobLocation, EventType } from '../../domain/types/queue';
import { FailureReason } from '../../domain/types/dlq';
import type { Shard } from '../../domain/queue/shard';
import type { SqliteStorage } from '../../infrastructure/persistence/sqlite';
import type { RWLock } from '../../shared/lock';
import { withWriteLock } from '../../shared/lock';
import { shardIndex, processingShardIndex } from '../../shared/hash';
import { latencyTracker } from '../latencyTracker';
import { throughputTracker } from '../throughputTracker';
import type { SetLike, MapLike } from '../../shared/lru';
import {
  groupByProcShard,
  groupItemsByProcShard,
  extractJobs,
  extractJobsWithResults,
  groupByQueueShard,
  releaseResources,
  finalizeBatchAck,
} from './ackHelpers';

/** Ack operation context */
export interface AckContext {
  storage: SqliteStorage | null;
  shards: Shard[];
  shardLocks: RWLock[];
  processingShards: Map<JobId, Job>[];
  processingLocks: RWLock[];
  completedJobs: SetLike<JobId>;
  completedJobsData: MapLike<JobId, Job>;
  jobResults: MapLike<JobId, unknown>;
  jobIndex: Map<JobId, JobLocation>;
  customIdMap?: MapLike<string, JobId>;
  totalCompleted: { value: bigint };
  totalFailed: { value: bigint };
  broadcast: (event: {
    eventType: EventType;
    queue: string;
    jobId: JobId;
    timestamp: number;
    data?: unknown;
    error?: string;
    prev?: string;
  }) => void;
  onJobCompleted: (jobId: JobId) => void;
  onJobsCompleted?: (jobIds: JobId[]) => void;
  needsBroadcast?: () => boolean;
  emitDashboardEvent?: (event: string, data: Record<string, unknown>) => void;
  hasPendingDeps?: () => boolean;
  onRepeat?: (job: Job) => void;
}

/**
 * Acknowledge job completion
 */
export async function ackJob(jobId: JobId, result: unknown, ctx: AckContext): Promise<void> {
  const startNs = Bun.nanoseconds();
  const procIdx = processingShardIndex(jobId);

  const job = await withWriteLock(ctx.processingLocks[procIdx], () => {
    const job = ctx.processingShards[procIdx].get(jobId);
    if (job) {
      ctx.processingShards[procIdx].delete(jobId);
    }
    return job;
  });

  if (!job) {
    throw new Error(`Job not found or not in processing state: ${jobId}`);
  }

  const idx = shardIndex(job.queue);
  await withWriteLock(ctx.shardLocks[idx], () => {
    ctx.shards[idx].releaseJobResources(job.queue, job.uniqueKey, job.groupId);
  });

  // Release customId so it can be reused
  if (job.customId && ctx.customIdMap) {
    ctx.customIdMap.delete(job.customId);
  }

  if (!job.removeOnComplete) {
    ctx.completedJobs.add(jobId);
    ctx.completedJobsData.set(jobId, job);
    if (result !== undefined) {
      ctx.jobResults.set(jobId, result);
      ctx.storage?.storeResult(jobId, result);
    }
    ctx.jobIndex.set(jobId, { type: 'completed' });
    ctx.storage?.markCompleted(jobId, Date.now());
  } else {
    ctx.jobIndex.delete(jobId);
    ctx.storage?.deleteJob(jobId);
  }

  ctx.totalCompleted.value++;
  throughputTracker.completeRate.increment();
  ctx.broadcast({
    eventType: 'completed' as EventType,
    queue: job.queue,
    jobId,
    timestamp: Date.now(),
    data: result,
  });

  ctx.onJobCompleted(jobId);

  if (job.repeat && ctx.onRepeat) {
    const shouldRepeat = job.repeat.limit === undefined || job.repeat.count < job.repeat.limit;
    if (shouldRepeat) {
      ctx.onRepeat(job);
    }
  }

  latencyTracker.ack.observe((Bun.nanoseconds() - startNs) / 1e6);
}

/**
 * Mark job as failed
 */
export async function failJob(
  jobId: JobId,
  error: string | undefined,
  ctx: AckContext
): Promise<void> {
  const procIdx = processingShardIndex(jobId);

  const job = await withWriteLock(ctx.processingLocks[procIdx], () => {
    const job = ctx.processingShards[procIdx].get(jobId);
    if (job) {
      ctx.processingShards[procIdx].delete(jobId);
    }
    return job;
  });

  if (!job) {
    throw new Error(`Job not found or not in processing state: ${jobId}`);
  }

  job.attempts++;

  const idx = shardIndex(job.queue);
  let wasRetried = false;
  await withWriteLock(ctx.shardLocks[idx], () => {
    const shard = ctx.shards[idx];
    shard.releaseJobResources(job.queue, job.uniqueKey, job.groupId);

    if (canRetry(job)) {
      const now = Date.now();
      job.runAt = now + calculateBackoff(job);
      shard.getQueue(job.queue).push(job);
      shard.incrementQueued(jobId, true, job.createdAt, job.queue, job.runAt);
      ctx.jobIndex.set(jobId, { type: 'queue', shardIdx: idx, queueName: job.queue });
      ctx.storage?.updateForRetry(job);
      wasRetried = true;
    } else if (job.removeOnFail) {
      ctx.jobIndex.delete(jobId);
      ctx.storage?.deleteJob(jobId);
      ctx.totalFailed.value++;
      throughputTracker.failRate.increment();
      // Release customId when job is removed on fail
      if (job.customId && ctx.customIdMap) {
        ctx.customIdMap.delete(job.customId);
      }
    } else {
      const entry = shard.addToDlq(job, FailureReason.MaxAttemptsExceeded, error ?? null);
      ctx.jobIndex.set(jobId, { type: 'dlq', queueName: job.queue });
      ctx.storage?.saveDlqEntry(entry);
      ctx.totalFailed.value++;
      throughputTracker.failRate.increment();
      // Release customId when job goes to DLQ
      if (job.customId && ctx.customIdMap) {
        ctx.customIdMap.delete(job.customId);
      }
      // Emit dlq:added dashboard event
      ctx.emitDashboardEvent?.('dlq:added', {
        queue: job.queue,
        jobId: String(jobId),
        reason: FailureReason.MaxAttemptsExceeded,
      });
    }
  });

  ctx.broadcast({
    eventType: 'failed' as EventType,
    queue: job.queue,
    jobId,
    timestamp: Date.now(),
    error,
  });

  // Emit retried event if job was requeued for retry (BullMQ v5)
  if (wasRetried) {
    ctx.broadcast({
      eventType: EventType.Retried,
      queue: job.queue,
      jobId,
      timestamp: Date.now(),
      prev: 'failed',
    });
  }
}

/**
 * Acknowledge multiple jobs - optimized batch processing
 * Groups jobs by shard to minimize lock acquisitions: O(shards) instead of O(n)
 */
export async function ackJobBatch(jobIds: JobId[], ctx: AckContext): Promise<void> {
  if (jobIds.length === 0) return;

  // Small batches - use parallel individual acks
  if (jobIds.length <= 4) {
    await Promise.all(jobIds.map((id) => ackJob(id, undefined, ctx)));
    return;
  }

  const batchCtx = {
    processingShards: ctx.processingShards,
    processingLocks: ctx.processingLocks,
    shards: ctx.shards,
    shardLocks: ctx.shardLocks,
  };

  // Step 1-2: Group and extract
  const byProcShard = groupByProcShard(jobIds);
  const extractedJobs = await extractJobs(byProcShard, batchCtx);

  // Step 3-4: Group by queue shard and release
  const byQueueShard = groupByQueueShard(extractedJobs);
  await releaseResources(byQueueShard, batchCtx);

  // Step 5: Finalize
  finalizeBatchAck(extractedJobs, ctx, false);
}

/**
 * Acknowledge multiple jobs with individual results - optimized batch processing
 */
export async function ackJobBatchWithResults(
  items: Array<{ id: JobId; result: unknown }>,
  ctx: AckContext
): Promise<void> {
  if (items.length === 0) return;

  // Small batches - use parallel individual acks
  if (items.length <= 4) {
    await Promise.all(items.map((item) => ackJob(item.id, item.result, ctx)));
    return;
  }

  const batchCtx = {
    processingShards: ctx.processingShards,
    processingLocks: ctx.processingLocks,
    shards: ctx.shards,
    shardLocks: ctx.shardLocks,
  };

  // Step 1-2: Group and extract with results
  const byProcShard = groupItemsByProcShard(items);
  const extractedJobs = await extractJobsWithResults(byProcShard, batchCtx);

  // Step 3-4: Group by queue shard and release
  const byQueueShard = groupByQueueShard(extractedJobs);
  await releaseResources(byQueueShard, batchCtx);

  // Step 5: Finalize with results
  finalizeBatchAck(extractedJobs, ctx, true);
}
