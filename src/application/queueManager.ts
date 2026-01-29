/**
 * Queue Manager
 * Core orchestrator for all queue operations
 */

import type { Job, JobId, JobInput } from '../domain/types/job';
import { queueLog } from '../shared/logger';
import type { JobLocation, JobEvent } from '../domain/types/queue';
import type { CronJob, CronJobInput } from '../domain/types/cron';
import type { JobLogEntry } from '../domain/types/worker';
import { Shard } from '../domain/queue/shard';
import { SqliteStorage } from '../infrastructure/persistence/sqlite';
import { CronScheduler } from '../infrastructure/scheduler/cronScheduler';
import { WebhookManager } from './webhookManager';
import { WorkerManager } from './workerManager';
import { EventsManager } from './eventsManager';
import { RWLock, withWriteLock } from '../shared/lock';
import { shardIndex, SHARD_COUNT } from '../shared/hash';
import { pushJob, pushJobBatch, type PushContext } from './operations/push';
import { pullJob, pullJobBatch, type PullContext } from './operations/pull';
import {
  ackJob,
  ackJobBatch,
  ackJobBatchWithResults,
  failJob,
  type AckContext,
} from './operations/ack';
import * as queueControl from './operations/queueControl';
import * as jobMgmt from './operations/jobManagement';
import * as queryOps from './operations/queryOperations';
import * as dlqOps from './dlqManager';
import * as logsOps from './jobLogsManager';
import { generatePrometheusMetrics } from './metricsExporter';
import { LRUMap, BoundedSet, BoundedMap, type SetLike } from '../shared/lru';

/** Queue Manager configuration */
export interface QueueManagerConfig {
  dataPath?: string;
  maxCompletedJobs?: number;
  maxJobResults?: number;
  maxJobLogs?: number;
  maxCustomIds?: number;
  maxWaitingDeps?: number;
  cleanupIntervalMs?: number;
  jobTimeoutCheckMs?: number;
  dependencyCheckMs?: number;
}

const DEFAULT_CONFIG = {
  maxCompletedJobs: 50_000,
  maxJobResults: 5_000,
  maxJobLogs: 10_000,
  maxCustomIds: 50_000,
  maxWaitingDeps: 10_000,
  cleanupIntervalMs: 10_000,
  jobTimeoutCheckMs: 5_000,
  dependencyCheckMs: 1_000,
};

/**
 * QueueManager - Central coordinator
 */
export class QueueManager {
  private readonly config: typeof DEFAULT_CONFIG & { dataPath?: string };
  private readonly storage: SqliteStorage | null;

  // Sharded data structures
  private readonly shards: Shard[] = [];
  private readonly shardLocks: RWLock[] = [];
  private readonly processingShards: Map<JobId, Job>[] = [];
  private readonly processingLocks: RWLock[] = [];

  // Global indexes (bounded with LRU eviction)
  private readonly jobIndex = new Map<JobId, JobLocation>();
  private readonly completedJobs!: BoundedSet<JobId>;
  private readonly jobResults!: BoundedMap<JobId, unknown>;
  private readonly customIdMap!: LRUMap<string, JobId>;
  private readonly jobLogs!: LRUMap<JobId, JobLogEntry[]>;

  // Deferred dependency resolution queue (to avoid lock order violations)
  private readonly pendingDepChecks = new Set<JobId>();
  private depCheckInterval: ReturnType<typeof setInterval> | null = null;

  // Cron scheduler
  private readonly cronScheduler: CronScheduler;

  // Managers
  readonly webhookManager: WebhookManager;
  readonly workerManager: WorkerManager;
  private readonly eventsManager: EventsManager;

  // Job logs config
  private readonly maxLogsPerJob = 100;

  // Metrics
  private readonly metrics = {
    totalPushed: { value: 0n },
    totalPulled: { value: 0n },
    totalCompleted: { value: 0n },
    totalFailed: { value: 0n },
  };
  private readonly startTime = Date.now();

  // Background intervals
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private timeoutInterval: ReturnType<typeof setInterval> | null = null;

  // Queue names cache for O(1) listQueues instead of O(32 * queues)
  private readonly queueNamesCache = new Set<string>();

