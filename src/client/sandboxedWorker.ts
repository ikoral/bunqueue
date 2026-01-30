/**
 * Sandboxed Worker
 * Runs job processors in isolated Bun Worker processes
 */

import { getSharedManager, type SharedManager } from './manager';
import type { Job as DomainJob } from '../domain/types/job';
import { join } from 'path';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

/** Sandboxed worker configuration */
export interface SandboxedWorkerOptions {
  /** Path to processor file (must export default async function) */
  processor: string;
  /** Number of worker processes (default: 1) */
  concurrency?: number;
  /** Max memory per worker in MB - uses smol mode if <= 64 (default: 256) */
  maxMemory?: number;
  /** Job timeout in ms (default: 30000) */
  timeout?: number;
  /** Auto-restart crashed workers (default: true) */
  autoRestart?: boolean;
  /** Max restarts before giving up (default: 10) */
  maxRestarts?: number;
  /** Poll interval when no workers are idle (default: 10ms) */
  pollInterval?: number;
  /** Custom QueueManager (for testing, defaults to shared manager) */
  manager?: SharedManager;
}

/** Worker process state */
interface WorkerProcess {
  worker: Worker;
  busy: boolean;
  currentJob: DomainJob | null;
  restarts: number;
  timeoutId: Timer | null;
}

/** IPC message from main to worker */
interface IPCRequest {
  type: 'job';
  job: {
    id: string;
    data: unknown;
    queue: string;
    attempts: number;
  };
}

/** IPC message from worker to main */
interface IPCResponse {
  type: 'result' | 'error' | 'progress';
  jobId: string;
  result?: unknown;
  error?: string;
  progress?: number;
}

/**
 * Sandboxed Worker - runs processors in isolated Bun Worker processes
 *
 * @example
 * ```typescript
 * import { Queue, SandboxedWorker } from 'bunqueue/client';
 *
 * const queue = new Queue('cpu-intensive');
 *
 * // Create processor file: processor.ts
 * // export default async (job) => {
 * //   const result = heavyComputation(job.data);
 * //   return result;
 * // };
 *
 * const worker = new SandboxedWorker('cpu-intensive', {
 *   processor: './processor.ts',
 *   concurrency: 4,
 *   timeout: 60000,
 * });
 *
 * await worker.start();
 * // Workers process jobs in isolated processes
 * // If one crashes, others continue working
 * ```
 */
export class SandboxedWorker {
  private readonly queueName: string;
  private readonly options: Required<Omit<SandboxedWorkerOptions, 'manager'>>;
  private readonly workers: WorkerProcess[] = [];
  private running = false;
  private pullPromise: Promise<void> | null = null;
  private wrapperPath: string | null = null;
  private readonly manager: SharedManager;

  constructor(queueName: string, options: SandboxedWorkerOptions) {
    this.queueName = queueName;
    this.manager = options.manager ?? getSharedManager();
    this.options = {
      processor: options.processor,
      concurrency: options.concurrency ?? 1,
      maxMemory: options.maxMemory ?? 256,
      timeout: options.timeout ?? 30000,
      autoRestart: options.autoRestart ?? true,
      maxRestarts: options.maxRestarts ?? 10,
      pollInterval: options.pollInterval ?? 10,
    };
  }

  /** Start the sandboxed worker pool */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Create wrapper script for workers
    this.wrapperPath = this.createWrapperScript();

    // Spawn worker processes
    for (let i = 0; i < this.options.concurrency; i++) {
      this.spawnWorker(i);
    }

