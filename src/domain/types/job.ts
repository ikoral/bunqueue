/**
 * Job domain types
 * Core job structure and related types
 */

/** Branded type for Job IDs (UUIDv7) */
export type JobId = string & { readonly __brand: 'JobId' };

/** Create a JobId from string */
export function jobId(id: string): JobId {
  return id as JobId;
}

/** Generate a new UUIDv7 JobId */
export function generateJobId(): JobId {
  return Bun.randomUUIDv7() as JobId;
}

/** Job state enumeration */
export const enum JobState {
  Waiting = 'waiting',
  Delayed = 'delayed',
  Active = 'active',
  Completed = 'completed',
  Failed = 'failed',
}

/** Repeat configuration for repeatable jobs */
export interface RepeatConfig {
  /** Repeat every N milliseconds */
  readonly every?: number;
  /** Maximum number of repetitions (null = infinite) */
  readonly limit?: number;
  /** Cron pattern (alternative to every) */
  readonly pattern?: string;
  /** Current repeat count */
  count: number;
}

/** Core job structure */
export interface Job {
  readonly id: JobId;
  readonly queue: string;
  readonly data: unknown;
  readonly priority: number;
  readonly createdAt: number;
  readonly lifo: boolean;

  // Scheduling
  runAt: number;
  startedAt: number | null;
  completedAt: number | null;

  // Retry config
  attempts: number;
  readonly maxAttempts: number;
  readonly backoff: number;

  // Timeouts
  readonly ttl: number | null;
  readonly timeout: number | null;

  // Deduplication
  readonly uniqueKey: string | null;
  readonly customId: string | null;

  // Dependencies & workflows
  readonly dependsOn: JobId[];
  readonly parentId: JobId | null;
  childrenIds: JobId[];
  childrenCompleted: number;

  // Metadata
  readonly tags: string[];
  readonly groupId: string | null;

  // Progress tracking
  progress: number;
  progressMessage: string | null;

  // Cleanup config
  readonly removeOnComplete: boolean;
  readonly removeOnFail: boolean;

  // Repeat config
  readonly repeat: RepeatConfig | null;

  // Stall detection
  lastHeartbeat: number;
  readonly stallTimeout: number | null;
  stallCount: number;
}

/** Input for creating a new job */
export interface JobInput {
  data: unknown;
  priority?: number;
  delay?: number;
  maxAttempts?: number;
  backoff?: number;
  ttl?: number;
  timeout?: number;
  uniqueKey?: string;
  customId?: string;
  dependsOn?: JobId[];
  parentId?: JobId;
  tags?: string[];
  groupId?: string;
  lifo?: boolean;
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
  stallTimeout?: number;
  repeat?: {
    every?: number;
    limit?: number;
    pattern?: string;
    /** Current count (for internal use when re-queueing) */
    count?: number;
  };
  /** Advanced deduplication options */
  dedup?: {
    /** TTL for unique key in milliseconds */
    ttl?: number;
    /** Extend TTL on duplicate instead of rejecting */
    extend?: boolean;
    /** Replace job data on duplicate instead of rejecting */
    replace?: boolean;
  };
}

/** Job creation defaults */
export const JOB_DEFAULTS = {
  priority: 0,
  maxAttempts: 3,
  backoff: 1000,
  lifo: false,
  removeOnComplete: false,
  removeOnFail: false,
} as const;

/** Create a new job from input */
export function createJob(
  id: JobId,
  queue: string,
  input: JobInput,
  now: number = Date.now()
): Job {
  const delay = input.delay ?? 0;

  return {
    id,
    queue,
    data: input.data,
    priority: input.priority ?? JOB_DEFAULTS.priority,
    createdAt: now,
    lifo: input.lifo ?? JOB_DEFAULTS.lifo,

    runAt: now + delay,
    startedAt: null,
    completedAt: null,

    attempts: 0,
    maxAttempts: input.maxAttempts ?? JOB_DEFAULTS.maxAttempts,
    backoff: input.backoff ?? JOB_DEFAULTS.backoff,

    ttl: input.ttl ?? null,
    timeout: input.timeout ?? null,

    uniqueKey: input.uniqueKey ?? null,
    customId: input.customId ?? null,

    dependsOn: input.dependsOn ?? [],
    parentId: input.parentId ?? null,
    childrenIds: [],
    childrenCompleted: 0,

    tags: input.tags ?? [],
    groupId: input.groupId ?? null,

    progress: 0,
    progressMessage: null,

    removeOnComplete: input.removeOnComplete ?? JOB_DEFAULTS.removeOnComplete,
    removeOnFail: input.removeOnFail ?? JOB_DEFAULTS.removeOnFail,

    repeat: input.repeat
      ? {
          every: input.repeat.every,
          limit: input.repeat.limit,
          pattern: input.repeat.pattern,
          count: input.repeat.count ?? 0,
        }
      : null,

    lastHeartbeat: now,
    stallTimeout: input.stallTimeout ?? null,
    stallCount: 0,
  };
}

/** Check if job is delayed */
export function isDelayed(job: Job, now: number = Date.now()): boolean {
  return job.runAt > now;
}

/** Check if job is ready to process */
export function isReady(job: Job, now: number = Date.now()): boolean {
  return job.runAt <= now;
}

/** Check if job is expired (TTL exceeded) */
export function isExpired(job: Job, now: number = Date.now()): boolean {
  if (job.ttl === null) return false;
  return now > job.createdAt + job.ttl;
}

/** Check if job has timed out during processing */
export function isTimedOut(job: Job, now: number = Date.now()): boolean {
  if (job.timeout === null || job.startedAt === null) return false;
  return now > job.startedAt + job.timeout;
}

/** Calculate next retry delay with exponential backoff */
export function calculateBackoff(job: Job): number {
  return job.backoff * Math.pow(2, job.attempts);
}

/** Check if job can retry */
export function canRetry(job: Job): boolean {
  return job.attempts < job.maxAttempts;
}

/** Lock token type (UUID) */
export type LockToken = string & { readonly __brand: 'LockToken' };

/** Create a LockToken from string */
export function lockToken(token: string): LockToken {
  return token as LockToken;
}

/** Generate a new lock token */
export function generateLockToken(): LockToken {
  return Bun.randomUUIDv7() as LockToken;
}

/** Job lock structure - tracks ownership of job processing */
export interface JobLock {
  readonly jobId: JobId;
  readonly token: LockToken;
  readonly owner: string; // Client/Worker identifier
  readonly createdAt: number;
  expiresAt: number;
  lastRenewalAt: number;
  renewalCount: number;
  readonly ttl: number; // Lock duration in ms
}

/** Default lock TTL in milliseconds (30 seconds like BullMQ) */
export const DEFAULT_LOCK_TTL = 30_000;

/** Create a new job lock */
export function createJobLock(
  jobId: JobId,
  owner: string,
  ttl: number = DEFAULT_LOCK_TTL,
  now: number = Date.now()
): JobLock {
  return {
    jobId,
    token: generateLockToken(),
    owner,
    createdAt: now,
    expiresAt: now + ttl,
    lastRenewalAt: now,
    renewalCount: 0,
    ttl,
  };
}

/** Check if lock is expired */
export function isLockExpired(lock: JobLock, now: number = Date.now()): boolean {
  return now >= lock.expiresAt;
}

/** Renew a lock, extending its expiration */
export function renewLock(lock: JobLock, newTtl?: number, now: number = Date.now()): void {
  const ttl = newTtl ?? lock.ttl;
  lock.expiresAt = now + ttl;
  lock.lastRenewalAt = now;
  lock.renewalCount++;
}
