/**
 * Client Types
 */

import type { Job as InternalJob } from '../domain/types/job';

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
}

/** Queue options */
export interface QueueOptions {
  defaultJobOptions?: JobOptions;
}

/** Worker options */
export interface WorkerOptions {
  concurrency?: number;
  autorun?: boolean;
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

/** Convert internal job to public job (with methods) */
export function createPublicJob<T>(
  job: InternalJob,
  name: string,
  updateProgress: (id: string, progress: number, message?: string) => Promise<void>,
  log: (id: string, message: string) => Promise<void>
): Job<T> {
  const id = String(job.id);
  return {
    id,
    name,
    data: job.data as T,
    queueName: job.queue,
    attemptsMade: job.attempts,
    timestamp: job.createdAt,
    progress: job.progress,
    updateProgress: (progress: number, message?: string) => updateProgress(id, progress, message),
    log: (message: string) => log(id, message),
  };
}

/** Simple public job without methods (for Queue.getJob) */
export function toPublicJob<T>(job: InternalJob, name: string): Job<T> {
  const id = String(job.id);
  return {
    id,
    name,
    data: job.data as T,
    queueName: job.queue,
    attemptsMade: job.attempts,
    timestamp: job.createdAt,
    progress: job.progress,
    updateProgress: async () => {},
    log: async () => {},
  };
}
