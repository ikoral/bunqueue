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
  ChangePriorityOpts,
  GetDependenciesOpts,
  JobDependencies,
  JobDependenciesCount,
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

    // Add parent info to data if specified (BullMQ v5 flow support)
    const jobData: Record<string, unknown> = { name, ...(data as object) };
    if (merged.parent) {
      jobData.__parentId = merged.parent.id;
      jobData.__parentQueue = merged.parent.queue;
    }

    if (this.embedded) {
      const manager = getSharedManager();

      // Parse removeOnComplete/removeOnFail (can be boolean, number, or KeepJobs)
      const removeOnComplete =
        typeof merged.removeOnComplete === 'boolean' ? merged.removeOnComplete : false;
      const removeOnFail = typeof merged.removeOnFail === 'boolean' ? merged.removeOnFail : false;

      // Parse repeat options with extended BullMQ v5 fields
      const repeat = merged.repeat
        ? {
            every: merged.repeat.every,
            limit: merged.repeat.limit,
            pattern: merged.repeat.pattern,
            count: merged.repeat.count,
            startDate:
              merged.repeat.startDate instanceof Date
                ? merged.repeat.startDate.getTime()
                : typeof merged.repeat.startDate === 'string'
                  ? new Date(merged.repeat.startDate).getTime()
                  : merged.repeat.startDate,
            endDate:
              merged.repeat.endDate instanceof Date
                ? merged.repeat.endDate.getTime()
                : typeof merged.repeat.endDate === 'string'
                  ? new Date(merged.repeat.endDate).getTime()
                  : merged.repeat.endDate,
            tz: merged.repeat.tz,
            immediately: merged.repeat.immediately,
            prevMillis: merged.repeat.prevMillis,
            offset: merged.repeat.offset,
            jobId: merged.repeat.jobId,
          }
        : undefined;

      const job = await manager.push(this.name, {
        data: jobData,
        priority: merged.priority,
        delay: merged.delay,
        maxAttempts: merged.attempts,
        backoff: merged.backoff,
        timeout: merged.timeout,
        customId: merged.jobId ?? merged.deduplication?.id,
        removeOnComplete,
        removeOnFail,
        repeat,
        stallTimeout: merged.stallTimeout,
        durable: merged.durable,
        parentId: merged.parent ? jobId(merged.parent.id) : undefined,
        // BullMQ v5 options
        lifo: merged.lifo,
        stackTraceLimit: merged.stackTraceLimit,
        keepLogs: merged.keepLogs,
        sizeLimit: merged.sizeLimit,
        failParentOnFailure: merged.failParentOnFailure,
        removeDependencyOnFailure: merged.removeDependencyOnFailure,
        dedup: merged.deduplication ? { ttl: merged.deduplication.ttl } : undefined,
        debounceId: merged.debounce?.id,
        debounceTtl: merged.debounce?.ttl,
      });
      return toPublicJob<T>({
        job,
        name,
        getState: (jid) => this.getJobState(jid),
        remove: (jid) => this.removeAsync(jid),
        retry: (jid) => this.retryJob(jid),
        getChildrenValues: (jid) => this.getChildrenValues(jid),
        updateData: (jid, data) => this.updateJobData(jid, data),
        promote: (jid) => this.promoteJob(jid),
        changeDelay: (jid, delay) => this.changeJobDelay(jid, delay),
        changePriority: (jid, opts) => this.changeJobPriority(jid, opts),
        extendLock: (jid, token, duration) => this.extendJobLock(jid, token, duration),
        clearLogs: (jid, keepLogs) => this.clearJobLogs(jid, keepLogs),
        getDependencies: (jid, opts) => this.getJobDependencies(jid, opts),
        getDependenciesCount: (jid, opts) => this.getJobDependenciesCount(jid, opts),
        moveToCompleted: (jid, result, token) => this.moveJobToCompleted(jid, result, token),
        moveToFailed: (jid, error, token) => this.moveJobToFailed(jid, error, token),
        moveToWait: (jid, token) => this.moveJobToWait(jid, token),
        moveToDelayed: (jid, timestamp, token) => this.moveJobToDelayed(jid, timestamp, token),
        moveToWaitingChildren: (jid, token, opts) =>
          this.moveJobToWaitingChildren(jid, token, opts),
        waitUntilFinished: (jid, queueEvents, ttl) =>
          this.waitJobUntilFinished(jid, queueEvents, ttl),
      });
    }

    const response = await this.tcp.send({
      cmd: 'PUSH',
      queue: this.name,
      data: jobData,
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
      parentId: merged.parent?.id,
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
        // Parse removeOnComplete/removeOnFail (can be boolean, number, or KeepJobs)
        const removeOnComplete =
          typeof m.removeOnComplete === 'boolean' ? m.removeOnComplete : false;
        const removeOnFail = typeof m.removeOnFail === 'boolean' ? m.removeOnFail : false;
        return {
          data: { name, ...data },
          priority: m.priority,
          delay: m.delay,
          maxAttempts: m.attempts,
          backoff: m.backoff,
          timeout: m.timeout,
          customId: m.jobId,
          removeOnComplete,
          removeOnFail,
          repeat: m.repeat
            ? {
                every: m.repeat.every,
                limit: m.repeat.limit,
                pattern: m.repeat.pattern,
                count: m.repeat.count,
                startDate:
                  m.repeat.startDate instanceof Date
                    ? m.repeat.startDate.getTime()
                    : typeof m.repeat.startDate === 'string'
                      ? new Date(m.repeat.startDate).getTime()
                      : m.repeat.startDate,
                endDate:
                  m.repeat.endDate instanceof Date
                    ? m.repeat.endDate.getTime()
                    : typeof m.repeat.endDate === 'string'
                      ? new Date(m.repeat.endDate).getTime()
                      : m.repeat.endDate,
                tz: m.repeat.tz,
                immediately: m.repeat.immediately,
                prevMillis: m.repeat.prevMillis,
                offset: m.repeat.offset,
                jobId: m.repeat.jobId,
              }
            : undefined,
          stallTimeout: m.stallTimeout,
          durable: m.durable,
          // BullMQ v5 options
          lifo: m.lifo,
          stackTraceLimit: m.stackTraceLimit,
          keepLogs: m.keepLogs,
          sizeLimit: m.sizeLimit,
          failParentOnFailure: m.failParentOnFailure,
          removeDependencyOnFailure: m.removeDependencyOnFailure,
          dedup: m.deduplication ? { ttl: m.deduplication.ttl } : undefined,
          debounceId: m.debounce?.id,
          debounceTtl: m.debounce?.ttl,
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
      return toPublicJob<T>({
        job,
        name: jobData?.name ?? 'default',
        getState: (jid) => this.getJobState(jid),
        remove: (jid) => this.removeAsync(jid),
        retry: (jid) => this.retryJob(jid),
        getChildrenValues: (jid) => this.getChildrenValues(jid),
        updateData: (jid, data) => this.updateJobData(jid, data),
        promote: (jid) => this.promoteJob(jid),
        changeDelay: (jid, delay) => this.changeJobDelay(jid, delay),
        changePriority: (jid, opts) => this.changeJobPriority(jid, opts),
        extendLock: (jid, token, duration) => this.extendJobLock(jid, token, duration),
        clearLogs: (jid, keepLogs) => this.clearJobLogs(jid, keepLogs),
        getDependencies: (jid, opts) => this.getJobDependencies(jid, opts),
        getDependenciesCount: (jid, opts) => this.getJobDependenciesCount(jid, opts),
        moveToCompleted: (jid, result, token) => this.moveJobToCompleted(jid, result, token),
        moveToFailed: (jid, error, token) => this.moveJobToFailed(jid, error, token),
        moveToWait: (jid, token) => this.moveJobToWait(jid, token),
        moveToDelayed: (jid, timestamp, token) => this.moveJobToDelayed(jid, timestamp, token),
        moveToWaitingChildren: (jid, token, opts) =>
          this.moveJobToWaitingChildren(jid, token, opts),
        waitUntilFinished: (jid, queueEvents, ttl) =>
          this.waitJobUntilFinished(jid, queueEvents, ttl),
      });
    }

    const response = await this.tcp.send({ cmd: 'GetJob', id });
    if (!response.ok || !response.job) return null;
    const jobData = response.job as Record<string, unknown>;
    const data = jobData.data as { name?: string } | null;
    const jobIdStr = String(jobData.id);
    const ts = (jobData.createdAt as number | undefined) ?? Date.now();
    const runAt = (jobData.runAt as number | undefined) ?? ts;
    return {
      id: jobIdStr,
      name: data?.name ?? 'default',
      data: jobData.data as T,
      queueName: this.name,
      attemptsMade: (jobData.attempts as number | undefined) ?? 0,
      timestamp: ts,
      progress: (jobData.progress as number | undefined) ?? 0,
      // BullMQ v5 properties
      delay: runAt > ts ? runAt - ts : 0,
      processedOn: (jobData.startedAt as number | undefined) ?? undefined,
      finishedOn: (jobData.completedAt as number | undefined) ?? undefined,
      stacktrace: null,
      stalledCounter: (jobData.stallCount as number | undefined) ?? 0,
      priority: (jobData.priority as number | undefined) ?? 0,
      parentKey: undefined,
      opts: {},
      token: undefined,
      processedBy: undefined,
      deduplicationId: (jobData.customId as string | undefined) ?? undefined,
      repeatJobKey: undefined,
      attemptsStarted: (jobData.attempts as number | undefined) ?? 0,
      // Methods
      updateProgress: async () => {},
      log: async () => {},
      getState: () => this.getJobState(jobIdStr),
      remove: () => this.removeAsync(jobIdStr),
      retry: () => this.retryJob(jobIdStr),
      getChildrenValues: () => this.getChildrenValues(jobIdStr),
      // BullMQ v5 state check methods
      isWaiting: async () => (await this.getJobState(jobIdStr)) === 'waiting',
      isActive: async () => (await this.getJobState(jobIdStr)) === 'active',
      isDelayed: async () => (await this.getJobState(jobIdStr)) === 'delayed',
      isCompleted: async () => (await this.getJobState(jobIdStr)) === 'completed',
      isFailed: async () => (await this.getJobState(jobIdStr)) === 'failed',
      isWaitingChildren: () => Promise.resolve(false),
      // BullMQ v5 mutation methods
      updateData: async () => {},
      promote: async () => {},
      changeDelay: async () => {},
      changePriority: async () => {},
      extendLock: () => Promise.resolve(0),
      clearLogs: async () => {},
      // BullMQ v5 dependency methods
      getDependencies: () => Promise.resolve({ processed: {}, unprocessed: [] }),
      getDependenciesCount: () => Promise.resolve({ processed: 0, unprocessed: 0 }),
      // BullMQ v5 serialization methods
      toJSON: () => ({
        id: jobIdStr,
        name: data?.name ?? 'default',
        data: jobData.data as T,
        opts: {},
        progress: (jobData.progress as number | undefined) ?? 0,
        delay: runAt > ts ? runAt - ts : 0,
        timestamp: ts,
        attemptsMade: (jobData.attempts as number | undefined) ?? 0,
        stacktrace: null,
        queueQualifiedName: `bull:${this.name}`,
      }),
      asJSON: () => ({
        id: jobIdStr,
        name: data?.name ?? 'default',
        data: JSON.stringify(jobData.data),
        opts: '{}',
        progress: String((jobData.progress as number | undefined) ?? 0),
        delay: String(runAt > ts ? runAt - ts : 0),
        timestamp: String(ts),
        attemptsMade: String((jobData.attempts as number | undefined) ?? 0),
        stacktrace: null,
      }),
      // BullMQ v5 move methods
      moveToCompleted: () => Promise.resolve(null),
      moveToFailed: () => Promise.resolve(),
      moveToWait: () => Promise.resolve(false),
      moveToDelayed: () => Promise.resolve(),
      moveToWaitingChildren: () => Promise.resolve(false),
      waitUntilFinished: () => Promise.resolve(undefined),
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

  /**
   * Get the return values of all children jobs (BullMQ v5 compatible).
   * Returns a Record where keys are job keys (queueName:jobId) and values are return values.
   */
  getChildrenValues(id: string): Promise<Record<string, unknown>> {
    if (this.embedded) {
      const manager = getSharedManager();
      return manager.getChildrenValues(jobId(id));
    }
    // TCP mode - would need server-side support
    // For now, return empty object
    return Promise.resolve({});
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
        return toPublicJob<T>({
          job,
          name: jobData?.name ?? 'default',
          getState: (jid) => this.getJobState(jid),
          remove: (jid) => this.removeAsync(jid),
          retry: (jid) => this.retryJob(jid),
          getChildrenValues: (jid) => this.getChildrenValues(jid),
          updateData: (jid, data) => this.updateJobData(jid, data),
          promote: (jid) => this.promoteJob(jid),
          changeDelay: (jid, delay) => this.changeJobDelay(jid, delay),
          changePriority: (jid, opts) => this.changeJobPriority(jid, opts),
          extendLock: (jid, token, duration) => this.extendJobLock(jid, token, duration),
          clearLogs: (jid, keepLogs) => this.clearJobLogs(jid, keepLogs),
          getDependencies: (jid, opts) => this.getJobDependencies(jid, opts),
          getDependenciesCount: (jid, opts) => this.getJobDependenciesCount(jid, opts),
          moveToCompleted: (jid, result, token) => this.moveJobToCompleted(jid, result, token),
          moveToFailed: (jid, error, token) => this.moveJobToFailed(jid, error, token),
          moveToWait: (jid, token) => this.moveJobToWait(jid, token),
          moveToDelayed: (jid, timestamp, token) => this.moveJobToDelayed(jid, timestamp, token),
          moveToWaitingChildren: (jid, token, opts) =>
            this.moveJobToWaitingChildren(jid, token, opts),
          waitUntilFinished: (jid, queueEvents, ttl) =>
            this.waitJobUntilFinished(jid, queueEvents, ttl),
        });
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
      const jobName = jobData?.name ?? 'default';
      return {
        id: j.id,
        name: jobName,
        data: j.data as T,
        queueName: j.queue,
        attemptsMade: j.attempts,
        timestamp: j.createdAt,
        progress: j.progress ?? 0,
        // BullMQ v5 properties
        delay: 0,
        processedOn: undefined,
        finishedOn: undefined,
        stacktrace: null,
        stalledCounter: 0,
        priority: j.priority,
        parentKey: undefined,
        opts: {},
        token: undefined,
        processedBy: undefined,
        deduplicationId: undefined,
        repeatJobKey: undefined,
        attemptsStarted: j.attempts,
        // Methods
        updateProgress: async () => {},
        log: async () => {},
        getState: () => this.getJobState(j.id),
        remove: () => this.removeAsync(j.id),
        retry: () => this.retryJob(j.id),
        getChildrenValues: () => this.getChildrenValues(j.id),
        // BullMQ v5 state check methods
        isWaiting: async () => (await this.getJobState(j.id)) === 'waiting',
        isActive: async () => (await this.getJobState(j.id)) === 'active',
        isDelayed: async () => (await this.getJobState(j.id)) === 'delayed',
        isCompleted: async () => (await this.getJobState(j.id)) === 'completed',
        isFailed: async () => (await this.getJobState(j.id)) === 'failed',
        isWaitingChildren: () => Promise.resolve(false),
        // BullMQ v5 mutation methods
        updateData: async () => {},
        promote: async () => {},
        changeDelay: async () => {},
        changePriority: async () => {},
        extendLock: () => Promise.resolve(0),
        clearLogs: async () => {},
        // BullMQ v5 dependency methods
        getDependencies: () => Promise.resolve({ processed: {}, unprocessed: [] }),
        getDependenciesCount: () => Promise.resolve({ processed: 0, unprocessed: 0 }),
        // BullMQ v5 serialization methods
        toJSON: () => ({
          id: j.id,
          name: jobName,
          data: j.data as T,
          opts: {},
          progress: j.progress ?? 0,
          delay: 0,
          timestamp: j.createdAt,
          attemptsMade: j.attempts,
          stacktrace: null,
          queueQualifiedName: `bull:${j.queue}`,
        }),
        asJSON: () => ({
          id: j.id,
          name: jobName,
          data: JSON.stringify(j.data),
          opts: '{}',
          progress: String(j.progress ?? 0),
          delay: '0',
          timestamp: String(j.createdAt),
          attemptsMade: String(j.attempts),
          stacktrace: null,
        }),
        // BullMQ v5 move methods
        moveToCompleted: () => Promise.resolve(null),
        moveToFailed: () => Promise.resolve(),
        moveToWait: () => Promise.resolve(false),
        moveToDelayed: () => Promise.resolve(),
        moveToWaitingChildren: () => Promise.resolve(false),
        waitUntilFinished: () => Promise.resolve(undefined),
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
          return toPublicJob<T>({
            job,
            name: jobData?.name ?? 'default',
            getState: (jid) => this.getJobState(jid),
            remove: (jid) => this.removeAsync(jid),
            retry: (jid) => this.retryJob(jid),
            getChildrenValues: (jid) => this.getChildrenValues(jid),
            updateData: (jid, data) => this.updateJobData(jid, data),
            promote: (jid) => this.promoteJob(jid),
            changeDelay: (jid, delay) => this.changeJobDelay(jid, delay),
            changePriority: (jid, opts) => this.changeJobPriority(jid, opts),
            extendLock: (jid, token, duration) => this.extendJobLock(jid, token, duration),
            clearLogs: (jid, keepLogs) => this.clearJobLogs(jid, keepLogs),
            getDependencies: (jid, opts) => this.getJobDependencies(jid, opts),
            getDependenciesCount: (jid, opts) => this.getJobDependenciesCount(jid, opts),
          });
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

  // ============================================================================
  // BullMQ v5 Job Mutation Methods (used by Job instances)
  // ============================================================================

  /** Update job data */
  async updateJobData(id: string, data: unknown): Promise<void> {
    if (this.embedded) {
      const manager = getSharedManager();
      await manager.updateJobData(jobId(id), data);
    } else {
      await this.tcp.send({ cmd: 'Update', id, data });
    }
  }

  /** Promote a delayed job to waiting */
  async promoteJob(id: string): Promise<void> {
    if (this.embedded) {
      await getSharedManager().promote(jobId(id));
    } else {
      await this.tcp.send({ cmd: 'Promote', id });
    }
  }

  /** Change job delay */
  async changeJobDelay(id: string, delay: number): Promise<void> {
    if (this.embedded) {
      const manager = getSharedManager();
      await manager.changeDelay(jobId(id), delay);
    } else {
      await this.tcp.send({ cmd: 'ChangeDelay', id, delay });
    }
  }

  /** Change job priority */
  async changeJobPriority(id: string, opts: ChangePriorityOpts): Promise<void> {
    if (this.embedded) {
      const manager = getSharedManager();
      await manager.changePriority(jobId(id), opts.priority);
    } else {
      await this.tcp.send({ cmd: 'ChangePriority', id, priority: opts.priority });
    }
  }

  /** Extend job lock */
  async extendJobLock(id: string, _token: string, duration: number): Promise<number> {
    if (this.embedded) {
      const manager = getSharedManager();
      const extended = await manager.extendLock(jobId(id), duration);
      return extended ? duration : 0;
    } else {
      const response = await this.tcp.send({ cmd: 'ExtendLock', id, duration });
      return response.ok ? duration : 0;
    }
  }

  /** Clear job logs */
  async clearJobLogs(id: string, keepLogs?: number): Promise<void> {
    if (this.embedded) {
      const manager = getSharedManager();
      manager.clearLogs(jobId(id), keepLogs);
    } else {
      await this.tcp.send({ cmd: 'ClearLogs', id, keepLogs });
    }
  }

  /** Get job dependencies */
  async getJobDependencies(id: string, _opts?: GetDependenciesOpts): Promise<JobDependencies> {
    if (this.embedded) {
      const manager = getSharedManager();
      const job = await manager.getJob(jobId(id));
      if (!job) return { processed: {}, unprocessed: [] };

      const childIds = job.childrenIds;
      const processed: Record<string, unknown> = {};
      const unprocessed: string[] = [];

      for (const childId of childIds) {
        const result = manager.getResult(childId);
        if (result !== undefined) {
          const childJob = await manager.getJob(childId);
          const key = childJob ? `${childJob.queue}:${childId}` : String(childId);
          processed[key] = result;
        } else {
          unprocessed.push(String(childId));
        }
      }

      return { processed, unprocessed };
    }
    // TCP mode
    return { processed: {}, unprocessed: [] };
  }

  /** Get job dependencies count */
  async getJobDependenciesCount(
    id: string,
    _opts?: GetDependenciesOpts
  ): Promise<JobDependenciesCount> {
    if (this.embedded) {
      const deps = await this.getJobDependencies(id);
      return {
        processed: Object.keys(deps.processed).length,
        unprocessed: deps.unprocessed.length,
      };
    }
    return { processed: 0, unprocessed: 0 };
  }

  // ============================================================================
  // BullMQ v5 Job Move Methods
  // ============================================================================

  /**
   * Move job to completed state (BullMQ v5 compatible).
   * Used internally by workers to mark jobs as complete.
   */
  async moveJobToCompleted(id: string, returnValue: unknown, _token?: string): Promise<unknown> {
    if (this.embedded) {
      const manager = getSharedManager();
      await manager.ack(jobId(id), returnValue);
      return null; // Could return next job if fetchNext was true
    } else {
      await this.tcp.send({ cmd: 'ACK', id, result: returnValue });
      return null;
    }
  }

  /**
   * Move job to failed state (BullMQ v5 compatible).
   * Used internally by workers to mark jobs as failed.
   */
  async moveJobToFailed(id: string, error: Error, _token?: string): Promise<void> {
    if (this.embedded) {
      const manager = getSharedManager();
      await manager.fail(jobId(id), error.message);
    } else {
      await this.tcp.send({ cmd: 'FAIL', id, error: error.message });
    }
  }

  /**
   * Move job back to waiting state (BullMQ v5 compatible).
   * Useful for re-queueing a job that needs to be processed again.
   */
  async moveJobToWait(id: string, _token?: string): Promise<boolean> {
    if (this.embedded) {
      const manager = getSharedManager();
      const job = await manager.getJob(jobId(id));
      if (!job) return false;

      // Re-queue the job by pushing it again
      await manager.push(job.queue, {
        data: job.data,
        priority: job.priority,
        customId: job.customId ?? undefined,
      });
      return true;
    } else {
      const response = await this.tcp.send({ cmd: 'MoveToWait', id });
      return response.ok === true;
    }
  }

  /**
   * Move job to delayed state (BullMQ v5 compatible).
   * The job will become available for processing at the specified timestamp.
   */
  async moveJobToDelayed(id: string, timestamp: number, _token?: string): Promise<void> {
    if (this.embedded) {
      const manager = getSharedManager();
      const delay = Math.max(0, timestamp - Date.now());
      await manager.changeDelay(jobId(id), delay);
    } else {
      await this.tcp.send({ cmd: 'MoveToDelayed', id, timestamp });
    }
  }

  /**
   * Move job to waiting-children state (BullMQ v5 compatible).
   * Job will wait for all children to complete before processing.
   */
  async moveJobToWaitingChildren(
    id: string,
    _token?: string,
    _opts?: { child?: { id: string; queue: string } }
  ): Promise<boolean> {
    if (this.embedded) {
      // In embedded mode, this is handled automatically by the dependency system
      // The job is already in waiting-children state if it has pending children
      const manager = getSharedManager();
      const job = await manager.getJob(jobId(id));
      if (!job) return false;

      // Check if job has unprocessed children
      const deps = await this.getJobDependencies(id);
      return deps.unprocessed.length > 0;
    }
    return false;
  }

  /**
   * Wait until job has finished (completed or failed).
   * BullMQ v5 compatible method.
   */
  async waitJobUntilFinished(id: string, queueEvents: unknown, ttl?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = ttl
        ? setTimeout(() => {
            cleanup();
            reject(new Error(`Job ${id} timed out after ${ttl}ms`));
          }, ttl)
        : null;

      // Cast queueEvents to expected interface
      const events = queueEvents as {
        on: (
          event: string,
          handler: (data: { jobId: string; returnvalue?: unknown; failedReason?: string }) => void
        ) => void;
        off: (
          event: string,
          handler: (data: { jobId: string; returnvalue?: unknown; failedReason?: string }) => void
        ) => void;
      };

      const completedHandler = (data: { jobId: string; returnvalue?: unknown }) => {
        if (data.jobId === id) {
          cleanup();
          resolve(data.returnvalue);
        }
      };

      const failedHandler = (data: { jobId: string; failedReason?: string }) => {
        if (data.jobId === id) {
          cleanup();
          reject(new Error(data.failedReason ?? 'Job failed'));
        }
      };

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        events.off('completed', completedHandler);
        events.off('failed', failedHandler);
      };

      events.on('completed', completedHandler);
      events.on('failed', failedHandler);

      // Also check if job is already finished
      void this.getJobState(id).then((state) => {
        if (state === 'completed') {
          cleanup();
          // Get the result
          if (this.embedded) {
            const result = getSharedManager().getResult(jobId(id));
            resolve(result);
          } else {
            resolve(undefined);
          }
        } else if (state === 'failed') {
          cleanup();
          reject(new Error('Job already failed'));
        }
      });
    });
  }

  close(): void {
    if (this.tcpPool) {
      if (this.useSharedPool) releaseSharedPool(this.tcpPool);
      else this.tcpPool.close();
    }
  }

  private createJobProxy(id: string, name: string, data: T): Job<T> {
    const tcp = this.tcp;
    const ts = Date.now();
    return {
      id,
      name,
      data,
      queueName: this.name,
      attemptsMade: 0,
      timestamp: ts,
      progress: 0,
      // BullMQ v5 properties
      delay: 0,
      processedOn: undefined,
      finishedOn: undefined,
      stacktrace: null,
      stalledCounter: 0,
      priority: 0,
      parentKey: undefined,
      opts: {},
      token: undefined,
      processedBy: undefined,
      deduplicationId: undefined,
      repeatJobKey: undefined,
      attemptsStarted: 0,
      // Methods
      updateProgress: async (progress: number, message?: string) => {
        await tcp.send({ cmd: 'Progress', id, progress, message });
      },
      log: async (message: string) => {
        await tcp.send({ cmd: 'AddLog', id, message });
      },
      getState: () => this.getJobState(id),
      remove: () => this.removeAsync(id),
      retry: () => this.retryJob(id),
      getChildrenValues: () => this.getChildrenValues(id),
      // BullMQ v5 state check methods
      isWaiting: async () => (await this.getJobState(id)) === 'waiting',
      isActive: async () => (await this.getJobState(id)) === 'active',
      isDelayed: async () => (await this.getJobState(id)) === 'delayed',
      isCompleted: async () => (await this.getJobState(id)) === 'completed',
      isFailed: async () => (await this.getJobState(id)) === 'failed',
      isWaitingChildren: () => Promise.resolve(false),
      // BullMQ v5 mutation methods
      updateData: async (newData) => {
        await tcp.send({ cmd: 'Update', id, data: newData });
      },
      promote: async () => {
        await tcp.send({ cmd: 'Promote', id });
      },
      changeDelay: async (delay) => {
        await tcp.send({ cmd: 'ChangeDelay', id, delay });
      },
      changePriority: async (opts) => {
        await tcp.send({ cmd: 'ChangePriority', id, priority: opts.priority });
      },
      extendLock: async (_token, duration) => {
        const res = await tcp.send({ cmd: 'ExtendLock', id, duration });
        return res.ok ? duration : 0;
      },
      clearLogs: async () => {
        await tcp.send({ cmd: 'ClearLogs', id });
      },
      // BullMQ v5 dependency methods
      getDependencies: () => Promise.resolve({ processed: {}, unprocessed: [] }),
      getDependenciesCount: () => Promise.resolve({ processed: 0, unprocessed: 0 }),
      // BullMQ v5 serialization methods
      toJSON: () => ({
        id,
        name,
        data,
        opts: {},
        progress: 0,
        delay: 0,
        timestamp: ts,
        attemptsMade: 0,
        stacktrace: null,
        queueQualifiedName: `bull:${this.name}`,
      }),
      asJSON: () => ({
        id,
        name,
        data: JSON.stringify(data),
        opts: '{}',
        progress: '0',
        delay: '0',
        timestamp: String(ts),
        attemptsMade: '0',
        stacktrace: null,
      }),
      // BullMQ v5 move methods
      moveToCompleted: async (returnValue) => {
        await tcp.send({ cmd: 'ACK', id, result: returnValue });
        return null;
      },
      moveToFailed: async (error) => {
        await tcp.send({ cmd: 'FAIL', id, error: error.message });
      },
      moveToWait: async () => {
        const res = await tcp.send({ cmd: 'MoveToWait', id });
        return res.ok === true;
      },
      moveToDelayed: async (timestamp) => {
        await tcp.send({ cmd: 'MoveToDelayed', id, timestamp });
      },
      moveToWaitingChildren: () => Promise.resolve(false),
      waitUntilFinished: () => Promise.resolve(undefined),
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
      // BullMQ v5 properties
      delay: 0,
      processedOn: undefined,
      finishedOn: undefined,
      stacktrace: null,
      stalledCounter: 0,
      priority: 0,
      parentKey: undefined,
      opts: {},
      token: undefined,
      processedBy: undefined,
      deduplicationId: undefined,
      repeatJobKey: undefined,
      attemptsStarted: 0,
      // Methods
      updateProgress: async () => {},
      log: async () => {},
      getState: () => this.getJobState(id),
      remove: () => this.removeAsync(id),
      retry: () => this.retryJob(id),
      getChildrenValues: () => this.getChildrenValues(id),
      // BullMQ v5 state check methods
      isWaiting: async () => (await this.getJobState(id)) === 'waiting',
      isActive: async () => (await this.getJobState(id)) === 'active',
      isDelayed: async () => (await this.getJobState(id)) === 'delayed',
      isCompleted: async () => (await this.getJobState(id)) === 'completed',
      isFailed: async () => (await this.getJobState(id)) === 'failed',
      isWaitingChildren: () => Promise.resolve(false),
      // BullMQ v5 mutation methods
      updateData: async () => {},
      promote: async () => {},
      changeDelay: async () => {},
      changePriority: async () => {},
      extendLock: () => Promise.resolve(0),
      clearLogs: async () => {},
      // BullMQ v5 dependency methods
      getDependencies: () => Promise.resolve({ processed: {}, unprocessed: [] }),
      getDependenciesCount: () => Promise.resolve({ processed: 0, unprocessed: 0 }),
      // BullMQ v5 serialization methods
      toJSON: () => ({
        id,
        name,
        data,
        opts: {},
        progress: 0,
        delay: 0,
        timestamp,
        attemptsMade: 0,
        stacktrace: null,
        queueQualifiedName: `bull:${this.name}`,
      }),
      asJSON: () => ({
        id,
        name,
        data: JSON.stringify(data),
        opts: '{}',
        progress: '0',
        delay: '0',
        timestamp: String(timestamp),
        attemptsMade: '0',
        stacktrace: null,
      }),
      // BullMQ v5 move methods
      moveToCompleted: () => Promise.resolve(null),
      moveToFailed: () => Promise.resolve(),
      moveToWait: () => Promise.resolve(false),
      moveToDelayed: () => Promise.resolve(),
      moveToWaitingChildren: () => Promise.resolve(false),
      waitUntilFinished: () => Promise.resolve(undefined),
    };
  }
}
