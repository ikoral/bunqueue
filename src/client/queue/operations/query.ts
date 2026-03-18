/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/switch-exhaustiveness-check */
/**
 * Queue Query Operations
 * getJob, getJobs, getJobState, getJobsAsync
 */

import { getSharedManager } from '../../manager';
import type { TcpConnectionPool } from '../../tcpPool';
import type {
  Job,
  JobStateType,
  GetDependenciesOpts,
  JobDependencies,
  JobDependenciesCount,
} from '../../types';
import { toPublicJob } from '../../types';
import { jobId } from '../../../domain/types/job';
import { createSimpleJob } from '../jobProxy';

interface QueryContext {
  name: string;
  embedded: boolean;
  tcp: TcpConnectionPool | null;
  getJobState: (id: string) => Promise<JobStateType>;
  removeAsync: (id: string) => Promise<void>;
  retryJob: (id: string) => Promise<void>;
  getChildrenValues: (id: string) => Promise<Record<string, unknown>>;
  // Extended context for toPublicJob
  updateJobData?: (id: string, data: unknown) => Promise<void>;
  promoteJob?: (id: string) => Promise<void>;
  changeJobDelay?: (id: string, delay: number) => Promise<void>;
  changeJobPriority?: (id: string, opts: { priority: number }) => Promise<void>;
  extendJobLock?: (id: string, token: string, duration: number) => Promise<number>;
  clearJobLogs?: (id: string, keepLogs?: number) => Promise<void>;
  getJobDependencies?: (id: string, opts?: GetDependenciesOpts) => Promise<JobDependencies>;
  getJobDependenciesCount?: (
    id: string,
    opts?: GetDependenciesOpts
  ) => Promise<JobDependenciesCount>;
}

/** Get a single job by ID */
export async function getJob<T>(ctx: QueryContext, id: string): Promise<Job<T> | null> {
  if (ctx.embedded) {
    const job = await getSharedManager().getJob(jobId(id));
    if (!job) return null;
    const name = (job.data as { name?: string })?.name ?? 'unknown';

    // Use toPublicJob if extended context is available (for full opts support)
    if (ctx.updateJobData) {
      return toPublicJob<T>({
        job,
        name,
        getState: (jid) => ctx.getJobState(jid),
        remove: (jid) => ctx.removeAsync(jid),
        retry: (jid) => ctx.retryJob(jid),
        getChildrenValues: (jid) => ctx.getChildrenValues(jid),
        updateData: ctx.updateJobData,
        promote: ctx.promoteJob,
        changeDelay: ctx.changeJobDelay,
        changePriority: ctx.changeJobPriority,
        extendLock: ctx.extendJobLock,
        clearLogs: ctx.clearJobLogs,
        getDependencies: ctx.getJobDependencies,
        getDependenciesCount: ctx.getJobDependenciesCount,
      });
    }

    // Fallback to simple job
    return createSimpleJob(String(job.id), name, job.data as T, job.createdAt, {
      queueName: ctx.name,
      getJobState: ctx.getJobState,
      removeAsync: ctx.removeAsync,
      retryJob: ctx.retryJob,
      getChildrenValues: ctx.getChildrenValues,
    });
  }

  const response = await ctx.tcp!.send({ cmd: 'GetJob', id });
  if (!response.ok || !response.job) return null;

  const j = response.job as {
    id: string;
    data: T;
    progress?: number;
    state?: string;
  };
  const name = (j.data as { name?: string })?.name ?? 'unknown';
  const result = createSimpleJob(j.id, name, j.data, Date.now(), {
    queueName: ctx.name,
    getJobState: ctx.getJobState,
    removeAsync: ctx.removeAsync,
    retryJob: ctx.retryJob,
    getChildrenValues: ctx.getChildrenValues,
  });
  if (j.progress !== undefined) (result as { progress: number }).progress = j.progress;
  return result;
}

/** Get job state by ID */
export async function getJobState(
  ctx: QueryContext,
  id: string
): Promise<'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'unknown'> {
  if (ctx.embedded) {
    const state = await getSharedManager().getJobState(jobId(id));
    return mapState(state);
  }

  const response = await ctx.tcp!.send({ cmd: 'GetState', id });
  if (!response.ok) return 'unknown';
  return mapState(response.state as string | undefined);
}

function mapState(
  state: string | undefined
): 'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'unknown' {
  switch (state) {
    case 'waiting':
    case 'delayed':
    case 'active':
    case 'completed':
    case 'failed':
      return state;
    case 'processing':
      return 'active';
    case 'dlq':
      return 'failed';
    default:
      return 'unknown';
  }
}

/** Get children values for a job */
export async function getChildrenValues(
  ctx: QueryContext,
  id: string
): Promise<Record<string, unknown>> {
  if (ctx.embedded) {
    return getSharedManager().getChildrenValues(jobId(id));
  }
  const response = await ctx.tcp!.send({ cmd: 'GetChildrenValues', id });
  if (!response.ok) return {};
  const data = (response as { data?: { values?: Record<string, unknown> } }).data;
  return data?.values ?? {};
}

