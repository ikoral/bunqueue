/**
 * Query Operations
 * Get job, get result, get progress
 */

import type { Job, JobId } from '../../domain/types/job';
import { JobState } from '../../domain/types/job';
import type { JobLocation } from '../../domain/types/queue';
import type { Shard } from '../../domain/queue/shard';
import type { SqliteStorage } from '../../infrastructure/persistence/sqlite';
import { type RWLock, withReadLock } from '../../shared/lock';
import type { SetLike, MapLike } from '../../shared/lru';

/** Context for query operations */
export interface QueryContext {
  storage: SqliteStorage | null;
  shards: Shard[];
  shardLocks: RWLock[];
  processingShards: Map<JobId, Job>[];
  processingLocks: RWLock[];
  jobIndex: Map<JobId, JobLocation>;
  completedJobs: SetLike<JobId>;
  completedJobsData: MapLike<JobId, Job>;
  jobResults: MapLike<JobId, unknown>;
  customIdMap: MapLike<string, JobId>;
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
      return ctx.storage?.getJob(jobId) ?? ctx.completedJobsData.get(jobId) ?? null;
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

/** Extended context for getJobs (needs SHARD_COUNT) */
export interface GetJobsContext extends QueryContext {
  shardCount: number;
}

/** Get job state by ID */
export async function getJobState(jobId: JobId, ctx: QueryContext): Promise<JobState | 'unknown'> {
  const location = ctx.jobIndex.get(jobId);

  // Check completed set first (fast path)
  if (ctx.completedJobs.has(jobId)) {
    return JobState.Completed;
  }

  if (!location) {
    return 'unknown';
  }

  switch (location.type) {
    case 'queue': {
      // Check if job is delayed or waiting
      const job = await withReadLock(ctx.shardLocks[location.shardIdx], () => {
        return ctx.shards[location.shardIdx].getQueue(location.queueName).find(jobId);
      });
      if (!job) return 'unknown';
      const now = Date.now();
      return job.runAt > now ? JobState.Delayed : JobState.Waiting;
    }
    case 'processing':
      return JobState.Active;
    case 'completed':
      return JobState.Completed;
    case 'dlq':
      return JobState.Failed;
  }
}

/** Collect completed jobs for a queue from index + storage */
function collectCompletedJobs(queue: string, ctx: GetJobsContext): Job[] {
  const jobs: Job[] = [];
  for (const [jobId, location] of ctx.jobIndex) {
    if (location.type === 'completed') {
      const job = ctx.storage?.getJob(jobId) ?? ctx.completedJobsData?.get(jobId) ?? null;
      if (job?.queue === queue) {
        jobs.push(job);
      }
    }
  }
  return jobs;
}

/** Get jobs from queue with filters */
export function getJobs(
  queue: string,
  shardIdx: number,
  options: {
    state?: 'waiting' | 'delayed' | 'active' | 'completed' | 'failed';
    start?: number;
    end?: number;
    asc?: boolean;
  },
  ctx: GetJobsContext
): Job[] {
  const { state, start = 0, end = 100, asc = true } = options;
  const shard = ctx.shards[shardIdx];
  const now = Date.now();
  const jobs: Job[] = [];

  if (!state || state === 'waiting') {
    jobs.push(
      ...shard
        .getQueue(queue)
        .values()
        .filter((j) => j.runAt <= now)
    );
  }
  if (!state || state === 'delayed') {
    jobs.push(
      ...shard
        .getQueue(queue)
        .values()
        .filter((j) => j.runAt > now)
    );
  }
  if (!state || state === 'active') {
    for (let i = 0; i < ctx.shardCount; i++) {
      for (const job of ctx.processingShards[i].values()) {
        if (job.queue === queue) jobs.push(job);
      }
    }
  }
  if (!state || state === 'failed') {
    jobs.push(...shard.getDlq(queue));
  }
  if (!state || state === 'completed') {
    jobs.push(...collectCompletedJobs(queue, ctx));
  }

  jobs.sort((a, b) => (asc ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
  return jobs.slice(start, end);
}
