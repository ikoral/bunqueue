/**
 * Job Conversion Functions
 * Convert internal job types to public API types
 */

import type { Job as InternalJob } from '../domain/types/job';
import type { DlqEntry as InternalDlqEntry } from '../domain/types/dlq';
import type {
  Job,
  JobStateType,
  JobOptions,
  ChangePriorityOpts,
  GetDependenciesOpts,
  JobDependencies,
  JobDependenciesCount,
  DlqEntry,
  FailureReason,
} from './types';
import {
  extractUserData,
  extractParent,
  buildJobOpts,
  buildParentKey,
  buildRepeatJobKey,
} from './jobHelpers';

/** Options for creating a public job */
export interface CreatePublicJobOptions {
  job: InternalJob;
  name: string;
  updateProgress: (id: string, progress: number, message?: string) => Promise<void>;
  log: (id: string, message: string) => Promise<void>;
  getState?: (id: string) => Promise<JobStateType>;
  remove?: (id: string) => Promise<void>;
  retry?: (id: string) => Promise<void>;
  getChildrenValues?: (id: string) => Promise<Record<string, unknown>>;
  // BullMQ v5 additional callbacks
  updateData?: (id: string, data: unknown) => Promise<void>;
  promote?: (id: string) => Promise<void>;
  changeDelay?: (id: string, delay: number) => Promise<void>;
  changePriority?: (id: string, opts: ChangePriorityOpts) => Promise<void>;
  extendLock?: (id: string, token: string, duration: number) => Promise<number>;
  clearLogs?: (id: string, keepLogs?: number) => Promise<void>;
  getDependencies?: (id: string, opts?: GetDependenciesOpts) => Promise<JobDependencies>;
  getDependenciesCount?: (id: string, opts?: GetDependenciesOpts) => Promise<JobDependenciesCount>;
  // BullMQ v5 move method callbacks
  moveToCompleted?: (id: string, returnValue: unknown, token?: string) => Promise<unknown>;
  moveToFailed?: (id: string, error: Error, token?: string) => Promise<void>;
  moveToWait?: (id: string, token?: string) => Promise<boolean>;
  moveToDelayed?: (id: string, timestamp: number, token?: string) => Promise<void>;
  moveToWaitingChildren?: (
    id: string,
    token?: string,
    opts?: { child?: { id: string; queue: string } }
  ) => Promise<boolean>;
  waitUntilFinished?: (id: string, queueEvents: unknown, ttl?: number) => Promise<unknown>;
  // BullMQ v5 additional method callbacks
  discard?: (id: string) => void;
  getFailedChildrenValues?: (id: string) => Promise<Record<string, string>>;
  getIgnoredChildrenFailures?: (id: string) => Promise<Record<string, string>>;
  removeChildDependency?: (id: string) => Promise<boolean>;
  removeDeduplicationKey?: (id: string) => Promise<boolean>;
  removeUnprocessedChildren?: (id: string) => Promise<void>;
  // Additional job metadata
  token?: string;
  processedBy?: string;
  stacktrace?: string[] | null;
}

