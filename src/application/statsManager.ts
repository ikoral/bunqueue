/**
 * Stats Manager - Queue statistics and memory management
 * Provides system metrics and memory compaction utilities
 */

import { SHARD_COUNT } from '../shared/hash';
import { queueLog } from '../shared/logger';
import type { StatsContext } from './types';

export interface QueueStats {
  waiting: number;
  delayed: number;
  active: number;
  dlq: number;
  completed: number;
  totalPushed: bigint;
  totalPulled: bigint;
  totalCompleted: bigint;
  totalFailed: bigint;
  uptime: number;
  cronJobs: number;
  cronPending: number;
}

export interface MemoryStats {
  jobIndex: number;
  completedJobs: number;
  jobResults: number;
  jobLogs: number;
  customIdMap: number;
  jobLocks: number;
  clientJobs: number;
  clientJobsTotal: number;
  pendingDepChecks: number;
  stalledCandidates: number;
  processingTotal: number;
  queuedTotal: number;
  waitingDepsTotal: number;
  temporalIndexTotal: number;
  delayedHeapTotal: number;
}

/**
 * Get queue statistics - O(32) using running counters
 */
export function getStats(
  ctx: StatsContext,
  cronScheduler: { getStats(): { total: number; pending: number } }
): QueueStats {
  let waiting = 0,
    delayed = 0,
    active = 0,
    dlq = 0;

  // O(32) instead of O(n) - use running counters from each shard
  for (let i = 0; i < SHARD_COUNT; i++) {
    const shardStats = ctx.shards[i].getStats();
    const queuedTotal = shardStats.queuedJobs;
    const delayedInShard = shardStats.delayedJobs;

    // waiting = queued jobs that are not delayed
    waiting += Math.max(0, queuedTotal - delayedInShard);
    delayed += delayedInShard;
    dlq += shardStats.dlqJobs;
    active += ctx.processingShards[i].size;
  }

  const cronStats = cronScheduler.getStats();
  return {
    waiting,
    delayed,
    active,
    dlq,
    completed: ctx.completedJobs.size,
    totalPushed: ctx.metrics.totalPushed.value,
    totalPulled: ctx.metrics.totalPulled.value,
    totalCompleted: ctx.metrics.totalCompleted.value,
    totalFailed: ctx.metrics.totalFailed.value,
    uptime: Date.now() - ctx.startTime,
    cronJobs: cronStats.total,
    cronPending: cronStats.pending,
  };
}

/**
 * Get detailed memory statistics for debugging memory issues.
 * Returns counts of entries in all major collections.
 */
export function getMemoryStats(ctx: StatsContext): MemoryStats {
  let processingTotal = 0;
  let queuedTotal = 0;
  let waitingDepsTotal = 0;
  let temporalIndexTotal = 0;
  let delayedHeapTotal = 0;

  for (let i = 0; i < SHARD_COUNT; i++) {
    processingTotal += ctx.processingShards[i].size;
    const shardStats = ctx.shards[i].getStats();
    queuedTotal += shardStats.queuedJobs;
    waitingDepsTotal += ctx.shards[i].waitingDeps.size;
    // Get internal structure sizes
    const internalSizes = ctx.shards[i].getInternalSizes();
    temporalIndexTotal += internalSizes.temporalIndex;
    delayedHeapTotal += internalSizes.delayedHeap;
  }

  // Count total jobs across all clients
  let clientJobsTotal = 0;
  for (const jobs of ctx.clientJobs.values()) {
    clientJobsTotal += jobs.size;
  }

  return {
    jobIndex: ctx.jobIndex.size,
    completedJobs: ctx.completedJobs.size,
    jobResults: ctx.jobResults.size,
    jobLogs: ctx.jobLogs.size,
    customIdMap: ctx.customIdMap.size,
    jobLocks: ctx.jobLocks.size,
    clientJobs: ctx.clientJobs.size,
    clientJobsTotal,
    pendingDepChecks: ctx.pendingDepChecks.size,
    stalledCandidates: ctx.stalledCandidates.size,
    processingTotal,
    queuedTotal,
    waitingDepsTotal,
    temporalIndexTotal,
    delayedHeapTotal,
  };
}

/**
 * Force compact all collections to reduce memory usage.
 * Use after large batch operations or when memory pressure is high.
 */
export function compactMemory(ctx: StatsContext): void {
  // Compact priority queues that have high stale ratios
  for (let i = 0; i < SHARD_COUNT; i++) {
    for (const q of ctx.shards[i].queues.values()) {
      if (q.needsCompaction(0.1)) {
        // More aggressive: 10% stale threshold
        q.compact();
      }
    }
  }

  // Clean up empty client tracking entries
  for (const [clientId, jobs] of ctx.clientJobs) {
    if (jobs.size === 0) {
      ctx.clientJobs.delete(clientId);
    }
  }

  // Clean orphaned job locks (jobs no longer in processing)
  for (const jobId of ctx.jobLocks.keys()) {
    const loc = ctx.jobIndex.get(jobId);
    if (loc?.type !== 'processing') {
      ctx.jobLocks.delete(jobId);
    }
  }

  queueLog.info('Memory compacted');
}
