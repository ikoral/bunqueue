/**
 * Queue Manager
 * Core orchestrator for all queue operations
 */

import type { Job, JobId, JobInput, JobLock, LockToken } from '../domain/types/job';
import { DEFAULT_LOCK_TTL } from '../domain/types/job';
import type { JobLocation, JobEvent } from '../domain/types/queue';
import type { CronJob, CronJobInput } from '../domain/types/cron';
import type { JobLogEntry } from '../domain/types/worker';
import { Shard } from '../domain/queue/shard';
import { SqliteStorage } from '../infrastructure/persistence/sqlite';
import { CronScheduler } from '../infrastructure/scheduler/cronScheduler';
import { WebhookManager } from './webhookManager';
import { WorkerManager } from './workerManager';
import { EventsManager } from './eventsManager';
import { RWLock } from '../shared/lock';
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

// Import extracted modules
import type { QueueManagerConfig, LockContext, BackgroundContext, StatsContext } from './types';
import { DEFAULT_CONFIG } from './types';
import * as lockMgr from './lockManager';
import * as bgTasks from './backgroundTasks';
import * as statsMgr from './statsManager';

// Re-export config type for external use
export type { QueueManagerConfig };

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

  // Deferred dependency resolution queue
  private readonly pendingDepChecks = new Set<JobId>();

  // Two-phase stall detection
  private readonly stalledCandidates = new Set<JobId>();

  // Lock-based job ownership tracking (BullMQ-style)
  private readonly jobLocks = new Map<JobId, JobLock>();
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

  // Background task handles
  private readonly backgroundTaskHandles: bgTasks.BackgroundTaskHandles | null = null;

  // Queue names cache for O(1) listQueues
  private readonly queueNamesCache = new Set<string>();

  constructor(config: QueueManagerConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.storage = config.dataPath ? new SqliteStorage({ path: config.dataPath }) : null;

    // Initialize bounded collections
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
    bgTasks.recover(this.getBackgroundContext());
    // Load cron jobs from storage
    if (this.storage) {
      this.cronScheduler.load(this.storage.loadCronJobs());
    }
    this.backgroundTaskHandles = bgTasks.startBackgroundTasks(
      this.getBackgroundContext(),
      this.cronScheduler
    );
  }

  // ============ Context Builders ============

  private getLockContext(): LockContext {
    return {
      jobIndex: this.jobIndex,
      jobLocks: this.jobLocks,
      clientJobs: this.clientJobs,
      processingShards: this.processingShards,
      processingLocks: this.processingLocks,
      shards: this.shards,
      shardLocks: this.shardLocks,
      eventsManager: this.eventsManager,
    };
  }

  private getBackgroundContext(): BackgroundContext {
    return {
      config: this.config,
      storage: this.storage,
      shards: this.shards,
      shardLocks: this.shardLocks,
      processingShards: this.processingShards,
      processingLocks: this.processingLocks,
      jobIndex: this.jobIndex,
      completedJobs: this.completedJobs,
      jobResults: this.jobResults,
      customIdMap: this.customIdMap,
      jobLogs: this.jobLogs,
      jobLocks: this.jobLocks,
      clientJobs: this.clientJobs,
      stalledCandidates: this.stalledCandidates,
      pendingDepChecks: this.pendingDepChecks,
      queueNamesCache: this.queueNamesCache,
      eventsManager: this.eventsManager,
      webhookManager: this.webhookManager,
      metrics: this.metrics,
      startTime: this.startTime,
      fail: this.fail.bind(this),
      registerQueueName: this.registerQueueName.bind(this),
      unregisterQueueName: this.unregisterQueueName.bind(this),
    };
  }

  private getStatsContext(): StatsContext {
    return {
      shards: this.shards,
      processingShards: this.processingShards,
      completedJobs: this.completedJobs,
      jobIndex: this.jobIndex,
      jobResults: this.jobResults,
      jobLogs: this.jobLogs,
      customIdMap: this.customIdMap,
      jobLocks: this.jobLocks,
      clientJobs: this.clientJobs,
      pendingDepChecks: this.pendingDepChecks,
      stalledCandidates: this.stalledCandidates,
      metrics: this.metrics,
      startTime: this.startTime,
    };
  }

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
    this.registerQueueName(queue);
    return pushJob(queue, input, this.getPushContext());
  }

  async pushBatch(queue: string, inputs: JobInput[]): Promise<JobId[]> {
    this.registerQueueName(queue);
    return pushJobBatch(queue, inputs, this.getPushContext());
  }

  async pull(queue: string, timeoutMs: number = 0): Promise<Job | null> {
    return pullJob(queue, timeoutMs, this.getPullContext());
  }

  async pullWithLock(
    queue: string,
    owner: string,
    timeoutMs: number = 0,
    lockTtl: number = DEFAULT_LOCK_TTL
  ): Promise<{ job: Job | null; token: string | null }> {
    const job = await pullJob(queue, timeoutMs, this.getPullContext());
    if (!job) return { job: null, token: null };
    const token = lockMgr.createLock(job.id, owner, this.getLockContext(), lockTtl);
    return { job, token };
  }

  async pullBatch(queue: string, count: number, timeoutMs: number = 0): Promise<Job[]> {
    return pullJobBatch(queue, count, timeoutMs, this.getPullContext());
  }

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
      const token = lockMgr.createLock(job.id, owner, this.getLockContext(), lockTtl);
      tokens.push(token ?? '');
    }
    return { jobs, tokens };
  }

  async ack(jobId: JobId, result?: unknown, token?: string): Promise<void> {
    if (token && !lockMgr.verifyLock(jobId, token, this.getLockContext())) {
      throw new Error(`Invalid or expired lock token for job ${jobId}`);
    }
    await ackJob(jobId, result, this.getAckContext());
    lockMgr.releaseLock(jobId, this.getLockContext(), token);
  }

  async ackBatch(jobIds: JobId[], tokens?: string[]): Promise<void> {
    if (tokens?.length === jobIds.length) {
      for (let i = 0; i < jobIds.length; i++) {
        const t = tokens[i];
        if (t && !lockMgr.verifyLock(jobIds[i], t, this.getLockContext())) {
          throw new Error(`Invalid or expired lock token for job ${jobIds[i]}`);
        }
      }
    }
    await ackJobBatch(jobIds, this.getAckContext());
    if (tokens) {
      for (let i = 0; i < jobIds.length; i++) {
        lockMgr.releaseLock(jobIds[i], this.getLockContext(), tokens[i]);
      }
    }
  }

  async ackBatchWithResults(
    items: Array<{ id: JobId; result: unknown; token?: string }>
  ): Promise<void> {
    for (const item of items) {
      if (item.token && !lockMgr.verifyLock(item.id, item.token, this.getLockContext())) {
        throw new Error(`Invalid or expired lock token for job ${item.id}`);
      }
    }
    await ackJobBatchWithResults(items, this.getAckContext());
    for (const item of items) {
      lockMgr.releaseLock(item.id, this.getLockContext(), item.token);
    }
  }

  async fail(jobId: JobId, error?: string, token?: string): Promise<void> {
    if (token && !lockMgr.verifyLock(jobId, token, this.getLockContext())) {
      throw new Error(`Invalid or expired lock token for job ${jobId}`);
    }
    await failJob(jobId, error, this.getAckContext());
    lockMgr.releaseLock(jobId, this.getLockContext(), token);
  }

  jobHeartbeat(jobId: JobId, token?: string): boolean {
    const loc = this.jobIndex.get(jobId);
    if (loc?.type !== 'processing') return false;

    if (token) {
      return lockMgr.renewJobLock(jobId, token, this.getLockContext());
    }

    const processing = this.processingShards[loc.shardIdx];
    const job = processing.get(jobId);
    if (job) {
      job.lastHeartbeat = Date.now();
      return true;
    }
    return false;
  }

  jobHeartbeatBatch(jobIds: JobId[], tokens?: string[]): number {
    let count = 0;
    for (let i = 0; i < jobIds.length; i++) {
      if (this.jobHeartbeat(jobIds[i], tokens?.[i])) count++;
    }
    return count;
  }

  // ============ Lock Management (delegated) ============

  createLock(jobId: JobId, owner: string, ttl: number = DEFAULT_LOCK_TTL): LockToken | null {
    return lockMgr.createLock(jobId, owner, this.getLockContext(), ttl);
  }

  verifyLock(jobId: JobId, token: string): boolean {
    return lockMgr.verifyLock(jobId, token, this.getLockContext());
  }

  renewJobLock(jobId: JobId, token: string, newTtl?: number): boolean {
    return lockMgr.renewJobLock(jobId, token, this.getLockContext(), newTtl);
  }

  renewJobLockBatch(items: Array<{ id: JobId; token: string; ttl?: number }>): string[] {
    return lockMgr.renewJobLockBatch(items, this.getLockContext());
  }

  releaseLock(jobId: JobId, token?: string): boolean {
    return lockMgr.releaseLock(jobId, this.getLockContext(), token);
  }

  getLockInfo(jobId: JobId): JobLock | null {
    return lockMgr.getLockInfo(jobId, this.getLockContext());
  }

  // ============ Client-Job Tracking (delegated) ============

  registerClientJob(clientId: string, jobId: JobId): void {
    lockMgr.registerClientJob(clientId, jobId, this.getLockContext());
  }

  unregisterClientJob(clientId: string | undefined, jobId: JobId): void {
    lockMgr.unregisterClientJob(clientId, jobId, this.getLockContext());
  }

  releaseClientJobs(clientId: string): Promise<number> {
    return lockMgr.releaseClientJobs(clientId, this.getLockContext());
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
    this.unregisterQueueName(queue);
  }

  listQueues(): string[] {
    return Array.from(this.queueNamesCache);
  }

  private registerQueueName(queue: string): void {
    this.queueNamesCache.add(queue);
  }

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

  getCountsPerPriority(queue: string): Record<number, number> {
    const idx = shardIndex(queue);
    const counts = this.shards[idx].getCountsPerPriority(queue);
    return Object.fromEntries(counts);
  }

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

    if (!state || state === 'waiting') {
      jobs.push(
        ...shard
          .getQueue(queue)
          .values()
          .filter((j) => j.runAt <= now)
      );
    }
    if (!state || state === 'delayed') {
      jobs.push(
        ...shard
          .getQueue(queue)
          .values()
          .filter((j) => j.runAt > now)
      );
    }
    if (!state || state === 'active') {
      for (let i = 0; i < SHARD_COUNT; i++) {
        for (const job of this.processingShards[i].values()) {
          if (job.queue === queue) jobs.push(job);
        }
      }
    }
    if (!state || state === 'failed') {
      jobs.push(...shard.getDlq(queue));
    }

    jobs.sort((a, b) => (asc ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
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

  retryCompleted(queue: string, jobId?: JobId): number {
    if (jobId) {
      if (!this.completedJobs.has(jobId)) return 0;
      const job = this.storage?.getJob(jobId);
      if (job?.queue !== queue) return 0;
      return this.requeueCompletedJob(job);
    }
    let count = 0;
    for (const id of this.completedJobs) {
      const job = this.storage?.getJob(id);
      if (job?.queue === queue) count += this.requeueCompletedJob(job);
    }
    return count;
  }

  private requeueCompletedJob(job: Job): number {
    job.attempts = 0;
    job.startedAt = null;
    job.completedAt = null;
    job.runAt = Date.now();
    job.progress = 0;

    const idx = shardIndex(job.queue);
    const shard = this.shards[idx];
    shard.getQueue(job.queue).push(job);
    shard.incrementQueued(job.id, false, job.createdAt, job.queue, job.runAt);
    this.jobIndex.set(job.id, { type: 'queue', shardIdx: idx, queueName: job.queue });
    this.completedJobs.delete(job.id);
    this.jobResults.delete(job.id);
    this.storage?.updateForRetry(job);
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
      { jobIndex: this.jobIndex, jobLogs: this.jobLogs, maxLogsPerJob: this.maxLogsPerJob },
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

  waitForJobCompletion(jobId: JobId, timeoutMs: number): Promise<boolean> {
    return this.eventsManager.waitForJobCompletion(jobId, timeoutMs);
  }

  // ============ Internal State Access ============

  getJobIndex(): Map<JobId, JobLocation> {
    return this.jobIndex;
  }

  getCompletedJobs(): SetLike<JobId> {
    return this.completedJobs;
  }

  /** Expose shards for testing (internal use only) */
  getShards(): Shard[] {
    return this.shards;
  }

  private onJobCompleted(completedId: JobId): void {
    this.pendingDepChecks.add(completedId);
  }

  private onJobsCompleted(completedIds: JobId[]): void {
    for (const id of completedIds) this.pendingDepChecks.add(id);
  }

  private hasPendingDeps(): boolean {
    for (const shard of this.shards) {
      if (shard.waitingDeps.size > 0) return true;
    }
    return false;
  }

  // ============ Stats (delegated) ============

  getStats() {
    return statsMgr.getStats(this.getStatsContext(), this.cronScheduler);
  }

  getMemoryStats() {
    return statsMgr.getMemoryStats(this.getStatsContext());
  }

  compactMemory(): void {
    statsMgr.compactMemory(this.getStatsContext());
  }

  // ============ Lifecycle ============

  shutdown(): void {
    this.cronScheduler.stop();
    this.workerManager.stop();
    this.eventsManager.clear();
    if (this.backgroundTaskHandles) {
      bgTasks.stopBackgroundTasks(this.backgroundTaskHandles);
    }
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
    for (const shard of this.processingShards) shard.clear();
    for (const shard of this.shards) {
      shard.waitingDeps.clear();
      shard.dependencyIndex.clear();
      shard.waitingChildren.clear();
      shard.uniqueKeys.clear();
      shard.activeGroups.clear();
    }
  }
}
