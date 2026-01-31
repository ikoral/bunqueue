/**
 * Lock Manager - Job lock and client tracking
 * Handles BullMQ-style lock-based job ownership
 */

import type { JobId, JobLock, LockToken } from '../domain/types/job';
import { createJobLock, isLockExpired, renewLock, DEFAULT_LOCK_TTL } from '../domain/types/job';
import { FailureReason } from '../domain/types/dlq';
import { EventType } from '../domain/types/queue';
import { queueLog } from '../shared/logger';
import { shardIndex, processingShardIndex } from '../shared/hash';
import { withWriteLock } from '../shared/lock';
import type { LockContext } from './types';

// ============ Lock Creation & Verification ============

/**
 * Create a lock for a job when it's pulled for processing.
 * @returns The lock token, or null if job not in processing
 */
export function createLock(
  jobId: JobId,
  owner: string,
  ctx: LockContext,
  ttl: number = DEFAULT_LOCK_TTL
): LockToken | null {
  const loc = ctx.jobIndex.get(jobId);
  if (loc?.type !== 'processing') return null;

  // Check if lock already exists (shouldn't happen, but defensive)
  if (ctx.jobLocks.has(jobId)) {
    queueLog.warn('Lock already exists for job', { jobId: String(jobId), owner });
    return null;
  }

  const lock = createJobLock(jobId, owner, ttl);
  ctx.jobLocks.set(jobId, lock);
  return lock.token;
}

/**
 * Verify that a token is valid for a job.
 * @returns true if token matches the active lock
 */
export function verifyLock(jobId: JobId, token: string, ctx: LockContext): boolean {
  const lock = ctx.jobLocks.get(jobId);
  if (!lock) return false;
  if (lock.token !== token) return false;
  if (isLockExpired(lock)) return false;
  return true;
}

/**
 * Renew a lock with the given token.
 * @returns true if renewal succeeded, false if token invalid or lock expired
 */
export function renewJobLock(
  jobId: JobId,
  token: string,
  ctx: LockContext,
  newTtl?: number
): boolean {
  const lock = ctx.jobLocks.get(jobId);
  if (!lock) return false;
  if (lock.token !== token) return false;
  if (isLockExpired(lock)) {
    // Lock already expired, remove it
    ctx.jobLocks.delete(jobId);
    return false;
  }

  renewLock(lock, newTtl);

  // Also update lastHeartbeat on the job (for legacy stall detection compatibility)
  const loc = ctx.jobIndex.get(jobId);
  if (loc?.type === 'processing') {
    const job = ctx.processingShards[loc.shardIdx].get(jobId);
    if (job) job.lastHeartbeat = Date.now();
  }

  return true;
}

/**
 * Renew locks for multiple jobs (batch operation).
 * @returns Array of jobIds that were successfully renewed
 */
export function renewJobLockBatch(
  items: Array<{ id: JobId; token: string; ttl?: number }>,
  ctx: LockContext
): string[] {
  const renewed: string[] = [];
  for (const item of items) {
    if (renewJobLock(item.id, item.token, ctx, item.ttl)) {
      renewed.push(String(item.id));
    }
  }
  return renewed;
}

/**
 * Release a lock when job is completed or failed.
 * Should be called by ACK/FAIL operations.
 */
export function releaseLock(jobId: JobId, ctx: LockContext, token?: string): boolean {
  const lock = ctx.jobLocks.get(jobId);
  if (!lock) return true; // No lock to release

  // If token provided, verify it matches
  if (token && lock.token !== token) {
    queueLog.warn('Token mismatch on lock release', {
      jobId: String(jobId),
      expected: lock.token.substring(0, 8),
      got: token.substring(0, 8),
    });
    return false;
  }

  ctx.jobLocks.delete(jobId);
  return true;
}

/**
 * Get lock info for a job (for debugging/monitoring).
 */
export function getLockInfo(jobId: JobId, ctx: LockContext): JobLock | null {
  return ctx.jobLocks.get(jobId) ?? null;
}

