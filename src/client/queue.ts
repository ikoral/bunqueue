/**
 * Queue - BullMQ-style API
 * Default: TCP connection to localhost:6789
 * Optional: embedded mode with { embedded: true }
 */

import { getSharedManager } from './manager';
import { getSharedTcpClient, type TcpClient } from './tcpClient';
import { TcpConnectionPool } from './tcpPool';
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
} from './types';
import { toPublicJob, toDlqEntry } from './types';
import { jobId } from '../domain/types/job';
import { shardIndex } from '../shared/hash';
import type { Shard } from '../domain/queue/shard';
import type {
  DlqFilter as DomainDlqFilter,
  DlqConfig as DomainDlqConfig,
} from '../domain/types/dlq';
import * as dlqOps from '../application/dlqManager';

/** Helper to get shard from manager (embedded mode only) */
function getShard(manager: ReturnType<typeof getSharedManager>, queue: string): Shard {
  const idx = shardIndex(queue);
  return (manager as unknown as { shards: Shard[] }).shards[idx];
}

/** Helper to create DLQ context (embedded mode only) */
function getDlqContext(manager: ReturnType<typeof getSharedManager>): dlqOps.DlqContext {
  return {
    shards: (manager as unknown as { shards: Shard[] }).shards,
    jobIndex: manager.getJobIndex(),
  };
}

/** Convert client filter to domain filter */
function toDomainFilter(filter: DlqFilter | undefined): DomainDlqFilter | undefined {
  if (!filter) return undefined;
  return filter as unknown as DomainDlqFilter;
}

/** Check if embedded mode should be forced (for tests) */
const FORCE_EMBEDDED = process.env.BUNQUEUE_EMBEDDED === '1';

/**
 * Queue class for adding and managing jobs
 * Default: connects to bunqueue server via TCP
 * Use { embedded: true } for in-process mode
 * Set BUNQUEUE_EMBEDDED=1 env var to force embedded mode
 */
export class Queue<T = unknown> {
  readonly name: string;
  private readonly opts: QueueOptions;
  private readonly embedded: boolean;
  private readonly tcpClient: TcpClient | null;
  private readonly tcpPool: TcpConnectionPool | null;

  constructor(name: string, opts: QueueOptions = {}) {
    this.name = name;
    this.opts = opts;
    this.embedded = opts.embedded ?? FORCE_EMBEDDED;

    if (this.embedded) {
      this.tcpClient = null;
      this.tcpPool = null;
    } else {
      const connOpts: ConnectionOptions = opts.connection ?? {};
      const poolSize = connOpts.poolSize ?? 1;

      if (poolSize > 1) {
        // Use connection pool for parallel operations
        this.tcpPool = new TcpConnectionPool({
          host: connOpts.host ?? 'localhost',
          port: connOpts.port ?? 6789,
          token: connOpts.token,
          poolSize,
        });
        this.tcpClient = null;
      } else {
        // Use single shared connection
        this.tcpClient = getSharedTcpClient({
          host: connOpts.host ?? 'localhost',
          port: connOpts.port ?? 6789,
          token: connOpts.token,
        });
        this.tcpPool = null;
      }
    }
  }

  /** Get TCP client (pool or single) */
  private get tcp(): { send: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>> } {
    return this.tcpPool ?? this.tcpClient!;
  }

  /** Add a job to the queue */
  async add(name: string, data: T, opts: JobOptions = {}): Promise<Job<T>> {
    const merged = { ...this.opts.defaultJobOptions, ...opts };

    if (this.embedded) {
      return this.addEmbedded(name, data, merged);
    }
    return this.addTcp(name, data, merged);
  }

  private async addTcp(name: string, data: T, opts: JobOptions): Promise<Job<T>> {
    const response = await this.tcp.send({
      cmd: 'PUSH',
      queue: this.name,
      data: { name, ...data },
      priority: opts.priority,
      delay: opts.delay,
      maxAttempts: opts.attempts,
      backoff: opts.backoff,
      timeout: opts.timeout,
      customId: opts.jobId,
      removeOnComplete: opts.removeOnComplete,
      removeOnFail: opts.removeOnFail,
    });

    if (!response.ok) {
      throw new Error((response.error as string) ?? 'Failed to add job');
    }

    const jobId = response.id as string;
    return {
      id: jobId,
      name,
      data,
      queueName: this.name,
      attemptsMade: 0,
      timestamp: Date.now(),
      progress: 0,
      updateProgress: async (progress: number, message?: string) => {
        await this.tcp.send({
          cmd: 'Progress',
          id: jobId,
          progress,
          message,
        });
      },
      log: async (message: string) => {
        await this.tcp.send({
          cmd: 'AddLog',
          id: jobId,
          message,
        });
      },
    };
  }

