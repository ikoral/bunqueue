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
import { pushJob, pushJobBatch } from './operations/push';
import { pullJob, pullJobBatch } from './operations/pull';
import { ackJob, ackJobBatch, ackJobBatchWithResults, failJob } from './operations/ack';
import * as queueControl from './operations/queueControl';
import * as jobMgmt from './operations/jobManagement';
import * as queryOps from './operations/queryOperations';
import * as dlqOps from './dlqManager';
import * as logsOps from './jobLogsManager';
import { generatePrometheusMetrics } from './metricsExporter';
import { LRUMap, BoundedSet, BoundedMap, type SetLike } from '../shared/lru';

import type { QueueManagerConfig } from './types';
import { DEFAULT_CONFIG } from './types';
import * as lockMgr from './lockManager';
import * as bgTasks from './backgroundTasks';
import * as statsMgr from './statsManager';
import { ContextFactory, type ContextDependencies, type ContextCallbacks } from './contextFactory';

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

  // Lock-based job ownership tracking
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
  private readonly backgroundTaskHandles!: bgTasks.BackgroundTaskHandles | null;

  // Queue names cache
  private readonly queueNamesCache = new Set<string>();

  // Context factory
  private readonly contextFactory: ContextFactory;

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
    // Set up persistence callback for cron state
    if (this.storage) {
      const storage = this.storage;
      this.cronScheduler.setPersistCallback((name, executions, nextRun) => {
        storage.updateCron(name, executions, nextRun);
      });
    }

    // Initialize managers
    this.webhookManager = new WebhookManager();
    this.workerManager = new WorkerManager();
    this.eventsManager = new EventsManager(this.webhookManager);

    // Initialize context factory
    this.contextFactory = new ContextFactory(
      this.getContextDependencies(),
      this.getContextCallbacks()
    );

    // Load and start
    bgTasks.recover(this.contextFactory.getBackgroundContext());
    if (this.storage) {
      this.cronScheduler.load(this.storage.loadCronJobs());
    }
    this.backgroundTaskHandles = bgTasks.startBackgroundTasks(
      this.contextFactory.getBackgroundContext(),
      this.cronScheduler
    );
  }

  // ============ Context Dependencies ============

  private getContextDependencies(): ContextDependencies {
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
      maxLogsPerJob: this.maxLogsPerJob,
    };
  }

  private getContextCallbacks(): ContextCallbacks {
    return {
      fail: this.fail.bind(this),
      registerQueueName: this.registerQueueName.bind(this),
      unregisterQueueName: this.unregisterQueueName.bind(this),
      onJobCompleted: this.onJobCompleted.bind(this),
      onJobsCompleted: this.onJobsCompleted.bind(this),
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

  // ============ Core Operations ============

  async push(queue: string, input: JobInput): Promise<Job> {
    this.registerQueueName(queue);
    return pushJob(queue, input, this.contextFactory.getPushContext());
  }

  async pushBatch(queue: string, inputs: JobInput[]): Promise<JobId[]> {
    this.registerQueueName(queue);
    return pushJobBatch(queue, inputs, this.contextFactory.getPushContext());
  }

  async pull(queue: string, timeoutMs: number = 0): Promise<Job | null> {
    return pullJob(queue, timeoutMs, this.contextFactory.getPullContext());
  }

  async pullWithLock(
    queue: string,
    owner: string,
    timeoutMs: number = 0,
    lockTtl: number = DEFAULT_LOCK_TTL
  ): Promise<{ job: Job | null; token: string | null }> {
    const job = await pullJob(queue, timeoutMs, this.contextFactory.getPullContext());
    if (!job) return { job: null, token: null };
    const token = lockMgr.createLock(job.id, owner, this.contextFactory.getLockContext(), lockTtl);
    return { job, token };
  }

  async pullBatch(queue: string, count: number, timeoutMs: number = 0): Promise<Job[]> {
    return pullJobBatch(queue, count, timeoutMs, this.contextFactory.getPullContext());
  }

  async pullBatchWithLock(
    queue: string,
    count: number,
    owner: string,
    timeoutMs: number = 0,
    lockTtl: number = DEFAULT_LOCK_TTL
  ): Promise<{ jobs: Job[]; tokens: string[] }> {
    const jobs = await pullJobBatch(queue, count, timeoutMs, this.contextFactory.getPullContext());
    const tokens: string[] = [];
    for (const job of jobs) {
      const token = lockMgr.createLock(
        job.id,
        owner,
        this.contextFactory.getLockContext(),
        lockTtl
      );
      tokens.push(token ?? '');
    }
    return { jobs, tokens };
  }

  async ack(jobId: JobId, result?: unknown, token?: string): Promise<void> {
    if (token && !lockMgr.verifyLock(jobId, token, this.contextFactory.getLockContext())) {
      throw new Error(`Invalid or expired lock token for job ${jobId}`);
    }
    await ackJob(jobId, result, this.contextFactory.getAckContext());
    lockMgr.releaseLock(jobId, this.contextFactory.getLockContext(), token);
  }

  async ackBatch(jobIds: JobId[], tokens?: string[]): Promise<void> {
    const lockCtx = this.contextFactory.getLockContext();
    if (tokens?.length === jobIds.length) {
      for (let i = 0; i < jobIds.length; i++) {
        const t = tokens[i];
        if (t && !lockMgr.verifyLock(jobIds[i], t, lockCtx)) {
          throw new Error(`Invalid or expired lock token for job ${jobIds[i]}`);
        }
      }
    }
    await ackJobBatch(jobIds, this.contextFactory.getAckContext());
    if (tokens) {
      for (let i = 0; i < jobIds.length; i++) {
        lockMgr.releaseLock(jobIds[i], lockCtx, tokens[i]);
      }
    }
  }

  async ackBatchWithResults(
    items: Array<{ id: JobId; result: unknown; token?: string }>
  ): Promise<void> {
    const lockCtx = this.contextFactory.getLockContext();
    for (const item of items) {
      if (item.token && !lockMgr.verifyLock(item.id, item.token, lockCtx)) {
        throw new Error(`Invalid or expired lock token for job ${item.id}`);
      }
    }
    await ackJobBatchWithResults(items, this.contextFactory.getAckContext());
    for (const item of items) {
      lockMgr.releaseLock(item.id, lockCtx, item.token);
    }
  }

  async fail(jobId: JobId, error?: string, token?: string): Promise<void> {
    const lockCtx = this.contextFactory.getLockContext();
    if (token && !lockMgr.verifyLock(jobId, token, lockCtx)) {
      throw new Error(`Invalid or expired lock token for job ${jobId}`);
    }
    await failJob(jobId, error, this.contextFactory.getAckContext());
    lockMgr.releaseLock(jobId, lockCtx, token);
  }

  jobHeartbeat(jobId: JobId, token?: string): boolean {
    const loc = this.jobIndex.get(jobId);
    if (loc?.type !== 'processing') return false;

    if (token) {
      return lockMgr.renewJobLock(jobId, token, this.contextFactory.getLockContext());
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

  // ============ Lock Management ============

  createLock(jobId: JobId, owner: string, ttl: number = DEFAULT_LOCK_TTL): LockToken | null {
    return lockMgr.createLock(jobId, owner, this.contextFactory.getLockContext(), ttl);
  }

  verifyLock(jobId: JobId, token: string): boolean {
    return lockMgr.verifyLock(jobId, token, this.contextFactory.getLockContext());
  }

  renewJobLock(jobId: JobId, token: string, newTtl?: number): boolean {
    return lockMgr.renewJobLock(jobId, token, this.contextFactory.getLockContext(), newTtl);
  }

  renewJobLockBatch(items: Array<{ id: JobId; token: string; ttl?: number }>): string[] {
    return lockMgr.renewJobLockBatch(items, this.contextFactory.getLockContext());
  }

  releaseLock(jobId: JobId, token?: string): boolean {
    return lockMgr.releaseLock(jobId, this.contextFactory.getLockContext(), token);
  }

  getLockInfo(jobId: JobId): JobLock | null {
    return lockMgr.getLockInfo(jobId, this.contextFactory.getLockContext());
  }

  // ============ Client-Job Tracking ============

  registerClientJob(clientId: string, jobId: JobId): void {
    lockMgr.registerClientJob(clientId, jobId, this.contextFactory.getLockContext());
  }

  unregisterClientJob(clientId: string | undefined, jobId: JobId): void {
    lockMgr.unregisterClientJob(clientId, jobId, this.contextFactory.getLockContext());
  }

  releaseClientJobs(clientId: string): Promise<number> {
    return lockMgr.releaseClientJobs(clientId, this.contextFactory.getLockContext());
  }

  // ============ Query Operations ============

  async getJob(jobId: JobId): Promise<Job | null> {
    return queryOps.getJob(jobId, this.contextFactory.getQueryContext());
  }

  async getJobState(jobId: JobId): Promise<string> {
    return queryOps.getJobState(jobId, this.contextFactory.getQueryContext());
  }

  getResult(jobId: JobId): unknown {
    return queryOps.getJobResult(jobId, this.contextFactory.getQueryContext());
  }

  getJobByCustomId(customId: string): Job | null {
    return queryOps.getJobByCustomId(customId, this.contextFactory.getQueryContext());
  }

  getProgress(jobId: JobId) {
    return queryOps.getJobProgress(jobId, this.contextFactory.getQueryContext());
  }

  count(queue: string): number {
    return queueControl.getQueueCount(queue, this.contextFactory.getQueueControlContext());
  }

  // ============ Queue Control ============

  pause(queue: string): void {
    queueControl.pauseQueue(queue, this.contextFactory.getQueueControlContext());
  }

  resume(queue: string): void {
    queueControl.resumeQueue(queue, this.contextFactory.getQueueControlContext());
  }

  isPaused(queue: string): boolean {
    return queueControl.isQueuePaused(queue, this.contextFactory.getQueueControlContext());
  }

  drain(queue: string): number {
    return queueControl.drainQueue(queue, this.contextFactory.getQueueControlContext());
  }

  obliterate(queue: string): void {
    queueControl.obliterateQueue(queue, this.contextFactory.getQueueControlContext());
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
      this.contextFactory.getQueueControlContext(),
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
    const idx = shardIndex(queue);
    return queryOps.getJobs(queue, idx, options, {
      ...this.contextFactory.getQueryContext(),
      shardCount: SHARD_COUNT,
    });
  }

  // ============ DLQ Operations ============

  getDlq(queue: string, count?: number): Job[] {
    return dlqOps.getDlqJobs(queue, this.contextFactory.getDlqContext(), count);
  }

  retryDlq(queue: string, jobId?: JobId): number {
    return dlqOps.retryDlqJobs(queue, this.contextFactory.getDlqContext(), jobId);
  }

  purgeDlq(queue: string): number {
    return dlqOps.purgeDlqJobs(queue, this.contextFactory.getDlqContext());
  }

  retryCompleted(queue: string, jobId?: JobId): number {
    return dlqOps.retryCompletedJobs(queue, this.contextFactory.getRetryCompletedContext(), jobId);
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

  // ============ Job Management ============

  async cancel(jobId: JobId): Promise<boolean> {
    return jobMgmt.cancelJob(jobId, this.contextFactory.getJobMgmtContext());
  }

  async updateProgress(jobId: JobId, progress: number, message?: string): Promise<boolean> {
    return jobMgmt.updateJobProgress(
      jobId,
      progress,
      this.contextFactory.getJobMgmtContext(),
      message
    );
  }

  async updateJobData(jobId: JobId, data: unknown): Promise<boolean> {
    return jobMgmt.updateJobData(jobId, data, this.contextFactory.getJobMgmtContext());
  }

  async changePriority(jobId: JobId, priority: number): Promise<boolean> {
    return jobMgmt.changeJobPriority(jobId, priority, this.contextFactory.getJobMgmtContext());
  }

  async promote(jobId: JobId): Promise<boolean> {
    return jobMgmt.promoteJob(jobId, this.contextFactory.getJobMgmtContext());
  }

  async moveToDelayed(jobId: JobId, delay: number): Promise<boolean> {
    return jobMgmt.moveJobToDelayed(jobId, delay, this.contextFactory.getJobMgmtContext());
  }

  async discard(jobId: JobId): Promise<boolean> {
    return jobMgmt.discardJob(jobId, this.contextFactory.getJobMgmtContext());
  }

  // ============ Job Logs ============

  addLog(jobId: JobId, message: string, level: 'info' | 'warn' | 'error' = 'info'): boolean {
    return logsOps.addJobLog(jobId, message, this.contextFactory.getLogsContext(), level);
  }

  getLogs(jobId: JobId): JobLogEntry[] {
    return logsOps.getJobLogs(jobId, this.contextFactory.getLogsContext());
  }

  clearLogs(jobId: JobId): void {
    logsOps.clearJobLogs(jobId, this.contextFactory.getLogsContext());
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

  // ============ Stats ============

  getStats() {
    return statsMgr.getStats(this.contextFactory.getStatsContext(), this.cronScheduler);
  }

  getMemoryStats() {
    return statsMgr.getMemoryStats(this.contextFactory.getStatsContext());
  }

  compactMemory(): void {
    statsMgr.compactMemory(this.contextFactory.getStatsContext());
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
