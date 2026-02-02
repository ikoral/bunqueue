/**
 * Background Tasks - Periodic maintenance operations
 * Orchestrates stall detection, cleanup, recovery, DLQ maintenance
 */

import { queueLog } from '../shared/logger';
import { shardIndex } from '../shared/hash';
import { FailureReason } from '../domain/types/dlq';
import * as dlqOps from './dlqManager';
import { checkExpiredLocks } from './lockManager';
import { cleanup } from './cleanupTasks';
import { checkStalledJobs } from './stallDetection';
import { processPendingDependencies } from './dependencyProcessor';
import type { BackgroundContext, LockContext } from './types';
import type { CronScheduler } from '../infrastructure/scheduler/cronScheduler';

// ============ Error Tracking ============

/** Maximum consecutive failures before critical warning */
const MAX_CONSECUTIVE_FAILURES = 5;

/** Track consecutive failures per task type */
interface TaskErrorState {
  consecutiveFailures: number;
  lastError?: string;
  lastFailureAt?: number;
}

const taskErrors: Record<string, TaskErrorState> = {
  cleanup: { consecutiveFailures: 0 },
  dependency: { consecutiveFailures: 0 },
  lockExpiration: { consecutiveFailures: 0 },
};

/**
 * Handle task error with tracking and circuit breaker pattern
 */
function handleTaskError(taskName: string, err: unknown): void {
  const state = taskErrors[taskName];
  if (!state) return;

  state.consecutiveFailures++;
  state.lastError = String(err);
  state.lastFailureAt = Date.now();

  queueLog.error(`${taskName} task failed`, {
    error: state.lastError,
    consecutiveFailures: state.consecutiveFailures,
    willRetry: state.consecutiveFailures < MAX_CONSECUTIVE_FAILURES,
  });

  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    queueLog.error(`CRITICAL: Background ${taskName} repeatedly failing`, {
      consecutiveFailures: state.consecutiveFailures,
      lastError: state.lastError,
    });
  }
}

/**
 * Reset error state on successful task completion
 */
function handleTaskSuccess(taskName: string): void {
  const state = taskErrors[taskName];
  if (state) {
    state.consecutiveFailures = 0;
  }
}

/**
 * Get error statistics for monitoring
 */
