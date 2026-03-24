/**
 * Job Proxy
 * Creates Job objects with methods for TCP and embedded modes
 */

import type { Job } from '../types';
import type { TcpConnectionPool } from '../tcpPool';

import type { JobStateType } from '../types';

interface JobProxyContext {
  queueName: string;
  tcp: TcpConnectionPool;
  getJobState: (id: string) => Promise<JobStateType>;
  removeAsync: (id: string) => Promise<void>;
  retryJob: (id: string) => Promise<void>;
  getChildrenValues: (id: string) => Promise<Record<string, unknown>>;
}

/** Create a full Job proxy with TCP methods */
export function createJobProxy<T>(id: string, name: string, data: T, ctx: JobProxyContext): Job<T> {
  const { tcp, queueName } = ctx;
  const ts = Date.now();

  return {
    id,
    name,
    data,
    queueName,
    attemptsMade: 0,
    timestamp: ts,
    progress: 0,
    delay: 0,
    processedOn: undefined,
    finishedOn: undefined,
    stacktrace: null,
    stalledCounter: 0,
    priority: 0,
    parentKey: undefined,
    opts: {},
    token: undefined,
    processedBy: undefined,
    deduplicationId: undefined,
    repeatJobKey: undefined,
    attemptsStarted: 0,

    // Methods
    updateProgress: async (progress: number, message?: string) => {
      await tcp.send({ cmd: 'Progress', id, progress, message });
    },
    log: async (message: string) => {
      await tcp.send({ cmd: 'AddLog', id, message });
    },
    getState: () => ctx.getJobState(id),
    remove: () => ctx.removeAsync(id),
    retry: () => ctx.retryJob(id),
    getChildrenValues: <R = unknown>() => ctx.getChildrenValues(id) as Promise<Record<string, R>>,

    // State check methods
    isWaiting: async () => (await ctx.getJobState(id)) === 'waiting',
    isActive: async () => (await ctx.getJobState(id)) === 'active',
    isDelayed: async () => (await ctx.getJobState(id)) === 'delayed',
    isCompleted: async () => (await ctx.getJobState(id)) === 'completed',
    isFailed: async () => (await ctx.getJobState(id)) === 'failed',
    isWaitingChildren: () => Promise.resolve(false),

    // Mutation methods
    updateData: async (newData) => {
      await tcp.send({ cmd: 'Update', id, data: newData });
    },
    promote: async () => {
      await tcp.send({ cmd: 'Promote', id });
    },
    changeDelay: async (delay) => {
      await tcp.send({ cmd: 'ChangeDelay', id, delay });
    },
    changePriority: async (opts) => {
      await tcp.send({ cmd: 'ChangePriority', id, priority: opts.priority });
    },
    extendLock: async (_token, duration) => {
      const res = await tcp.send({ cmd: 'ExtendLock', id, duration });
      return res.ok ? duration : 0;
    },
    clearLogs: async () => {
      await tcp.send({ cmd: 'ClearLogs', id });
    },

    // Dependency methods
    getDependencies: () => Promise.resolve({ processed: {}, unprocessed: [] }),
    getDependenciesCount: () => Promise.resolve({ processed: 0, unprocessed: 0 }),

    // Serialization methods
    toJSON: () => ({
      id,
      name,
      data,
      opts: {},
      progress: 0,
      delay: 0,
      timestamp: ts,
      attemptsMade: 0,
      stacktrace: null,
      queueQualifiedName: `bull:${queueName}`,
    }),
    asJSON: () => ({
      id,
      name,
      data: JSON.stringify(data),
      opts: '{}',
      progress: '0',
      delay: '0',
      timestamp: String(ts),
      attemptsMade: '0',
      stacktrace: null,
    }),

    // Move methods
    moveToCompleted: async (returnValue) => {
      await tcp.send({ cmd: 'ACK', id, result: returnValue });
      return null;
    },
    moveToFailed: async (error) => {
      await tcp.send({ cmd: 'FAIL', id, error: error.message });
    },
    moveToWait: async () => {
      const res = await tcp.send({ cmd: 'MoveToWait', id });
      return res.ok === true;
    },
    moveToDelayed: async (timestamp) => {
      await tcp.send({ cmd: 'MoveToDelayed', id, timestamp });
    },
    moveToWaitingChildren: () => Promise.resolve(false),
    waitUntilFinished: () => Promise.resolve(undefined),

    // Additional methods
    discard: () => {},
    getFailedChildrenValues: async () => {
      const res = await tcp.send({ cmd: 'GetFailedChildrenValues', id });
      return (res.values as Record<string, string> | undefined) ?? {};
    },
    getIgnoredChildrenFailures: async () => {
      const res = await tcp.send({ cmd: 'GetIgnoredChildrenFailures', id });
      return (res.values as Record<string, string> | undefined) ?? {};
    },
    removeChildDependency: async () => {
      const res = await tcp.send({ cmd: 'RemoveChildDependency', id });
      return (res.removed as boolean | undefined) ?? false;
    },
    removeDeduplicationKey: () => Promise.resolve(false),
    removeUnprocessedChildren: async () => {
      await tcp.send({ cmd: 'RemoveUnprocessedChildren', id });
    },
  };
}

