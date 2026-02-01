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

  // Heartbeat tracking with lock tokens (BullMQ-style ownership)
  // Track ALL pulled jobs (both active and buffered) for heartbeat
  private readonly activeJobIds: Set<string> = new Set();
  private readonly pulledJobIds: Set<string> = new Set(); // All pulled jobs (for heartbeat)
  private readonly jobTokens: Map<string, string> = new Map(); // jobId -> lockToken
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Unique worker ID for lock ownership
  private readonly workerId: string;

  // Job buffer for batch pulls (with tokens)
  private pendingJobs: Array<{ job: InternalJob; token: string | null }> = [];
  private pendingJobsHead = 0;
  private processingScheduled = false; // Prevent multiple setImmediate calls

  constructor(name: string, processor: Processor<T, R>, opts: WorkerOptions = {}) {
    super();
    this.name = name;
    this.processor = processor;
    this.embedded = opts.embedded ?? FORCE_EMBEDDED;

    // Generate unique worker ID for lock ownership
    this.workerId = `worker-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const concurrency = opts.concurrency ?? 1;
    this.opts = {
      concurrency,
      autorun: opts.autorun ?? true,
      heartbeatInterval: opts.heartbeatInterval ?? 10000,
      batchSize: Math.min(opts.batchSize ?? 10, 1000),
      pollTimeout: Math.min(opts.pollTimeout ?? 0, WORKER_CONSTANTS.MAX_POLL_TIMEOUT),
      embedded: this.embedded,
      // Lock-based ownership: disable for high-throughput scenarios where stall detection is sufficient
      useLocks: opts.useLocks ?? true,
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

    if (!force) {
      // Wait for buffered jobs to be processed and all active jobs to finish
      const bufferSize = () => this.pendingJobs.length - this.pendingJobsHead;
      while (this.activeJobs > 0 || bufferSize() > 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    // Flush any remaining pending acks
    await this.ackBatcher.flush();
    // Wait for ALL in-flight flushes to complete (critical!)
    await this.ackBatcher.waitForInFlight();
    this.ackBatcher.stop();

    // Small delay to ensure TCP responses are processed
    await new Promise((r) => setTimeout(r, 100));

    // Clear tracking sets
    this.activeJobIds.clear();
    this.pulledJobIds.clear();
    this.jobTokens.clear();
    this.pendingJobs = [];
    this.pendingJobsHead = 0;

    if (this.tcpPool) this.tcpPool.close();
    this.emit('closed');
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), this.opts.heartbeatInterval);
  }

  private async sendHeartbeat(): Promise<void> {
    // Send heartbeat for ALL pulled jobs (including buffered ones)
    // This is critical: when locks are enabled, we need to renew them
    // even for jobs sitting in the buffer waiting to be processed
    if (this.pulledJobIds.size === 0 || !this.tcp) return;

    try {
      // Always take a fresh snapshot - avoids race with job start/complete
      const ids = Array.from(this.pulledJobIds);
      if (ids.length === 0) return;

      if (this.opts.useLocks) {
        // With locks: include tokens for lock renewal
        const tokens = ids.map((id) => this.jobTokens.get(id) ?? '');
        if (ids.length === 1) {
          await this.tcp.send({ cmd: 'JobHeartbeat', id: ids[0], token: tokens[0] || undefined });
        } else {
          await this.tcp.send({ cmd: 'JobHeartbeatB', ids, tokens });
        }
      } else {
        // Without locks: simple heartbeat for stall detection only
        if (ids.length === 1) {
          await this.tcp.send({ cmd: 'JobHeartbeat', id: ids[0] });
        } else {
          await this.tcp.send({ cmd: 'JobHeartbeatB', ids });
        }
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
      let item = this.getBufferedJob();

      if (!item) {
        const items = await this.pullBatch();
        // Re-check state after async operation (can be modified during await)
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!this.running || this.closing) return;
        if (items.length > 0) {
          // Register ALL pulled jobs for heartbeat tracking immediately
          this.registerPulledJobs(items);
          item = items[0];
          this.pendingJobs = items;
          this.pendingJobsHead = 1;
        }
      }

      if (item) {
        this.consecutiveErrors = 0;
        this.startJob(item.job, item.token);
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

  /** Register pulled jobs for heartbeat tracking */
  private registerPulledJobs(items: Array<{ job: InternalJob; token: string | null }>): void {
    // When locks are enabled: jobs need heartbeats to renew locks
    // Without locks: still track for stall detection heartbeats
    for (const pulledItem of items) {
      const jobIdStr = String(pulledItem.job.id);
      this.pulledJobIds.add(jobIdStr);
      if (this.opts.useLocks && pulledItem.token) {
        this.jobTokens.set(jobIdStr, pulledItem.token);
      }
    }
  }

  private getBufferedJob(): { job: InternalJob; token: string | null } | null {
    if (this.pendingJobsHead >= this.pendingJobs.length) return null;

    const item = this.pendingJobs[this.pendingJobsHead++];
    if (this.pendingJobsHead > 500 && this.pendingJobsHead >= this.pendingJobs.length / 2) {
      this.pendingJobs = this.pendingJobs.slice(this.pendingJobsHead);
      this.pendingJobsHead = 0;
    }
    return item;
  }

  private async pullBatch(): Promise<Array<{ job: InternalJob; token: string | null }>> {
    const slots = this.opts.concurrency - this.activeJobs;
    const batchSize = Math.min(this.opts.batchSize, slots, 1000);
    if (batchSize <= 0) return [];

    return this.embedded ? this.pullEmbedded(batchSize) : this.pullTcp(batchSize);
  }

  private async pullEmbedded(
    count: number
  ): Promise<Array<{ job: InternalJob; token: string | null }>> {
    const manager = getSharedManager();

    // Use lock-based pull only when useLocks is enabled
    if (this.opts.useLocks) {
      if (count === 1) {
        const { job, token } = await manager.pullWithLock(this.name, this.workerId, 0);
        return job ? [{ job, token }] : [];
      }
      const { jobs, tokens } = await manager.pullBatchWithLock(this.name, count, this.workerId, 0);
      return jobs.map((job, i) => ({ job, token: tokens[i] || null }));
    }

    // No locks - use regular pull
    if (count === 1) {
      const job = await manager.pull(this.name, 0);
      return job ? [{ job, token: null }] : [];
    }
    const jobs = await manager.pullBatch(this.name, count, 0);
    return jobs.map((job) => ({ job, token: null }));
  }

  private async pullTcp(count: number): Promise<Array<{ job: InternalJob; token: string | null }>> {
    if (!this.tcp || this.closing) return [];

    // Build pull command - only request locks if useLocks is enabled
    const cmd: Record<string, unknown> = {
      cmd: count === 1 ? 'PULL' : 'PULLB',
      queue: this.name,
      timeout: this.opts.pollTimeout,
      count,
    };

    // Only request lock ownership when useLocks is enabled
    if (this.opts.useLocks) {
      cmd.owner = this.workerId;
    }

    const response = await this.tcp.send(cmd);

    if (!response.ok) return [];

    if (count === 1) {
      const job = response.job as Record<string, unknown> | null | undefined;
      // Only expect token if locks are enabled
      const token = this.opts.useLocks
        ? ((response.token as string | null | undefined) ?? null)
        : null;
      if (job) {
        return [{ job: parseJobFromResponse(job, this.name), token }];
      }
      return [];
    }

    const jobs = response.jobs as Array<Record<string, unknown>> | undefined;
    // Only expect tokens if locks are enabled
    const tokens = this.opts.useLocks ? ((response.tokens as string[] | undefined) ?? []) : [];
    return (
      jobs?.map((j, i) => ({
        job: parseJobFromResponse(j, this.name),
        token: tokens[i] || null,
      })) ?? []
    );
  }

  private startJob(job: InternalJob, token: string | null): void {
    this.activeJobs++;
    const jobIdStr = String(job.id);
    this.activeJobIds.add(jobIdStr);

    // Token management only when locks are enabled
    if (this.opts.useLocks && token && !this.jobTokens.has(jobIdStr)) {
      this.jobTokens.set(jobIdStr, token);
    }
    // Ensure job is in pulledJobIds for heartbeat (should already be there from pullBatch)
    this.pulledJobIds.add(jobIdStr);

    // Only pass token if locks are enabled
    const tokenForProcess = this.opts.useLocks ? token : undefined;

    void processJob(job, {
      name: this.name,
      processor: this.processor,
      embedded: this.embedded,
      tcp: this.tcp,
      ackBatcher: this.ackBatcher,
      emitter: this,
      token: tokenForProcess, // Pass token for ACK/FAIL verification (only when locks enabled)
    }).finally(() => {
      this.activeJobs--;
      this.activeJobIds.delete(jobIdStr);
      this.pulledJobIds.delete(jobIdStr); // Remove from heartbeat tracking
      if (this.opts.useLocks) {
        this.jobTokens.delete(jobIdStr); // Clean up token
      }
      if (this.running && !this.closing) this.poll();
    });

    // Prevent multiple setImmediate calls (event loop starvation)
    if (this.activeJobs < this.opts.concurrency && !this.closing && !this.processingScheduled) {
      this.processingScheduled = true;
      setImmediate(() => {
        this.processingScheduled = false;
        void this.tryProcess();
      });
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
