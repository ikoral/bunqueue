/**
 * Queue Manager
 * Core orchestrator for all queue operations
 */

import type { Job, JobId, JobInput, JobLock, LockToken } from '../domain/types/job';
import {
  calculateBackoff,
  createJobLock,
  isLockExpired,
  renewLock,
  DEFAULT_LOCK_TTL,
} from '../domain/types/job';
import { queueLog } from '../shared/logger';
import type { JobLocation, JobEvent } from '../domain/types/queue';
import { EventType } from '../domain/types/queue';
import type { CronJob, CronJobInput } from '../domain/types/cron';
import type { JobLogEntry } from '../domain/types/worker';
import type { WebhookEvent } from '../domain/types/webhook';
import { FailureReason } from '../domain/types/dlq';
import { StallAction, getStallAction, incrementStallCount } from '../domain/types/stall';
import { Shard } from '../domain/queue/shard';
import { SqliteStorage } from '../infrastructure/persistence/sqlite';
import { CronScheduler } from '../infrastructure/scheduler/cronScheduler';
import { WebhookManager } from './webhookManager';
import { WorkerManager } from './workerManager';
import { EventsManager } from './eventsManager';
import { RWLock, withWriteLock } from '../shared/lock';
import { shardIndex, processingShardIndex, SHARD_COUNT } from '../shared/hash';
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
  stallCheckMs?: number;
  dlqMaintenanceMs?: number;
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
  stallCheckMs: 5_000,
  dlqMaintenanceMs: 60_000,
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

  // Two-phase stall detection (like BullMQ)
  // Jobs are added here on first check, confirmed stalled on second check
  private readonly stalledCandidates = new Set<JobId>();

  // Lock-based job ownership tracking (BullMQ-style)
  // Maps jobId to lock info (token, owner, expiration)
  private readonly jobLocks = new Map<JobId, JobLock>();

  // Client-job tracking for connection-based release
  // When a TCP connection closes, all jobs owned by that client are released
  private readonly clientJobs = new Map<string, Set<JobId>>();

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
  private stallCheckInterval: ReturnType<typeof setInterval> | null = null;
  private dlqMaintenanceInterval: ReturnType<typeof setInterval> | null = null;
  private lockCheckInterval: ReturnType<typeof setInterval> | null = null;

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
      onRepeat: this.handleRepeat.bind(this),
    };
  }

  /** Handle repeatable job - re-queue with incremented count */
  private handleRepeat(job: Job): void {
    if (!job.repeat) return;

    const delay = job.repeat.every ?? 0;
    void this.push(job.queue, {
      data: job.data,
      priority: job.priority,
      delay,
      maxAttempts: job.maxAttempts,
      backoff: job.backoff,
      ttl: job.ttl ?? undefined,
      timeout: job.timeout ?? undefined,
      tags: job.tags,
      groupId: job.groupId ?? undefined,
      lifo: job.lifo,
      removeOnComplete: job.removeOnComplete,
      removeOnFail: job.removeOnFail,
      repeat: {
        every: job.repeat.every,
        limit: job.repeat.limit,
        pattern: job.repeat.pattern,
        count: job.repeat.count + 1,
      },
    });
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

  private getDlqContext(): dlqOps.DlqContext {
    return {
      shards: this.shards,
      jobIndex: this.jobIndex,
      storage: this.storage,
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

  /**
   * Pull a job and create a lock for it (BullMQ-style).
   * Returns both the job and its lock token for ownership verification.
   */
  async pullWithLock(
    queue: string,
    owner: string,
    timeoutMs: number = 0,
    lockTtl: number = DEFAULT_LOCK_TTL
  ): Promise<{ job: Job | null; token: string | null }> {
    const job = await pullJob(queue, timeoutMs, this.getPullContext());
    if (!job) return { job: null, token: null };

    const token = this.createLock(job.id, owner, lockTtl);
    return { job, token };
  }

  /** Pull multiple jobs in single lock acquisition - O(1) instead of O(n) locks */
  async pullBatch(queue: string, count: number, timeoutMs: number = 0): Promise<Job[]> {
    return pullJobBatch(queue, count, timeoutMs, this.getPullContext());
  }

  /**
   * Pull multiple jobs and create locks for them (BullMQ-style).
   * Returns both jobs and their lock tokens for ownership verification.
   */
  async pullBatchWithLock(
    queue: string,
    count: number,
    owner: string,
    timeoutMs: number = 0,
    lockTtl: number = DEFAULT_LOCK_TTL
  ): Promise<{ jobs: Job[]; tokens: string[] }> {
    const jobs = await pullJobBatch(queue, count, timeoutMs, this.getPullContext());
    const tokens: string[] = [];

    for (const job of jobs) {
      const token = this.createLock(job.id, owner, lockTtl);
      tokens.push(token ?? '');
    }

    return { jobs, tokens };
  }

  async ack(jobId: JobId, result?: unknown, token?: string): Promise<void> {
    // If token provided, verify ownership before acknowledging
    if (token && !this.verifyLock(jobId, token)) {
      throw new Error(`Invalid or expired lock token for job ${jobId}`);
    }
    await ackJob(jobId, result, this.getAckContext());
    // Release lock after successful ack
    this.releaseLock(jobId, token);
  }

  /** Acknowledge multiple jobs in parallel with Promise.all */
  async ackBatch(jobIds: JobId[], tokens?: string[]): Promise<void> {
    // Verify all tokens first if provided
    if (tokens?.length === jobIds.length) {
      for (let i = 0; i < jobIds.length; i++) {
        const t = tokens[i];
        if (t && !this.verifyLock(jobIds[i], t)) {
          throw new Error(`Invalid or expired lock token for job ${jobIds[i]}`);
        }
      }
    }
    await ackJobBatch(jobIds, this.getAckContext());
    // Release locks after successful ack
    if (tokens) {
      for (let i = 0; i < jobIds.length; i++) {
        this.releaseLock(jobIds[i], tokens[i]);
      }
    }
  }

  /** Acknowledge multiple jobs with individual results - batch optimized */
  async ackBatchWithResults(
    items: Array<{ id: JobId; result: unknown; token?: string }>
  ): Promise<void> {
    // Verify all tokens first if provided
    for (const item of items) {
      if (item.token && !this.verifyLock(item.id, item.token)) {
        throw new Error(`Invalid or expired lock token for job ${item.id}`);
      }
    }
    await ackJobBatchWithResults(items, this.getAckContext());
    // Release locks after successful ack
    for (const item of items) {
      this.releaseLock(item.id, item.token);
    }
  }

  async fail(jobId: JobId, error?: string, token?: string): Promise<void> {
    // If token provided, verify ownership before failing
    if (token && !this.verifyLock(jobId, token)) {
      throw new Error(`Invalid or expired lock token for job ${jobId}`);
    }
    await failJob(jobId, error, this.getAckContext());
    // Release lock after fail
    this.releaseLock(jobId, token);
  }

  /**
   * Update job heartbeat for stall detection (single job).
   * If token is provided, also renews the lock.
   */
  jobHeartbeat(jobId: JobId, token?: string): boolean {
    const loc = this.jobIndex.get(jobId);
    if (loc?.type !== 'processing') return false;

    // If token provided, renew lock (which also updates heartbeat)
    if (token) {
      return this.renewJobLock(jobId, token);
    }

    // Legacy mode: just update heartbeat without token verification
    const processing = this.processingShards[loc.shardIdx];
    const job = processing.get(jobId);

    if (job) {
      job.lastHeartbeat = Date.now();
      return true;
    }
    return false;
  }

  /**
   * Update job heartbeat for multiple jobs (batch).
   * If tokens are provided, also renews the locks.
   */
  jobHeartbeatBatch(jobIds: JobId[], tokens?: string[]): number {
    let count = 0;
    for (let i = 0; i < jobIds.length; i++) {
      const token = tokens?.[i];
      if (this.jobHeartbeat(jobIds[i], token)) count++;
    }
    return count;
  }

  // ============ Lock Management (BullMQ-style) ============

  /**
   * Create a lock for a job when it's pulled for processing.
   * @returns The lock token, or null if job not in processing
   */
  createLock(jobId: JobId, owner: string, ttl: number = DEFAULT_LOCK_TTL): LockToken | null {
    const loc = this.jobIndex.get(jobId);
    if (loc?.type !== 'processing') return null;

    // Check if lock already exists (shouldn't happen, but defensive)
    if (this.jobLocks.has(jobId)) {
      queueLog.warn('Lock already exists for job', { jobId: String(jobId), owner });
      return null;
    }

    const lock = createJobLock(jobId, owner, ttl);
    this.jobLocks.set(jobId, lock);
    return lock.token;
  }

  /**
   * Verify that a token is valid for a job.
   * @returns true if token matches the active lock
   */
  verifyLock(jobId: JobId, token: string): boolean {
    const lock = this.jobLocks.get(jobId);
    if (!lock) return false;
    if (lock.token !== token) return false;
    if (isLockExpired(lock)) return false;
    return true;
  }

  /**
   * Renew a lock with the given token.
   * @returns true if renewal succeeded, false if token invalid or lock expired
   */
  renewJobLock(jobId: JobId, token: string, newTtl?: number): boolean {
    const lock = this.jobLocks.get(jobId);
    if (!lock) return false;
    if (lock.token !== token) return false;
    if (isLockExpired(lock)) {
      // Lock already expired, remove it
      this.jobLocks.delete(jobId);
      return false;
    }

    renewLock(lock, newTtl);

    // Also update lastHeartbeat on the job (for legacy stall detection compatibility)
    const loc = this.jobIndex.get(jobId);
    if (loc?.type === 'processing') {
      const job = this.processingShards[loc.shardIdx].get(jobId);
      if (job) job.lastHeartbeat = Date.now();
    }

    return true;
  }

  /**
   * Renew locks for multiple jobs (batch operation).
   * @returns Array of jobIds that were successfully renewed
   */
  renewJobLockBatch(items: Array<{ id: JobId; token: string; ttl?: number }>): string[] {
    const renewed: string[] = [];
    for (const item of items) {
      if (this.renewJobLock(item.id, item.token, item.ttl)) {
        renewed.push(String(item.id));
      }
    }
    return renewed;
  }

  /**
   * Release a lock when job is completed or failed.
   * Should be called by ACK/FAIL operations.
   */
  releaseLock(jobId: JobId, token?: string): boolean {
    const lock = this.jobLocks.get(jobId);
    if (!lock) return true; // No lock to release

    // If token provided, verify it matches
    if (token && lock.token !== token) {
      queueLog.warn('Token mismatch on lock release', {
        jobId: String(jobId),
        expected: lock.token.substring(0, 8),
        got: token.substring(0, 8),
      });
      return false;
    }

    this.jobLocks.delete(jobId);
    return true;
  }

  /**
   * Get lock info for a job (for debugging/monitoring).
   */
  getLockInfo(jobId: JobId): JobLock | null {
    return this.jobLocks.get(jobId) ?? null;
  }

  // ============ Client-Job Tracking ============

  /**
   * Register a job as owned by a client (called on PULL).
   */
  registerClientJob(clientId: string, jobId: JobId): void {
    let jobs = this.clientJobs.get(clientId);
    if (!jobs) {
      jobs = new Set();
      this.clientJobs.set(clientId, jobs);
    }
    jobs.add(jobId);
  }

  /**
   * Unregister a job from a client (called on ACK/FAIL).
   */
  unregisterClientJob(clientId: string | undefined, jobId: JobId): void {
    if (!clientId) return;
    const jobs = this.clientJobs.get(clientId);
    if (jobs) {
      jobs.delete(jobId);
      if (jobs.size === 0) {
        this.clientJobs.delete(clientId);
      }
    }
  }

  /**
   * Release all jobs owned by a client back to queue (called on TCP disconnect).
   * Returns the number of jobs released.
   */
  releaseClientJobs(clientId: string): number {
    const jobs = this.clientJobs.get(clientId);
    if (!jobs || jobs.size === 0) {
      this.clientJobs.delete(clientId);
      return 0;
    }

    let released = 0;
    const now = Date.now();

    for (const jobId of jobs) {
      const loc = this.jobIndex.get(jobId);
      if (loc?.type !== 'processing') continue;

      const procIdx = loc.shardIdx;
      const job = this.processingShards[procIdx].get(jobId);
      if (!job) continue;

      // Remove from processing
      this.processingShards[procIdx].delete(jobId);

      // Release lock if exists
      this.jobLocks.delete(jobId);

      // Release concurrency
      const idx = shardIndex(job.queue);
      const shard = this.shards[idx];
      shard.releaseConcurrency(job.queue);

      // Release group if active
      if (job.groupId) {
        shard.releaseGroup(job.queue, job.groupId);
      }

      // Reset job state for retry
      job.startedAt = null;
      job.lastHeartbeat = now;

      // Re-queue the job
      shard.getQueue(job.queue).push(job);
      const isDelayed = job.runAt > now;
      shard.incrementQueued(jobId, isDelayed, job.createdAt, job.queue, job.runAt);
      this.jobIndex.set(jobId, { type: 'queue', shardIdx: idx, queueName: job.queue });

      released++;
    }

    // Clear client tracking
    this.clientJobs.delete(clientId);

    if (released > 0) {
      queueLog.info('Released client jobs', { clientId: clientId.substring(0, 8), released });
    }

    return released;
  }

  /**
   * Check and handle expired locks.
   * Jobs with expired locks are requeued for retry.
   */
  private checkExpiredLocks(): void {
    const now = Date.now();
    const expired: Array<{ jobId: JobId; lock: JobLock }> = [];

    for (const [jobId, lock] of this.jobLocks) {
      if (isLockExpired(lock, now)) {
        expired.push({ jobId, lock });
      }
    }

    for (const { jobId, lock } of expired) {
      const procIdx = processingShardIndex(String(jobId));
      const job = this.processingShards[procIdx].get(jobId);

      if (job) {
        const idx = shardIndex(job.queue);
        const shard = this.shards[idx];
        const queue = shard.getQueue(job.queue);

        // Remove from processing
        this.processingShards[procIdx].delete(jobId);

        // Increment attempts and reset state
        job.attempts++;
        job.startedAt = null;
        job.lastHeartbeat = now;
        job.stallCount++;

        // Check if max stalls exceeded
        const stallConfig = shard.getStallConfig(job.queue);
        if (stallConfig.maxStalls > 0 && job.stallCount >= stallConfig.maxStalls) {
          // Move to DLQ using shard's addToDlq method
          shard.addToDlq(
            job,
            FailureReason.Stalled,
            `Lock expired after ${lock.renewalCount} renewals`
          );
          this.jobIndex.set(jobId, { type: 'dlq', queueName: job.queue });

          queueLog.warn('Job moved to DLQ due to lock expiration', {
            jobId: String(jobId),
            queue: job.queue,
            owner: lock.owner,
            renewals: lock.renewalCount,
            stallCount: job.stallCount,
          });

          this.eventsManager.broadcast({
            eventType: EventType.Failed,
            jobId,
            queue: job.queue,
            timestamp: now,
            error: 'Lock expired (max stalls reached)',
          });
        } else {
          // Requeue for retry (always push - priority queue handles ordering)
          queue.push(job);
          this.jobIndex.set(jobId, { type: 'queue', shardIdx: idx, queueName: job.queue });

          queueLog.info('Job requeued due to lock expiration', {
            jobId: String(jobId),
            queue: job.queue,
            owner: lock.owner,
            renewals: lock.renewalCount,
            attempt: job.attempts,
          });

          this.eventsManager.broadcast({
            eventType: EventType.Stalled,
            jobId,
            queue: job.queue,
            timestamp: now,
          });
        }
      }

      // Remove the expired lock
      this.jobLocks.delete(jobId);
    }

    if (expired.length > 0) {
      queueLog.info('Processed expired locks', { count: expired.length });
    }
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

  /** Get job counts grouped by priority for a queue */
  getCountsPerPriority(queue: string): Record<number, number> {
    const idx = shardIndex(queue);
    const counts = this.shards[idx].getCountsPerPriority(queue);
    return Object.fromEntries(counts);
  }

  /**
   * Get jobs with filtering and pagination
   * @param queue - Queue name
   * @param options - Filter options
   * @returns Array of jobs matching the criteria
   */
  getJobs(
    queue: string,
    options: {
      state?: 'waiting' | 'delayed' | 'active' | 'completed' | 'failed';
      start?: number;
      end?: number;
      asc?: boolean;
    } = {}
  ): Job[] {
    const { state, start = 0, end = 100, asc = true } = options;
    const idx = shardIndex(queue);
    const shard = this.shards[idx];
    const now = Date.now();

    const jobs: Job[] = [];

    // Collect jobs based on state filter
    if (!state || state === 'waiting') {
      const queueJobs = shard.getQueue(queue).values();
      jobs.push(...queueJobs.filter((j) => j.runAt <= now));
    }

    if (!state || state === 'delayed') {
      const queueJobs = shard.getQueue(queue).values();
      jobs.push(...queueJobs.filter((j) => j.runAt > now));
    }

    if (!state || state === 'active') {
      for (let i = 0; i < SHARD_COUNT; i++) {
        for (const job of this.processingShards[i].values()) {
          if (job.queue === queue) {
            jobs.push(job);
          }
        }
      }
    }

    if (!state || state === 'failed') {
      const dlqJobs = shard.getDlq(queue);
      jobs.push(...dlqJobs);
    }

    // For completed jobs, check completed jobs set
    if (state === 'completed') {
      // Iterate completedJobs and filter by queue
      // Note: This is not efficient for large sets, but provides the data
      for (const jobId of this.completedJobs) {
        const result = this.jobResults.get(jobId);
        if (result) {
          // We don't have the full job object for completed jobs in memory
          // Just count them or return IDs - for now skip completed state
        }
      }
      // Completed jobs are stored in SQLite, would need storage access
      // For now, return empty for completed state if not in DLQ
    }

    // Sort by createdAt
    jobs.sort((a, b) => (asc ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));

    // Apply pagination
    return jobs.slice(start, end);
  }

  // ============ DLQ Operations (delegated) ============

  getDlq(queue: string, count?: number): Job[] {
    return dlqOps.getDlqJobs(queue, this.getDlqContext(), count);
  }

  retryDlq(queue: string, jobId?: JobId): number {
    return dlqOps.retryDlqJobs(queue, this.getDlqContext(), jobId);
  }

  purgeDlq(queue: string): number {
    return dlqOps.purgeDlqJobs(queue, this.getDlqContext());
  }

  /**
   * Retry a completed job by re-queueing it
   * @param queue - Queue name
   * @param jobId - Specific job ID to retry (optional - retries all if not specified)
   * @returns Number of jobs retried
   */
  retryCompleted(queue: string, jobId?: JobId): number {
    if (jobId) {
      // Check if job is in completedJobs set
      if (!this.completedJobs.has(jobId)) {
        return 0;
      }

      // Get job from storage
      const job = this.storage?.getJob(jobId);
      if (job?.queue !== queue) {
        return 0;
      }

      return this.requeueCompletedJob(job);
    }

    // Retry all completed jobs for queue
    let count = 0;
    for (const id of this.completedJobs) {
      const job = this.storage?.getJob(id);
      if (job?.queue === queue) {
        count += this.requeueCompletedJob(job);
      }
    }
    return count;
  }

  /**
   * Internal helper to re-queue a completed job
   */
  private requeueCompletedJob(job: Job): number {
    // Reset job state
    job.attempts = 0;
    job.startedAt = null;
    job.completedAt = null;
    job.runAt = Date.now();
    job.progress = 0;

    // Re-queue
    const idx = shardIndex(job.queue);
    const shard = this.shards[idx];
    shard.getQueue(job.queue).push(job);
    shard.incrementQueued(job.id, false, job.createdAt, job.queue, job.runAt);

    // Update index
    this.jobIndex.set(job.id, { type: 'queue', shardIdx: idx, queueName: job.queue });

    // Cleanup completed tracking
    this.completedJobs.delete(job.id);
    this.jobResults.delete(job.id);

    // Update storage
    this.storage?.updateForRetry(job);

    // Notify
    shard.notify();

    return 1;
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
                shard.incrementQueued(job.id, isDelayed, job.createdAt, job.queue, job.runAt);
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
    this.stallCheckInterval = setInterval(() => {
      this.checkStalledJobs();
    }, this.config.stallCheckMs);
    this.dlqMaintenanceInterval = setInterval(() => {
      this.performDlqMaintenance();
    }, this.config.dlqMaintenanceMs);
    // Lock expiration check runs at same interval as stall check
    this.lockCheckInterval = setInterval(() => {
      this.checkExpiredLocks();
    }, this.config.stallCheckMs);
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

  /**
   * Check for stalled jobs and handle them
   * Uses two-phase detection (like BullMQ) to prevent false positives:
   * - Phase 1: Jobs marked as candidates in previous check are confirmed stalled
   * - Phase 2: Current processing jobs are marked as candidates for next check
   */
  private checkStalledJobs(): void {
    const now = Date.now();
    const confirmedStalled: Array<{ job: Job; action: StallAction }> = [];

    // Phase 1: Check jobs that were candidates from previous cycle
    // If still in processing and still meets stall criteria → confirmed stalled
    for (const jobId of this.stalledCandidates) {
      // Find job in processing shards
      const procIdx = processingShardIndex(String(jobId));
      const job = this.processingShards[procIdx].get(jobId);

      if (!job) {
        // Job completed between checks - not stalled (false positive avoided!)
        this.stalledCandidates.delete(jobId);
        continue;
      }

      const stallConfig = this.shards[shardIndex(job.queue)].getStallConfig(job.queue);
      if (!stallConfig.enabled) {
        this.stalledCandidates.delete(jobId);
        continue;
      }

      // Re-check stall criteria (job might have received heartbeat)
      const action = getStallAction(job, stallConfig, now);
      if (action !== StallAction.Keep) {
        // Confirmed stalled - was candidate AND still meets criteria
        confirmedStalled.push({ job, action });
      }

      // Remove from candidates (will be re-added in phase 2 if still processing)
      this.stalledCandidates.delete(jobId);
    }

    // Phase 2: Mark current processing jobs as candidates for NEXT check
    for (let i = 0; i < SHARD_COUNT; i++) {
      const procShard = this.processingShards[i];

      for (const [jobId, job] of procShard) {
        const stallConfig = this.shards[shardIndex(job.queue)].getStallConfig(job.queue);
        if (!stallConfig.enabled) continue;

        // Only mark as candidate if past grace period and no recent heartbeat
        const action = getStallAction(job, stallConfig, now);
        if (action !== StallAction.Keep) {
          // Add to candidates - will be checked in NEXT cycle
          this.stalledCandidates.add(jobId);
        }
      }
    }

    // Process confirmed stalled jobs
    for (const { job, action } of confirmedStalled) {
      this.handleStalledJob(job, action).catch((err: unknown) => {
        queueLog.error('Failed to handle stalled job', {
          jobId: String(job.id),
          error: String(err),
        });
      });
    }
  }

  /**
   * Handle a stalled job based on the action
   */
  private async handleStalledJob(job: Job, action: StallAction): Promise<void> {
    const idx = shardIndex(job.queue);
    const shard = this.shards[idx];
    const procIdx = processingShardIndex(String(job.id));

    // Emit stalled event
    this.eventsManager.broadcast({
      eventType: EventType.Stalled,
      queue: job.queue,
      jobId: job.id,
      timestamp: Date.now(),
      data: { stallCount: job.stallCount + 1, action },
    });
    void this.webhookManager.trigger('stalled' as WebhookEvent, String(job.id), job.queue, {
      data: { stallCount: job.stallCount + 1, action },
    });

    if (action === StallAction.MoveToDlq) {
      // Max stalls reached - move to DLQ
      queueLog.warn('Job exceeded max stalls, moving to DLQ', {
        jobId: String(job.id),
        queue: job.queue,
        stallCount: job.stallCount,
      });

      // Remove from processing
      this.processingShards[procIdx].delete(job.id);
      shard.releaseConcurrency(job.queue);

      // Add to DLQ with stalled reason
      const entry = shard.addToDlq(
        job,
        FailureReason.Stalled,
        `Job stalled ${job.stallCount + 1} times`
      );
      this.jobIndex.set(job.id, { type: 'dlq', queueName: job.queue });

      // Persist DLQ entry
      this.storage?.saveDlqEntry(entry);
    } else {
      // Retry - increment stall count and re-queue
      incrementStallCount(job);
      job.attempts++;
      job.startedAt = null;
      job.runAt = Date.now() + calculateBackoff(job);
      job.lastHeartbeat = Date.now();

      queueLog.warn('Job stalled, retrying', {
        jobId: String(job.id),
        queue: job.queue,
        stallCount: job.stallCount,
        attempt: job.attempts,
      });

      // Remove from processing
      this.processingShards[procIdx].delete(job.id);
      shard.releaseConcurrency(job.queue);

      // Re-queue
      shard.getQueue(job.queue).push(job);
      const isDelayed = job.runAt > Date.now();
      shard.incrementQueued(job.id, isDelayed, job.createdAt, job.queue, job.runAt);
      this.jobIndex.set(job.id, { type: 'queue', shardIdx: idx, queueName: job.queue });

      // Persist
      this.storage?.updateForRetry(job);
    }
  }

  /**
   * Perform DLQ maintenance: auto-retry and purge expired
   */
  private performDlqMaintenance(): void {
    const ctx = this.getDlqContext();

    // Process each queue
    for (const queueName of this.queueNamesCache) {
      try {
        // Auto-retry eligible entries
        const retried = dlqOps.processAutoRetry(queueName, ctx);
        if (retried > 0) {
          queueLog.info('DLQ auto-retry completed', { queue: queueName, retried });
        }

        // Purge expired entries
        const purged = dlqOps.purgeExpiredDlq(queueName, ctx);
        if (purged > 0) {
          queueLog.info('DLQ purge completed', { queue: queueName, purged });
        }
      } catch (err) {
        queueLog.error('DLQ maintenance failed', { queue: queueName, error: String(err) });
      }
    }
  }

  private recover(): void {
    if (!this.storage) return;

    // Load pending jobs
    const now = Date.now();
    for (const job of this.storage.loadPendingJobs()) {
      const idx = shardIndex(job.queue);
      const shard = this.shards[idx];
      shard.getQueue(job.queue).push(job);
      this.jobIndex.set(job.id, { type: 'queue', shardIdx: idx, queueName: job.queue });
      // Update running counters for O(1) stats
      const isDelayed = job.runAt > now;
      shard.incrementQueued(job.id, isDelayed, job.createdAt, job.queue, job.runAt);
      // Register queue name in cache
      this.registerQueueName(job.queue);
    }

    // Load DLQ entries
    const dlqEntries = this.storage.loadDlq();
    let dlqCount = 0;
    for (const [queue, entries] of dlqEntries) {
      const idx = shardIndex(queue);
      const shard = this.shards[idx];
      for (const entry of entries) {
        // Add to shard's DLQ (directly set since we're loading)
        let dlq = shard.dlq.get(queue);
        if (!dlq) {
          dlq = [];
          shard.dlq.set(queue, dlq);
        }
        dlq.push(entry);
        shard.incrementDlq();
        dlqCount++;
      }
      this.registerQueueName(queue);
    }
    if (dlqCount > 0) {
      queueLog.info('Loaded DLQ entries', { count: dlqCount });
    }

    // Load cron jobs
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

    // Clean orphaned and expired unique keys
    for (let i = 0; i < SHARD_COUNT; i++) {
      const shard = this.shards[i];
      // First, clean expired unique keys
      const expiredCleaned = shard.cleanExpiredUniqueKeys();
      if (expiredCleaned > 0) {
        queueLog.info('Cleaned expired unique keys', { shard: i, removed: expiredCleaned });
      }

      // Then trim if too many keys remain
      for (const [queueName, keys] of shard.uniqueKeys) {
        if (keys.size > 1000) {
          // If too many keys, trim oldest half
          const toRemove = Math.floor(keys.size / 2);
          const iter = keys.keys();
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

    // Clean stale stalledCandidates (jobs no longer in processing)
    for (const jobId of this.stalledCandidates) {
      const loc = this.jobIndex.get(jobId);
      if (loc?.type !== 'processing') {
        this.stalledCandidates.delete(jobId);
      }
    }

    // Clean orphaned jobIndex entries (pointing to invalid locations)
    // This is expensive so only run if index is large
    if (this.jobIndex.size > 100_000) {
      let orphanedCount = 0;
      for (const [jobId, loc] of this.jobIndex) {
        if (loc.type === 'processing') {
          const procIdx = processingShardIndex(String(jobId));
          if (!this.processingShards[procIdx].has(jobId)) {
            this.jobIndex.delete(jobId);
            orphanedCount++;
          }
        } else if (loc.type === 'queue') {
          // Check if job still exists in shard
          const shard = this.shards[loc.shardIdx];
          if (!shard.getQueue(loc.queueName).has(jobId)) {
            this.jobIndex.delete(jobId);
            orphanedCount++;
          }
        }
      }
      if (orphanedCount > 0) {
        queueLog.info('Cleaned orphaned jobIndex entries', { count: orphanedCount });
      }
    }

    // Clean orphaned job locks (locks for jobs no longer in processing)
    for (const jobId of this.jobLocks.keys()) {
      const loc = this.jobIndex.get(jobId);
      if (loc?.type !== 'processing') {
        this.jobLocks.delete(jobId);
      }
    }

    // Remove empty queues to free memory (like obliterate but only for empty queues)
    for (let i = 0; i < SHARD_COUNT; i++) {
      const shard = this.shards[i];
      const emptyQueues: string[] = [];

      for (const [queueName, queue] of shard.queues) {
        // Queue is empty and has no DLQ entries
        const dlqEntries = shard.dlq.get(queueName);
        if (queue.size === 0 && (!dlqEntries || dlqEntries.length === 0)) {
          emptyQueues.push(queueName);
        }
      }

      for (const queueName of emptyQueues) {
        shard.queues.delete(queueName);
        shard.dlq.delete(queueName);
        shard.uniqueKeys.delete(queueName);
        shard.queueState.delete(queueName);
        shard.activeGroups.delete(queueName);
        shard.rateLimiters.delete(queueName);
        shard.concurrencyLimiters.delete(queueName);
        shard.stallConfig.delete(queueName);
        shard.dlqConfig.delete(queueName);
        this.unregisterQueueName(queueName);
      }

      if (emptyQueues.length > 0) {
        queueLog.info('Removed empty queues', { shard: i, count: emptyQueues.length });
      }

      // Clean orphaned temporal index entries (memory leak fix)
      const cleanedTemporal = shard.cleanOrphanedTemporalEntries();
      if (cleanedTemporal > 0) {
        queueLog.info('Cleaned orphaned temporal entries', { shard: i, count: cleanedTemporal });
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
    if (this.stallCheckInterval) clearInterval(this.stallCheckInterval);
    if (this.dlqMaintenanceInterval) clearInterval(this.dlqMaintenanceInterval);
    if (this.lockCheckInterval) clearInterval(this.lockCheckInterval);
    this.storage?.close();

    // Clear in-memory collections
    this.jobIndex.clear();
    this.completedJobs.clear();
    this.jobResults.clear();
    this.jobLogs.clear();
    this.customIdMap.clear();
    this.pendingDepChecks.clear();
    this.queueNamesCache.clear();
    this.jobLocks.clear();
    this.stalledCandidates.clear();
    this.clientJobs.clear();
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

  /**
   * Get detailed memory statistics for debugging memory issues.
   * Returns counts of entries in all major collections.
   */
  getMemoryStats(): {
    jobIndex: number;
    completedJobs: number;
    jobResults: number;
    jobLogs: number;
    customIdMap: number;
    jobLocks: number;
    clientJobs: number;
    clientJobsTotal: number;
    pendingDepChecks: number;
    stalledCandidates: number;
    processingTotal: number;
    queuedTotal: number;
    waitingDepsTotal: number;
    // Internal shard structures (can accumulate and cause memory leaks)
    temporalIndexTotal: number;
    delayedHeapTotal: number;
  } {
    let processingTotal = 0;
    let queuedTotal = 0;
    let waitingDepsTotal = 0;
    let temporalIndexTotal = 0;
    let delayedHeapTotal = 0;

    for (let i = 0; i < SHARD_COUNT; i++) {
      processingTotal += this.processingShards[i].size;
      const shardStats = this.shards[i].getStats();
      queuedTotal += shardStats.queuedJobs;
      waitingDepsTotal += this.shards[i].waitingDeps.size;
      // Get internal structure sizes
      const internalSizes = this.shards[i].getInternalSizes();
      temporalIndexTotal += internalSizes.temporalIndex;
      delayedHeapTotal += internalSizes.delayedHeap;
    }

    // Count total jobs across all clients
    let clientJobsTotal = 0;
    for (const jobs of this.clientJobs.values()) {
      clientJobsTotal += jobs.size;
    }

    return {
      jobIndex: this.jobIndex.size,
      completedJobs: this.completedJobs.size,
      jobResults: this.jobResults.size,
      jobLogs: this.jobLogs.size,
      customIdMap: this.customIdMap.size,
      jobLocks: this.jobLocks.size,
      clientJobs: this.clientJobs.size,
      clientJobsTotal,
      pendingDepChecks: this.pendingDepChecks.size,
      stalledCandidates: this.stalledCandidates.size,
      processingTotal,
      queuedTotal,
      waitingDepsTotal,
      temporalIndexTotal,
      delayedHeapTotal,
    };
  }

  /**
   * Force compact all collections to reduce memory usage.
   * Use after large batch operations or when memory pressure is high.
   */
  compactMemory(): void {
    // Compact priority queues that have high stale ratios
    for (let i = 0; i < SHARD_COUNT; i++) {
      for (const q of this.shards[i].queues.values()) {
        if (q.needsCompaction(0.1)) {
          // More aggressive: 10% stale threshold
          q.compact();
        }
      }
    }

    // Clean up empty client tracking entries
    for (const [clientId, jobs] of this.clientJobs) {
      if (jobs.size === 0) {
        this.clientJobs.delete(clientId);
      }
    }

    // Clean orphaned job locks (jobs no longer in processing)
    for (const jobId of this.jobLocks.keys()) {
      const loc = this.jobIndex.get(jobId);
      if (loc?.type !== 'processing') {
        this.jobLocks.delete(jobId);
      }
    }

    queueLog.info('Memory compacted');
  }
}
