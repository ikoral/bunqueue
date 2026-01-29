/**
 * Ack/Fail Operations
 * Job acknowledgement and failure handling
 */

import { type Job, type JobId, calculateBackoff, canRetry } from '../../domain/types/job';
import type { JobLocation, EventType } from '../../domain/types/queue';
import type { Shard } from '../../domain/queue/shard';
import type { SqliteStorage } from '../../infrastructure/persistence/sqlite';
import type { RWLock } from '../../shared/lock';
import { withWriteLock } from '../../shared/lock';
import { shardIndex, processingShardIndex } from '../../shared/hash';
import type { SetLike, MapLike } from '../../shared/lru';

/** Ack operation context */
export interface AckContext {
  storage: SqliteStorage | null;
  shards: Shard[];
  shardLocks: RWLock[];
  processingShards: Map<JobId, Job>[];
  processingLocks: RWLock[];
  completedJobs: SetLike<JobId>;
  jobResults: MapLike<JobId, unknown>;
  jobIndex: Map<JobId, JobLocation>;
  totalCompleted: { value: bigint };
  totalFailed: { value: bigint };
  broadcast: (event: {
    eventType: EventType;
    queue: string;
    jobId: JobId;
    timestamp: number;
    data?: unknown;
    error?: string;
  }) => void;
  onJobCompleted: (jobId: JobId) => void;
}

/**
 * Acknowledge job completion
 */
export async function ackJob(jobId: JobId, result: unknown, ctx: AckContext): Promise<void> {
  const procIdx = processingShardIndex(jobId);

  // Remove from processing
  const job = await withWriteLock(ctx.processingLocks[procIdx], () => {
    const job = ctx.processingShards[procIdx].get(jobId);
    if (job) {
      ctx.processingShards[procIdx].delete(jobId);
    }
    return job;
  });

  if (!job) {
    throw new Error('Job not found');
  }

  // Release resources
  const idx = shardIndex(job.queue);
  await withWriteLock(ctx.shardLocks[idx], () => {
    ctx.shards[idx].releaseJobResources(job.queue, job.uniqueKey, job.groupId);
  });

  // Store result and mark completed
  if (!job.removeOnComplete) {
    ctx.completedJobs.add(jobId);
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

  // Update metrics
  ctx.totalCompleted.value++;
  ctx.broadcast({
    eventType: 'completed' as EventType,
    queue: job.queue,
    jobId,
    timestamp: Date.now(),
    data: result,
  });

  // Notify completion (for dependencies and parent jobs)
  ctx.onJobCompleted(jobId);
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

  // Remove from processing
  const job = await withWriteLock(ctx.processingLocks[procIdx], () => {
    const job = ctx.processingShards[procIdx].get(jobId);
    if (job) {
      ctx.processingShards[procIdx].delete(jobId);
    }
    return job;
  });

  if (!job) {
    throw new Error('Job not found');
  }

  // Increment attempts
  job.attempts++;

  const idx = shardIndex(job.queue);
  await withWriteLock(ctx.shardLocks[idx], () => {
    const shard = ctx.shards[idx];
    shard.releaseJobResources(job.queue, job.uniqueKey, job.groupId);

    if (canRetry(job)) {
      // Retry with exponential backoff
      job.runAt = Date.now() + calculateBackoff(job);
      shard.getQueue(job.queue).push(job);
      ctx.jobIndex.set(jobId, { type: 'queue', shardIdx: idx, queueName: job.queue });
      ctx.storage?.updateForRetry(job);
    } else if (job.removeOnFail) {
      // Remove completely - don't add to DLQ
      ctx.jobIndex.delete(jobId);
      ctx.storage?.deleteJob(jobId);
      ctx.totalFailed.value++;
    } else {
      // Move to DLQ
      shard.addToDlq(job);
      ctx.jobIndex.set(jobId, { type: 'dlq', queueName: job.queue });
      ctx.storage?.markFailed(job, error ?? null);
      ctx.totalFailed.value++;
    }
  });

  // Broadcast event
  ctx.broadcast({
    eventType: 'failed' as EventType,
    queue: job.queue,
    jobId,
    timestamp: Date.now(),
    error,
  });
}

/**
 * Acknowledge multiple jobs
 */
export async function ackJobBatch(jobIds: JobId[], ctx: AckContext): Promise<void> {
  for (const id of jobIds) {
    await ackJob(id, undefined, ctx);
  }
}
