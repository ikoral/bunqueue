/**
 * Worker - BullMQ-style API
 */

import { EventEmitter } from 'events';
import { getSharedManager } from './manager';
import type { WorkerOptions, Processor } from './types';
import { createPublicJob } from './types';
import type { Job as InternalJob } from '../domain/types/job';
import { jobId } from '../domain/types/job';

/**
 * Worker class for processing jobs
 */
export class Worker<T = unknown, R = unknown> extends EventEmitter {
  readonly name: string;
  private readonly opts: Required<WorkerOptions>;
  private readonly processor: Processor<T, R>;
  private running = false;
  private activeJobs = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(name: string, processor: Processor<T, R>, opts: WorkerOptions = {}) {
    super();
    this.name = name;
    this.processor = processor;
    this.opts = {
      concurrency: opts.concurrency ?? 1,
      autorun: opts.autorun ?? true,
    };

    if (this.opts.autorun) {
      this.run();
    }
  }

  /** Start processing */
  run(): void {
    if (this.running) return;
    this.running = true;
    this.emit('ready');
    this.poll();
  }

  /** Pause processing */
  pause(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Resume processing */
  resume(): void {
    this.run();
  }

  /** Close worker gracefully */
  async close(force = false): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    if (!force) {
      while (this.activeJobs > 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    this.emit('closed');
  }

  private poll(): void {
    if (!this.running) return;

    if (this.activeJobs >= this.opts.concurrency) {
      this.pollTimer = setTimeout(() => {
        this.poll();
      }, 10);
      return;
    }

    void this.tryProcess();
  }

  private async tryProcess(): Promise<void> {
    if (!this.running) return;
    const manager = getSharedManager();

    try {
      const internalJob = await manager.pull(this.name, 0);

      if (internalJob) {
        this.activeJobs++;
        void this.processJob(internalJob).finally(() => {
          this.activeJobs--;
          if (this.running) this.poll();
        });

        if (this.activeJobs < this.opts.concurrency) {
          setImmediate(() => {
            void this.tryProcess();
          });
        }
      } else {
        this.pollTimer = setTimeout(() => {
          this.poll();
        }, 50);
      }
    } catch (err) {
      this.emit('error', err);
      this.pollTimer = setTimeout(() => {
        this.poll();
      }, 100);
    }
  }

  private async processJob(internalJob: InternalJob): Promise<void> {
    const manager = getSharedManager();
    const jobData = internalJob.data as { name?: string } | null;
    const name = jobData?.name ?? 'default';

    // Create job with progress and log methods
    const job = createPublicJob<T>(
      internalJob,
      name,
      async (id, progress, message) => {
        await manager.updateProgress(jobId(id), progress, message);
        this.emit('progress', job, progress);
      },
      (id, message) => {
        manager.addLog(jobId(id), message);
        return Promise.resolve();
      }
    );

    this.emit('active', job);

    try {
      const result = await this.processor(job);
      await manager.ack(internalJob.id, result);
      (job as { returnvalue?: unknown }).returnvalue = result;
      this.emit('completed', job, result);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await manager.fail(internalJob.id, err.message);
      (job as { failedReason?: string }).failedReason = err.message;
      this.emit('failed', job, err);
    }
  }
}
