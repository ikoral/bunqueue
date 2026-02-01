/**
 * Queue
 * BullMQ-style queue for job management
 */

import { getSharedManager } from '../manager';
import { TcpConnectionPool, getSharedPool, releaseSharedPool } from '../tcpPool';
import type {
  Job,
  JobOptions,
  QueueOptions,
  StallConfig,
  DlqConfig,
  DlqEntry,
  DlqStats,
  DlqFilter,
  FailureReason,
  ConnectionOptions,
} from '../types';
import { toPublicJob } from '../types';
import { jobId } from '../../domain/types/job';
import { FORCE_EMBEDDED } from './helpers';
import * as dlqOps from './dlqOps';

/**
 * Queue class for adding and managing jobs
 */
export class Queue<T = unknown> {
  readonly name: string;
  private readonly opts: QueueOptions;
  private readonly embedded: boolean;
  private readonly tcpPool: TcpConnectionPool | null;
  private readonly useSharedPool: boolean;

  constructor(name: string, opts: QueueOptions = {}) {
    this.name = name;
    this.opts = opts;
    this.embedded = opts.embedded ?? FORCE_EMBEDDED;

    if (this.embedded) {
      this.tcpPool = null;
      this.useSharedPool = false;
    } else {
      const connOpts: ConnectionOptions = opts.connection ?? {};
      const poolSize = connOpts.poolSize ?? 4;

      if (poolSize === 4 && !connOpts.token) {
        this.tcpPool = getSharedPool({ host: connOpts.host, port: connOpts.port, poolSize });
        this.useSharedPool = true;
      } else {
        this.tcpPool = new TcpConnectionPool({
          host: connOpts.host ?? 'localhost',
          port: connOpts.port ?? 6789,
          token: connOpts.token,
          poolSize,
        });
        this.useSharedPool = false;
      }
    }
  }

  private get tcp(): TcpConnectionPool {
    if (!this.tcpPool) throw new Error('No TCP connection available');
    return this.tcpPool;
  }

