/**
 * Query Operations
 * Get job, get result, get progress
 */

import type { Job, JobId } from '../../domain/types/job';
import type { JobLocation } from '../../domain/types/queue';
import type { Shard } from '../../domain/queue/shard';
import type { SqliteStorage } from '../../infrastructure/persistence/sqlite';
import { type RWLock, withReadLock } from '../../shared/lock';

/** Context for query operations */
export interface QueryContext {
  storage: SqliteStorage | null;
  shards: Shard[];
  shardLocks: RWLock[];
  processingShards: Map<JobId, Job>[];
  processingLocks: RWLock[];
  jobIndex: Map<JobId, JobLocation>;
  completedJobs: Set<JobId>;
  jobResults: Map<JobId, unknown>;
  customIdMap: Map<string, JobId>;
}

/** Get job by ID */
export async function getJob(jobId: JobId, ctx: QueryContext): Promise<Job | null> {
  const location = ctx.jobIndex.get(jobId);
  if (!location) return null;

  switch (location.type) {
    case 'queue': {
      return await withReadLock(ctx.shardLocks[location.shardIdx], () => {
        return ctx.shards[location.shardIdx].getQueue(location.queueName).find(jobId);
      });
    }
    case 'processing': {
      return await withReadLock(ctx.processingLocks[location.shardIdx], () => {
        return ctx.processingShards[location.shardIdx].get(jobId) ?? null;
      });
    }
    case 'completed':
    case 'dlq':
      return ctx.storage?.getJob(jobId) ?? null;
  }
}

/** Get job result */
export function getJobResult(jobId: JobId, ctx: QueryContext): unknown {
  return ctx.jobResults.get(jobId) ?? ctx.storage?.getResult(jobId);
}

/** Get job by custom ID */
export function getJobByCustomId(customId: string, ctx: QueryContext): Job | null {
  const jobId = ctx.customIdMap.get(customId);
  if (!jobId) return null;

  const location = ctx.jobIndex.get(jobId);
  if (!location) return null;

  if (location.type === 'queue') {
    return ctx.shards[location.shardIdx].getQueue(location.queueName).find(jobId);
  }
  if (location.type === 'processing') {
    return ctx.processingShards[location.shardIdx].get(jobId) ?? null;
  }
  return null;
}

/** Get job progress */
export function getJobProgress(
  jobId: JobId,
  ctx: QueryContext
): { progress: number; message: string | null } | null {
  const location = ctx.jobIndex.get(jobId);
  if (location?.type !== 'processing') return null;

  const job = ctx.processingShards[location.shardIdx].get(jobId);
  if (!job) return null;

  return { progress: job.progress, message: job.progressMessage };
}
