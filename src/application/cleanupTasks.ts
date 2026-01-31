/**
 * Cleanup Tasks - Periodic maintenance and garbage collection
 * Handles orphaned entries, stale data, and memory management
 */

import type { Job, JobId } from '../domain/types/job';
import { queueLog } from '../shared/logger';
import { processingShardIndex, SHARD_COUNT } from '../shared/hash';
import type { BackgroundContext } from './types';

/**
 * Main cleanup function - called periodically to maintain system health
 * Cleans orphaned entries, stale data, and manages memory
 */
export function cleanup(ctx: BackgroundContext): void {
  const now = Date.now();
  const stallTimeout = 30 * 60 * 1000; // 30 minutes max for processing

  // Refresh delayed counters
  for (let i = 0; i < SHARD_COUNT; i++) {
    ctx.shards[i].refreshDelayedCount(now);
  }

  // Compact priority queues if stale ratio > 20%
  for (let i = 0; i < SHARD_COUNT; i++) {
    for (const q of ctx.shards[i].queues.values()) {
      if (q.needsCompaction(0.2)) {
        q.compact();
      }
    }
  }

  cleanOrphanedProcessingEntries(ctx, now, stallTimeout);
  cleanStaleWaitingDependencies(ctx, now);
  cleanUniqueKeysAndGroups(ctx);
  cleanStalledCandidates(ctx);
  cleanOrphanedJobIndex(ctx);
  cleanOrphanedJobLocks(ctx);
  cleanEmptyQueues(ctx);
}

function cleanOrphanedProcessingEntries(
  ctx: BackgroundContext,
  now: number,
  stallTimeout: number
): void {
  for (let i = 0; i < SHARD_COUNT; i++) {
    const orphaned: JobId[] = [];
    for (const [jobId, job] of ctx.processingShards[i]) {
      if (job.startedAt && now - job.startedAt > stallTimeout) {
        orphaned.push(jobId);
      }
    }
    for (const jobId of orphaned) {
      const job = ctx.processingShards[i].get(jobId);
      if (job) {
        ctx.processingShards[i].delete(jobId);
        ctx.jobIndex.delete(jobId);
        queueLog.warn('Cleaned orphaned processing job', { jobId: String(jobId) });
      }
    }
  }
}

function cleanStaleWaitingDependencies(ctx: BackgroundContext, now: number): void {
  const depTimeout = 60 * 60 * 1000; // 1 hour

  for (let i = 0; i < SHARD_COUNT; i++) {
    const shard = ctx.shards[i];
    const stale: Job[] = [];
    for (const [_id, job] of shard.waitingDeps) {
      if (now - job.createdAt > depTimeout) {
        stale.push(job);
      }
    }
    for (const job of stale) {
      shard.waitingDeps.delete(job.id);
      shard.unregisterDependencies(job.id, job.dependsOn);
      ctx.jobIndex.delete(job.id);
      queueLog.warn('Cleaned stale waiting dependency', { jobId: String(job.id) });
    }
  }
}

function cleanUniqueKeysAndGroups(ctx: BackgroundContext): void {
  for (let i = 0; i < SHARD_COUNT; i++) {
    const shard = ctx.shards[i];

    // Clean expired unique keys
    const expiredCleaned = shard.cleanExpiredUniqueKeys();
    if (expiredCleaned > 0) {
      queueLog.info('Cleaned expired unique keys', { shard: i, removed: expiredCleaned });
    }

    // Trim if too many keys remain
    for (const [queueName, keys] of shard.uniqueKeys) {
      if (keys.size > 1000) {
        const toRemove = Math.floor(keys.size / 2);
        const iter = keys.keys();
        for (let j = 0; j < toRemove; j++) {
          const { value, done } = iter.next();
          if (done) break;
          keys.delete(value);
        }
        queueLog.info('Trimmed unique keys', { queue: queueName, removed: toRemove });
      }
    }

    // Clean orphaned active groups
    for (const [queueName, groups] of shard.activeGroups) {
      if (groups.size > 1000) {
        const toRemove = Math.floor(groups.size / 2);
        const iter = groups.values();
        for (let j = 0; j < toRemove; j++) {
          const { value, done } = iter.next();
          if (done) break;
          groups.delete(value);
        }
        queueLog.info('Trimmed active groups', { queue: queueName, removed: toRemove });
      }
    }
  }
}

function cleanStalledCandidates(ctx: BackgroundContext): void {
  for (const jobId of ctx.stalledCandidates) {
    const loc = ctx.jobIndex.get(jobId);
    if (loc?.type !== 'processing') {
      ctx.stalledCandidates.delete(jobId);
    }
  }
}

function cleanOrphanedJobIndex(ctx: BackgroundContext): void {
  // Expensive operation - only run when index is large
  if (ctx.jobIndex.size <= 100_000) return;

  let orphanedCount = 0;
  for (const [jobId, loc] of ctx.jobIndex) {
    if (loc.type === 'processing') {
      const procIdx = processingShardIndex(String(jobId));
      if (!ctx.processingShards[procIdx].has(jobId)) {
        ctx.jobIndex.delete(jobId);
        orphanedCount++;
      }
    } else if (loc.type === 'queue') {
      const shard = ctx.shards[loc.shardIdx];
      if (!shard.getQueue(loc.queueName).has(jobId)) {
        ctx.jobIndex.delete(jobId);
        orphanedCount++;
      }
    }
  }
  if (orphanedCount > 0) {
    queueLog.info('Cleaned orphaned jobIndex entries', { count: orphanedCount });
  }
}

function cleanOrphanedJobLocks(ctx: BackgroundContext): void {
  for (const jobId of ctx.jobLocks.keys()) {
    const loc = ctx.jobIndex.get(jobId);
    if (loc?.type !== 'processing') {
      ctx.jobLocks.delete(jobId);
    }
  }
}

function cleanEmptyQueues(ctx: BackgroundContext): void {
  for (let i = 0; i < SHARD_COUNT; i++) {
    const shard = ctx.shards[i];
    const emptyQueues: string[] = [];

    for (const [queueName, queue] of shard.queues) {
      const dlqEntries = shard.dlq.get(queueName);
      if (queue.size === 0 && (!dlqEntries || dlqEntries.length === 0)) {
        emptyQueues.push(queueName);
      }
    }

    for (const queueName of emptyQueues) {
      shard.queues.delete(queueName);
      shard.dlq.delete(queueName);
      shard.uniqueKeys.delete(queueName);
      shard.queueState.delete(queueName);
      shard.activeGroups.delete(queueName);
      shard.rateLimiters.delete(queueName);
      shard.concurrencyLimiters.delete(queueName);
      shard.stallConfig.delete(queueName);
      shard.dlqConfig.delete(queueName);
      ctx.unregisterQueueName(queueName);
    }

    if (emptyQueues.length > 0) {
      queueLog.info('Removed empty queues', { shard: i, count: emptyQueues.length });
    }

    // Clean orphaned temporal index entries
    const cleanedTemporal = shard.cleanOrphanedTemporalEntries();
    if (cleanedTemporal > 0) {
      queueLog.info('Cleaned orphaned temporal entries', { shard: i, count: cleanedTemporal });
    }
  }
}