  /** Add a job to the queue */
  async add(name: string, data: T, opts: JobOptions = {}): Promise<Job<T>> {
    const merged = { ...this.opts.defaultJobOptions, ...opts };
    if (this.embedded) {
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
        stallTimeout: merged.stallTimeout,
        durable: merged.durable,
      });
      return toPublicJob<T>(job, name);
    }

    const response = await this.tcp.send({
      cmd: 'PUSH',
      queue: this.name,
      data: { name, ...data },
      priority: merged.priority,
      delay: merged.delay,
      maxAttempts: merged.attempts,
      backoff: merged.backoff,
      timeout: merged.timeout,
      jobId: merged.jobId,
      removeOnComplete: merged.removeOnComplete,
      removeOnFail: merged.removeOnFail,
      stallTimeout: merged.stallTimeout,
      durable: merged.durable,
      repeat: merged.repeat,
    });

    if (!response.ok) {
      throw new Error((response.error as string | undefined) ?? 'Failed to add job');
    }
    const jobIdStr = response.id as string;
    return this.createJobProxy(jobIdStr, name, data);
  }

  /** Add multiple jobs (batch optimized) */
  async addBulk(jobs: Array<{ name: string; data: T; opts?: JobOptions }>): Promise<Job<T>[]> {
    if (jobs.length === 0) return [];
    const now = Date.now();

    if (this.embedded) {
      const manager = getSharedManager();
      const inputs = jobs.map(({ name, data, opts }) => {
        const m = { ...this.opts.defaultJobOptions, ...opts };
        return {
          data: { name, ...data },
          priority: m.priority,
          delay: m.delay,
          maxAttempts: m.attempts,
          backoff: m.backoff,
          timeout: m.timeout,
          customId: m.jobId,
          removeOnComplete: m.removeOnComplete,
          removeOnFail: m.removeOnFail,
          repeat: m.repeat,
          stallTimeout: m.stallTimeout,
          durable: m.durable,
        };
      });
      const ids = await manager.pushBatch(this.name, inputs);
      return ids.map((id, i) => this.createSimpleJob(String(id), jobs[i].name, jobs[i].data, now));
    }

    const jobInputs = jobs.map(({ name, data, opts }) => {
      const m = { ...this.opts.defaultJobOptions, ...opts };
      return {
        data: { name, ...data },
        priority: m.priority,
        delay: m.delay,
        maxAttempts: m.attempts,
        backoff: m.backoff,
        timeout: m.timeout,
        customId: m.jobId,
        removeOnComplete: m.removeOnComplete,
        removeOnFail: m.removeOnFail,
        stallTimeout: m.stallTimeout,
      };
    });

    const response = await this.tcp.send({ cmd: 'PUSHB', queue: this.name, jobs: jobInputs });
    if (!response.ok) {
      throw new Error((response.error as string | undefined) ?? 'Failed to add jobs');
    }
    const ids = response.ids as string[];
    return ids.map((id, i) => this.createSimpleJob(id, jobs[i].name, jobs[i].data, now));
  }

  /** Get a job by ID */
  async getJob(id: string): Promise<Job<T> | null> {
    if (this.embedded) {
      const manager = getSharedManager();
      const job = await manager.getJob(jobId(id));
      if (!job) return null;
      const jobData = job.data as { name?: string } | null;
      return toPublicJob<T>(job, jobData?.name ?? 'default');
    }

    const response = await this.tcp.send({ cmd: 'GetJob', id });
    if (!response.ok || !response.job) return null;
    const jobData = response.job as Record<string, unknown>;
    const data = jobData.data as { name?: string } | null;
    return {
      id: String(jobData.id),
      name: data?.name ?? 'default',
      data: jobData.data as T,
      queueName: this.name,
      attemptsMade: (jobData.attempts as number | undefined) ?? 0,
      timestamp: (jobData.createdAt as number | undefined) ?? Date.now(),
      progress: (jobData.progress as number | undefined) ?? 0,
      updateProgress: async () => {},
      log: async () => {},
    };
  }

  /** Remove a job by ID */
  remove(id: string): void {
    if (this.embedded) void getSharedManager().cancel(jobId(id));
    else void this.tcp.send({ cmd: 'Cancel', id });
  }

  /** Get job counts by state */
  getJobCounts(): { waiting: number; active: number; completed: number; failed: number } {
    if (this.embedded) {
      const s = getSharedManager().getStats();
      return { waiting: s.waiting, active: s.active, completed: s.completed, failed: s.dlq };
    }
    return { waiting: 0, active: 0, completed: 0, failed: 0 };
  }

  /** Get job counts (async, works with TCP) */
  async getJobCountsAsync(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
  }> {
    if (this.embedded) return this.getJobCounts();
    const response = await this.tcp.send({ cmd: 'Stats' });
    if (!response.ok) return { waiting: 0, active: 0, completed: 0, failed: 0 };
    const s = response.stats as Record<string, number | undefined> | undefined;
    return {
      waiting: s?.queued ?? 0,
      active: s?.processing ?? 0,
      completed: s?.completed ?? 0,
      failed: s?.dlq ?? 0,
    };
  }

  /** Get job counts grouped by priority */
  getCountsPerPriority(): Record<number, number> {
    if (this.embedded) {
      return getSharedManager().getCountsPerPriority(this.name);
    }
    // TCP mode returns empty for sync - use getCountsPerPriorityAsync
    return {};
  }

  /** Get job counts grouped by priority (async, works with TCP) */
  async getCountsPerPriorityAsync(): Promise<Record<number, number>> {
    if (this.embedded) return this.getCountsPerPriority();
    const response = await this.tcp.send({ cmd: 'GetCountsPerPriority', queue: this.name });
    if (!response.ok) return {};
    return (response as { counts?: Record<number, number> }).counts ?? {};
  }

  pause(): void {
    if (this.embedded) getSharedManager().pause(this.name);
    else void this.tcp.send({ cmd: 'Pause', queue: this.name });
  }
  resume(): void {
    if (this.embedded) getSharedManager().resume(this.name);
    else void this.tcp.send({ cmd: 'Resume', queue: this.name });
  }
  drain(): void {
    if (this.embedded) getSharedManager().drain(this.name);
    else void this.tcp.send({ cmd: 'Drain', queue: this.name });
  }
  obliterate(): void {
    if (this.embedded) getSharedManager().obliterate(this.name);
    else void this.tcp.send({ cmd: 'Obliterate', queue: this.name });
  }

  /** Get jobs with filtering and pagination */
  getJobs(
    options: {
      state?: 'waiting' | 'delayed' | 'active' | 'completed' | 'failed';
      start?: number;
      end?: number;
      asc?: boolean;
    } = {}
  ): Job<T>[] {
    if (this.embedded) {
      const jobs = getSharedManager().getJobs(this.name, options);
      return jobs.map((job) => {
        const jobData = job.data as { name?: string } | null;
        return toPublicJob<T>(job, jobData?.name ?? 'default');
      });
    }
    // Sync TCP version returns empty - use getJobsAsync
    return [];
  }

  /** Get jobs with filtering and pagination (async, works with TCP) */
  async getJobsAsync(
    options: {
      state?: 'waiting' | 'delayed' | 'active' | 'completed' | 'failed';
      start?: number;
      end?: number;
      asc?: boolean;
    } = {}
  ): Promise<Job<T>[]> {
    if (this.embedded) return this.getJobs(options);

    const response = await this.tcp.send({
      cmd: 'GetJobs',
      queue: this.name,
      state: options.state,
      offset: options.start ?? 0,
      limit: (options.end ?? 100) - (options.start ?? 0),
    });

    if (!response.ok || !Array.isArray((response as { jobs?: unknown[] }).jobs)) {
      return [];
    }

    const jobs = (
      response as {
        jobs: Array<{
          id: string;
          queue: string;
          data: unknown;
          priority: number;
          attempts: number;
          createdAt: number;
          progress?: number;
        }>;
      }
    ).jobs;

    return jobs.map((j) => {
      const jobData = j.data as { name?: string } | null;
      return {
        id: j.id,
        name: jobData?.name ?? 'default',
        data: j.data as T,
        queueName: j.queue,
        attemptsMade: j.attempts,
        timestamp: j.createdAt,
        progress: j.progress ?? 0,
        updateProgress: async () => {},
        log: async () => {},
      };
    });
  }

  // Stall Detection
  setStallConfig(config: Partial<StallConfig>): void {
    if (!this.embedded) {
      console.warn('setStallConfig: embedded only');
      return;
    }
    dlqOps.setStallConfigEmbedded(this.name, config);
  }

  getStallConfig(): StallConfig {
    if (!this.embedded) {
      return { enabled: true, stallInterval: 30000, maxStalls: 3, gracePeriod: 5000 };
    }
    return dlqOps.getStallConfigEmbedded(this.name);
  }

  // DLQ Operations
  setDlqConfig(config: Partial<DlqConfig>): void {
    if (!this.embedded) {
      console.warn('setDlqConfig: embedded only');
      return;
    }
    dlqOps.setDlqConfig(this.name, config);
  }

  getDlqConfig(): DlqConfig {
    if (!this.embedded) return {};
    return dlqOps.getDlqConfigEmbedded(this.name);
  }

  getDlq(filter?: DlqFilter): DlqEntry<T>[] {
    if (!this.embedded) return [];
    return dlqOps.getDlqEntries<T>(this.name, filter);
  }

  getDlqStats(): DlqStats {
    if (!this.embedded) {
      return {
        total: 0,
        byReason: {} as Record<FailureReason, number>,
        pendingRetry: 0,
        expired: 0,
        oldestEntry: null,
        newestEntry: null,
      };
    }
    return dlqOps.getDlqStatsEmbedded(this.name);
  }

  retryDlq(id?: string): number {
    if (this.embedded) return dlqOps.retryDlqEmbedded(this.name, id);
    void this.tcp.send({ cmd: 'RetryDlq', queue: this.name, id });
    return 0;
  }

  retryDlqByFilter(filter: DlqFilter): number {
    if (!this.embedded) return 0;
    return dlqOps.retryDlqByFilterEmbedded(this.name, filter);
  }

  purgeDlq(): number {
    if (this.embedded) return dlqOps.purgeDlqEmbedded(this.name);
    void this.tcp.send({ cmd: 'PurgeDlq', queue: this.name });
    return 0;
  }

  /** Retry a completed job by re-queueing it */
  retryCompleted(id?: string): number {
    if (this.embedded) {
      const jid = id ? jobId(id) : undefined;
      return getSharedManager().retryCompleted(this.name, jid);
    }
    void this.tcp.send({ cmd: 'RetryCompleted', queue: this.name, id });
    return 0;
  }

  /** Retry a completed job (async, works with TCP) */
  async retryCompletedAsync(id?: string): Promise<number> {
    if (this.embedded) return this.retryCompleted(id);
    const response = await this.tcp.send({ cmd: 'RetryCompleted', queue: this.name, id });
    if (!response.ok) return 0;
    return (response as { count?: number }).count ?? 0;
  }

  close(): void {
    if (this.tcpPool) {
      if (this.useSharedPool) releaseSharedPool(this.tcpPool);
      else this.tcpPool.close();
    }
  }

  private createJobProxy(id: string, name: string, data: T): Job<T> {
    const tcp = this.tcp;
    return {
      id,
      name,
      data,
      queueName: this.name,
      attemptsMade: 0,
      timestamp: Date.now(),
      progress: 0,
      updateProgress: async (progress: number, message?: string) => {
        await tcp.send({ cmd: 'Progress', id, progress, message });
      },
      log: async (message: string) => {
        await tcp.send({ cmd: 'AddLog', id, message });
      },
    };
  }

  private createSimpleJob(id: string, name: string, data: T, timestamp: number): Job<T> {
    return {
      id,
      name,
      data,
      queueName: this.name,
      attemptsMade: 0,
      timestamp,
      progress: 0,
      updateProgress: async () => {},
      log: async () => {},
    };
  }
}
