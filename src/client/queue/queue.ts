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
        repeat: m.repeat,
        durable: m.durable,
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
      return toPublicJob<T>(
        job,
        jobData?.name ?? 'default',
        (jid) => this.getJobState(jid),
        (jid) => this.removeAsync(jid),
        (jid) => this.retryJob(jid)
      );
    }

    const response = await this.tcp.send({ cmd: 'GetJob', id });
    if (!response.ok || !response.job) return null;
    const jobData = response.job as Record<string, unknown>;
    const data = jobData.data as { name?: string } | null;
    const jobIdStr = String(jobData.id);
    return {
      id: jobIdStr,
      name: data?.name ?? 'default',
      data: jobData.data as T,
      queueName: this.name,
      attemptsMade: (jobData.attempts as number | undefined) ?? 0,
      timestamp: (jobData.createdAt as number | undefined) ?? Date.now(),
      progress: (jobData.progress as number | undefined) ?? 0,
      updateProgress: async () => {},
      log: async () => {},
      getState: () => this.getJobState(jobIdStr),
      remove: () => this.removeAsync(jobIdStr),
      retry: () => this.retryJob(jobIdStr),
    };
  }

  /** Remove a job by ID */
  remove(id: string): void {
    if (this.embedded) void getSharedManager().cancel(jobId(id));
    else void this.tcp.send({ cmd: 'Cancel', id });
  }

  /** Remove a job by ID (async) */
  async removeAsync(id: string): Promise<void> {
    if (this.embedded) {
      await getSharedManager().cancel(jobId(id));
    } else {
      await this.tcp.send({ cmd: 'Cancel', id });
    }
  }

  /** Retry a job by ID */
  async retryJob(id: string): Promise<void> {
    if (this.embedded) {
      // For embedded mode, we need to implement retry in QueueManager
      // For now, just get the job and re-add it
      const manager = getSharedManager();
      const job = await manager.getJob(jobId(id));
      if (job) {
        await manager.push(job.queue, { data: job.data, priority: job.priority });
      }
    } else {
      await this.tcp.send({ cmd: 'RetryJob', id });
    }
  }

  /** Get job state by ID (async, works with both embedded and TCP) */
  async getJobState(
    id: string
  ): Promise<'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'unknown'> {
    if (this.embedded) {
      const manager = getSharedManager();
      const state = await manager.getJobState(jobId(id));
      return state as 'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'unknown';
    }

    const response = await this.tcp.send({ cmd: 'GetState', id });
    if (!response.ok) return 'unknown';
    return response.state as string as
      | 'waiting'
      | 'delayed'
      | 'active'
      | 'completed'
      | 'failed'
      | 'unknown';
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

  /** Check if queue is paused */
  isPaused(): boolean {
    if (this.embedded) {
      return getSharedManager().isPaused(this.name);
    }
    return false;
  }

  /** Check if queue is paused (async, works with TCP) */
  async isPausedAsync(): Promise<boolean> {
    if (this.embedded) return this.isPaused();
    const response = await this.tcp.send({ cmd: 'IsPaused', queue: this.name });
    if (!response.ok) return false;
    return (response as { paused?: boolean }).paused === true;
  }

  /** Count jobs awaiting processing */
  count(): number {
    if (this.embedded) {
      return getSharedManager().count(this.name);
    }
    return 0;
  }

  /** Count jobs awaiting processing (async, works with TCP) */
  async countAsync(): Promise<number> {
    if (this.embedded) return this.count();
    const response = await this.tcp.send({ cmd: 'Count', queue: this.name });
    if (!response.ok) return 0;
    return (response as { count?: number }).count ?? 0;
  }

  /** Get active jobs */
  getActive(start = 0, end = 100): Job<T>[] {
    return this.getJobs({ state: 'active', start, end });
  }

  /** Get active jobs (async) */
  async getActiveAsync(start = 0, end = 100): Promise<Job<T>[]> {
    return this.getJobsAsync({ state: 'active', start, end });
  }

  /** Get completed jobs */
  getCompleted(start = 0, end = 100): Job<T>[] {
    return this.getJobs({ state: 'completed', start, end });
  }

  /** Get completed jobs (async) */
  async getCompletedAsync(start = 0, end = 100): Promise<Job<T>[]> {
    return this.getJobsAsync({ state: 'completed', start, end });
  }

  /** Get failed jobs */
  getFailed(start = 0, end = 100): Job<T>[] {
    return this.getJobs({ state: 'failed', start, end });
  }

  /** Get failed jobs (async) */
  async getFailedAsync(start = 0, end = 100): Promise<Job<T>[]> {
    return this.getJobsAsync({ state: 'failed', start, end });
  }

  /** Get delayed jobs */
  getDelayed(start = 0, end = 100): Job<T>[] {
    return this.getJobs({ state: 'delayed', start, end });
  }

  /** Get delayed jobs (async) */
  async getDelayedAsync(start = 0, end = 100): Promise<Job<T>[]> {
    return this.getJobsAsync({ state: 'delayed', start, end });
  }

  /** Get waiting jobs */
  getWaiting(start = 0, end = 100): Job<T>[] {
    return this.getJobs({ state: 'waiting', start, end });
  }

  /** Get waiting jobs (async) */
  async getWaitingAsync(start = 0, end = 100): Promise<Job<T>[]> {
    return this.getJobsAsync({ state: 'waiting', start, end });
  }

  /** Get active job count */
  async getActiveCount(): Promise<number> {
    const counts = await this.getJobCountsAsync();
    return counts.active;
  }

  /** Get completed job count */
  async getCompletedCount(): Promise<number> {
    const counts = await this.getJobCountsAsync();
    return counts.completed;
  }

  /** Get failed job count */
  async getFailedCount(): Promise<number> {
    const counts = await this.getJobCountsAsync();
    return counts.failed;
  }

  /** Get delayed job count */
  async getDelayedCount(): Promise<number> {
    if (this.embedded) {
      const stats = getSharedManager().getStats();
      return stats.delayed;
    }
    const response = await this.tcp.send({ cmd: 'Stats' });
    if (!response.ok) return 0;
    return (response.stats as { delayed?: number } | undefined)?.delayed ?? 0;
  }

  /** Get waiting job count */
  async getWaitingCount(): Promise<number> {
    const counts = await this.getJobCountsAsync();
    return counts.waiting;
  }

  /** Clean old jobs from the queue */
  clean(
    grace: number,
    limit: number,
    type?: 'completed' | 'wait' | 'active' | 'paused' | 'delayed' | 'failed'
  ): string[] {
    if (this.embedded) {
      const count = getSharedManager().clean(this.name, grace, type, limit);
      // Return empty array for now - would need to track removed IDs
      return new Array<string>(count).fill('');
    }
    return [];
  }

  /** Clean old jobs from the queue (async, works with TCP) */
  async cleanAsync(
    grace: number,
    limit: number,
    type?: 'completed' | 'wait' | 'active' | 'paused' | 'delayed' | 'failed'
  ): Promise<string[]> {
    if (this.embedded) return this.clean(grace, limit, type);
    const response = await this.tcp.send({
      cmd: 'Clean',
      queue: this.name,
      grace,
      limit,
      type,
    });
    if (!response.ok) return [];
    return (response as { removed?: string[] }).removed ?? [];
  }

  /** Retry failed jobs */
  async retryJobs(opts?: {
    count?: number;
    state?: 'completed' | 'failed';
    timestamp?: number;
  }): Promise<number> {
    const state = opts?.state ?? 'failed';
    const count = opts?.count ?? 100;

    if (this.embedded) {
      if (state === 'failed') {
        return getSharedManager().retryDlq(this.name);
      } else {
        return getSharedManager().retryCompleted(this.name);
      }
    }

    const cmd = state === 'failed' ? 'RetryDlq' : 'RetryCompleted';
    const response = await this.tcp.send({ cmd, queue: this.name, count });
    if (!response.ok) return 0;
    return (response as { count?: number }).count ?? 0;
  }

  /** Promote delayed jobs to waiting */
  async promoteJobs(opts?: { count?: number }): Promise<number> {
    const count = opts?.count ?? 100;

    if (this.embedded) {
      // Get delayed jobs and promote them
      const jobs = this.getJobs({ state: 'delayed', start: 0, end: count });
      let promoted = 0;
      for (const job of jobs) {
        const success = await getSharedManager().promote(jobId(job.id));
        if (success) promoted++;
      }
      return promoted;
    }

    const response = await this.tcp.send({ cmd: 'PromoteJobs', queue: this.name, count });
    if (!response.ok) return 0;
    return (response as { count?: number }).count ?? 0;
  }

  /** Get job logs */
  async getJobLogs(
    id: string,
    start = 0,
    end = 100,
    _asc = true
  ): Promise<{ logs: string[]; count: number }> {
    if (this.embedded) {
      const logs = getSharedManager().getLogs(jobId(id));
      const logStrings = logs.slice(start, end).map((l) => `[${l.level}] ${l.message}`);
      return { logs: logStrings, count: logs.length };
    }

    const response = await this.tcp.send({ cmd: 'GetLogs', id, start, end });
    if (!response.ok) return { logs: [], count: 0 };
    const result = response as { logs?: Array<{ message: string; level: string }>; count?: number };
    const logStrings = (result.logs ?? []).map((l) => `[${l.level}] ${l.message}`);
    return { logs: logStrings, count: result.count ?? 0 };
  }

  /** Add a log entry to a job */
  async addJobLog(id: string, logRow: string, _keepLogs?: number): Promise<number> {
    if (this.embedded) {
      const success = getSharedManager().addLog(jobId(id), logRow);
      return success ? 1 : 0;
    }

    const response = await this.tcp.send({ cmd: 'AddLog', id, message: logRow });
    return response.ok ? 1 : 0;
  }

  /** Update job progress */
  async updateJobProgress(id: string, progress: number | object): Promise<void> {
    const progressValue = typeof progress === 'number' ? progress : 0;
    const message = typeof progress === 'object' ? JSON.stringify(progress) : undefined;

    if (this.embedded) {
      await getSharedManager().updateProgress(jobId(id), progressValue, message);
      return;
    }

    await this.tcp.send({ cmd: 'Progress', id, progress: progressValue, message });
  }

  /** Set global concurrency limit for this queue */
  setGlobalConcurrency(concurrency: number): void {
    if (this.embedded) {
      getSharedManager().setConcurrency(this.name, concurrency);
    } else {
      void this.tcp.send({ cmd: 'SetConcurrency', queue: this.name, limit: concurrency });
    }
  }

  /** Remove global concurrency limit */
  removeGlobalConcurrency(): void {
    if (this.embedded) {
      getSharedManager().clearConcurrency(this.name);
    } else {
      void this.tcp.send({ cmd: 'ClearConcurrency', queue: this.name });
    }
  }

  /** Get global concurrency limit */
  getGlobalConcurrency(): Promise<number | null> {
    // This would need to be implemented in QueueManager
    // For now, return null
    return Promise.resolve(null);
  }

  /** Set global rate limit for this queue */
  setGlobalRateLimit(max: number, _duration?: number): void {
    if (this.embedded) {
      getSharedManager().setRateLimit(this.name, max);
    } else {
      void this.tcp.send({ cmd: 'RateLimit', queue: this.name, limit: max });
    }
  }

  /** Remove global rate limit */
  removeGlobalRateLimit(): void {
    if (this.embedded) {
      getSharedManager().clearRateLimit(this.name);
    } else {
      void this.tcp.send({ cmd: 'RateLimitClear', queue: this.name });
    }
  }

  /** Get global rate limit */
  getGlobalRateLimit(): Promise<{ max: number; duration: number } | null> {
    // This would need to be implemented in QueueManager
    // For now, return null
    return Promise.resolve(null);
  }

  /** Get metrics for this queue */
  async getMetrics(
    type: 'completed' | 'failed',
    _start?: number,
    _end?: number
  ): Promise<{ meta: { count: number }; data: number[] }> {
    if (this.embedded) {
      const stats = getSharedManager().getStats();
      const count = type === 'completed' ? stats.completed : stats.dlq;
      return { meta: { count }, data: [] };
    }

    const response = await this.tcp.send({ cmd: 'Metrics' });
    if (!response.ok) return { meta: { count: 0 }, data: [] };
    const stats = response.stats as { completed?: number; dlq?: number } | undefined;
    const count = type === 'completed' ? (stats?.completed ?? 0) : (stats?.dlq ?? 0);
    return { meta: { count }, data: [] };
  }

  /** Get workers processing this queue */
  async getWorkers(): Promise<Array<{ id: string; name: string; addr?: string }>> {
    if (this.embedded) {
      // Would need to implement worker tracking
      return [];
    }

    const response = await this.tcp.send({ cmd: 'ListWorkers' });
    if (!response.ok) return [];
    return (
      (response as { workers?: Array<{ id: string; name: string; addr?: string }> }).workers ?? []
    );
  }

  /** Get worker count */
  async getWorkersCount(): Promise<number> {
    const workers = await this.getWorkers();
    return workers.length;
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
        return toPublicJob<T>(
          job,
          jobData?.name ?? 'default',
          (jid) => this.getJobState(jid),
          (jid) => this.removeAsync(jid),
          (jid) => this.retryJob(jid)
        );
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
        getState: () => this.getJobState(j.id),
        remove: () => this.removeAsync(j.id),
        retry: () => this.retryJob(j.id),
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

  // ============================================================================
  // BullMQ v5 Compatibility Methods (Additional)
  // ============================================================================

  /**
   * Trim events to a maximum length.
   * In bunqueue, events are emitted in real-time and not stored, so this is a no-op.
   */
  trimEvents(_maxLength: number): Promise<number> {
    // Events in bunqueue are not persisted - they're emitted via EventEmitter
    return Promise.resolve(0);
  }

  /**
   * Get jobs sorted by priority (highest first).
   * In BullMQ, this returns jobs waiting to be processed sorted by priority.
   */
  getPrioritized(start = 0, end = -1): Promise<Job<T>[]> {
    // In bunqueue, all waiting jobs are already prioritized in the priority queue
    return this.getWaitingAsync(start, end);
  }

  /** Get count of prioritized jobs (same as waiting count in bunqueue) */
  getPrioritizedCount(): Promise<number> {
    return this.getWaitingCount();
  }

  /**
   * Get jobs that are waiting for their parent to complete.
   * Used in job flows (parent-child dependencies).
   */
  getWaitingChildren(start = 0, end = -1): Promise<Job<T>[]> {
    if (this.embedded) {
      // Get jobs with pending dependencies
      const jobs = getSharedManager().getJobs(this.name, {
        state: 'delayed',
        start,
        end: end === -1 ? 1000 : end,
      });
      // Filter to only those with dependencies (would need dependency tracking)
      const result = jobs
        .filter((j) => {
          const data = j.data as { _waitingParent?: boolean } | null;
          return data?._waitingParent === true;
        })
        .map((job) => {
          const jobData = job.data as { name?: string } | null;
          return toPublicJob<T>(
            job,
            jobData?.name ?? 'default',
            (jid) => this.getJobState(jid),
            (jid) => this.removeAsync(jid),
            (jid) => this.retryJob(jid)
          );
        });
      return Promise.resolve(result);
    }
    // TCP mode - not fully supported yet
    return Promise.resolve([]);
  }

  /** Get count of jobs waiting for their parent */
  async getWaitingChildrenCount(): Promise<number> {
    const children = await this.getWaitingChildren();
    return children.length;
  }

  /**
   * Get dependencies of a parent job.
   * Returns processed/unprocessed children of a parent job in a flow.
   */
  getDependencies(
    _parentId: string,
    _type?: 'processed' | 'unprocessed',
    _start = 0,
    _end = -1
  ): Promise<{
    processed?: Record<string, unknown>;
    unprocessed?: string[];
    nextProcessedCursor?: number;
    nextUnprocessedCursor?: number;
  }> {
    // Would require implementing dependency tracking
    return Promise.resolve({
      processed: {},
      unprocessed: [],
    });
  }

  /**
   * Get the TTL of the current rate limit.
   * Returns 0 if no rate limit is active.
   */
  getRateLimitTtl(_maxJobs?: number): Promise<number> {
    // Would need to track rate limit expiration
    return Promise.resolve(0);
  }

  /**
   * Set a temporary rate limit that expires after the given time.
   */
  async rateLimit(expireTimeMs: number): Promise<void> {
    if (this.embedded) {
      // Set rate limit with expiration
      getSharedManager().setRateLimit(this.name, 1);
      // Schedule removal after expiration
      setTimeout(() => {
        getSharedManager().clearRateLimit(this.name);
      }, expireTimeMs);
    } else {
      await this.tcp.send({ cmd: 'RateLimit', queue: this.name, limit: 1 });
      // Note: TCP mode would need server-side expiration support
    }
  }

  /**
   * Check if the queue is currently rate limited (at max capacity).
   */
  isMaxed(): Promise<boolean> {
    // Would need to check if rate limit is currently blocking
    return Promise.resolve(false);
  }

  // ============================================================================
  // Job Scheduler Methods (BullMQ v5 repeatable jobs)
  // ============================================================================

  /**
   * Create or update a job scheduler (repeatable job).
   * This is the BullMQ v5 way to handle cron/repeating jobs.
   */
  async upsertJobScheduler(
    schedulerId: string,
    repeatOpts: {
      pattern?: string;
      every?: number;
      limit?: number;
      immediately?: boolean;
      count?: number;
      prevMillis?: number;
      offset?: number;
      jobId?: string;
    },
    jobTemplate?: { name?: string; data?: unknown; opts?: JobOptions }
  ): Promise<{ id: string; name: string; next: number } | null> {
    const cronPattern = repeatOpts.pattern;
    const repeatEvery = repeatOpts.every;

    if (this.embedded) {
      const manager = getSharedManager();
      // Use the cron scheduler
      manager.addCron({
        name: schedulerId,
        queue: this.name,
        data: jobTemplate?.data ?? {},
        schedule: cronPattern,
        repeatEvery,
        timezone: 'UTC',
      });

      return {
        id: schedulerId,
        name: jobTemplate?.name ?? 'default',
        next: Date.now() + (repeatEvery ?? 60000),
      };
    } else {
      const response = await this.tcp.send({
        cmd: 'Cron',
        name: schedulerId,
        queue: this.name,
        data: jobTemplate?.data ?? {},
        schedule: cronPattern,
        repeatEvery,
      });
      if (!response.ok) return null;
      return {
        id: schedulerId,
        name: jobTemplate?.name ?? 'default',
        next: (response as { nextRun?: number }).nextRun ?? Date.now(),
      };
    }
  }

  /**
   * Remove a job scheduler.
   */
  async removeJobScheduler(schedulerId: string): Promise<boolean> {
    if (this.embedded) {
      getSharedManager().removeCron(schedulerId);
      return true;
    } else {
      const response = await this.tcp.send({ cmd: 'CronDelete', name: schedulerId });
      return response.ok === true;
    }
  }

  /**
   * Get a job scheduler by ID.
   */
  async getJobScheduler(
    schedulerId: string
  ): Promise<{ id: string; name: string; next: number; pattern?: string; every?: number } | null> {
    if (this.embedded) {
      const crons = getSharedManager().listCrons();
      const cron = crons.find((c) => c.name === schedulerId);
      if (!cron) return null;
      return {
        id: cron.name,
        name: cron.name,
        next: cron.nextRun,
        pattern: cron.schedule ?? undefined,
        every: cron.repeatEvery ?? undefined,
      };
    } else {
      const response = await this.tcp.send({ cmd: 'CronList' });
      if (!response.ok) return null;
      const crons = (
        response as {
          crons?: Array<{ name: string; nextRun: number; schedule?: string; repeatEvery?: number }>;
        }
      ).crons;
      const cron = crons?.find((c) => c.name === schedulerId);
      if (!cron) return null;
      return {
        id: cron.name,
        name: cron.name,
        next: cron.nextRun,
        pattern: cron.schedule ?? undefined,
        every: cron.repeatEvery ?? undefined,
      };
    }
  }

  /**
   * Get all job schedulers for this queue.
   */
  async getJobSchedulers(
    _start = 0,
    _end = -1,
    _asc = true
  ): Promise<Array<{ id: string; name: string; next: number; pattern?: string; every?: number }>> {
    if (this.embedded) {
      const crons = getSharedManager()
        .listCrons()
        .filter((c) => c.queue === this.name);
      return crons.map((c) => ({
        id: c.name,
        name: c.name,
        next: c.nextRun,
        pattern: c.schedule ?? undefined,
        every: c.repeatEvery ?? undefined,
      }));
    } else {
      const response = await this.tcp.send({ cmd: 'CronList' });
      if (!response.ok) return [];
      const crons = (
        response as {
          crons?: Array<{
            name: string;
            queue: string;
            nextRun: number;
            schedule?: string;
            repeatEvery?: number;
          }>;
        }
      ).crons;
      return (crons ?? [])
        .filter((c) => c.queue === this.name)
        .map((c) => ({
          id: c.name,
          name: c.name,
          next: c.nextRun,
          pattern: c.schedule ?? undefined,
          every: c.repeatEvery ?? undefined,
        }));
    }
  }

  /** Get count of job schedulers for this queue */
  async getJobSchedulersCount(): Promise<number> {
    const schedulers = await this.getJobSchedulers();
    return schedulers.length;
  }

  // ============================================================================
  // Deduplication Methods
  // ============================================================================

  /**
   * Get the job ID associated with a deduplication key.
   */
  getDeduplicationJobId(deduplicationId: string): Promise<string | null> {
    if (this.embedded) {
      const job = getSharedManager().getJobByCustomId(deduplicationId);
      return Promise.resolve(job ? String(job.id) : null);
    }
    // TCP mode - would need server support
    return Promise.resolve(null);
  }

  /**
   * Remove a deduplication key, allowing a new job with the same key.
   */
  removeDeduplicationKey(deduplicationId: string): Promise<number> {
    if (this.embedded) {
      // Remove the custom ID mapping
      const job = getSharedManager().getJobByCustomId(deduplicationId);
      if (job) {
        // Would need a method to remove just the customId mapping
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    }
    return Promise.resolve(0);
  }

  // ============================================================================
  // Connection Methods
  // ============================================================================

  /**
   * Wait until the queue is ready (connection established).
   */
  async waitUntilReady(): Promise<void> {
    if (this.embedded) {
      // Embedded mode is always ready
      return;
    }
    // TCP mode - the pool handles connection
    // Just ensure we can send a ping
    await this.tcp.send({ cmd: 'Ping' });
  }

  /**
   * Disconnect from the server (async version of close).
   */
  disconnect(): Promise<void> {
    this.close();
    return Promise.resolve();
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
      getState: () => this.getJobState(id),
      remove: () => this.removeAsync(id),
      retry: () => this.retryJob(id),
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
      getState: () => this.getJobState(id),
      remove: () => this.removeAsync(id),
      retry: () => this.retryJob(id),
    };
  }
}
