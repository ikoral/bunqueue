/**
 * Pull Operations
 * Job pull logic with timeout support
 */

import { type Job, type JobId, isExpired, isReady } from '../../domain/types/job';
import type { JobLocation, EventType } from '../../domain/types/queue';
import type { Shard } from '../../domain/queue/shard';
import type { SqliteStorage } from '../../infrastructure/persistence/sqlite';
import { RWLock, withWriteLock } from '../../shared/lock';
import { shardIndex, processingShardIndex } from '../../shared/hash';

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
}

/**
 * Pull next job from queue
 */
export async function pullJob(
  queue: string,
  timeoutMs: number,
  ctx: PullContext
): Promise<Job | null> {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
  const idx = shardIndex(queue);

  while (true) {
    const job = await tryPullFromShard(queue, idx, ctx);

    if (job) {
      // Move to processing
      const procIdx = processingShardIndex(job.id);
      await withWriteLock(ctx.processingLocks[procIdx], () => {
        ctx.processingShards[procIdx].set(job.id, job);
      });
      ctx.jobIndex.set(job.id, { type: 'processing', shardIdx: procIdx });

      // Persist state change
      ctx.storage?.markActive(job.id, job.startedAt!);

      // Update metrics
      ctx.totalPulled.value++;
      ctx.broadcast({
        eventType: 'pulled' as EventType,
        queue,
        jobId: job.id,
        timestamp: Date.now(),
      });

      return job;
    }

    // No job available, check timeout
    if (deadline === 0 || Date.now() >= deadline) {
      return null;
    }

    // Wait for notification or timeout (event-based, not polling)
    const remaining = deadline - Date.now();
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

    // Check if paused
    if (state.paused) return null;

    // Check rate limit
    if (!shard.tryAcquireRateLimit(queue)) return null;

    // Check concurrency
    if (!shard.tryAcquireConcurrency(queue)) return null;

    const q = shard.getQueue(queue);
    const now = Date.now();

    // Find ready job
    while (true) {
      const job = q.peek();
      if (!job) break;

      // Skip expired jobs
      if (isExpired(job, now)) {
        q.pop();
        ctx.jobIndex.delete(job.id);
        continue;
      }

      // Check if ready
      if (!isReady(job, now)) break;

      // Check FIFO group
      if (job.groupId && shard.isGroupActive(queue, job.groupId)) {
        // Skip, will retry
        break;
      }

      // Dequeue
      q.pop();

      // Mark group active
      if (job.groupId) {
        shard.activateGroup(queue, job.groupId);
      }

      // Update job
      job.startedAt = now;
      job.lastHeartbeat = now;

      return job;
    }

    return null;
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
  const jobs: Job[] = [];
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;

  for (let i = 0; i < count; i++) {
    const remaining = deadline > 0 ? Math.max(0, deadline - Date.now()) : 0;
    const job = await pullJob(queue, remaining, ctx);

    if (!job) break;
    jobs.push(job);
  }

  return jobs;
}
