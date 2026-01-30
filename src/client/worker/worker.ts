/**
 * Worker
 * BullMQ-style worker for job processing
 */

import { EventEmitter } from 'events';
import { getSharedManager } from '../manager';
import { TcpConnectionPool } from '../tcpPool';
import type { WorkerOptions, Processor, ConnectionOptions } from '../types';
import type { Job as InternalJob } from '../../domain/types/job';
import type { TcpConnection, ExtendedWorkerOptions } from './types';
import { FORCE_EMBEDDED, WORKER_CONSTANTS } from './types';
import { AckBatcher } from './ackBatcher';
import { parseJobFromResponse } from './jobParser';
import { processJob } from './processor';

/**
 * Worker class for processing jobs
 */
export class Worker<T = unknown, R = unknown> extends EventEmitter {
  readonly name: string;
  private readonly opts: ExtendedWorkerOptions;
  private readonly processor: Processor<T, R>;
  private readonly embedded: boolean;
  private readonly tcp: TcpConnection | null;
  private readonly tcpPool: TcpConnectionPool | null;
  private readonly ackBatcher: AckBatcher;

  private running = false;
  private closing = false;
  private activeJobs = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveErrors = 0;

  // Heartbeat tracking
  private readonly activeJobIds: Set<string> = new Set();
  private cachedActiveJobIds: string[] = [];
  private activeJobIdsDirty = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Job buffer for batch pulls
  private pendingJobs: InternalJob[] = [];
  private pendingJobsHead = 0;

  constructor(name: string, processor: Processor<T, R>, opts: WorkerOptions = {}) {
    super();
    this.name = name;
    this.processor = processor;
    this.embedded = opts.embedded ?? FORCE_EMBEDDED;

    const concurrency = opts.concurrency ?? 1;
    this.opts = {
      concurrency,
      autorun: opts.autorun ?? true,
      heartbeatInterval: opts.heartbeatInterval ?? 10000,
      batchSize: Math.min(opts.batchSize ?? 10, 1000),
      pollTimeout: Math.min(opts.pollTimeout ?? 0, WORKER_CONSTANTS.MAX_POLL_TIMEOUT),
      embedded: this.embedded,
    };

    this.ackBatcher = new AckBatcher({
      batchSize: opts.batchSize ?? 10,
      interval: WORKER_CONSTANTS.DEFAULT_ACK_INTERVAL,
      embedded: this.embedded,
    });

    if (this.embedded) {
      this.tcp = null;
      this.tcpPool = null;
    } else {
      const connOpts: ConnectionOptions = opts.connection ?? {};
      const poolSize = connOpts.poolSize ?? Math.min(concurrency, 8);

      this.tcpPool = new TcpConnectionPool({
        host: connOpts.host ?? 'localhost',
        port: connOpts.port ?? 6789,
        token: connOpts.token,
        poolSize,
      });
      this.tcp = this.tcpPool;
      this.ackBatcher.setTcp(this.tcp);
    }

    if (this.opts.autorun) this.run();
  }