  private async addEmbedded(name: string, data: T, opts: JobOptions): Promise<Job<T>> {
    const manager = getSharedManager();
    const job = await manager.push(this.name, {
      data: { name, ...data },
      priority: opts.priority,
      delay: opts.delay,
      maxAttempts: opts.attempts,
      backoff: opts.backoff,
      timeout: opts.timeout,
      customId: opts.jobId,
      removeOnComplete: opts.removeOnComplete,
      removeOnFail: opts.removeOnFail,
      repeat: opts.repeat,
    });
    return toPublicJob<T>(job, name);
  }

  /** Add multiple jobs (batch optimized) */
  async addBulk(jobs: Array<{ name: string; data: T; opts?: JobOptions }>): Promise<Job<T>[]> {
    if (jobs.length === 0) return [];

    if (this.embedded) {
      return this.addBulkEmbedded(jobs);
    }
    return this.addBulkTcp(jobs);
  }

  private async addBulkTcp(
    jobs: Array<{ name: string; data: T; opts?: JobOptions }>
  ): Promise<Job<T>[]> {
    const now = Date.now();
    const jobInputs = jobs.map(({ name, data, opts }) => {
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
      };
    });

    const response = await this.tcp.send({
      cmd: 'PUSHB',
      queue: this.name,
      jobs: jobInputs,
    });

    if (!response.ok) {
      throw new Error((response.error as string) ?? 'Failed to add jobs');
    }