    // Start pulling jobs
    this.pullPromise = this.pullLoop();
  }

  /** Stop all workers gracefully */
  async stop(): Promise<void> {
    this.running = false;

    // Clear all timeouts
    for (const wp of this.workers) {
      if (wp.timeoutId) {
        clearTimeout(wp.timeoutId);
      }
    }

    // Terminate all workers
    for (const wp of this.workers) {
      wp.worker.terminate();
    }
    this.workers.length = 0;

    // Wait for pull loop to finish
    if (this.pullPromise) {
      await this.pullPromise;
    }

    // Cleanup wrapper script
    if (this.wrapperPath && existsSync(this.wrapperPath)) {
      try {
        unlinkSync(this.wrapperPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /** Get worker pool stats */
  getStats(): { total: number; busy: number; idle: number; restarts: number } {
    const busy = this.workers.filter((w) => w.busy).length;
    const restarts = this.workers.reduce((sum, w) => sum + w.restarts, 0);
    return {
      total: this.workers.length,
      busy,
      idle: this.workers.length - busy,
      restarts,
    };
  }

  /** Create wrapper script file that loads the processor */
  private createWrapperScript(): string {
    const processorPath = this.options.processor.startsWith('/')
      ? this.options.processor
      : join(process.cwd(), this.options.processor);

    const wrapperCode = `
// Sandboxed Worker Wrapper
const processor = (await import('${processorPath}')).default;

self.onmessage = async (event) => {
  const { type, job } = event.data;
  if (type !== 'job') return;

  try {
    const result = await processor({
      id: job.id,
      data: job.data,
      queue: job.queue,
      attempts: job.attempts,
      progress: (value) => {
        self.postMessage({ type: 'progress', jobId: job.id, progress: value });
      },
    });

    self.postMessage({ type: 'result', jobId: job.id, result });
  } catch (err) {
    self.postMessage({
      type: 'error',
      jobId: job.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
`;

    // Write to temp file
    const tempDir = join(tmpdir(), 'bunqueue-workers');
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }

    const wrapperPath = join(tempDir, `worker-${this.queueName}-${Date.now()}.ts`);
    writeFileSync(wrapperPath, wrapperCode);

    return wrapperPath;
  }

  /** Spawn a single worker process */
  private spawnWorker(index: number): void {
    if (!this.wrapperPath) return;

    const worker = new Worker(this.wrapperPath, {
      smol: this.options.maxMemory <= 64,
    });

    const wp: WorkerProcess = {
      worker,
      busy: false,
      currentJob: null,
      restarts: this.workers[index]?.restarts ?? 0,
      timeoutId: null,
    };

    // Handle messages from worker
    worker.onmessage = (event: MessageEvent<IPCResponse>) => {
      this.handleWorkerMessage(wp, event.data);
    };

    // Handle worker errors/crashes
    worker.onerror = (error) => {
      console.error(`[SandboxedWorker] Worker ${index} error:`, error.message);
      this.handleWorkerCrash(wp, index);
    };

    if (this.workers[index]) {
      this.workers[index] = wp;
    } else {
      this.workers.push(wp);
    }
  }

  /** Main loop - pull jobs and dispatch to workers */
  private async pullLoop(): Promise<void> {
    while (this.running) {
      // Find idle worker
      const idleWorker = this.workers.find((w) => !w.busy);
      if (!idleWorker) {
        await Bun.sleep(this.options.pollInterval);
        continue;
      }

      // Pull job from queue using manager
      const job = await this.manager.pull(this.queueName, 1000);
      if (!job) continue;

      // Dispatch to worker
      this.dispatchJob(idleWorker, job);
    }
  }

  /** Dispatch job to a worker process */
  private dispatchJob(wp: WorkerProcess, job: DomainJob): void {
    wp.busy = true;
    wp.currentJob = job;

    // Set timeout
    wp.timeoutId = setTimeout(() => {
      this.handleJobTimeout(wp, job);
    }, this.options.timeout);

    // Send job to worker
    const request: IPCRequest = {
      type: 'job',
      job: {
        id: String(job.id),
        data: job.data,
        queue: job.queue,
        attempts: job.attempts,
      },
    };
    wp.worker.postMessage(request);
  }

  /** Handle message from worker */
  private handleWorkerMessage(wp: WorkerProcess, msg: IPCResponse): void {
    if (!wp.currentJob || msg.jobId !== String(wp.currentJob.id)) return;

    switch (msg.type) {
      case 'result':
        this.completeJob(wp, msg.result);
        break;
      case 'error':
        this.failJob(wp, msg.error ?? 'Unknown error');
        break;
      case 'progress':
        if (msg.progress !== undefined) {
          this.manager.updateProgress(wp.currentJob.id, msg.progress).catch(() => {});
        }
        break;
    }
  }

  /** Complete a job successfully */
  private completeJob(wp: WorkerProcess, result: unknown): void {
    if (wp.timeoutId) {
      clearTimeout(wp.timeoutId);
      wp.timeoutId = null;
    }

    if (wp.currentJob) {
      const jobId = wp.currentJob.id;
      this.manager.ack(jobId, result).catch((err: unknown) => {
        console.error(`[SandboxedWorker] Failed to ack job ${jobId}:`, err);
      });
    }

    wp.busy = false;
    wp.currentJob = null;
  }

  /** Fail a job */
  private failJob(wp: WorkerProcess, error: string): void {
    if (wp.timeoutId) {
      clearTimeout(wp.timeoutId);
      wp.timeoutId = null;
    }

    if (wp.currentJob) {
      const jobId = wp.currentJob.id;
      this.manager.fail(jobId, error).catch((err: unknown) => {
        console.error(`[SandboxedWorker] Failed to fail job ${jobId}:`, err);
      });
    }

    wp.busy = false;
    wp.currentJob = null;
  }

  /** Handle job timeout */
  private handleJobTimeout(wp: WorkerProcess, job: DomainJob): void {
    console.error(`[SandboxedWorker] Job ${job.id} timed out after ${this.options.timeout}ms`);

    // Terminate the stuck worker
    wp.worker.terminate();

    // Fail the job
    this.manager.fail(job.id, `Job timed out after ${this.options.timeout}ms`).catch(() => {});

    // Restart worker if allowed
    const index = this.workers.indexOf(wp);
    if (index !== -1) {
      this.handleWorkerCrash(wp, index);
    }
  }

  /** Handle worker crash and potentially restart */
  private handleWorkerCrash(wp: WorkerProcess, index: number): void {
    // Fail current job if any
    if (wp.currentJob) {
      this.manager.fail(wp.currentJob.id, 'Worker crashed').catch(() => {});
    }

    wp.busy = false;
    wp.currentJob = null;
    wp.restarts++;

    // Check if we should restart
    if (this.options.autoRestart && wp.restarts < this.options.maxRestarts && this.running) {
      console.log(`[SandboxedWorker] Restarting worker ${index} (attempt ${wp.restarts})`);
      this.spawnWorker(index);
    } else if (wp.restarts >= this.options.maxRestarts) {
      console.error(
        `[SandboxedWorker] Worker ${index} exceeded max restarts (${this.options.maxRestarts})`
      );
    }
  }
}