/** Options for creating a simple public job */
export interface ToPublicJobOptions {
  job: InternalJob;
  name: string;
  getState?: (id: string) => Promise<JobStateType>;
  remove?: (id: string) => Promise<void>;
  retry?: (id: string) => Promise<void>;
  getChildrenValues?: (id: string) => Promise<Record<string, unknown>>;
  // BullMQ v5 additional callbacks
  updateData?: (id: string, data: unknown) => Promise<void>;
  promote?: (id: string) => Promise<void>;
  changeDelay?: (id: string, delay: number) => Promise<void>;
  changePriority?: (id: string, opts: ChangePriorityOpts) => Promise<void>;
  extendLock?: (id: string, token: string, duration: number) => Promise<number>;
  clearLogs?: (id: string, keepLogs?: number) => Promise<void>;
  getDependencies?: (id: string, opts?: GetDependenciesOpts) => Promise<JobDependencies>;
  getDependenciesCount?: (id: string, opts?: GetDependenciesOpts) => Promise<JobDependenciesCount>;
  // BullMQ v5 move method callbacks
  moveToCompleted?: (id: string, returnValue: unknown, token?: string) => Promise<unknown>;
  moveToFailed?: (id: string, error: Error, token?: string) => Promise<void>;
  moveToWait?: (id: string, token?: string) => Promise<boolean>;
  moveToDelayed?: (id: string, timestamp: number, token?: string) => Promise<void>;
  moveToWaitingChildren?: (
    id: string,
    token?: string,
    opts?: { child?: { id: string; queue: string } }
  ) => Promise<boolean>;
  waitUntilFinished?: (id: string, queueEvents: unknown, ttl?: number) => Promise<unknown>;
  // BullMQ v5 additional method callbacks
  discard?: (id: string) => void;
  getFailedChildrenValues?: (id: string) => Promise<Record<string, string>>;
  getIgnoredChildrenFailures?: (id: string) => Promise<Record<string, string>>;
  removeChildDependency?: (id: string) => Promise<boolean>;
  removeDeduplicationKey?: (id: string) => Promise<boolean>;
  removeUnprocessedChildren?: (id: string) => Promise<void>;
  // Additional job metadata
  stacktrace?: string[] | null;
}

/** Build common job properties from internal job */
function buildJobProperties<T>(
  job: InternalJob,
  name: string,
  stacktrace?: string[] | null,
  token?: string,
  processedBy?: string
): Pick<
  Job<T>,
  | 'id'
  | 'name'
  | 'data'
  | 'queueName'
  | 'attemptsMade'
  | 'timestamp'
  | 'progress'
  | 'parent'
  | 'delay'
  | 'processedOn'
  | 'finishedOn'
  | 'stacktrace'
  | 'stalledCounter'
  | 'priority'
  | 'parentKey'
  | 'opts'
  | 'token'
  | 'processedBy'
  | 'deduplicationId'
  | 'repeatJobKey'
  | 'attemptsStarted'
> {
  const id = String(job.id);
  const parent = extractParent(job.data);
  const jobOpts = buildJobOpts(job);

  return {
    id,
    name,
    data: extractUserData(job.data) as T,
    queueName: job.queue,
    attemptsMade: job.attempts,
    timestamp: job.createdAt,
    progress: job.progress,
    parent,
    delay: job.runAt > job.createdAt ? job.runAt - job.createdAt : 0,
    processedOn: job.startedAt ?? undefined,
    finishedOn: job.completedAt ?? undefined,
    stacktrace: stacktrace ?? null,
    stalledCounter: job.stallCount,
    priority: job.priority,
    parentKey: buildParentKey(job),
    opts: jobOpts,
    token,
    processedBy,
    deduplicationId: job.customId ?? undefined,
    repeatJobKey: buildRepeatJobKey(job),
    attemptsStarted: job.attempts,
  };
}

/** Build state check methods */
function buildStateCheckMethods(
  id: string,
  getState?: (id: string) => Promise<JobStateType>,
  getDependenciesCount?: (id: string, opts?: GetDependenciesOpts) => Promise<JobDependenciesCount>
): Pick<
  Job,
  'isWaiting' | 'isActive' | 'isDelayed' | 'isCompleted' | 'isFailed' | 'isWaitingChildren'
> {
  return {
    isWaiting: async () => {
      const state = await (getState ? getState(id) : Promise.resolve('unknown'));
      return state === 'waiting';
    },
    isActive: async () => {
      const state = await (getState ? getState(id) : Promise.resolve('unknown'));
      return state === 'active';
    },
    isDelayed: async () => {
      const state = await (getState ? getState(id) : Promise.resolve('unknown'));
      return state === 'delayed';
    },
    isCompleted: async () => {
      const state = await (getState ? getState(id) : Promise.resolve('unknown'));
      return state === 'completed';
    },
    isFailed: async () => {
      const state = await (getState ? getState(id) : Promise.resolve('unknown'));
      return state === 'failed';
    },
    isWaitingChildren: async () => {
      if (getDependenciesCount) {
        const counts = await getDependenciesCount(id);
        return counts.unprocessed > 0;
      }
      return false;
    },
  };
}

