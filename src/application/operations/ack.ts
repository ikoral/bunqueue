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
  /** Batch notify completions - more efficient than per-job calls */
  onJobsCompleted?: (jobIds: JobId[]) => void;
  /** Fast check if broadcast is needed - avoids function call overhead */
  needsBroadcast?: () => boolean;
  /** Check if any jobs are waiting for dependencies */
  hasPendingDeps?: () => boolean;
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
    throw new Error(`Job not found or not in processing state: ${jobId}`);
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
    throw new Error(`Job not found or not in processing state: ${jobId}`);
  }

  // Increment attempts
  job.attempts++;

  const idx = shardIndex(job.queue);
  await withWriteLock(ctx.shardLocks[idx], () => {
    const shard = ctx.shards[idx];
    shard.releaseJobResources(job.queue, job.uniqueKey, job.groupId);

    if (canRetry(job)) {
      // Retry with exponential backoff
      const now = Date.now();
      job.runAt = now + calculateBackoff(job);
      shard.getQueue(job.queue).push(job);
      // Update running counters for O(1) stats (retry jobs are always delayed)
      shard.incrementQueued(jobId, true, job.createdAt, job.queue);
      ctx.jobIndex.set(jobId, { type: 'queue', shardIdx: idx, queueName: job.queue });
      ctx.storage?.updateForRetry(job);
    } else if (job.removeOnFail) {
      // Remove completely - don't add to DLQ
      ctx.jobIndex.delete(jobId);
      ctx.storage?.deleteJob(jobId);
      ctx.totalFailed.value++;
    } else {
      // Move to DLQ (addToDlq already updates dlq counter)
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

/** Debug flag for ackBatch timing */
const DEBUG_ACK_BATCH = process.env.DEBUG_ACK_BATCH === '1';

/**
 * Acknowledge multiple jobs - optimized batch processing
 * Groups jobs by shard to minimize lock acquisitions: O(shards) instead of O(n)
 */
// eslint-disable-next-line complexity
export async function ackJobBatch(jobIds: JobId[], ctx: AckContext): Promise<void> {
  if (jobIds.length === 0) return;

  // Small batches - use parallel individual acks (overhead of grouping not worth it)
  if (jobIds.length <= 4) {
    await Promise.all(jobIds.map((id) => ackJob(id, undefined, ctx)));
    return;
  }

  const t0 = DEBUG_ACK_BATCH ? performance.now() : 0;

  // Step 1: Group jobs by processing shard
  const byProcShard = new Map<number, JobId[]>();
  for (const jobId of jobIds) {
    const procIdx = processingShardIndex(jobId);
    let group = byProcShard.get(procIdx);
    if (!group) {
      group = [];
      byProcShard.set(procIdx, group);
    }
    group.push(jobId);
  }

  const t1 = DEBUG_ACK_BATCH ? performance.now() : 0;

  // Step 2: Extract all jobs from processing shards (one lock per shard)
  // Use arrays instead of Map for faster iteration in step 5
  const extractedJobs: Array<{ id: JobId; job: Job }> = [];
  await Promise.all(
    Array.from(byProcShard.entries()).map(async ([procIdx, ids]) => {
      await withWriteLock(ctx.processingLocks[procIdx], () => {
        for (const jobId of ids) {
          const job = ctx.processingShards[procIdx].get(jobId);
          if (job) {
            ctx.processingShards[procIdx].delete(jobId);
            extractedJobs.push({ id: jobId, job });
          }
        }
      });
    })
  );

  const t2 = DEBUG_ACK_BATCH ? performance.now() : 0;

  // Step 3: Group extracted jobs by queue shard
  const byQueueShard = new Map<number, Job[]>();
  for (let i = 0; i < extractedJobs.length; i++) {
    const job = extractedJobs[i].job;
    const idx = shardIndex(job.queue);
    let group = byQueueShard.get(idx);
    if (!group) {
      group = [];
      byQueueShard.set(idx, group);
    }
    group.push(job);
  }

  const t3 = DEBUG_ACK_BATCH ? performance.now() : 0;

  // Step 4: Release resources for each queue shard (one lock per shard)
  await Promise.all(
    Array.from(byQueueShard.entries()).map(async ([idx, jobs]) => {
      await withWriteLock(ctx.shardLocks[idx], () => {
        const shard = ctx.shards[idx];
        for (const job of jobs) {
          shard.releaseJobResources(job.queue, job.uniqueKey, job.groupId);
        }
      });
    })
  );

  const t4 = DEBUG_ACK_BATCH ? performance.now() : 0;

  // Step 5: Update indexes and metrics (no locks needed - single-threaded)
  // Optimized: use indexed for loop (faster than for-of), minimize function calls
  const now = Date.now();
  const completedLocation: JobLocation = { type: 'completed' };
  const storage = ctx.storage;
  const hasStorage = storage !== null;
  const jobCount = extractedJobs.length;

  // Pre-check flags (check once, not per job)
  const needsBroadcast = ctx.needsBroadcast?.() ?? true;
  const hasPendingDeps = ctx.hasPendingDeps?.() ?? true;

  const t5a = DEBUG_ACK_BATCH ? performance.now() : 0;

  // Batch counter update (single BigInt operation instead of N increments)
  ctx.totalCompleted.value += BigInt(jobCount);

  const t5b = DEBUG_ACK_BATCH ? performance.now() : 0;

  // Main loop - indexed for loop is faster than for-of on arrays
  for (let i = 0; i < jobCount; i++) {
    const { id: jobId, job } = extractedJobs[i];
    if (!job.removeOnComplete) {
      ctx.completedJobs.add(jobId);
      ctx.jobIndex.set(jobId, completedLocation);
      if (hasStorage) storage.markCompleted(jobId, now);
    } else {
      ctx.jobIndex.delete(jobId);
      if (hasStorage) storage.deleteJob(jobId);
    }
  }

  const t5c = DEBUG_ACK_BATCH ? performance.now() : 0;

  // Broadcast events (only if listeners exist)
  if (needsBroadcast) {
    const event = {
      eventType: 'completed' as EventType,
      queue: '',
      jobId: '' as unknown as JobId,
      timestamp: now,
    };
    for (let i = 0; i < jobCount; i++) {
      const { id: jobId, job } = extractedJobs[i];
      event.queue = job.queue;
      event.jobId = jobId;
      ctx.broadcast(event);
    }
  }

  const t5d = DEBUG_ACK_BATCH ? performance.now() : 0;

  // Batch notify completions (for dependency checking)
  if (hasPendingDeps && ctx.onJobsCompleted) {
    const completedIds = extractedJobs.map((e) => e.id);
    ctx.onJobsCompleted(completedIds);
  } else if (hasPendingDeps) {
    for (let i = 0; i < jobCount; i++) {
      ctx.onJobCompleted(extractedJobs[i].id);
    }
  }

  const t5 = DEBUG_ACK_BATCH ? performance.now() : 0;

  if (DEBUG_ACK_BATCH) {
    console.log(`  Step 5 details:`);
    console.log(`    5a checks:         ${(t5b - t5a).toFixed(2)}ms`);
    console.log(`    5b main loop:      ${(t5c - t5b).toFixed(2)}ms`);
    console.log(
      `    5c broadcast:      ${(t5d - t5c).toFixed(2)}ms (needsBroadcast=${needsBroadcast})`
    );
    console.log(
      `    5d deps:           ${(t5 - t5d).toFixed(2)}ms (hasPendingDeps=${hasPendingDeps})`
    );
  }

  if (DEBUG_ACK_BATCH) {
    console.log(`ackBatch timing (${jobIds.length} jobs):`);
    console.log(`  Step 1 (group proc):    ${(t1 - t0).toFixed(2)}ms`);
    console.log(`  Step 2 (extract):       ${(t2 - t1).toFixed(2)}ms`);
    console.log(`  Step 3 (group queue):   ${(t3 - t2).toFixed(2)}ms`);
    console.log(`  Step 4 (release):       ${(t4 - t3).toFixed(2)}ms`);
    console.log(`  Step 5 (update idx):    ${(t5 - t4).toFixed(2)}ms`);
    console.log(`  Total:                  ${(t5 - t0).toFixed(2)}ms`);
  }
}

/**
 * Acknowledge multiple jobs with individual results - optimized batch processing
 * Same as ackJobBatch but supports passing result data for each job
 */
// eslint-disable-next-line complexity
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

  const t0 = DEBUG_ACK_BATCH ? performance.now() : 0;

  // Step 1: Group jobs by processing shard
  const byProcShard = new Map<number, Array<{ id: JobId; result: unknown }>>();
  for (const item of items) {
    const procIdx = processingShardIndex(item.id);
    let group = byProcShard.get(procIdx);
    if (!group) {
      group = [];
      byProcShard.set(procIdx, group);
    }
    group.push(item);
  }

  const t1 = DEBUG_ACK_BATCH ? performance.now() : 0;

  // Step 2: Extract all jobs from processing shards (one lock per shard)
  // Keep result with each extracted job
  const extractedJobs: Array<{ id: JobId; job: Job; result: unknown }> = [];
  await Promise.all(
    Array.from(byProcShard.entries()).map(async ([procIdx, itemsInShard]) => {
      await withWriteLock(ctx.processingLocks[procIdx], () => {
        for (const item of itemsInShard) {
          const job = ctx.processingShards[procIdx].get(item.id);
          if (job) {
            ctx.processingShards[procIdx].delete(item.id);
            extractedJobs.push({ id: item.id, job, result: item.result });
          }
        }
      });
    })
  );

  const t2 = DEBUG_ACK_BATCH ? performance.now() : 0;

  // Step 3: Group extracted jobs by queue shard
  const byQueueShard = new Map<number, Job[]>();
  for (let i = 0; i < extractedJobs.length; i++) {
    const job = extractedJobs[i].job;
    const idx = shardIndex(job.queue);
    let group = byQueueShard.get(idx);
    if (!group) {
      group = [];
      byQueueShard.set(idx, group);
    }
    group.push(job);
  }

  const t3 = DEBUG_ACK_BATCH ? performance.now() : 0;

  // Step 4: Release resources for each queue shard (one lock per shard)
  await Promise.all(
    Array.from(byQueueShard.entries()).map(async ([idx, jobs]) => {
      await withWriteLock(ctx.shardLocks[idx], () => {
        const shard = ctx.shards[idx];
        for (const job of jobs) {
          shard.releaseJobResources(job.queue, job.uniqueKey, job.groupId);
        }
      });
    })
  );

  const t4 = DEBUG_ACK_BATCH ? performance.now() : 0;

  // Step 5: Update indexes, store results, and metrics
  const now = Date.now();
  const completedLocation: JobLocation = { type: 'completed' };
  const storage = ctx.storage;
  const hasStorage = storage !== null;
  const jobCount = extractedJobs.length;

  // Pre-check flags
  const needsBroadcast = ctx.needsBroadcast?.() ?? true;
  const hasPendingDeps = ctx.hasPendingDeps?.() ?? true;

  // Batch counter update
  ctx.totalCompleted.value += BigInt(jobCount);

  // Main loop with result storage
  for (let i = 0; i < jobCount; i++) {
    const { id: jobId, job, result } = extractedJobs[i];
    if (!job.removeOnComplete) {
      ctx.completedJobs.add(jobId);
      if (result !== undefined) {
        ctx.jobResults.set(jobId, result);
        if (hasStorage) storage.storeResult(jobId, result);
      }
      ctx.jobIndex.set(jobId, completedLocation);
      if (hasStorage) storage.markCompleted(jobId, now);
    } else {
      ctx.jobIndex.delete(jobId);
      if (hasStorage) storage.deleteJob(jobId);
    }
  }

  // Broadcast events with results (only if listeners exist)
  if (needsBroadcast) {
    for (let i = 0; i < jobCount; i++) {
      const { id: jobId, job, result } = extractedJobs[i];
      ctx.broadcast({
        eventType: 'completed' as EventType,
        queue: job.queue,
        jobId,
        timestamp: now,
        data: result,
      });
    }
  }

  // Batch notify completions (for dependency checking)
  if (hasPendingDeps && ctx.onJobsCompleted) {
    const completedIds = extractedJobs.map((e) => e.id);
    ctx.onJobsCompleted(completedIds);
  } else if (hasPendingDeps) {
    for (let i = 0; i < jobCount; i++) {
      ctx.onJobCompleted(extractedJobs[i].id);
    }
  }

  const t5 = DEBUG_ACK_BATCH ? performance.now() : 0;

  if (DEBUG_ACK_BATCH) {
    console.log(`ackBatchWithResults timing (${items.length} jobs):`);
    console.log(`  Step 1 (group proc):    ${(t1 - t0).toFixed(2)}ms`);
    console.log(`  Step 2 (extract):       ${(t2 - t1).toFixed(2)}ms`);
    console.log(`  Step 3 (group queue):   ${(t3 - t2).toFixed(2)}ms`);
    console.log(`  Step 4 (release):       ${(t4 - t3).toFixed(2)}ms`);
    console.log(`  Step 5 (update+store):  ${(t5 - t4).toFixed(2)}ms`);
    console.log(`  Total:                  ${(t5 - t0).toFixed(2)}ms`);
  }
}
