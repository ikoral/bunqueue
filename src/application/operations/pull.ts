/**
 * Pull Operations
 * Job pull logic with timeout support
 */

import { type Job, type JobId, isExpired, isReady } from '../../domain/types/job';
import type { JobLocation, EventType } from '../../domain/types/queue';
import type { Shard } from '../../domain/queue/shard';
import type { SqliteStorage } from '../../infrastructure/persistence/sqlite';
import type { RWLock } from '../../shared/lock';
import { withWriteLock } from '../../shared/lock';
import { shardIndex, processingShardIndex } from '../../shared/hash';
import { latencyTracker } from '../latencyTracker';
import { throughputTracker } from '../throughputTracker';

/** Pull operation context */
export interface PullContext {
  storage: SqliteStorage | null;
  shards: Shard[];
  shardLocks: RWLock[];
  processingShards: Map<JobId, Job>[];
  processingLocks: RWLock[];
  jobIndex: Map<JobId, JobLocation>;
  totalPulled: { value: bigint };
  broadcast: (event: {
    eventType: EventType;
    queue: string;
    jobId: JobId;
    timestamp: number;
  }) => void;
  dashboardEmit?: (event: string, data: Record<string, unknown>) => void;
}

/** Result of trying to dequeue a job */
type DequeueResult =
  | { status: 'job'; job: Job }
  | { status: 'skip' } // expired, try next
  | { status: 'stop' }; // not ready or blocked

/**
 * Try to dequeue next ready job from queue
 * Handles: expired skip, ready check, group blocking, timestamps
 */
function tryDequeueNextJob(
  shard: Shard,
  queue: string,
  now: number,
  ctx: PullContext
): DequeueResult {
  const q = shard.getQueue(queue);
  const job = q.peek();

  if (!job) return { status: 'stop' };

  // Skip expired jobs
  if (isExpired(job, now)) {
    q.pop();
    shard.decrementQueued(job.id);
    ctx.jobIndex.delete(job.id);
    return { status: 'skip' };
  }

  // Not ready yet (delayed)
  if (!isReady(job, now)) return { status: 'stop' };

  // FIFO group blocked
  if (job.groupId && shard.isGroupActive(queue, job.groupId)) {
    return { status: 'stop' };
  }

  // Dequeue and update
  q.pop();
  shard.decrementQueued(job.id);

  if (job.groupId) {
    shard.activateGroup(queue, job.groupId);
  }

  job.startedAt = now;
  job.lastHeartbeat = now;

  return { status: 'job', job };
}

/**
 * Move job to processing shard and broadcast
 */
async function moveToProcessing(job: Job, queue: string, ctx: PullContext): Promise<void> {
  const procIdx = processingShardIndex(job.id);
  const now = Date.now();

  await withWriteLock(ctx.processingLocks[procIdx], () => {
    ctx.processingShards[procIdx].set(job.id, job);
  });

  ctx.jobIndex.set(job.id, { type: 'processing', shardIdx: procIdx });
  ctx.storage?.markActive(job.id, job.startedAt ?? now);
  ctx.totalPulled.value++;
  throughputTracker.pullRate.increment();
  ctx.broadcast({
    eventType: 'pulled' as EventType,
    queue,
    jobId: job.id,
    timestamp: now,
  });
}

/**
 * Move multiple jobs to processing shards (optimized: groups by shard)
 */
async function moveToProcessingBatch(jobs: Job[], queue: string, ctx: PullContext): Promise<void> {
  // Group by processing shard for efficiency
  const byProcShard = new Map<number, Job[]>();
  for (const job of jobs) {
    const procIdx = processingShardIndex(job.id);
    const shardJobs = byProcShard.get(procIdx) ?? [];
    if (shardJobs.length === 0) byProcShard.set(procIdx, shardJobs);
    shardJobs.push(job);
  }

  // Add to processing shards in parallel
  const lockPromises: Promise<void>[] = [];
  for (const [procIdx, shardJobs] of byProcShard) {
    lockPromises.push(
      withWriteLock(ctx.processingLocks[procIdx], () => {
        for (const job of shardJobs) {
          ctx.processingShards[procIdx].set(job.id, job);
        }
      })
    );
  }
  await Promise.all(lockPromises);

  // Update indexes and broadcast
  const now = Date.now();
  for (const job of jobs) {
    const procIdx = processingShardIndex(job.id);
    ctx.jobIndex.set(job.id, { type: 'processing', shardIdx: procIdx });
    ctx.storage?.markActive(job.id, job.startedAt ?? now);
    ctx.totalPulled.value++;
    throughputTracker.pullRate.increment();
    ctx.broadcast({
      eventType: 'pulled' as EventType,
      queue,
      jobId: job.id,
      timestamp: now,
    });
  }
}