/** Build serialization methods */
function buildSerializationMethods<T>(
  job: InternalJob,
  id: string,
  name: string,
  jobOpts: JobOptions,
  stacktrace?: string[] | null
): Pick<Job<T>, 'toJSON' | 'asJSON'> {
  return {
    toJSON: () => ({
      id,
      name,
      data: extractUserData(job.data) as T,
      opts: jobOpts,
      progress: job.progress,
      delay: job.runAt > job.createdAt ? job.runAt - job.createdAt : 0,
      timestamp: job.createdAt,
      attemptsMade: job.attempts,
      stacktrace: stacktrace ?? null,
      returnvalue: undefined,
      failedReason: undefined,
      finishedOn: job.completedAt ?? undefined,
      processedOn: job.startedAt ?? undefined,
      queueQualifiedName: `bull:${job.queue}`,
      parentKey: buildParentKey(job),
    }),
    asJSON: () => ({
      id,
      name,
      data: JSON.stringify(extractUserData(job.data)),
      opts: JSON.stringify(jobOpts),
      progress: JSON.stringify(job.progress),
      delay: String(job.runAt > job.createdAt ? job.runAt - job.createdAt : 0),
      timestamp: String(job.createdAt),
      attemptsMade: String(job.attempts),
      stacktrace: stacktrace ? JSON.stringify(stacktrace) : null,
      returnvalue: undefined,
      failedReason: undefined,
      finishedOn: job.completedAt ? String(job.completedAt) : undefined,
      processedOn: job.startedAt ? String(job.startedAt) : undefined,
      parentKey: buildParentKey(job),
    }),
  };
}

/** Convert internal job to public job (with methods) */
export function createPublicJob<T>(opts: CreatePublicJobOptions): Job<T> {
  const {
    job,
    name,
    updateProgress,
    log,
    getState,
    remove,
    retry,
    getChildrenValues,
    updateData,
    promote,
    changeDelay,
    changePriority,
    extendLock,
    clearLogs,
    getDependencies,
    getDependenciesCount,
    moveToCompleted,
    moveToFailed,
    moveToWait,
    moveToDelayed,
    moveToWaitingChildren,
    waitUntilFinished,
    discard,
    getFailedChildrenValues,
    getIgnoredChildrenFailures,
    removeChildDependency,
    removeDeduplicationKey,
    removeUnprocessedChildren,
    token,
    processedBy,
    stacktrace,
  } = opts;

  const id = String(job.id);
  const jobOpts = buildJobOpts(job);
  const props = buildJobProperties<T>(job, name, stacktrace, token, processedBy);
  const stateChecks = buildStateCheckMethods(id, getState, getDependenciesCount);
  const serialization = buildSerializationMethods<T>(job, id, name, jobOpts, stacktrace);

  return {
    ...props,
    ...stateChecks,
    ...serialization,

    // Core methods
    updateProgress: (progress: number, message?: string) => updateProgress(id, progress, message),
    log: (message: string) => log(id, message),
    getState: () => (getState ? getState(id) : Promise.resolve('unknown' as JobStateType)),
    remove: () => (remove ? remove(id) : Promise.resolve()),
    retry: () => (retry ? retry(id) : Promise.resolve()),
    getChildrenValues: <R = unknown>() =>
      (getChildrenValues ? getChildrenValues(id) : Promise.resolve({})) as Promise<
        Record<string, R>
      >,

    // BullMQ v5 mutation methods
    updateData: (data: T) => (updateData ? updateData(id, data) : Promise.resolve()),
    promote: () => (promote ? promote(id) : Promise.resolve()),
    changeDelay: (delay: number) => (changeDelay ? changeDelay(id, delay) : Promise.resolve()),
    changePriority: (prioOpts: ChangePriorityOpts) =>
      changePriority ? changePriority(id, prioOpts) : Promise.resolve(),
    extendLock: (lockToken: string, duration: number) =>
      extendLock ? extendLock(id, lockToken, duration) : Promise.resolve(0),
    clearLogs: (keepLogs?: number) => (clearLogs ? clearLogs(id, keepLogs) : Promise.resolve()),

    // BullMQ v5 dependency methods
    getDependencies: (depOpts?: GetDependenciesOpts) =>
      getDependencies
        ? getDependencies(id, depOpts)
        : Promise.resolve({ processed: {}, unprocessed: [] }),
    getDependenciesCount: (depOpts?: GetDependenciesOpts) =>
      getDependenciesCount
        ? getDependenciesCount(id, depOpts)
        : Promise.resolve({ processed: 0, unprocessed: 0 }),

    // BullMQ v5 move methods
    moveToCompleted: (returnValue: unknown, lockToken?: string, _fetchNext?: boolean) =>
      moveToCompleted ? moveToCompleted(id, returnValue, lockToken) : Promise.resolve(null),
    moveToFailed: (error: Error, lockToken?: string, _fetchNext?: boolean) =>
      moveToFailed ? moveToFailed(id, error, lockToken) : Promise.resolve(),
    moveToWait: (lockToken?: string) =>
      moveToWait ? moveToWait(id, lockToken) : Promise.resolve(false),
    moveToDelayed: (timestamp: number, lockToken?: string) =>
      moveToDelayed ? moveToDelayed(id, timestamp, lockToken) : Promise.resolve(),
    moveToWaitingChildren: (
      lockToken?: string,
      moveOpts?: { child?: { id: string; queue: string } }
    ) =>
      moveToWaitingChildren
        ? moveToWaitingChildren(id, lockToken, moveOpts)
        : Promise.resolve(false),
    waitUntilFinished: (queueEvents: unknown, ttl?: number) =>
      waitUntilFinished ? waitUntilFinished(id, queueEvents, ttl) : Promise.resolve(undefined),

    // BullMQ v5 additional methods
    discard: () => {
      if (discard) discard(id);
    },
    getFailedChildrenValues: () =>
      getFailedChildrenValues ? getFailedChildrenValues(id) : Promise.resolve({}),
    getIgnoredChildrenFailures: () =>
      getIgnoredChildrenFailures ? getIgnoredChildrenFailures(id) : Promise.resolve({}),
    removeChildDependency: () =>
      removeChildDependency ? removeChildDependency(id) : Promise.resolve(false),
    removeDeduplicationKey: () =>
      removeDeduplicationKey ? removeDeduplicationKey(id) : Promise.resolve(false),
    removeUnprocessedChildren: () =>
      removeUnprocessedChildren ? removeUnprocessedChildren(id) : Promise.resolve(),
  };
}