  constructor(config: QueueManagerConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.storage = config.dataPath ? new SqliteStorage({ path: config.dataPath }) : null;

    // Initialize bounded collections - BoundedSet is faster for completedJobs (no recency tracking needed)
    this.completedJobs = new BoundedSet<JobId>(this.config.maxCompletedJobs, (jobId) => {
      this.jobIndex.delete(jobId);
    });
    this.jobResults = new BoundedMap<JobId, unknown>(this.config.maxJobResults);
    this.customIdMap = new LRUMap<string, JobId>(this.config.maxCustomIds);
    this.jobLogs = new LRUMap<JobId, JobLogEntry[]>(this.config.maxJobLogs);

    // Initialize shards
    for (let i = 0; i < SHARD_COUNT; i++) {
      this.shards.push(new Shard());
      this.shardLocks.push(new RWLock());
      this.processingShards.push(new Map());
      this.processingLocks.push(new RWLock());
    }

    // Initialize cron scheduler
    this.cronScheduler = new CronScheduler();
    this.cronScheduler.setPushCallback(async (queue, input) => {
      await this.push(queue, input);
    });

    // Initialize managers
    this.webhookManager = new WebhookManager();
    this.workerManager = new WorkerManager();
    this.eventsManager = new EventsManager(this.webhookManager);

    // Load and start
    this.recover();
    this.startBackgroundTasks();
  }

  // ============ Context Builders ============

  private getPushContext(): PushContext {
    return {
      storage: this.storage,
      shards: this.shards,
      shardLocks: this.shardLocks,
      completedJobs: this.completedJobs,
      customIdMap: this.customIdMap,
      jobIndex: this.jobIndex,
      totalPushed: this.metrics.totalPushed,
      broadcast: this.eventsManager.broadcast.bind(this.eventsManager),
    };
  }

  private getPullContext(): PullContext {
    return {
      storage: this.storage,
      shards: this.shards,
      shardLocks: this.shardLocks,
      processingShards: this.processingShards,
      processingLocks: this.processingLocks,
      jobIndex: this.jobIndex,
      totalPulled: this.metrics.totalPulled,
      broadcast: this.eventsManager.broadcast.bind(this.eventsManager),
    };
  }

  private getAckContext(): AckContext {
    return {
      storage: this.storage,
      shards: this.shards,
      shardLocks: this.shardLocks,
      processingShards: this.processingShards,
      processingLocks: this.processingLocks,
      completedJobs: this.completedJobs,
      jobResults: this.jobResults,
      jobIndex: this.jobIndex,
      totalCompleted: this.metrics.totalCompleted,
      totalFailed: this.metrics.totalFailed,
      broadcast: this.eventsManager.broadcast.bind(this.eventsManager),
      onJobCompleted: this.onJobCompleted.bind(this),
      onJobsCompleted: this.onJobsCompleted.bind(this),
      needsBroadcast: this.eventsManager.needsBroadcast.bind(this.eventsManager),
      hasPendingDeps: this.hasPendingDeps.bind(this),
    };
  }

  private getJobMgmtContext(): jobMgmt.JobManagementContext {
    return {
      storage: this.storage,
      shards: this.shards,
      shardLocks: this.shardLocks,
      processingShards: this.processingShards,
      processingLocks: this.processingLocks,
      jobIndex: this.jobIndex,
      webhookManager: this.webhookManager,
    };
  }

  private getQueryContext(): queryOps.QueryContext {
    return {
      storage: this.storage,
      shards: this.shards,
      shardLocks: this.shardLocks,
      processingShards: this.processingShards,
      processingLocks: this.processingLocks,
      jobIndex: this.jobIndex,
      completedJobs: this.completedJobs,
      jobResults: this.jobResults,
      customIdMap: this.customIdMap,
    };
  }

  // ============ Core Operations ============

  async push(queue: string, input: JobInput): Promise<Job> {
    // Register queue name in cache for O(1) listQueues
    this.registerQueueName(queue);
    return pushJob(queue, input, this.getPushContext());
  }

  async pushBatch(queue: string, inputs: JobInput[]): Promise<JobId[]> {
    // Register queue name in cache for O(1) listQueues
    this.registerQueueName(queue);
    return pushJobBatch(queue, inputs, this.getPushContext());
  }

  async pull(queue: string, timeoutMs: number = 0): Promise<Job | null> {
    return pullJob(queue, timeoutMs, this.getPullContext());
  }

  /** Pull multiple jobs in single lock acquisition - O(1) instead of O(n) locks */
  async pullBatch(queue: string, count: number, timeoutMs: number = 0): Promise<Job[]> {
    return pullJobBatch(queue, count, timeoutMs, this.getPullContext());
  }