interface GetJobsOptions {
  state?: string | string[];
  start?: number;
  end?: number;
  asc?: boolean;
}

/** Get jobs with filtering (sync, embedded only) */
export function getJobs<T>(ctx: QueryContext, options: GetJobsOptions = {}): Job<T>[] {
  if (!ctx.embedded) return [];

  const manager = getSharedManager();
  const jobs = manager.getJobs(ctx.name, {
    state: options.state,
    start: options.start ?? 0,
    end: options.end ?? 100,
  });

  return jobs.map((j) => {
    const name = (j.data as { name?: string })?.name ?? 'unknown';
    return createSimpleJob(String(j.id), name, j.data as T, j.createdAt, {
      queueName: ctx.name,
      getJobState: ctx.getJobState,
      removeAsync: ctx.removeAsync,
      retryJob: ctx.retryJob,
      getChildrenValues: ctx.getChildrenValues,
    });
  });
}

/** Get jobs with filtering (async, works with TCP) */
export async function getJobsAsync<T>(
  ctx: QueryContext,
  options: GetJobsOptions = {}
): Promise<Job<T>[]> {
  if (ctx.embedded) return getJobs(ctx, options);

  // Handle end=-1 as "get all"
  const end = options.end !== undefined && options.end >= 0 ? options.end : 1000;
  const start = options.start ?? 0;

  const response = await ctx.tcp!.send({
    cmd: 'GetJobs',
    queue: ctx.name,
    state: options.state,
    offset: start,
    limit: end - start,
  });

  if (!response.ok || !Array.isArray((response as { jobs?: unknown[] }).jobs)) {
    return [];
  }

  const jobs = (
    response as {
      jobs: Array<{
        id: string;
        queue: string;
        data: T;
        progress?: number;
        createdAt?: number;
        startedAt?: number;
        attempts?: number;
        priority?: number;
        runAt?: number;
      }>;
    }
  ).jobs;

  const now = Date.now();
  return jobs.map((j) => {
    const name = (j.data as { name?: string })?.name ?? 'unknown';
    const result = createSimpleJob(j.id, name, j.data, j.createdAt ?? now, {
      queueName: ctx.name,
      getJobState: ctx.getJobState,
      removeAsync: ctx.removeAsync,
      retryJob: ctx.retryJob,
      getChildrenValues: ctx.getChildrenValues,
    });
    if (j.progress !== undefined) (result as { progress: number }).progress = j.progress;
    if (j.priority !== undefined) (result as { priority: number }).priority = j.priority;
    if (j.attempts !== undefined) (result as { attemptsMade: number }).attemptsMade = j.attempts;
    return result;
  });
}

/** Get waiting jobs */
export function getWaiting<T>(ctx: QueryContext, start = 0, end = 100): Job<T>[] {
  return getJobs(ctx, { state: 'waiting', start, end });
}

export async function getWaitingAsync<T>(
  ctx: QueryContext,
  start = 0,
  end = 100
): Promise<Job<T>[]> {
  return getJobsAsync(ctx, { state: 'waiting', start, end });
}

/** Get delayed jobs */
export function getDelayed<T>(ctx: QueryContext, start = 0, end = 100): Job<T>[] {
  return getJobs(ctx, { state: 'delayed', start, end });
}

export async function getDelayedAsync<T>(
  ctx: QueryContext,
  start = 0,
  end = 100
): Promise<Job<T>[]> {
  return getJobsAsync(ctx, { state: 'delayed', start, end });
}

/** Get active jobs */
export function getActive<T>(ctx: QueryContext, start = 0, end = 100): Job<T>[] {
  return getJobs(ctx, { state: 'active', start, end });
}

export async function getActiveAsync<T>(
  ctx: QueryContext,
  start = 0,
  end = 100
): Promise<Job<T>[]> {
  return getJobsAsync(ctx, { state: 'active', start, end });
}

/** Get completed jobs */
export function getCompleted<T>(ctx: QueryContext, start = 0, end = 100): Job<T>[] {
  return getJobs(ctx, { state: 'completed', start, end });
}

export async function getCompletedAsync<T>(
  ctx: QueryContext,
  start = 0,
  end = 100
): Promise<Job<T>[]> {
  return getJobsAsync(ctx, { state: 'completed', start, end });
}

/** Get failed jobs */
export function getFailed<T>(ctx: QueryContext, start = 0, end = 100): Job<T>[] {
  return getJobs(ctx, { state: 'failed', start, end });
}

export async function getFailedAsync<T>(
  ctx: QueryContext,
  start = 0,
  end = 100
): Promise<Job<T>[]> {
  return getJobsAsync(ctx, { state: 'failed', start, end });
}
