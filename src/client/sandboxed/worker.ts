/**
 * Sandboxed Worker
 * Runs job processors in isolated Bun Worker processes
 */

import { getSharedManager, type SharedManager } from '../manager';
import type { Job as DomainJob } from '../../domain/types/job';
import type {
  SandboxedWorkerOptions,
  RequiredSandboxedWorkerOptions,
  WorkerProcess,
  IPCRequest,
  IPCResponse,
} from './types';
import { createWrapperScript, cleanupWrapperScript } from './wrapper';

/**
 * Sandboxed Worker - runs processors in isolated Bun Worker processes
 */
export class SandboxedWorker {
  private readonly queueName: string;
  private readonly options: RequiredSandboxedWorkerOptions;
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
    this.wrapperPath = createWrapperScript(this.queueName, this.options.processor);

    for (let i = 0; i < this.options.concurrency; i++) {
      this.spawnWorker(i);
    }
    this.pullPromise = this.pullLoop();
  }

  /** Stop all workers gracefully */
  async stop(): Promise<void> {
    this.running = false;

    for (const wp of this.workers) {
      if (wp.timeoutId) clearTimeout(wp.timeoutId);
      wp.worker.terminate();
    }
    this.workers.length = 0;

    if (this.pullPromise) await this.pullPromise;
    cleanupWrapperScript(this.wrapperPath);
  }

  /** Get worker pool stats */
  getStats(): { total: number; busy: number; idle: number; restarts: number } {
    const busy = this.workers.filter((w) => w.busy).length;
    const restarts = this.workers.reduce((sum, w) => sum + w.restarts, 0);
    return { total: this.workers.length, busy, idle: this.workers.length - busy, restarts };
  }

  private spawnWorker(index: number): void {
    if (!this.wrapperPath) return;

    const worker = new Worker(this.wrapperPath, { smol: this.options.maxMemory <= 64 });
    const wp: WorkerProcess = {
      worker,
      busy: false,
      currentJob: null,
      restarts: this.workers[index]?.restarts ?? 0,
      timeoutId: null,
    };

    worker.onmessage = (event: MessageEvent<IPCResponse>) => {
      this.handleMessage(wp, event.data);
    };
    worker.onerror = (error) => {
      console.error(`[SandboxedWorker] Worker ${index} error:`, error.message);
      this.handleCrash(wp, index);
    };

    if (this.workers[index]) this.workers[index] = wp;
    else this.workers.push(wp);
  }

  private async pullLoop(): Promise<void> {
    while (this.running) {
      const idle = this.workers.find((w) => !w.busy);
      if (!idle) {
        await Bun.sleep(this.options.pollInterval);
        continue;
      }

      const job = await this.manager.pull(this.queueName, 1000);
      if (job) this.dispatch(idle, job);
    }
  }

  private dispatch(wp: WorkerProcess, job: DomainJob): void {
    wp.busy = true;
    wp.currentJob = job;
    wp.timeoutId = setTimeout(() => {
      this.handleTimeout(wp, job);
    }, this.options.timeout);

    const request: IPCRequest = {
      type: 'job',
      job: { id: String(job.id), data: job.data, queue: job.queue, attempts: job.attempts },
    };
    wp.worker.postMessage(request);
  }

  private handleMessage(wp: WorkerProcess, msg: IPCResponse): void {
    if (!wp.currentJob || msg.jobId !== String(wp.currentJob.id)) return;

    switch (msg.type) {
      case 'result':
        this.complete(wp, msg.result);
        break;
      case 'error':
        this.fail(wp, msg.error ?? 'Unknown error');
        break;
      case 'progress':
        if (msg.progress !== undefined) {
          this.manager.updateProgress(wp.currentJob.id, msg.progress).catch(() => {});
        }
        break;
    }
  }

  private complete(wp: WorkerProcess, result: unknown): void {
    if (wp.timeoutId) {
      clearTimeout(wp.timeoutId);
      wp.timeoutId = null;
    }
    if (wp.currentJob) {
      const jobId = wp.currentJob.id;
      this.manager.ack(jobId, result).catch((e: unknown) => {
        console.error(`[SandboxedWorker] Failed to ack job ${jobId}:`, e);
      });
    }
    wp.busy = false;
    wp.currentJob = null;
  }

  private fail(wp: WorkerProcess, error: string): void {
    if (wp.timeoutId) {
      clearTimeout(wp.timeoutId);
      wp.timeoutId = null;
    }
    if (wp.currentJob) {
      const jobId = wp.currentJob.id;
      this.manager.fail(jobId, error).catch((e: unknown) => {
        console.error(`[SandboxedWorker] Failed to fail job ${jobId}:`, e);
      });
    }
    wp.busy = false;
    wp.currentJob = null;
  }

  private handleTimeout(wp: WorkerProcess, job: DomainJob): void {
    console.error(`[SandboxedWorker] Job ${job.id} timed out after ${this.options.timeout}ms`);
    wp.worker.terminate();
    this.manager.fail(job.id, `Job timed out after ${this.options.timeout}ms`).catch(() => {});

    const index = this.workers.indexOf(wp);
    if (index !== -1) this.handleCrash(wp, index);
  }

  private handleCrash(wp: WorkerProcess, index: number): void {
    if (wp.currentJob) this.manager.fail(wp.currentJob.id, 'Worker crashed').catch(() => {});

    wp.busy = false;
    wp.currentJob = null;
    wp.restarts++;

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