  async ack(jobId: JobId, result?: unknown): Promise<void> {
    return ackJob(jobId, result, this.getAckContext());
  }

  /** Acknowledge multiple jobs in parallel with Promise.all */
  async ackBatch(jobIds: JobId[]): Promise<void> {
    return ackJobBatch(jobIds, this.getAckContext());
  }

  /** Acknowledge multiple jobs with individual results - batch optimized */
  async ackBatchWithResults(items: Array<{ id: JobId; result: unknown }>): Promise<void> {
    return ackJobBatchWithResults(items, this.getAckContext());
  }

  async fail(jobId: JobId, error?: string): Promise<void> {
    return failJob(jobId, error, this.getAckContext());
  }

  // ============ Query Operations (delegated) ============

  async getJob(jobId: JobId): Promise<Job | null> {
    return queryOps.getJob(jobId, this.getQueryContext());
  }

  getResult(jobId: JobId): unknown {
    return queryOps.getJobResult(jobId, this.getQueryContext());
  }

  getJobByCustomId(customId: string): Job | null {
    return queryOps.getJobByCustomId(customId, this.getQueryContext());
  }

  getProgress(jobId: JobId) {
    return queryOps.getJobProgress(jobId, this.getQueryContext());
  }

  count(queue: string): number {
    return queueControl.getQueueCount(queue, { shards: this.shards, jobIndex: this.jobIndex });
  }

  // ============ Queue Control (delegated) ============

  pause(queue: string): void {
    queueControl.pauseQueue(queue, { shards: this.shards, jobIndex: this.jobIndex });
  }

  resume(queue: string): void {
    queueControl.resumeQueue(queue, { shards: this.shards, jobIndex: this.jobIndex });
  }

  isPaused(queue: string): boolean {
    return queueControl.isQueuePaused(queue, { shards: this.shards, jobIndex: this.jobIndex });
  }

  drain(queue: string): number {
    return queueControl.drainQueue(queue, { shards: this.shards, jobIndex: this.jobIndex });
  }

  obliterate(queue: string): void {
    queueControl.obliterateQueue(queue, { shards: this.shards, jobIndex: this.jobIndex });
    // Remove from cache
    this.unregisterQueueName(queue);
  }

  listQueues(): string[] {
    // O(1) using cache instead of O(32 * queues) iterating all shards
    return Array.from(this.queueNamesCache);
  }

  /** Register queue name in cache - called when first job is pushed */
  private registerQueueName(queue: string): void {
    this.queueNamesCache.add(queue);
  }

  /** Unregister queue name from cache - called on obliterate */
  private unregisterQueueName(queue: string): void {
    this.queueNamesCache.delete(queue);
  }

  clean(queue: string, graceMs: number, state?: string, limit?: number): number {
    return queueControl.cleanQueue(
      queue,
      graceMs,
      { shards: this.shards, jobIndex: this.jobIndex },
      state,
      limit
    );
  }

  // ============ DLQ Operations (delegated) ============

  getDlq(queue: string, count?: number): Job[] {
    return dlqOps.getDlqJobs(queue, { shards: this.shards, jobIndex: this.jobIndex }, count);
  }

  retryDlq(queue: string, jobId?: JobId): number {
    return dlqOps.retryDlqJobs(queue, { shards: this.shards, jobIndex: this.jobIndex }, jobId);
  }

  purgeDlq(queue: string): number {
    return dlqOps.purgeDlqJobs(queue, { shards: this.shards, jobIndex: this.jobIndex });
  }

  // ============ Rate Limiting ============

  setRateLimit(queue: string, limit: number): void {
    this.shards[shardIndex(queue)].setRateLimit(queue, limit);
  }

  clearRateLimit(queue: string): void {
    this.shards[shardIndex(queue)].clearRateLimit(queue);
  }

  setConcurrency(queue: string, limit: number): void {
    this.shards[shardIndex(queue)].setConcurrency(queue, limit);
  }

  clearConcurrency(queue: string): void {
    this.shards[shardIndex(queue)].clearConcurrency(queue);
  }

  // ============ Job Management (delegated) ============

  async cancel(jobId: JobId): Promise<boolean> {
    return jobMgmt.cancelJob(jobId, this.getJobMgmtContext());
  }

  async updateProgress(jobId: JobId, progress: number, message?: string): Promise<boolean> {
    return jobMgmt.updateJobProgress(jobId, progress, this.getJobMgmtContext(), message);
  }