interface SimpleJobContext {
  queueName: string;
  getJobState: (id: string) => Promise<JobStateType>;
  removeAsync: (id: string) => Promise<void>;
  retryJob: (id: string) => Promise<void>;
  getChildrenValues: (id: string) => Promise<Record<string, unknown>>;
}

/** Create a simple Job without TCP methods (for embedded or read-only) */
export function createSimpleJob<T>(
  id: string,
  name: string,
  data: T,
  timestamp: number,
  ctx: SimpleJobContext
): Job<T> {
  const { queueName } = ctx;

  return {
    id,
    name,
    data,
    queueName,
    attemptsMade: 0,
    timestamp,
    progress: 0,
    delay: 0,
    processedOn: undefined,
    finishedOn: undefined,
    stacktrace: null,
    stalledCounter: 0,
    priority: 0,
    parentKey: undefined,
    opts: {},
    token: undefined,
    processedBy: undefined,
    deduplicationId: undefined,
    repeatJobKey: undefined,
    attemptsStarted: 0,

    // Methods (no-op for simple jobs)
    updateProgress: async () => {},
    log: async () => {},
    getState: () => ctx.getJobState(id),
    remove: () => ctx.removeAsync(id),
    retry: () => ctx.retryJob(id),
    getChildrenValues: <R = unknown>() => ctx.getChildrenValues(id) as Promise<Record<string, R>>,

    // State check methods
    isWaiting: async () => (await ctx.getJobState(id)) === 'waiting',
    isActive: async () => (await ctx.getJobState(id)) === 'active',
    isDelayed: async () => (await ctx.getJobState(id)) === 'delayed',
    isCompleted: async () => (await ctx.getJobState(id)) === 'completed',
    isFailed: async () => (await ctx.getJobState(id)) === 'failed',
    isWaitingChildren: () => Promise.resolve(false),

    // No-op mutation methods
    updateData: async () => {},
    promote: async () => {},
    changeDelay: async () => {},
    changePriority: async () => {},
    extendLock: () => Promise.resolve(0),
    clearLogs: async () => {},

    // Dependency methods
    getDependencies: () => Promise.resolve({ processed: {}, unprocessed: [] }),
    getDependenciesCount: () => Promise.resolve({ processed: 0, unprocessed: 0 }),

    // Serialization methods
    toJSON: () => ({
      id,
      name,
      data,
      opts: {},
      progress: 0,
      delay: 0,
      timestamp,
      attemptsMade: 0,
      stacktrace: null,
      queueQualifiedName: `bull:${queueName}`,
    }),
    asJSON: () => ({
      id,
      name,
      data: JSON.stringify(data),
      opts: '{}',
      progress: '0',
      delay: '0',
      timestamp: String(timestamp),
      attemptsMade: '0',
      stacktrace: null,
    }),

    // Move methods (no-op)
    moveToCompleted: () => Promise.resolve(null),
    moveToFailed: () => Promise.resolve(),
    moveToWait: () => Promise.resolve(false),
    moveToDelayed: () => Promise.resolve(),
    moveToWaitingChildren: () => Promise.resolve(false),
    waitUntilFinished: () => Promise.resolve(undefined),

    // Additional methods
    discard: () => {},
    getFailedChildrenValues: () => Promise.resolve({}),
    getIgnoredChildrenFailures: () => Promise.resolve({}),
    removeChildDependency: () => Promise.resolve(false),
    removeDeduplicationKey: () => Promise.resolve(false),
    removeUnprocessedChildren: () => Promise.resolve(),
  };
}