  /** Start processing */
  run(): void {
    if (this.running) return;
    this.running = true;
    this.closing = false;
    this.emit('ready');

    if (!this.embedded && this.opts.heartbeatInterval > 0) {
      this.startHeartbeat();
    }
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
    this.closing = true;
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    await this.ackBatcher.flush();
    this.ackBatcher.stop();

    if (!force) {
      while (this.activeJobs > 0) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 100));
    }

    if (this.tcpPool) this.tcpPool.close();
    this.emit('closed');
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), this.opts.heartbeatInterval);
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.activeJobIds.size === 0 || !this.tcp) return;

    try {
      if (this.activeJobIdsDirty) {
        this.cachedActiveJobIds = Array.from(this.activeJobIds);
        this.activeJobIdsDirty = false;
      }

      const ids = this.cachedActiveJobIds;
      if (ids.length === 1) {
        await this.tcp.send({ cmd: 'JobHeartbeat', id: ids[0] });
      } else if (ids.length > 1) {
        await this.tcp.send({ cmd: 'JobHeartbeatB', ids });
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', Object.assign(error, { context: 'heartbeat' }));
    }
  }

  private poll(): void {
    if (!this.running || this.closing) return;

    if (this.activeJobs >= this.opts.concurrency) {
      this.pollTimer = setTimeout(() => {
        this.poll();
      }, 10);
      return;
    }
    void this.tryProcess();
  }

  private async tryProcess(): Promise<void> {
    if (!this.running || this.closing) return;

    try {
      let job = this.getBufferedJob();

      if (!job) {
        const jobs = await this.pullBatch();
        // Re-check closing after async operation (can be modified during await)
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (this.closing) return;
        if (jobs.length > 0) {
          job = jobs[0];
          this.pendingJobs = jobs;
          this.pendingJobsHead = 1;
        }
      }

      if (job) {
        this.consecutiveErrors = 0;
        this.startJob(job);
      } else {
        const waitTime = this.opts.pollTimeout > 0 ? 10 : 50;
        this.pollTimer = setTimeout(() => {
          this.poll();
        }, waitTime);
      }
    } catch (err) {
      // Re-check running state - could have changed during async pullBatch()
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!this.running) return;
      this.handlePullError(err);
    }
  }

  private getBufferedJob(): InternalJob | null {
    if (this.pendingJobsHead >= this.pendingJobs.length) return null;

    const job = this.pendingJobs[this.pendingJobsHead++];
    if (this.pendingJobsHead > 500 && this.pendingJobsHead >= this.pendingJobs.length / 2) {
      this.pendingJobs = this.pendingJobs.slice(this.pendingJobsHead);
      this.pendingJobsHead = 0;
    }
    return job;
  }

  private async pullBatch(): Promise<InternalJob[]> {
    const slots = this.opts.concurrency - this.activeJobs;
    const batchSize = Math.min(this.opts.batchSize, slots, 1000);
    if (batchSize <= 0) return [];

    return this.embedded ? this.pullEmbedded(batchSize) : this.pullTcp(batchSize);
  }

  private async pullEmbedded(count: number): Promise<InternalJob[]> {
    const manager = getSharedManager();
    if (count === 1) {
      const job = await manager.pull(this.name, 0);
      return job ? [job] : [];
    }
    return manager.pullBatch(this.name, count, 0);
  }

  private async pullTcp(count: number): Promise<InternalJob[]> {
    if (!this.tcp || this.closing) return [];

    const response = await this.tcp.send({
      cmd: count === 1 ? 'PULL' : 'PULLB',
      queue: this.name,
      timeout: this.opts.pollTimeout,
      count,
    });

    if (!response.ok) return [];

    if (count === 1 && response.job) {
      return [parseJobFromResponse(response.job as Record<string, unknown>, this.name)];
    }

    const jobs = response.jobs as Array<Record<string, unknown>> | undefined;
    return jobs?.map((j) => parseJobFromResponse(j, this.name)) ?? [];
  }

  private startJob(job: InternalJob): void {
    this.activeJobs++;
    const jobIdStr = String(job.id);
    this.activeJobIds.add(jobIdStr);
    this.activeJobIdsDirty = true;

    void processJob(job, {
      name: this.name,
      processor: this.processor,
      embedded: this.embedded,
      tcp: this.tcp,
      ackBatcher: this.ackBatcher,
      emitter: this,
    }).finally(() => {
      this.activeJobs--;
      this.activeJobIds.delete(jobIdStr);
      this.activeJobIdsDirty = true;
      if (this.running && !this.closing) this.poll();
    });

    if (this.activeJobs < this.opts.concurrency && !this.closing) {
      setImmediate(() => void this.tryProcess());
    }
  }

  private handlePullError(err: unknown): void {
    this.consecutiveErrors++;
    const error = err instanceof Error ? err : new Error(String(err));
    this.emit(
      'error',
      Object.assign(error, {
        queue: this.name,
        consecutiveErrors: this.consecutiveErrors,
        context: 'pull',
      })
    );

    const backoffMs = Math.min(
      WORKER_CONSTANTS.BASE_BACKOFF_MS * Math.pow(2, this.consecutiveErrors - 1),
      WORKER_CONSTANTS.MAX_BACKOFF_MS
    );
    this.pollTimer = setTimeout(() => {
      this.poll();
    }, backoffMs);
  }
}