  async updateJobData(jobId: JobId, data: unknown): Promise<boolean> {
    return jobMgmt.updateJobData(jobId, data, this.getJobMgmtContext());
  }

  async changePriority(jobId: JobId, priority: number): Promise<boolean> {
    return jobMgmt.changeJobPriority(jobId, priority, this.getJobMgmtContext());
  }

  async promote(jobId: JobId): Promise<boolean> {
    return jobMgmt.promoteJob(jobId, this.getJobMgmtContext());
  }

  async moveToDelayed(jobId: JobId, delay: number): Promise<boolean> {
    return jobMgmt.moveJobToDelayed(jobId, delay, this.getJobMgmtContext());
  }

  async discard(jobId: JobId): Promise<boolean> {
    return jobMgmt.discardJob(jobId, this.getJobMgmtContext());
  }

  // ============ Job Logs (delegated) ============

  addLog(jobId: JobId, message: string, level: 'info' | 'warn' | 'error' = 'info'): boolean {
    return logsOps.addJobLog(
      jobId,
      message,
      {
        jobIndex: this.jobIndex,
        jobLogs: this.jobLogs,
        maxLogsPerJob: this.maxLogsPerJob,
      },
      level
    );
  }

  getLogs(jobId: JobId): JobLogEntry[] {
    return logsOps.getJobLogs(jobId, {
      jobIndex: this.jobIndex,
      jobLogs: this.jobLogs,
      maxLogsPerJob: this.maxLogsPerJob,
    });
  }

  clearLogs(jobId: JobId): void {
    logsOps.clearJobLogs(jobId, {
      jobIndex: this.jobIndex,
      jobLogs: this.jobLogs,
      maxLogsPerJob: this.maxLogsPerJob,
    });
  }

  // ============ Metrics ============

  getPrometheusMetrics(): string {
    return generatePrometheusMetrics(this.getStats(), this.workerManager, this.webhookManager);
  }

  // ============ Cron Operations ============

  addCron(input: CronJobInput): CronJob {
    const cron = this.cronScheduler.add(input);
    this.storage?.saveCron(cron);
    return cron;
  }

  removeCron(name: string): boolean {
    const removed = this.cronScheduler.remove(name);
    if (removed) this.storage?.deleteCron(name);
    return removed;
  }

  getCron(name: string): CronJob | undefined {
    return this.cronScheduler.get(name);
  }

  listCrons(): CronJob[] {
    return this.cronScheduler.list();
  }

  // ============ Events ============

  subscribe(callback: (event: JobEvent) => void): () => void {
    return this.eventsManager.subscribe(callback);
  }

  /** Wait for job completion - event-driven, no polling */
  waitForJobCompletion(jobId: JobId, timeoutMs: number): Promise<boolean> {
    return this.eventsManager.waitForJobCompletion(jobId, timeoutMs);
  }

  // ============ Internal State Access (for validation) ============

  /** Get job index for dependency validation */
  getJobIndex(): Map<JobId, JobLocation> {
    return this.jobIndex;
  }

  /** Get completed jobs set for dependency validation */
  getCompletedJobs(): SetLike<JobId> {
    return this.completedJobs;
  }

  /**
   * Called when a job is completed - schedules deferred dependency check
   * This avoids lock order violations by not iterating shards while holding locks
   */
  private onJobCompleted(completedId: JobId): void {
    this.pendingDepChecks.add(completedId);
  }

  /**
   * Batch version of onJobCompleted - more efficient for large batches
   */
  private onJobsCompleted(completedIds: JobId[]): void {
    for (const id of completedIds) {
      this.pendingDepChecks.add(id);
    }
  }

  /**
   * Check if there are any jobs waiting for dependencies
   * Used to skip dependency tracking when not needed
   */
  private hasPendingDeps(): boolean {
    // Check if any shard has waiting dependencies
    for (const shard of this.shards) {
      if (shard.waitingDeps.size > 0) return true;
    }
    return false;
  }

