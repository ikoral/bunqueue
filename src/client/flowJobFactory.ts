/**
 * Flow Job Factory
 * Creates simple Job objects for FlowProducer results
 */

import type { Job } from './types';

/** Callbacks for flow job mutation operations */
export interface FlowJobCallbacks {
  updateData?: (id: string, data: unknown) => Promise<void>;
  updateProgress?: (id: string, progress: number | object) => Promise<void>;
  log?: (id: string, message: string) => Promise<void>;
  promote?: (id: string) => Promise<void>;
  remove?: (id: string) => Promise<void>;
  changePriority?: (id: string, priority: number) => Promise<void>;
  changeDelay?: (id: string, delay: number) => Promise<void>;
  clearLogs?: (id: string) => Promise<void>;
  retry?: (id: string) => Promise<void>;
  getState?: (id: string) => Promise<string>;
}

/** Extract user data (remove internal fields like __parentId, __childrenIds, name) */
export function extractUserDataFromInternal(data: Record<string, unknown>): unknown {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith('__') && key !== 'name') {
      result[key] = value;
    }
  }
  return result;
}

/** Create a simple Job object for flow results */
export function createFlowJobObject<T>(
  id: string,
  name: string,
  data: T,
  queueName: string,
  callbacks?: FlowJobCallbacks
): Job<T> {
  const ts = Date.now();
  return {
    id,
    name,
    data,
    queueName,
    attemptsMade: 0,
    timestamp: ts,
    progress: 0,
    // BullMQ v5 properties
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
    // Methods - wired to callbacks when available, otherwise no-op
    updateProgress: (progress) =>
      callbacks?.updateProgress
        ? callbacks.updateProgress(id, progress as number | object)
        : Promise.resolve(),
    log: (message) => (callbacks?.log ? callbacks.log(id, message) : Promise.resolve()),
    getState: () =>
      callbacks?.getState
        ? (callbacks.getState(id) as Promise<
            'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'unknown'
          >)
        : Promise.resolve('waiting' as const),
    remove: () => (callbacks?.remove ? callbacks.remove(id) : Promise.resolve()),
    retry: () => (callbacks?.retry ? callbacks.retry(id) : Promise.resolve()),
    getChildrenValues: () => Promise.resolve({}),
    // BullMQ v5 state check methods
    isWaiting: () =>
      callbacks?.getState
        ? callbacks.getState(id).then((s) => s === 'waiting')
        : Promise.resolve(true),
    isActive: () =>
      callbacks?.getState
        ? callbacks.getState(id).then((s) => s === 'active')
        : Promise.resolve(false),
    isDelayed: () =>
      callbacks?.getState
        ? callbacks.getState(id).then((s) => s === 'delayed')
        : Promise.resolve(false),
    isCompleted: () =>
      callbacks?.getState
        ? callbacks.getState(id).then((s) => s === 'completed')
        : Promise.resolve(false),
    isFailed: () =>
      callbacks?.getState
        ? callbacks.getState(id).then((s) => s === 'failed')
        : Promise.resolve(false),
    isWaitingChildren: () => Promise.resolve(false),
    // BullMQ v5 mutation methods
    updateData: (newData) =>
      callbacks?.updateData ? callbacks.updateData(id, newData) : Promise.resolve(),
    promote: () => (callbacks?.promote ? callbacks.promote(id) : Promise.resolve()),
    changeDelay: (delay) =>
      callbacks?.changeDelay ? callbacks.changeDelay(id, delay) : Promise.resolve(),
    changePriority: (opts) =>
      callbacks?.changePriority
        ? callbacks.changePriority(id, (opts as { priority: number }).priority)
        : Promise.resolve(),
    extendLock: () => Promise.resolve(0),
    clearLogs: () => (callbacks?.clearLogs ? callbacks.clearLogs(id) : Promise.resolve()),
    // BullMQ v5 dependency methods
    getDependencies: () => Promise.resolve({ processed: {}, unprocessed: [] }),
    getDependenciesCount: () => Promise.resolve({ processed: 0, unprocessed: 0 }),
    // BullMQ v5 serialization methods
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
    // BullMQ v5 move methods
    moveToCompleted: () => Promise.resolve(null),
    moveToFailed: () => Promise.resolve(),
    moveToWait: () => Promise.resolve(false),
    moveToDelayed: () => Promise.resolve(),
    moveToWaitingChildren: () => Promise.resolve(false),
    waitUntilFinished: () => Promise.resolve(undefined),
    // BullMQ v5 additional methods
    discard: () => {},
    getFailedChildrenValues: () => Promise.resolve({}),
    getIgnoredChildrenFailures: () => Promise.resolve({}),
    removeChildDependency: () => Promise.resolve(false),
    removeDeduplicationKey: () => Promise.resolve(false),
    removeUnprocessedChildren: () => Promise.resolve(),
  };
}
