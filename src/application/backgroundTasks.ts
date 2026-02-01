/**
 * Background Tasks - Periodic maintenance operations
 * Orchestrates stall detection, cleanup, recovery, DLQ maintenance
 */

import { queueLog } from '../shared/logger';
import { shardIndex } from '../shared/hash';
import * as dlqOps from './dlqManager';
import { checkExpiredLocks } from './lockManager';
import { cleanup } from './cleanupTasks';
import { checkStalledJobs } from './stallDetection';
import { processPendingDependencies } from './dependencyProcessor';
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
    cleanup(ctx).catch((err: unknown) => {
      queueLog.error('Cleanup task failed', { error: String(err) });
    });
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