  /**
   * Process pending dependency checks in a separate task
   * Uses reverse index for O(m) where m = jobs waiting on completed deps
   * Instead of O(n) full scan of all waiting deps
   */
  private async processPendingDependencies(): Promise<void> {
    if (this.pendingDepChecks.size === 0) return;

    // Copy and clear the pending set
    const completedIds = Array.from(this.pendingDepChecks);
    this.pendingDepChecks.clear();

    // Collect jobs to check by shard
    const jobsToCheckByShard = new Map<number, Set<JobId>>();

    // Use reverse index to find only affected jobs - O(m) instead of O(n)
    for (const completedId of completedIds) {
      for (let i = 0; i < SHARD_COUNT; i++) {
        const waitingJobIds = this.shards[i].getJobsWaitingFor(completedId);
        if (waitingJobIds && waitingJobIds.size > 0) {
          let shardJobs = jobsToCheckByShard.get(i);
          if (!shardJobs) {
            shardJobs = new Set();
            jobsToCheckByShard.set(i, shardJobs);
          }
          for (const jobId of waitingJobIds) {
            shardJobs.add(jobId);
          }
        }
      }
    }

    // Process each shard that has affected jobs - in parallel using Promise.all
    await Promise.all(
      Array.from(jobsToCheckByShard.entries()).map(async ([i, jobIdsToCheck]) => {
        const shard = this.shards[i];
        const jobsToPromote: Job[] = [];

        // Check only the affected jobs, not all waiting deps
        for (const jobId of jobIdsToCheck) {
          const job = shard.waitingDeps.get(jobId);
          if (job?.dependsOn.every((dep) => this.completedJobs.has(dep))) {
            jobsToPromote.push(job);
          }
        }

        // Now acquire lock and modify
        if (jobsToPromote.length > 0) {
          await withWriteLock(this.shardLocks[i], () => {
            const now = Date.now();
            for (const job of jobsToPromote) {
              if (shard.waitingDeps.has(job.id)) {
                shard.waitingDeps.delete(job.id);
                // Unregister from dependency index
                shard.unregisterDependencies(job.id, job.dependsOn);
                shard.getQueue(job.queue).push(job);
                // Update running counters for O(1) stats and temporal index
                const isDelayed = job.runAt > now;
                shard.incrementQueued(job.id, isDelayed, job.createdAt, job.queue);
                this.jobIndex.set(job.id, { type: 'queue', shardIdx: i, queueName: job.queue });
              }
            }
            if (jobsToPromote.length > 0) {
              shard.notify();
            }
          });
        }
      })
    );
  }

  // ============ Background Tasks ============