// ============ Client-Job Tracking ============

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
  for (const [procIdx, items] of byProcShard) {
    await withWriteLock(ctx.processingLocks[procIdx], async () => {
      for (const { jobId, queueShardIdx } of items) {
        const job = ctx.processingShards[procIdx].get(jobId);
        if (!job) continue;

        // Acquire shard lock for queue modifications
        await withWriteLock(ctx.shardLocks[queueShardIdx], () => {
          const shard = ctx.shards[queueShardIdx];

          // Remove from processing
          ctx.processingShards[procIdx].delete(jobId);

          // Release lock if exists
          ctx.jobLocks.delete(jobId);

          // Release concurrency
          shard.releaseConcurrency(job.queue);

          // Release group if active
          if (job.groupId) {
            shard.releaseGroup(job.queue, job.groupId);
          }

          // Reset job state for retry
          job.startedAt = null;
          job.lastHeartbeat = now;

          // Re-queue the job
          shard.getQueue(job.queue).push(job);
          const isDelayed = job.runAt > now;
          shard.incrementQueued(jobId, isDelayed, job.createdAt, job.queue, job.runAt);
          ctx.jobIndex.set(jobId, { type: 'queue', shardIdx: queueShardIdx, queueName: job.queue });

          released++;
        });
      }
    });
  }

  // Clear client tracking
  ctx.clientJobs.delete(clientId);

  if (released > 0) {
    queueLog.info('Released client jobs', { clientId: clientId.substring(0, 8), released });
  }

  return released;
}

// ============ Lock Expiration Check ============

/**
 * Check and handle expired locks.
 * Jobs with expired locks are requeued for retry.
 *
 * Uses proper locking to prevent race conditions.
 */
export async function checkExpiredLocks(ctx: LockContext): Promise<void> {
  const now = Date.now();

  // Phase 1: Collect expired locks (read-only)
  const expired: Array<{ jobId: JobId; lock: JobLock; procIdx: number }> = [];

  for (const [jobId, lock] of ctx.jobLocks) {
    if (isLockExpired(lock, now)) {
      const procIdx = processingShardIndex(String(jobId));
      expired.push({ jobId, lock, procIdx });
    }
  }

  if (expired.length === 0) return;

  // Phase 2: Group by processing shard
  const byProcShard = new Map<number, typeof expired>();
  for (const item of expired) {
    let list = byProcShard.get(item.procIdx);
    if (!list) {
      list = [];
      byProcShard.set(item.procIdx, list);
    }
    list.push(item);
  }

  // Phase 3: Process each shard with proper locking
  for (const [procIdx, items] of byProcShard) {
    await withWriteLock(ctx.processingLocks[procIdx], async () => {
      for (const { jobId, lock } of items) {
        const job = ctx.processingShards[procIdx].get(jobId);

        if (job) {
          const idx = shardIndex(job.queue);

          await withWriteLock(ctx.shardLocks[idx], () => {
            const shard = ctx.shards[idx];
            const queue = shard.getQueue(job.queue);

            // Remove from processing
            ctx.processingShards[procIdx].delete(jobId);

            // Increment attempts and reset state
            job.attempts++;
            job.startedAt = null;
            job.lastHeartbeat = now;
            job.stallCount++;

            // Check if max stalls exceeded
            const stallConfig = shard.getStallConfig(job.queue);
            if (stallConfig.maxStalls > 0 && job.stallCount >= stallConfig.maxStalls) {
              shard.addToDlq(
                job,
                FailureReason.Stalled,
                `Lock expired after ${lock.renewalCount} renewals`
              );
              ctx.jobIndex.set(jobId, { type: 'dlq', queueName: job.queue });

              queueLog.warn('Job moved to DLQ due to lock expiration', {
                jobId: String(jobId),
                queue: job.queue,
                owner: lock.owner,
                renewals: lock.renewalCount,
                stallCount: job.stallCount,
              });

              ctx.eventsManager.broadcast({
                eventType: EventType.Failed,
                jobId,
                queue: job.queue,
                timestamp: now,
                error: 'Lock expired (max stalls reached)',
              });
            } else {
              queue.push(job);
              ctx.jobIndex.set(jobId, { type: 'queue', shardIdx: idx, queueName: job.queue });

              queueLog.info('Job requeued due to lock expiration', {
                jobId: String(jobId),
                queue: job.queue,
                owner: lock.owner,
                renewals: lock.renewalCount,
                attempt: job.attempts,
              });

              ctx.eventsManager.broadcast({
                eventType: EventType.Stalled,
                jobId,
                queue: job.queue,
                timestamp: now,
              });
            }
          });
        }

        // Remove the expired lock
        ctx.jobLocks.delete(jobId);
      }
    });
  }

  queueLog.info('Processed expired locks', { count: expired.length });
}