    const ids = response.ids as string[];
    return ids.map((id, i) => ({
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

  private async addBulkEmbedded(
    jobs: Array<{ name: string; data: T; opts?: JobOptions }>
  ): Promise<Job<T>[]> {
    const manager = getSharedManager();
    const now = Date.now();
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

    const jobIds = await manager.pushBatch(this.name, inputs);
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
    if (this.embedded) {
      const manager = getSharedManager();
      const job = await manager.getJob(jobId(id));
      if (!job) return null;
      const jobData = job.data as { name?: string } | null;
      return toPublicJob<T>(job, jobData?.name ?? 'default');
    }

    const response = await this.tcp.send({
      cmd: 'GetJob',
      id,
    });

    if (!response.ok || !response.job) return null;
    const jobData = response.job as Record<string, unknown>;
    const data = jobData.data as { name?: string } | null;
    return {
      id: String(jobData.id),
      name: data?.name ?? 'default',
      data: jobData.data as T,
      queueName: this.name,
      attemptsMade: (jobData.attempts as number) ?? 0,
      timestamp: (jobData.createdAt as number) ?? Date.now(),
      progress: (jobData.progress as number) ?? 0,
      updateProgress: async () => {},
      log: async () => {},
    };
  }

  /** Remove a job by ID */
  remove(id: string): void {
    if (this.embedded) {
      const manager = getSharedManager();
      void manager.cancel(jobId(id));
    } else {
      void this.tcp.send({ cmd: 'Cancel', id });
    }
  }

  /** Get job counts by state */
  getJobCounts(): { waiting: number; active: number; completed: number; failed: number } {
    if (this.embedded) {
      const stats = getSharedManager().getStats();
      return {
        waiting: stats.waiting,
        active: stats.active,
        completed: stats.completed,
        failed: stats.dlq,
      };
    }

    // TCP mode - sync call not ideal, return zeros
    // For accurate counts, use getJobCountsAsync
    return { waiting: 0, active: 0, completed: 0, failed: 0 };
  }

  /** Get job counts (async, works with TCP) */
  async getJobCountsAsync(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
  }> {
    if (this.embedded) {
      return this.getJobCounts();
    }

    const response = await this.tcp.send({ cmd: 'Stats' });
    if (!response.ok) {
      return { waiting: 0, active: 0, completed: 0, failed: 0 };
    }
    const stats = response.stats as Record<string, number> | undefined;
    if (!stats) {
      return { waiting: 0, active: 0, completed: 0, failed: 0 };
    }
    return {
      waiting: stats.queued ?? 0,
      active: stats.processing ?? 0,
      completed: stats.completed ?? 0,
      failed: stats.dlq ?? 0,
    };
  }

  /** Pause the queue */
  pause(): void {
    if (this.embedded) {
      getSharedManager().pause(this.name);
    } else {
      void this.tcp.send({ cmd: 'Pause', queue: this.name });
    }
  }

  /** Resume the queue */
  resume(): void {
    if (this.embedded) {
      getSharedManager().resume(this.name);
    } else {
      void this.tcp.send({ cmd: 'Resume', queue: this.name });
    }
  }

  /** Remove all waiting jobs */
  drain(): void {
    if (this.embedded) {
      getSharedManager().drain(this.name);
    } else {
      void this.tcp.send({ cmd: 'Drain', queue: this.name });
    }
  }

  /** Remove all queue data (waiting, active, completed, failed) */
  obliterate(): void {
    if (this.embedded) {
      getSharedManager().obliterate(this.name);
    } else {
      void this.tcp.send({ cmd: 'Obliterate', queue: this.name });
    }
  }

  // ============ Stall Detection (embedded only for now) ============

  /** Configure stall detection for this queue */
  setStallConfig(config: Partial<StallConfig>): void {
    if (!this.embedded) {
      console.warn('setStallConfig is only supported in embedded mode');
      return;
    }
    const manager = getSharedManager();
    const shard = getShard(manager, this.name);
    shard.setStallConfig(this.name, config);
  }

  /** Get stall detection configuration */
  getStallConfig(): StallConfig {
    if (!this.embedded) {
      console.warn('getStallConfig is only supported in embedded mode');
      return { enabled: true, stallInterval: 30000, maxStalls: 3, gracePeriod: 5000 };
    }
    const manager = getSharedManager();
    const shard = getShard(manager, this.name);
    return shard.getStallConfig(this.name);
  }

  // ============ DLQ Operations ============

  /** Configure DLQ for this queue (embedded only) */
  setDlqConfig(config: Partial<DlqConfig>): void {
    if (!this.embedded) {
      console.warn('setDlqConfig is only supported in embedded mode');
      return;
    }
    const manager = getSharedManager();
    const ctx = getDlqContext(manager);
    dlqOps.configureDlq(this.name, ctx, config as Partial<DomainDlqConfig>);
  }

  /** Get DLQ configuration (embedded only) */
  getDlqConfig(): DlqConfig {
    if (!this.embedded) {
      console.warn('getDlqConfig is only supported in embedded mode');
      return {};
    }
    const manager = getSharedManager();
    const ctx = getDlqContext(manager);
    return dlqOps.getDlqConfig(this.name, ctx);
  }

  /** Get DLQ entries with optional filter */
  getDlq(filter?: DlqFilter): DlqEntry<T>[] {
    if (!this.embedded) {
      console.warn('getDlq is only supported in embedded mode, use getDlqAsync for TCP');
      return [];
    }
    const manager = getSharedManager();
    const ctx = getDlqContext(manager);
    const entries = dlqOps.getDlqEntries(this.name, ctx, toDomainFilter(filter));
    return entries.map((entry) => toDlqEntry<T>(entry));
  }

  /** Get DLQ statistics (embedded only) */
  getDlqStats(): DlqStats {
    if (!this.embedded) {
      console.warn('getDlqStats is only supported in embedded mode');
      return {
        total: 0,
        byReason: {} as Record<FailureReason, number>,
        pendingRetry: 0,
        expired: 0,
        oldestEntry: null,
        newestEntry: null,
      };
    }
    const manager = getSharedManager();
    const ctx = getDlqContext(manager);
    const stats = dlqOps.getDlqStats(this.name, ctx);
    return {
      total: stats.total,
      byReason: stats.byReason as Record<FailureReason, number>,
      pendingRetry: stats.pendingRetry,
      expired: stats.expired,
      oldestEntry: stats.oldestEntry,
      newestEntry: stats.newestEntry,
    };
  }

  /** Retry jobs from DLQ */
  retryDlq(id?: string): number {
    if (this.embedded) {
      const manager = getSharedManager();
      return manager.retryDlq(this.name, id ? jobId(id) : undefined);
    }
    void this.tcp.send({ cmd: 'RetryDlq', queue: this.name, id });
    return 0; // TCP doesn't return count synchronously
  }

  /** Retry DLQ jobs by filter (embedded only) */
  retryDlqByFilter(filter: DlqFilter): number {
    if (!this.embedded) {
      console.warn('retryDlqByFilter is only supported in embedded mode');
      return 0;
    }
    const manager = getSharedManager();
    const ctx = getDlqContext(manager);
    const domainFilter = toDomainFilter(filter);
    if (!domainFilter) return 0;
    return dlqOps.retryDlqByFilter(this.name, ctx, domainFilter);
  }

  /** Purge all jobs from DLQ */
  purgeDlq(): number {
    if (this.embedded) {
      return getSharedManager().purgeDlq(this.name);
    }
    void this.tcp.send({ cmd: 'PurgeDlq', queue: this.name });
    return 0;
  }

  /** Close the queue */
  async close(): Promise<void> {
    // Close pool if using pooled connections (not shared)
    if (this.tcpPool) {
      this.tcpPool.close();
    }
    // Shared client is managed globally, don't close
  }
}