  private startBackgroundTasks(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupIntervalMs);
    this.timeoutInterval = setInterval(() => {
      this.checkJobTimeouts();
    }, this.config.jobTimeoutCheckMs);
    this.depCheckInterval = setInterval(() => {
      this.processPendingDependencies().catch((err: unknown) => {
        queueLog.error('Dependency check failed', { error: String(err) });
      });
    }, this.config.dependencyCheckMs);
    this.cronScheduler.start();
  }

  private checkJobTimeouts(): void {
    const now = Date.now();
    for (const procShard of this.processingShards) {
      for (const [jobId, job] of procShard) {
        if (job.timeout && job.startedAt && now - job.startedAt > job.timeout) {
          this.fail(jobId, 'Job timeout exceeded').catch((err: unknown) => {
            queueLog.error('Failed to mark timed out job as failed', {
              jobId: String(jobId),
              error: String(err),
            });
          });
        }
      }
    }
  }

  private recover(): void {
    if (!this.storage) return;
    for (const job of this.storage.loadPendingJobs()) {
      const idx = shardIndex(job.queue);
      this.shards[idx].getQueue(job.queue).push(job);
      this.jobIndex.set(job.id, { type: 'queue', shardIdx: idx, queueName: job.queue });
      // Register queue name in cache
      this.registerQueueName(job.queue);
    }
    this.cronScheduler.load(this.storage.loadCronJobs());
  }

  // eslint-disable-next-line complexity
  private cleanup(): void {
    // LRU collections auto-evict, but we still need to clean up:
    // 1. Orphaned processing shard entries (jobs stuck in processing)
    // 2. Stale waiting dependencies
    // 3. Orphaned unique keys and active groups
    // 4. Refresh delayed job counters (jobs that became ready)

    const now = Date.now();
    const stallTimeout = 30 * 60 * 1000; // 30 minutes max for processing

    // Refresh delayed counters - update jobs that have become ready
    for (let i = 0; i < SHARD_COUNT; i++) {
      this.shards[i].refreshDelayedCount(now);
    }

    // Compact priority queues if stale ratio > 20% (reclaim memory)
    for (let i = 0; i < SHARD_COUNT; i++) {
      for (const q of this.shards[i].queues.values()) {
        if (q.needsCompaction(0.2)) {
          q.compact();
        }
      }
    }

    // Clean orphaned processing entries
    for (let i = 0; i < SHARD_COUNT; i++) {
      const orphaned: JobId[] = [];
      for (const [jobId, job] of this.processingShards[i]) {
        if (job.startedAt && now - job.startedAt > stallTimeout) {
          orphaned.push(jobId);
        }
      }
      for (const jobId of orphaned) {
        const job = this.processingShards[i].get(jobId);
        if (job) {
          this.processingShards[i].delete(jobId);
          this.jobIndex.delete(jobId);
          queueLog.warn('Cleaned orphaned processing job', { jobId: String(jobId) });
        }
      }
    }

    // Clean stale waiting dependencies (waiting > 1 hour)
    const depTimeout = 60 * 60 * 1000; // 1 hour
    for (let i = 0; i < SHARD_COUNT; i++) {
      const shard = this.shards[i];
      const stale: Job[] = [];
      for (const [_id, job] of shard.waitingDeps) {
        if (now - job.createdAt > depTimeout) {
          stale.push(job);
        }
      }
      for (const job of stale) {
        shard.waitingDeps.delete(job.id);
        // Remove from dependency index
        shard.unregisterDependencies(job.id, job.dependsOn);
        this.jobIndex.delete(job.id);
        queueLog.warn('Cleaned stale waiting dependency', { jobId: String(job.id) });
      }
    }

    // Clean orphaned unique keys (keys with no matching job)
    for (let i = 0; i < SHARD_COUNT; i++) {
      const shard = this.shards[i];
      for (const [queueName, keys] of shard.uniqueKeys) {
        if (keys.size > 1000) {
          // If too many keys, trim oldest half
          const toRemove = Math.floor(keys.size / 2);
          const iter = keys.values();
          for (let j = 0; j < toRemove; j++) {
            const { value, done } = iter.next();
            if (done) break;
            keys.delete(value);
          }
          queueLog.info('Trimmed unique keys', { queue: queueName, removed: toRemove });
        }
      }

      // Clean orphaned active groups
      for (const [queueName, groups] of shard.activeGroups) {
        if (groups.size > 1000) {
          const toRemove = Math.floor(groups.size / 2);
          const iter = groups.values();
          for (let j = 0; j < toRemove; j++) {
            const { value, done } = iter.next();
            if (done) break;
            groups.delete(value);
          }
          queueLog.info('Trimmed active groups', { queue: queueName, removed: toRemove });
        }
      }
    }
  }

  // ============ Lifecycle ============

  shutdown(): void {
    this.cronScheduler.stop();
    this.workerManager.stop();
    this.eventsManager.clear();
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.timeoutInterval) clearInterval(this.timeoutInterval);
    if (this.depCheckInterval) clearInterval(this.depCheckInterval);
    this.storage?.close();

    // Clear in-memory collections
    this.jobIndex.clear();
    this.completedJobs.clear();
    this.jobResults.clear();
    this.jobLogs.clear();
    this.customIdMap.clear();
    this.pendingDepChecks.clear();
    this.queueNamesCache.clear();
    for (const shard of this.processingShards) {
      shard.clear();
    }
    for (const shard of this.shards) {
      shard.waitingDeps.clear();
      shard.dependencyIndex.clear();
      shard.waitingChildren.clear();
      shard.uniqueKeys.clear();
      shard.activeGroups.clear();
    }
  }

  getStats() {
    let waiting = 0,
      delayed = 0,
      active = 0,
      dlq = 0;

    // O(32) instead of O(n) - use running counters from each shard
    for (let i = 0; i < SHARD_COUNT; i++) {
      const shardStats = this.shards[i].getStats();
      const queuedTotal = shardStats.queuedJobs;
      const delayedInShard = shardStats.delayedJobs;

      // waiting = queued jobs that are not delayed
      waiting += Math.max(0, queuedTotal - delayedInShard);
      delayed += delayedInShard;
      dlq += shardStats.dlqJobs;
      active += this.processingShards[i].size;
    }

    const cronStats = this.cronScheduler.getStats();
    return {
      waiting,
      delayed,
      active,
      dlq,
      completed: this.completedJobs.size,
      totalPushed: this.metrics.totalPushed.value,
      totalPulled: this.metrics.totalPulled.value,
      totalCompleted: this.metrics.totalCompleted.value,
      totalFailed: this.metrics.totalFailed.value,
      uptime: Date.now() - this.startTime,
      cronJobs: cronStats.total,
      cronPending: cronStats.pending,
    };
  }
}