/** Simple public job without methods (for Queue.getJob) */
export function toPublicJob<T>(opts: ToPublicJobOptions): Job<T> {
  const {
    job,
    name,
    getState,
    remove,
    retry,
    getChildrenValues,
    updateData,
    promote,
    changeDelay,
    changePriority,
    extendLock,
    clearLogs,
    getDependencies,
    getDependenciesCount,
    moveToCompleted,
    moveToFailed,
    moveToWait,
    moveToDelayed,
    moveToWaitingChildren,
    waitUntilFinished,
    discard,
    getFailedChildrenValues,
    getIgnoredChildrenFailures,
    removeChildDependency,
    removeDeduplicationKey,
    removeUnprocessedChildren,
    stacktrace,
  } = opts;

  const id = String(job.id);
  const jobOpts = buildJobOpts(job);
  const props = buildJobProperties<T>(job, name, stacktrace, undefined, undefined);
  const stateChecks = buildStateCheckMethods(id, getState, getDependenciesCount);
  const serialization = buildSerializationMethods<T>(job, id, name, jobOpts, stacktrace);

  return {
    ...props,
    ...stateChecks,
    ...serialization,

    // Core methods (no-op for simple jobs)
    updateProgress: async () => {},
    log: async () => {},
    getState: () => (getState ? getState(id) : Promise.resolve('unknown' as JobStateType)),
    remove: () => (remove ? remove(id) : Promise.resolve()),
    retry: () => (retry ? retry(id) : Promise.resolve()),
    getChildrenValues: <R = unknown>() =>
      (getChildrenValues ? getChildrenValues(id) : Promise.resolve({})) as Promise<
        Record<string, R>
      >,

    // BullMQ v5 mutation methods
    updateData: (data: T) => (updateData ? updateData(id, data) : Promise.resolve()),
    promote: () => (promote ? promote(id) : Promise.resolve()),
    changeDelay: (delay: number) => (changeDelay ? changeDelay(id, delay) : Promise.resolve()),
    changePriority: (prioOpts: ChangePriorityOpts) =>
      changePriority ? changePriority(id, prioOpts) : Promise.resolve(),
    extendLock: (lockToken: string, duration: number) =>
      extendLock ? extendLock(id, lockToken, duration) : Promise.resolve(0),
    clearLogs: (keepLogs?: number) => (clearLogs ? clearLogs(id, keepLogs) : Promise.resolve()),

    // BullMQ v5 dependency methods
    getDependencies: (depOpts?: GetDependenciesOpts) =>
      getDependencies
        ? getDependencies(id, depOpts)
        : Promise.resolve({ processed: {}, unprocessed: [] }),
    getDependenciesCount: (depOpts?: GetDependenciesOpts) =>
      getDependenciesCount
        ? getDependenciesCount(id, depOpts)
        : Promise.resolve({ processed: 0, unprocessed: 0 }),

    // BullMQ v5 move methods
    moveToCompleted: (returnValue: unknown, lockToken?: string, _fetchNext?: boolean) =>
      moveToCompleted ? moveToCompleted(id, returnValue, lockToken) : Promise.resolve(null),
    moveToFailed: (error: Error, lockToken?: string, _fetchNext?: boolean) =>
      moveToFailed ? moveToFailed(id, error, lockToken) : Promise.resolve(),
    moveToWait: (lockToken?: string) =>
      moveToWait ? moveToWait(id, lockToken) : Promise.resolve(false),
    moveToDelayed: (timestamp: number, lockToken?: string) =>
      moveToDelayed ? moveToDelayed(id, timestamp, lockToken) : Promise.resolve(),
    moveToWaitingChildren: (
      lockToken?: string,
      moveOpts?: { child?: { id: string; queue: string } }
    ) =>
      moveToWaitingChildren
        ? moveToWaitingChildren(id, lockToken, moveOpts)
        : Promise.resolve(false),
    waitUntilFinished: (queueEvents: unknown, ttl?: number) =>
      waitUntilFinished ? waitUntilFinished(id, queueEvents, ttl) : Promise.resolve(undefined),

    // BullMQ v5 additional methods
    discard: () => {
      if (discard) discard(id);
    },
    getFailedChildrenValues: () =>
      getFailedChildrenValues ? getFailedChildrenValues(id) : Promise.resolve({}),
    getIgnoredChildrenFailures: () =>
      getIgnoredChildrenFailures ? getIgnoredChildrenFailures(id) : Promise.resolve({}),
    removeChildDependency: () =>
      removeChildDependency ? removeChildDependency(id) : Promise.resolve(false),
    removeDeduplicationKey: () =>
      removeDeduplicationKey ? removeDeduplicationKey(id) : Promise.resolve(false),
    removeUnprocessedChildren: () =>
      removeUnprocessedChildren ? removeUnprocessedChildren(id) : Promise.resolve(),
  };
}

/** Convert internal DLQ entry to public DLQ entry */
export function toDlqEntry<T>(entry: InternalDlqEntry): DlqEntry<T> {
  const jobData = entry.job.data as { name?: string } | null;
  return {
    job: toPublicJob<T>({ job: entry.job, name: jobData?.name ?? 'default' }),
    enteredAt: entry.enteredAt,
    reason: entry.reason as FailureReason,
    error: entry.error,
    attempts: entry.attempts.map((a) => ({
      attempt: a.attempt,
      startedAt: a.startedAt,
      failedAt: a.failedAt,
      reason: a.reason as FailureReason,
      error: a.error,
      duration: a.duration,
    })),
    retryCount: entry.retryCount,
    lastRetryAt: entry.lastRetryAt,
    nextRetryAt: entry.nextRetryAt,
    expiresAt: entry.expiresAt,
  };
}
