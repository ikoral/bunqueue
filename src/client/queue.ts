/**
 * Queue - BullMQ-style API
 */

import { getSharedManager } from './manager';
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

/** Helper to get shard from manager */
function getShard(manager: ReturnType<typeof getSharedManager>, queue: string): Shard {
  const idx = shardIndex(queue);
  // Access internal shards array (safe cast for embedded mode)
  return (manager as unknown as { shards: Shard[] }).shards[idx];
}

/** Helper to create DLQ context */
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

  // ============ Stall Detection ============

  /** Configure stall detection for this queue */
  setStallConfig(config: Partial<StallConfig>): void {
    const manager = getSharedManager();
    const shard = getShard(manager, this.name);
    shard.setStallConfig(this.name, config);
  }

  /** Get stall detection configuration */
  getStallConfig(): StallConfig {
    const manager = getSharedManager();
    const shard = getShard(manager, this.name);
    return shard.getStallConfig(this.name);
  }

  // ============ DLQ Operations ============

  /** Configure DLQ for this queue */
  setDlqConfig(config: Partial<DlqConfig>): void {
    const manager = getSharedManager();
    const ctx = getDlqContext(manager);
    dlqOps.configureDlq(this.name, ctx, config as Partial<DomainDlqConfig>);
  }

  /** Get DLQ configuration */
  getDlqConfig(): DlqConfig {
    const manager = getSharedManager();
    const ctx = getDlqContext(manager);
    return dlqOps.getDlqConfig(this.name, ctx);
  }

  /** Get DLQ entries with optional filter */
  getDlq(filter?: DlqFilter): DlqEntry<T>[] {
    const manager = getSharedManager();
    const ctx = getDlqContext(manager);
    const entries = dlqOps.getDlqEntries(this.name, ctx, toDomainFilter(filter));
    return entries.map((entry) => toDlqEntry<T>(entry));
  }

  /** Get DLQ statistics */
  getDlqStats(): DlqStats {
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
    const manager = getSharedManager();
    return manager.retryDlq(this.name, id ? jobId(id) : undefined);
  }

  /** Retry DLQ jobs by filter */
  retryDlqByFilter(filter: DlqFilter): number {
    const manager = getSharedManager();
    const ctx = getDlqContext(manager);
    const domainFilter = toDomainFilter(filter);
    if (!domainFilter) return 0;
    return dlqOps.retryDlqByFilter(this.name, ctx, domainFilter);
  }

  /** Purge all jobs from DLQ */
  purgeDlq(): number {
    return getSharedManager().purgeDlq(this.name);
  }

  /** Close the queue */
  async close(): Promise<void> {
    // No-op for embedded mode
  }
}
