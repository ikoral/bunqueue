/**
 * Queue - BullMQ-style API
 */

import { getSharedManager } from './manager';
import type { Job, JobOptions, QueueOptions } from './types';
import { toPublicJob } from './types';
import { jobId } from '../domain/types/job';

/**
 * Queue class for adding and managing jobs
 */
export class Queue<T = unknown> {
  readonly name: string;
  private readonly opts: QueueOptions;

  constructor(name: string, opts: QueueOptions = {}) {
    this.name = name;
    this.opts = opts;
  }

  /** Add a job to the queue */
  async add(name: string, data: T, opts: JobOptions = {}): Promise<Job<T>> {
    const merged = { ...this.opts.defaultJobOptions, ...opts };
    const manager = getSharedManager();

    const job = await manager.push(this.name, {
      data: { name, ...data },
      priority: merged.priority,
      delay: merged.delay,
      maxAttempts: merged.attempts,
      backoff: merged.backoff,
      timeout: merged.timeout,
      customId: merged.jobId,
      removeOnComplete: merged.removeOnComplete,
      removeOnFail: merged.removeOnFail,
      repeat: merged.repeat,
    });

    return toPublicJob<T>(job, name);
  }

  /** Add multiple jobs (batch optimized) */
  async addBulk(jobs: Array<{ name: string; data: T; opts?: JobOptions }>): Promise<Job<T>[]> {
    if (jobs.length === 0) return [];

    const manager = getSharedManager();
    const now = Date.now();

    // Map to JobInput format
    const inputs = jobs.map(({ name, data, opts }) => {
      const merged = { ...this.opts.defaultJobOptions, ...opts };
      return {
        data: { name, ...data },
        priority: merged.priority,
        delay: merged.delay,
        maxAttempts: merged.attempts,
        backoff: merged.backoff,
        timeout: merged.timeout,
        customId: merged.jobId,
        removeOnComplete: merged.removeOnComplete,
        removeOnFail: merged.removeOnFail,
        repeat: merged.repeat,
      };
    });

    // Single batch push (optimized: single lock, batch INSERT)
    const jobIds = await manager.pushBatch(this.name, inputs);

    // Create public job objects
    return jobIds.map((id, i) => ({
      id: String(id),
      name: jobs[i].name,
      data: jobs[i].data,
      queueName: this.name,
      attemptsMade: 0,
      timestamp: now,
      progress: 0,
      updateProgress: async () => {},
      log: async () => {},
    }));
  }

  /** Get a job by ID */
  async getJob(id: string): Promise<Job<T> | null> {
    const manager = getSharedManager();
    const job = await manager.getJob(jobId(id));
    if (!job) return null;
    const jobData = job.data as { name?: string } | null;
    return toPublicJob<T>(job, jobData?.name ?? 'default');
  }

  /** Remove a job by ID */
  remove(id: string): void {
    const manager = getSharedManager();
    void manager.cancel(jobId(id));
  }

  /** Get job counts by state */
  getJobCounts(): { waiting: number; active: number; completed: number; failed: number } {
    const stats = getSharedManager().getStats();
    return {
      waiting: stats.waiting,
      active: stats.active,
      completed: stats.completed,
      failed: stats.dlq,
    };
  }

  /** Pause the queue */
  pause(): void {
    getSharedManager().pause(this.name);
  }

  /** Resume the queue */
  resume(): void {
    getSharedManager().resume(this.name);
  }

  /** Remove all waiting jobs */
  drain(): void {
    getSharedManager().drain(this.name);
  }

  /** Remove all queue data (waiting, active, completed, failed) */
  obliterate(): void {
    getSharedManager().obliterate(this.name);
  }

  /** Close the queue */
  async close(): Promise<void> {
    // No-op for embedded mode
  }
}
