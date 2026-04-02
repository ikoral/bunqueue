/**
 * Client Tracking - Client-job relationship management
 * Handles job ownership and release on client disconnect
 */

import type { Job, JobId } from '../domain/types/job';
import { shardIndex } from '../shared/hash';
import { withWriteLock } from '../shared/lock';
import type { LockContext } from './types';

/**
 * Register a job as owned by a client (called on PULL).
 */
export function registerClientJob(clientId: string, jobId: JobId, ctx: LockContext): void {
  let jobs = ctx.clientJobs.get(clientId);
  if (!jobs) {
    jobs = new Set();
    ctx.clientJobs.set(clientId, jobs);
  }
  jobs.add(jobId);
}

/**
 * Unregister a job from a client (called on ACK/FAIL).
 */
export function unregisterClientJob(
  clientId: string | undefined,
  jobId: JobId,
  ctx: LockContext
): void {
  if (!clientId) return;
  const jobs = ctx.clientJobs.get(clientId);
  if (jobs) {
    jobs.delete(jobId);
    if (jobs.size === 0) {
      ctx.clientJobs.delete(clientId);
    }
  }
}

/**
 * Release all jobs owned by a client back to queue (called on TCP disconnect).
 * Returns the number of jobs released.
 *
 * Uses proper locking to prevent race conditions.
 */
export async function releaseClientJobs(clientId: string, ctx: LockContext): Promise<number> {
  const jobs = ctx.clientJobs.get(clientId);
  if (!jobs || jobs.size === 0) {
    ctx.clientJobs.delete(clientId);
    return 0;
  }

  // Phase 1: Collect jobs to release (read-only, no locks needed)
  const jobsToRelease: Array<{
    jobId: JobId;
    procIdx: number;
    queueShardIdx: number;
  }> = [];

  for (const jobId of jobs) {
    const loc = ctx.jobIndex.get(jobId);
    if (loc?.type !== 'processing') continue;

    const procIdx = loc.shardIdx;
    const job = ctx.processingShards[procIdx].get(jobId);
    if (!job) continue;

    jobsToRelease.push({
      jobId,
      procIdx,
      queueShardIdx: shardIndex(job.queue),
    });
  }

  if (jobsToRelease.length === 0) {
    ctx.clientJobs.delete(clientId);
    return 0;
  }

  // Phase 2: Group by processing shard for efficient locking
  const byProcShard = new Map<number, typeof jobsToRelease>();
  for (const item of jobsToRelease) {
    let list = byProcShard.get(item.procIdx);
    if (!list) {
      list = [];
      byProcShard.set(item.procIdx, list);
    }
    list.push(item);
  }

  let released = 0;
  const now = Date.now();

  // Phase 3: Process each processing shard with proper locking
  // Lock order: shardLocks BEFORE processingLocks (per lock hierarchy in CLAUDE.md)
  for (const [procIdx, items] of byProcShard) {
    // Group items by queue shard to minimize lock acquisitions
    const byQueueShard = new Map<number, typeof items>();
    for (const item of items) {
      let list = byQueueShard.get(item.queueShardIdx);
      if (!list) {
        list = [];
        byQueueShard.set(item.queueShardIdx, list);
      }
      list.push(item);
    }

    // Acquire shard locks first, then processing lock
    for (const [queueShardIdx, shardItems] of byQueueShard) {
      await withWriteLock(ctx.shardLocks[queueShardIdx], async () => {
        await withWriteLock(ctx.processingLocks[procIdx], () => {
          for (const { jobId } of shardItems) {
            const job = ctx.processingShards[procIdx].get(jobId);
            if (!job) continue;
            released += releaseJobToQueue({ jobId, job, procIdx, queueShardIdx, ctx, now });
          }
        });
      });
    }
  }

  // Clear client tracking
  ctx.clientJobs.delete(clientId);

  return released;
}

/** Options for releasing a job back to queue */
interface ReleaseJobOptions {
  jobId: JobId;
  job: Job;
  procIdx: number;
  queueShardIdx: number;
  ctx: LockContext;
  now: number;
}

/** Release a single job back to queue */
function releaseJobToQueue(opts: ReleaseJobOptions): number {
  const { jobId, job, procIdx, queueShardIdx, ctx, now } = opts;
  const shard = ctx.shards[queueShardIdx];

  // Remove from processing
  ctx.processingShards[procIdx].delete(jobId);

  // Release lock if exists
  ctx.jobLocks.delete(jobId);

  // Release all job resources (concurrency, uniqueKey, groupId)
  shard.releaseJobResources(job.queue, job.uniqueKey, job.groupId);

  // Discard cron jobs with preventOverlap instead of re-queuing (#73).
  // The cron scheduler will re-create them at the next scheduled tick.
  // Re-queuing them causes the "starts right away on reconnect" bug.
  if (job.uniqueKey?.startsWith('cron:')) {
    ctx.jobIndex.delete(jobId);
    ctx.storage?.deleteJob(jobId);
    return 1;
  }

  // Reset job state for retry
  job.startedAt = null;
  job.lastHeartbeat = now;

  // Re-queue the job
  shard.getQueue(job.queue).push(job);
  const isDelayed = job.runAt > now;
  shard.incrementQueued(jobId, isDelayed, job.createdAt, job.queue, job.runAt);
  ctx.jobIndex.set(jobId, { type: 'queue', shardIdx: queueShardIdx, queueName: job.queue });

  return 1;
}
