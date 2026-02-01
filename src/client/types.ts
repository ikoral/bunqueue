/**
 * Client Types
 */

import type { Job as InternalJob } from '../domain/types/job';

/** Job state type */
export type JobStateType = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'unknown';

/** Job interface exposed to users */
export interface Job<T = unknown> {
  id: string;
  name: string;
  data: T;
  queueName: string;
  attemptsMade: number;
  timestamp: number;
  progress: number;
  returnvalue?: unknown;
  failedReason?: string;
  /** Update job progress (0-100) */
  updateProgress(progress: number, message?: string): Promise<void>;
  /** Log a message to the job */
  log(message: string): Promise<void>;
  /** Get current job state */
  getState(): Promise<JobStateType>;
  /** Remove this job from the queue */
  remove(): Promise<void>;
  /** Retry this job */
  retry(): Promise<void>;
}

/** Job options when adding to queue */
export interface JobOptions {
  priority?: number;
  delay?: number;
  attempts?: number;
  backoff?: number;
  timeout?: number;
  jobId?: string;
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
  /** Stall timeout in ms - job is stalled if no heartbeat after this time */
  stallTimeout?: number;
  /** Repeat configuration for recurring jobs */
  repeat?: {
    /** Repeat every N milliseconds */
    every?: number;
    /** Maximum repetitions (omit for infinite) */
    limit?: number;
    /** Cron pattern (alternative to every) */
    pattern?: string;
  };
  /**
   * Force immediate persistence to disk (bypass write buffer).
   * Use for critical jobs where data loss is unacceptable.
   * Default: false (uses buffered writes for better throughput)
   */
  durable?: boolean;
}

/** Connection options for TCP mode */
export interface ConnectionOptions {
  /** Server host (default: localhost, ignored if socketPath is set) */
  host?: string;
  /** Server port (default: 6789, ignored if socketPath is set) */
  port?: number;
  /** Unix socket path (takes priority over host/port) */
  socketPath?: string;
  /** Auth token */
  token?: string;
  /** Connection pool size for parallel operations (default: 1, set >1 to enable pooling) */
  poolSize?: number;
}

/** Queue options */
export interface QueueOptions {
  defaultJobOptions?: JobOptions;
  /** Connection options - if omitted, connects to localhost:6789 */
  connection?: ConnectionOptions;
  /** Use embedded mode (in-process SQLite) instead of TCP */
  embedded?: boolean;
}

/** Worker options */
export interface WorkerOptions {
  concurrency?: number;
  autorun?: boolean;
  /** Heartbeat interval in ms (default: 10000). Set to 0 to disable. */
  heartbeatInterval?: number;
  /** Connection options - if omitted, connects to localhost:6789 */
  connection?: ConnectionOptions;
  /** Use embedded mode (in-process SQLite) instead of TCP */
  embedded?: boolean;
  /** Batch size for pulling jobs (default: 10, max: 1000). Higher = fewer round-trips */
  batchSize?: number;
  /** Long poll timeout in ms when queue is empty (default: 0 = no wait, max: 30000) */
  pollTimeout?: number;
  /**
   * Use lock-based job ownership (BullMQ-style).
   * When enabled, each pulled job gets a lock that must be renewed via heartbeat.
   * Disable for high-throughput scenarios where stall detection is sufficient.
   * Default: true
   */
  useLocks?: boolean;
}

/** Stall configuration for a queue */
export interface StallConfig {
  /** Enable stall detection (default: true) */
  enabled?: boolean;
  /** Stall timeout in ms (default: 30000) */
  stallInterval?: number;
  /** Max stalls before moving to DLQ (default: 3) */
  maxStalls?: number;
  /** Grace period after job start (default: 5000) */
  gracePeriod?: number;
}

/** DLQ configuration for a queue */
export interface DlqConfig {
  /** Enable auto-retry from DLQ */
  autoRetry?: boolean;
  /** Auto-retry interval in ms (default: 3600000 = 1 hour) */
  autoRetryInterval?: number;
  /** Max auto-retries (default: 3) */
  maxAutoRetries?: number;
  /** Max age before auto-purge in ms (default: 604800000 = 7 days) */
  maxAge?: number | null;
  /** Max entries per queue (default: 10000) */
  maxEntries?: number;
}