export function getTaskErrorStats(): Record<string, TaskErrorState> {
  return { ...taskErrors };
}

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
    cleanup(ctx)
      .then(() => {
        handleTaskSuccess('cleanup');
      })
      .catch((err: unknown) => {
        handleTaskError('cleanup', err);
      });
  }, ctx.config.cleanupIntervalMs);

  const timeoutInterval = setInterval(() => {
    checkJobTimeouts(ctx);
  }, ctx.config.jobTimeoutCheckMs);

  const depCheckInterval = setInterval(() => {
    processPendingDependencies(ctx)
      .then(() => {
        handleTaskSuccess('dependency');
      })
      .catch((err: unknown) => {
        handleTaskError('dependency', err);
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
    checkExpiredLocks(getLockContext(ctx))
      .then(() => {
        handleTaskSuccess('lockExpiration');
      })
      .catch((err: unknown) => {
        handleTaskError('lockExpiration', err);
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

/** Batch size for paginated recovery */
const RECOVERY_BATCH_SIZE = 10000;

// eslint-disable-next-line complexity
export function recover(ctx: BackgroundContext): void {
  if (!ctx.storage) return;

  // Load completed job IDs from SQLite for dependency checking
  const completedInDb = ctx.storage.loadCompletedJobIds();

  const now = Date.now();

  // === PHASE 1: Recover active jobs (were processing when server stopped) ===
  // These jobs are considered "stalled" and need to be retried or moved to DLQ
  let totalActiveRecovered = 0;
  let activeOffset = 0;

  while (true) {
    const activeJobs = ctx.storage.loadActiveJobs(RECOVERY_BATCH_SIZE, activeOffset);
    if (activeJobs.length === 0) break;

    for (const job of activeJobs) {
      const idx = shardIndex(job.queue);
      const shard = ctx.shards[idx];
      const stallConfig = shard.getStallConfig(job.queue);

      // Increment stall count (job was interrupted)
      job.stallCount = (job.stallCount || 0) + 1;
      job.attempts++;
      job.startedAt = null;
      job.lastHeartbeat = now;

      // Check if exceeded max stalls
      const maxStalls = stallConfig.maxStalls ?? 3;
      if (job.stallCount >= maxStalls) {
        // Move to DLQ
        const entry = shard.addToDlq(
          job,
          FailureReason.Stalled,
          `Job stalled ${job.stallCount} times (recovered at startup)`
        );
        ctx.jobIndex.set(job.id, { type: 'dlq', queueName: job.queue });
        ctx.storage.saveDlqEntry(entry);
        ctx.storage.deleteJob(job.id);
        queueLog.warn('Recovered active job exceeded max stalls, moved to DLQ', {
          jobId: String(job.id),
          queue: job.queue,
          stallCount: job.stallCount,
        });
      } else {
        // Retry: put back in queue with backoff
        job.runAt = now + job.backoff * Math.pow(2, job.attempts - 1);
        shard.getQueue(job.queue).push(job);
        const isDelayed = job.runAt > now;
        shard.incrementQueued(job.id, isDelayed, job.createdAt, job.queue, job.runAt);
        ctx.jobIndex.set(job.id, { type: 'queue', shardIdx: idx, queueName: job.queue });
        ctx.storage.updateForRetry(job);
        queueLog.info('Recovered active job, retrying', {
          jobId: String(job.id),
          queue: job.queue,
          stallCount: job.stallCount,
          attempt: job.attempts,
        });
      }

      ctx.registerQueueName(job.queue);
    }

    totalActiveRecovered += activeJobs.length;
    activeOffset += activeJobs.length;
    if (activeJobs.length < RECOVERY_BATCH_SIZE) break;
  }

  if (totalActiveRecovered > 0) {
    queueLog.info('Recovered active jobs from previous session', { count: totalActiveRecovered });
  }

  // === PHASE 2: Load pending jobs ===
  let totalPendingLoaded = 0;
  let offset = 0;

  // Load pending jobs in batches to avoid memory spikes
  while (true) {
    const jobs = ctx.storage.loadPendingJobs(RECOVERY_BATCH_SIZE, offset);
    if (jobs.length === 0) break;

    for (const job of jobs) {
      const idx = shardIndex(job.queue);
      const shard = ctx.shards[idx];

      // Check if job has unmet dependencies
      // Check both in-memory completedJobs AND SQLite job_results table
      const hasDependencies = job.dependsOn && job.dependsOn.length > 0;
      const needsWaitingDeps =
        hasDependencies &&
        !job.dependsOn.every((depId) => ctx.completedJobs.has(depId) || completedInDb.has(depId));

      if (needsWaitingDeps) {
        // Job is waiting for dependencies - don't add to main queue
        shard.waitingDeps.set(job.id, job);
        shard.registerDependencies(job.id, job.dependsOn);
        // Note: don't call incrementQueued for waitingDeps jobs (matches push.ts behavior)
      } else {
        // Job is ready to process
        shard.getQueue(job.queue).push(job);
        // Update running counters for O(1) stats and temporal index
        const isDelayed = job.runAt > now;
        shard.incrementQueued(job.id, isDelayed, job.createdAt, job.queue, job.runAt);
      }

      ctx.jobIndex.set(job.id, { type: 'queue', shardIdx: idx, queueName: job.queue });

      // Restore customId mapping for deduplication (fixes idempotency on restart)
      if (job.customId) {
        ctx.customIdMap.set(job.customId, job.id);
      }

      // Restore uniqueKey mapping for TTL-based deduplication
      if (job.uniqueKey) {
        shard.registerUniqueKeyWithTtl(
          job.queue,
          job.uniqueKey,
          job.id,
          job.deduplicationTtl ?? undefined
        );
      }

      ctx.registerQueueName(job.queue);
    }

    totalPendingLoaded += jobs.length;
    offset += jobs.length;

    // If we got less than batch size, we're done
    if (jobs.length < RECOVERY_BATCH_SIZE) break;
  }

  if (totalPendingLoaded > 0) {
    queueLog.info('Loaded pending jobs', { count: totalPendingLoaded });
  }

  // Load DLQ entries
  const dlqEntries = ctx.storage.loadDlq();
  let dlqCount = 0;
  for (const [queue, entries] of dlqEntries) {
    const idx = shardIndex(queue);
    const shard = ctx.shards[idx];
    for (const entry of entries) {
      shard.restoreDlqEntry(queue, entry);
      dlqCount++;
    }
    ctx.registerQueueName(queue);
  }
  if (dlqCount > 0) {
    queueLog.info('Loaded DLQ entries', { count: dlqCount });
  }
}

// Re-export for backward compatibility
export { processPendingDependencies };
