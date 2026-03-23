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
import { shardIndex } from '../../shared/hash';

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
        const shard = ctx.shards[location.shardIdx];
        return (
          shard.getQueue(location.queueName).find(jobId) ?? shard.waitingDeps.get(jobId) ?? null
        );
      });
    }
    case 'processing': {
      return await withReadLock(ctx.processingLocks[location.shardIdx], () => {
        return ctx.processingShards[location.shardIdx].get(jobId) ?? null;
      });
    }
    case 'completed':
      return ctx.storage?.getJob(jobId) ?? ctx.completedJobsData.get(jobId) ?? null;
    case 'dlq': {
      if (ctx.storage) {
        const job = ctx.storage.getJob(jobId);
        if (job) return job;
      }
      const dlqShardIdx = shardIndex(location.queueName);
      const dlqJobs = ctx.shards[dlqShardIdx].getDlq(location.queueName);
      return dlqJobs.find((j) => j.id === jobId) ?? null;
    }
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
    const shard = ctx.shards[location.shardIdx];
    return shard.getQueue(location.queueName).find(jobId) ?? shard.waitingDeps.get(jobId) ?? null;
  }
  if (location.type === 'processing') {
    return ctx.processingShards[location.shardIdx].get(jobId) ?? null;
  }
  if (location.type === 'completed') {
    return ctx.storage?.getJob(jobId) ?? ctx.completedJobsData.get(jobId) ?? null;
  }
  if (location.type === 'dlq') {
    if (ctx.storage) {
      const job = ctx.storage.getJob(jobId);
      if (job) return job;
    }
    const dlqShardIdx = shardIndex(location.queueName);
    const dlqJobs = ctx.shards[dlqShardIdx].getDlq(location.queueName);
    return dlqJobs.find((j) => j.id === jobId) ?? null;
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
      // Check if job is delayed, waiting, or waiting for children/deps
      const result = await withReadLock(ctx.shardLocks[location.shardIdx], () => {
        const shard = ctx.shards[location.shardIdx];
        const queueJob = shard.getQueue(location.queueName).find(jobId);
        if (queueJob) return { job: queueJob, waitingDeps: false, waitingChildren: false };
        const depsJob = shard.waitingDeps.get(jobId);
        if (depsJob) return { job: depsJob, waitingDeps: true, waitingChildren: false };
        const childrenJob = shard.waitingChildren.get(jobId);
        if (childrenJob) return { job: childrenJob, waitingDeps: false, waitingChildren: true };
        return null;
      });
      if (!result) return 'unknown';
      if (result.waitingDeps || result.waitingChildren) return 'waiting-children' as JobState;
      const now = Date.now();
      if (result.job.runAt > now) return JobState.Delayed;
      return result.job.priority > 0 ? JobState.Prioritized : JobState.Waiting;
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
function collectCompletedJobs(queue: string, ctx: GetJobsContext, maxCollect: number): Job[] {
  const jobs: Job[] = [];
  for (const [jId, location] of ctx.jobIndex) {
    if (location.type === 'completed' && location.queueName === queue) {
      const job = ctx.storage?.getJob(jId) ?? ctx.completedJobsData?.get(jId) ?? null;
      if (job) {
        jobs.push(job);
        if (jobs.length >= maxCollect) break;
      }
    }
  }
  return jobs;
}

/** Collect active jobs for a queue across all processing shards */
function collectActiveJobs(
  queue: string,
  shardIdx: number,
  ctx: GetJobsContext,
  maxCollect: number
): Job[] {
  const jobs: Job[] = [];
  // Own shard first (most likely location)
  for (const job of ctx.processingShards[shardIdx].values()) {
    if (job.queue === queue) jobs.push(job);
    if (jobs.length >= maxCollect) return jobs;
  }
  // Other shards
  for (let i = 0; i < ctx.shardCount; i++) {
    if (i === shardIdx) continue;
    for (const job of ctx.processingShards[i].values()) {
      if (job.queue === queue) jobs.push(job);
      if (jobs.length >= maxCollect) return jobs;
    }
  }
  return jobs;
}

/** Collect waiting/delayed/prioritized jobs in a single pass */
function collectTemporalJobs(
  shard: Shard,
  queue: string,
  needs: { waiting: boolean; prioritized: boolean; delayed: boolean },
  maxCollect: number
): Job[] {
  const { waiting: needWaiting, prioritized: needPrioritized, delayed: needDelayed } = needs;
  const now = Date.now();
  const jobs: Job[] = [];
  for (const j of shard.getQueue(queue).values()) {
    if (jobs.length >= maxCollect) break;
    const isDelayed = j.runAt > now;
    if (isDelayed && needDelayed) {
      jobs.push(j);
    } else if (!isDelayed) {
      // BullMQ v5: priority>0 → "prioritized", priority=0 → "waiting"
      if (j.priority > 0 ? needPrioritized : needWaiting) {
        jobs.push(j);
      }
    }
  }
  return jobs;
}

/** Collect jobs from in-memory structures by state filter */
function collectJobsByState(
  queue: string,
  shardIdx: number,
  states: string[] | null,
  ctx: GetJobsContext
): Job[] {
  const shard = ctx.shards[shardIdx];
  const jobs: Job[] = [];
  const needWaiting = !states || states.includes('waiting');
  const needPrioritized = !states || states.includes('prioritized');
  const needDelayed = !states || states.includes('delayed');

  if (needWaiting || needPrioritized || needDelayed) {
    jobs.push(
      ...collectTemporalJobs(
        shard,
        queue,
        { waiting: needWaiting, prioritized: needPrioritized, delayed: needDelayed },
        Infinity
      )
    );
  }
  if (!states || states.includes('active')) {
    jobs.push(...collectActiveJobs(queue, shardIdx, ctx, Infinity));
  }
  if (!states || states.includes('failed')) {
    jobs.push(...shard.getDlq(queue));
  }
  if (!states || states.includes('completed')) {
    jobs.push(...collectCompletedJobs(queue, ctx, Infinity));
  }
  if (!states || states.includes('waiting-children')) {
    // Collect jobs waiting for deps or children to complete
    for (const job of shard.waitingDeps.values()) {
      if (job.queue === queue) jobs.push(job);
    }
    for (const job of shard.waitingChildren.values()) {
      if (job.queue === queue) jobs.push(job);
    }
  }
  return jobs;
}

/** Collect waiting-children jobs from in-memory shard maps */
function collectWaitingChildrenJobs(shard: Shard, queue: string): Job[] {
  const jobs: Job[] = [];
  for (const job of shard.waitingDeps.values()) {
    if (job.queue === queue) jobs.push(job);
  }
  for (const job of shard.waitingChildren.values()) {
    if (job.queue === queue) jobs.push(job);
  }
  return jobs;
}

/** Query SQLite with priority/waiting translation */
function querySqliteWithPriority(
  storage: NonNullable<GetJobsContext['storage']>,
  queue: string,
  sqlFilteredStates: string[],
  opts: { limit: number; offset: number; asc: boolean }
): Job[] {
  const hasPrioritized = sqlFilteredStates.includes('prioritized');
  const hasWaiting = sqlFilteredStates.includes('waiting');

  if (!hasPrioritized && !hasWaiting) {
    if (sqlFilteredStates.length === 1) {
      return storage.queryJobs(queue, { state: sqlFilteredStates[0], ...opts });
    }
    return storage.queryJobs(queue, { states: sqlFilteredStates, ...opts });
  }

  // Map 'prioritized' to 'waiting' for SQLite, then post-filter by priority
  const sqlStates = sqlFilteredStates
    .map((s) => (s === 'prioritized' ? 'waiting' : s))
    .filter((s, i, arr) => arr.indexOf(s) === i);

  const overFetchOpts = { ...opts, limit: opts.limit * 2 };
  let jobs =
    sqlStates.length === 1
      ? storage.queryJobs(queue, { state: sqlStates[0], ...overFetchOpts })
      : storage.queryJobs(queue, { states: sqlStates, ...overFetchOpts });

  if (hasPrioritized && !hasWaiting) {
    jobs = jobs.filter((j) => j.priority > 0);
  } else if (hasWaiting && !hasPrioritized) {
    jobs = jobs.filter((j) => j.priority <= 0);
  }
  return jobs.slice(0, opts.limit);
}

/** Get jobs from queue with filters */
export function getJobs(
  queue: string,
  shardIdx: number,
  options: {
    state?: string | string[];
    start?: number;
    end?: number;
    asc?: boolean;
  },
  ctx: GetJobsContext
): Job[] {
  const { state, start = 0, end = 100, asc = true } = options;

  const states = !state
    ? null
    : Array.isArray(state)
      ? state.length === 0
        ? null
        : state
      : [state];

  const limit = end - start;

  if (ctx.storage) {
    if (!states) {
      return ctx.storage.queryJobs(queue, { limit, offset: start, asc });
    }

    const hasWaitingChildren = states.includes('waiting-children');
    const sqlFilteredStates = states.filter((s) => s !== 'waiting-children');

    // Only waiting-children: collect from in-memory
    if (hasWaitingChildren && sqlFilteredStates.length === 0) {
      const jobs = collectWaitingChildrenJobs(ctx.shards[shardIdx], queue);
      jobs.sort((a, b) => (asc ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
      return jobs.slice(start, end);
    }

    const jobs =
      sqlFilteredStates.length > 0
        ? querySqliteWithPriority(ctx.storage, queue, sqlFilteredStates, {
            limit,
            offset: start,
            asc,
          })
        : [];

    if (!hasWaitingChildren) return jobs;

    const merged = jobs.concat(collectWaitingChildrenJobs(ctx.shards[shardIdx], queue));
    merged.sort((a, b) => (asc ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
    return merged.slice(0, limit);
  }

  // In-memory path (embedded mode only)
  const jobs = collectJobsByState(queue, shardIdx, states, ctx);
  jobs.sort((a, b) => (asc ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
  return jobs.slice(start, end);
}