/** Failure reason for DLQ entries */
export type FailureReason =
  | 'explicit_fail'
  | 'max_attempts_exceeded'
  | 'timeout'
  | 'stalled'
  | 'ttl_expired'
  | 'worker_lost'
  | 'unknown';

/** DLQ entry with metadata */
export interface DlqEntry<T = unknown> {
  job: Job<T>;
  enteredAt: number;
  reason: FailureReason;
  error: string | null;
  attempts: Array<{
    attempt: number;
    startedAt: number;
    failedAt: number;
    reason: FailureReason;
    error: string | null;
    duration: number;
  }>;
  retryCount: number;
  lastRetryAt: number | null;
  nextRetryAt: number | null;
  expiresAt: number | null;
}

/** DLQ statistics */
export interface DlqStats {
  total: number;
  byReason: Record<FailureReason, number>;
  pendingRetry: number;
  expired: number;
  oldestEntry: number | null;
  newestEntry: number | null;
}

/** DLQ filter options */
export interface DlqFilter {
  reason?: FailureReason;
  olderThan?: number;
  newerThan?: number;
  retriable?: boolean;
  expired?: boolean;
  limit?: number;
  offset?: number;
}

/** Job processor function */
export type Processor<T = unknown, R = unknown> = (job: Job<T>) => Promise<R> | R;

/** Queue events */
export type QueueEventType =
  | 'waiting'
  | 'active'
  | 'completed'
  | 'failed'
  | 'progress'
  | 'removed'
  | 'drained';

/** Extract user data from stored job data (removes internal 'name' field) */
function extractUserData(jobData: unknown): unknown {
  if (typeof jobData === 'object' && jobData !== null) {
    const { name: _name, ...userData } = jobData as Record<string, unknown>;
    return userData;
  }
  return jobData;
}

/** Options for creating a public job */
export interface CreatePublicJobOptions {
  job: InternalJob;
  name: string;
  updateProgress: (id: string, progress: number, message?: string) => Promise<void>;
  log: (id: string, message: string) => Promise<void>;
  getState?: (id: string) => Promise<JobStateType>;
  remove?: (id: string) => Promise<void>;
  retry?: (id: string) => Promise<void>;
}

/** Convert internal job to public job (with methods) */
export function createPublicJob<T>(opts: CreatePublicJobOptions): Job<T> {
  const { job, name, updateProgress, log, getState, remove, retry } = opts;
  const id = String(job.id);
  return {
    id,
    name,
    data: extractUserData(job.data) as T,
    queueName: job.queue,
    attemptsMade: job.attempts,
    timestamp: job.createdAt,
    progress: job.progress,
    updateProgress: (progress: number, message?: string) => updateProgress(id, progress, message),
    log: (message: string) => log(id, message),
    getState: () => (getState ? getState(id) : Promise.resolve('unknown' as JobStateType)),
    remove: () => (remove ? remove(id) : Promise.resolve()),
    retry: () => (retry ? retry(id) : Promise.resolve()),
  };
}

/** Simple public job without methods (for Queue.getJob) */
export function toPublicJob<T>(
  job: InternalJob,
  name: string,
  getState?: (id: string) => Promise<JobStateType>,
  remove?: (id: string) => Promise<void>,
  retry?: (id: string) => Promise<void>
): Job<T> {
  const id = String(job.id);
  return {
    id,
    name,
    data: extractUserData(job.data) as T,
    queueName: job.queue,
    attemptsMade: job.attempts,
    timestamp: job.createdAt,
    progress: job.progress,
    updateProgress: async () => {},
    log: async () => {},
    getState: () => (getState ? getState(id) : Promise.resolve('unknown' as JobStateType)),
    remove: () => (remove ? remove(id) : Promise.resolve()),
    retry: () => (retry ? retry(id) : Promise.resolve()),
  };
}

import type { DlqEntry as InternalDlqEntry } from '../domain/types/dlq';

/** Convert internal DLQ entry to public DLQ entry */
export function toDlqEntry<T>(entry: InternalDlqEntry): DlqEntry<T> {
  const jobData = entry.job.data as { name?: string } | null;
  return {
    job: toPublicJob<T>(entry.job, jobData?.name ?? 'default'),
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