/**
 * Pull next job from queue
 */
export async function pullJob(
  queue: string,
  timeoutMs: number,
  ctx: PullContext
): Promise<Job | null> {
  const startNs = Bun.nanoseconds();
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
  const idx = shardIndex(queue);

  while (true) {
    const job = await tryPullFromShard(queue, idx, ctx);

    if (job) {
      await moveToProcessing(job, queue, ctx);
      latencyTracker.pull.observe((Bun.nanoseconds() - startNs) / 1e6);
      return job;
    }

    // No job available, check timeout
    // Cache Date.now() to avoid multiple syscalls per iteration
    const now = Date.now();
    if (deadline === 0 || now >= deadline) {
      return null;
    }

    // Wait for notification or timeout
    const remaining = deadline - now;
    await ctx.shards[idx].waitForJob(remaining);
  }
}

/**
 * Try to pull a job from a specific shard
 */
async function tryPullFromShard(queue: string, idx: number, ctx: PullContext): Promise<Job | null> {
  return await withWriteLock(ctx.shardLocks[idx], () => {
    const shard = ctx.shards[idx];
    const state = shard.getState(queue);

    if (state.paused) {
      return null;
    }

    if (!shard.tryAcquireRateLimit(queue)) {
      ctx.dashboardEmit?.('ratelimit:rejected', { queue });
      return null;
    }

    if (!shard.tryAcquireConcurrency(queue)) {
      ctx.dashboardEmit?.('concurrency:rejected', { queue });
      return null;
    }

    const now = Date.now();

    while (true) {
      const result = tryDequeueNextJob(shard, queue, now, ctx);

      if (result.status === 'job') return result.job;
      if (result.status === 'stop') {
        shard.releaseConcurrency(queue);
        return null;
      }
      // status === 'skip': continue loop
    }
  });
}

/**
 * Pull multiple jobs from queue
 */
export async function pullJobBatch(
  queue: string,
  count: number,
  timeoutMs: number,
  ctx: PullContext
): Promise<Job[]> {
  const startNs = Bun.nanoseconds();
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
  const idx = shardIndex(queue);

  while (true) {
    const jobs = await tryPullBatchFromShard(queue, idx, count, ctx);

    if (jobs.length > 0) {
      await moveToProcessingBatch(jobs, queue, ctx);
      if (jobs.length > 1) {
        ctx.dashboardEmit?.('batch:pulled', { queue, count: jobs.length });
      }
      latencyTracker.pull.observe((Bun.nanoseconds() - startNs) / 1e6);
      return jobs;
    }

    // No jobs available, check timeout
    // Cache Date.now() to avoid multiple syscalls per iteration
    const now = Date.now();
    if (deadline === 0 || now >= deadline) {
      return [];
    }

    // Wait for notification or timeout
    const remaining = deadline - now;
    await ctx.shards[idx].waitForJob(remaining);
  }
}

/**
 * Try to pull multiple jobs from a shard
 */
async function tryPullBatchFromShard(
  queue: string,
  idx: number,
  count: number,
  ctx: PullContext
): Promise<Job[]> {
  return await withWriteLock(ctx.shardLocks[idx], () => {
    const shard = ctx.shards[idx];
    const state = shard.getState(queue);
    const jobs: Job[] = [];

    if (state.paused) return jobs;

    const now = Date.now();

    while (jobs.length < count) {
      // Check limits per job
      if (!shard.tryAcquireRateLimit(queue)) {
        break;
      }
      if (!shard.tryAcquireConcurrency(queue)) {
        break;
      }

      const result = tryDequeueNextJob(shard, queue, now, ctx);

      if (result.status === 'job') {
        jobs.push(result.job);
      } else {
        // 'stop' or 'skip': release the concurrency slot since no job was taken
        shard.releaseConcurrency(queue);
        if (result.status === 'stop') break;
        // 'skip': continue loop to try next job
      }
    }

    return jobs;
  });
}
