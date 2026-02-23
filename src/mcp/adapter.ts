/* eslint-disable @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unnecessary-type-conversion, @typescript-eslint/no-base-to-string, @typescript-eslint/prefer-readonly, @typescript-eslint/require-await */
/**
 * MCP Backend Adapter
 * Abstraction layer for embedded (SQLite direct) and TCP (remote server) modes.
 */

import type { Job } from '../domain/types/job';
import type { CronJobInput } from '../domain/types/cron';
import type { JobLogEntry } from '../domain/types/worker';
import { jobId as toJobId } from '../domain/types/job';

/** Job counts per state */
export interface JobCounts {
  waiting: number;
  delayed: number;
  active: number;
  completed: number;
  failed: number;
}

/** Serialized job for MCP responses */
export interface SerializedJob {
  id: string;
  queue: string;
  data: unknown;
  priority: number;
  state?: string;
  progress: number;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt?: string;
}

/** Serialized cron for MCP responses */
export interface SerializedCron {
  name: string;
  queue: string;
  schedule?: string;
  repeatEvery?: number;
  nextRun: string | null;
  executions: number;
}

/** Webhook info */
export interface WebhookInfo {
  id: string;
  url: string;
  events: string[];
  queue?: string;
  enabled: boolean;
}

/** Worker info */
export interface WorkerInfo {
  id: string;
  name: string;
  queues: string[];
  active: number;
  processed: number;
  failed: number;
  lastHeartbeat: number;
}

/** Common backend interface - all methods async for TCP compatibility */
export interface McpBackend {
  // Job operations
  addJob(
    queue: string,
    name: string,
    data: unknown,
    opts?: { priority?: number; delay?: number; attempts?: number }
  ): Promise<{ jobId: string }>;
  addJobsBulk(
    queue: string,
    jobs: Array<{ name: string; data: unknown; priority?: number; delay?: number }>
  ): Promise<{ jobIds: string[] }>;
  getJob(jobId: string): Promise<SerializedJob | null>;
  getJobState(jobId: string): Promise<string>;
  getJobResult(jobId: string): Promise<unknown>;
  getProgress(jobId: string): Promise<{ progress: number; message: string | null } | null>;
  cancelJob(jobId: string): Promise<boolean>;
  promoteJob(jobId: string): Promise<boolean>;
  updateProgress(jobId: string, progress: number, message?: string): Promise<boolean>;
  updateJobData(jobId: string, data: unknown): Promise<boolean>;
  changeJobPriority(jobId: string, priority: number): Promise<boolean>;
  moveToDelayed(jobId: string, delay: number): Promise<boolean>;
  changeDelay(jobId: string, delay: number): Promise<boolean>;
  discardJob(jobId: string): Promise<boolean>;
  getChildrenValues(parentJobId: string): Promise<Record<string, unknown>>;
  getJobByCustomId(customId: string): Promise<SerializedJob | null>;
  waitForJobCompletion(jobId: string, timeoutMs: number): Promise<boolean>;

  // Job consumption (pull/ack/fail cycle)
  pullJob(queue: string, timeoutMs?: number): Promise<SerializedJob | null>;
  pullJobBatch(queue: string, count: number, timeoutMs?: number): Promise<SerializedJob[]>;
  ackJob(jobId: string, result?: unknown): Promise<void>;
  ackJobBatch(jobIds: string[]): Promise<void>;
  failJob(jobId: string, error?: string): Promise<void>;
  jobHeartbeat(jobId: string): Promise<boolean>;
  jobHeartbeatBatch(jobIds: string[]): Promise<number>;

  // Lock management
  extendLock(jobId: string, token: string, duration: number): Promise<boolean>;

  // Queue operations
  getJobs(
    queue: string,
    opts?: { state?: string; start?: number; end?: number }
  ): Promise<SerializedJob[]>;
  getJobCounts(queue: string): Promise<JobCounts>;
  pauseQueue(queue: string): Promise<void>;
  resumeQueue(queue: string): Promise<void>;
  drainQueue(queue: string): Promise<number>;
  obliterateQueue(queue: string): Promise<void>;
  listQueues(): Promise<string[]>;
  countJobs(queue: string): Promise<number>;
  cleanQueue(queue: string, graceMs: number, state?: string, limit?: number): Promise<number>;
  isPaused(queue: string): Promise<boolean>;
  getCountsPerPriority(queue: string): Promise<Record<number, number>>;

  // DLQ
  getDlq(queue: string, limit?: number): Promise<SerializedJob[]>;
  retryDlq(queue: string, jobId?: string): Promise<number>;
  purgeDlq(queue: string): Promise<number>;
  retryCompleted(queue: string, jobId?: string): Promise<number>;

  // Rate limit & concurrency
  setRateLimit(queue: string, limit: number): Promise<void>;
  clearRateLimit(queue: string): Promise<void>;
  setConcurrency(queue: string, limit: number): Promise<void>;
  clearConcurrency(queue: string): Promise<void>;

  // Cron
  addCron(input: CronJobInput): Promise<SerializedCron>;
  getCron(name: string): Promise<SerializedCron | null>;
  listCrons(): Promise<SerializedCron[]>;
  deleteCron(name: string): Promise<boolean>;

  // Webhooks
  addWebhook(url: string, events: string[], queue?: string): Promise<WebhookInfo>;
  removeWebhook(id: string): Promise<boolean>;
  listWebhooks(): Promise<WebhookInfo[]>;
  setWebhookEnabled(id: string, enabled: boolean): Promise<boolean>;

  // Worker management
  registerWorker(name: string, queues: string[]): Promise<WorkerInfo>;
  unregisterWorker(id: string): Promise<boolean>;
  workerHeartbeat(id: string): Promise<boolean>;
  listWorkers(): Promise<WorkerInfo[]>;

  // Monitoring & logs
  getStats(): Promise<Record<string, unknown>>;
  getPerQueueStats(): Promise<Record<string, unknown>>;
  getMemoryStats(): Promise<Record<string, unknown>>;
  getPrometheusMetrics(): Promise<string>;
  getStorageStatus(): Promise<{ diskFull: boolean; error: string | null }>;
  getJobLogs(jobId: string): Promise<JobLogEntry[]>;
  addJobLog(jobId: string, message: string, level?: 'info' | 'warn' | 'error'): Promise<boolean>;
  clearJobLogs(jobId: string, keepLogs?: number): Promise<void>;
  compactMemory(): Promise<void>;

  // Lifecycle
  shutdown(): void;
}

/** Serialize a Job to a plain object */
function serializeJob(job: Job): SerializedJob {
  return {
    id: String(job.id),
    queue: job.queue,
    data: job.data,
    priority: job.priority,
    progress: job.progress,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdAt: new Date(job.createdAt).toISOString(),
    startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : undefined,
  };
}

function serializeCron(c: {
  name: string;
  queue: string;
  schedule?: string | null;
  repeatEvery?: number | null;
  nextRun: number | null;
  executions: number;
}): SerializedCron {
  return {
    name: c.name,
    queue: c.queue,
    schedule: c.schedule ?? undefined,
    repeatEvery: c.repeatEvery ?? undefined,
    nextRun: c.nextRun ? new Date(c.nextRun).toISOString() : null,
    executions: c.executions,
  };
}

// ============ Embedded Backend ============

import { getSharedManager, shutdownManager } from '../client/manager';

export class EmbeddedBackend implements McpBackend {
  private get manager() {
    return getSharedManager();
  }

  async addJob(
    queue: string,
    name: string,
    data: unknown,
    opts?: { priority?: number; delay?: number; attempts?: number }
  ) {
    const job = await this.manager.push(queue, {
      data: { name, ...(data as object) },
      priority: opts?.priority,
      delay: opts?.delay,
      maxAttempts: opts?.attempts,
    });
    return { jobId: String(job.id) };
  }

  async addJobsBulk(
    queue: string,
    jobs: Array<{ name: string; data: unknown; priority?: number; delay?: number }>
  ) {
    const inputs = jobs.map((j) => ({
      data: { name: j.name, ...(j.data as object) },
      priority: j.priority,
      delay: j.delay,
    }));
    const ids = await this.manager.pushBatch(queue, inputs);
    return { jobIds: ids.map(String) };
  }

  async getJob(id: string) {
    const job = await this.manager.getJob(toJobId(id));
    return job ? serializeJob(job) : null;
  }

  getJobState(id: string) {
    return Promise.resolve(this.manager.getJobState(toJobId(id)));
  }

  getJobResult(id: string) {
    return Promise.resolve(this.manager.getResult(toJobId(id)));
  }

  cancelJob(id: string) {
    return Promise.resolve(this.manager.cancel(toJobId(id)));
  }

  promoteJob(id: string) {
    return Promise.resolve(this.manager.promote(toJobId(id)));
  }

  updateProgress(id: string, progress: number, message?: string) {
    return Promise.resolve(this.manager.updateProgress(toJobId(id), progress, message));
  }

  updateJobData(id: string, data: unknown) {
    return Promise.resolve(this.manager.updateJobData(toJobId(id), data));
  }

  changeJobPriority(id: string, priority: number) {
    return Promise.resolve(this.manager.changePriority(toJobId(id), priority));
  }

  moveToDelayed(id: string, delay: number) {
    return Promise.resolve(this.manager.moveToDelayed(toJobId(id), delay));
  }

  discardJob(id: string) {
    return Promise.resolve(this.manager.discard(toJobId(id)));
  }

  getChildrenValues(parentJobId: string) {
    return Promise.resolve(this.manager.getChildrenValues(toJobId(parentJobId)));
  }

  getJobByCustomId(customId: string) {
    const job = this.manager.getJobByCustomId(customId);
    return Promise.resolve(job ? serializeJob(job) : null);
  }

  waitForJobCompletion(id: string, timeoutMs: number) {
    return this.manager.waitForJobCompletion(toJobId(id), timeoutMs);
  }

  async pullJob(queue: string, timeoutMs?: number) {
    const job = await this.manager.pull(queue, timeoutMs);
    return job ? serializeJob(job) : null;
  }

  async pullJobBatch(queue: string, count: number, timeoutMs?: number) {
    const jobs = await this.manager.pullBatch(queue, count, timeoutMs);
    return jobs.map(serializeJob);
  }

  async ackJob(id: string, result?: unknown) {
    await this.manager.ack(toJobId(id), result);
  }

  async ackJobBatch(ids: string[]) {
    await this.manager.ackBatch(ids.map(toJobId));
  }

  async failJob(id: string, error?: string) {
    await this.manager.fail(toJobId(id), error);
  }

  jobHeartbeat(id: string) {
    return Promise.resolve(this.manager.jobHeartbeat(toJobId(id)));
  }

  jobHeartbeatBatch(ids: string[]) {
    return Promise.resolve(this.manager.jobHeartbeatBatch(ids.map(toJobId)));
  }

  getProgress(id: string) {
    return Promise.resolve(this.manager.getProgress(toJobId(id)));
  }

  changeDelay(id: string, delay: number) {
    return Promise.resolve(this.manager.changeDelay(toJobId(id), delay));
  }

  extendLock(id: string, token: string, duration: number) {
    return Promise.resolve(this.manager.extendLock(toJobId(id), token, duration));
  }

  getJobs(queue: string, opts?: { state?: string; start?: number; end?: number }) {
    const jobs = this.manager.getJobs(queue, {
      state: opts?.state as 'waiting' | 'delayed' | 'active' | 'completed' | 'failed',
      start: opts?.start,
      end: opts?.end,
    });
    return Promise.resolve(jobs.map(serializeJob));
  }

  getJobCounts(queue: string): Promise<JobCounts> {
    return Promise.resolve(this.manager.getQueueJobCounts(queue));
  }

  pauseQueue(queue: string) {
    this.manager.pause(queue);
    return Promise.resolve();
  }

  resumeQueue(queue: string) {
    this.manager.resume(queue);
    return Promise.resolve();
  }

  drainQueue(queue: string) {
    return Promise.resolve(this.manager.drain(queue));
  }

  obliterateQueue(queue: string) {
    this.manager.obliterate(queue);
    return Promise.resolve();
  }

  listQueues() {
    return Promise.resolve(this.manager.listQueues());
  }

  countJobs(queue: string) {
    return Promise.resolve(this.manager.count(queue));
  }

  cleanQueue(queue: string, graceMs: number, state?: string, limit?: number) {
    return Promise.resolve(this.manager.clean(queue, graceMs, state, limit));
  }

  isPaused(queue: string) {
    return Promise.resolve(this.manager.isPaused(queue));
  }

  getCountsPerPriority(queue: string) {
    return Promise.resolve(this.manager.getCountsPerPriority(queue));
  }

  getDlq(queue: string, limit?: number) {
    return Promise.resolve(this.manager.getDlq(queue, limit).map(serializeJob));
  }

  retryDlq(queue: string, id?: string) {
    return Promise.resolve(this.manager.retryDlq(queue, id ? toJobId(id) : undefined));
  }

  purgeDlq(queue: string) {
    return Promise.resolve(this.manager.purgeDlq(queue));
  }

  retryCompleted(queue: string, id?: string) {
    return Promise.resolve(this.manager.retryCompleted(queue, id ? toJobId(id) : undefined));
  }

  setRateLimit(queue: string, limit: number) {
    this.manager.setRateLimit(queue, limit);
    return Promise.resolve();
  }

  clearRateLimit(queue: string) {
    this.manager.clearRateLimit(queue);
    return Promise.resolve();
  }

  setConcurrency(queue: string, limit: number) {
    this.manager.setConcurrency(queue, limit);
    return Promise.resolve();
  }

  clearConcurrency(queue: string) {
    this.manager.clearConcurrency(queue);
    return Promise.resolve();
  }

  addCron(input: CronJobInput): Promise<SerializedCron> {
    const cron = this.manager.addCron(input);
    return Promise.resolve(serializeCron(cron));
  }

  listCrons(): Promise<SerializedCron[]> {
    return Promise.resolve(this.manager.listCrons().map(serializeCron));
  }

  getCron(name: string): Promise<SerializedCron | null> {
    const cron = this.manager.getCron(name);
    return Promise.resolve(cron ? serializeCron(cron) : null);
  }

  deleteCron(name: string) {
    return Promise.resolve(this.manager.removeCron(name));
  }

  addWebhook(url: string, events: string[], queue?: string): Promise<WebhookInfo> {
    const wh = this.manager.webhookManager.add(url, events, queue);
    return Promise.resolve({
      id: String(wh.id),
      url: wh.url,
      events: wh.events as string[],
      queue: wh.queue ?? undefined,
      enabled: wh.enabled,
    });
  }

  removeWebhook(id: string) {
    return Promise.resolve(this.manager.webhookManager.remove(id as never));
  }

  listWebhooks(): Promise<WebhookInfo[]> {
    return Promise.resolve(
      this.manager.webhookManager.list().map((wh) => ({
        id: String(wh.id),
        url: wh.url,
        events: wh.events as string[],
        queue: wh.queue ?? undefined,
        enabled: wh.enabled,
      }))
    );
  }

  setWebhookEnabled(id: string, enabled: boolean) {
    return Promise.resolve(this.manager.webhookManager.setEnabled(id as never, enabled));
  }

  registerWorker(name: string, queues: string[]): Promise<WorkerInfo> {
    const w = this.manager.workerManager.register(name, queues);
    return Promise.resolve({
      id: String(w.id),
      name: w.name,
      queues: w.queues,
      active: w.activeJobs,
      processed: w.processedJobs,
      failed: w.failedJobs,
      lastHeartbeat: w.lastSeen,
    });
  }

  unregisterWorker(id: string) {
    return Promise.resolve(this.manager.workerManager.unregister(id as never));
  }

  workerHeartbeat(id: string) {
    return Promise.resolve(this.manager.workerManager.heartbeat(id as never));
  }

  getStats(): Promise<Record<string, unknown>> {
    const stats = this.manager.getStats();
    return Promise.resolve(
      JSON.parse(
        JSON.stringify(stats, (_key, value: unknown) =>
          typeof value === 'bigint' ? Number(value) : value
        )
      ) as Record<string, unknown>
    );
  }

  listWorkers(): Promise<WorkerInfo[]> {
    return Promise.resolve(
      this.manager.workerManager.list().map((w) => ({
        id: String(w.id),
        name: w.name,
        queues: w.queues,
        active: w.activeJobs,
        processed: w.processedJobs,
        failed: w.failedJobs,
        lastHeartbeat: w.lastSeen,
      }))
    );
  }

  getJobLogs(id: string) {
    return Promise.resolve(this.manager.getLogs(toJobId(id)));
  }

  addJobLog(id: string, message: string, level?: 'info' | 'warn' | 'error') {
    return Promise.resolve(this.manager.addLog(toJobId(id), message, level));
  }

  getPerQueueStats(): Promise<Record<string, unknown>> {
    const stats = this.manager.getPerQueueStats();
    const result: Record<string, unknown> = {};
    for (const [k, v] of stats) result[k] = v;
    return Promise.resolve(result);
  }

  getMemoryStats(): Promise<Record<string, unknown>> {
    return Promise.resolve(this.manager.getMemoryStats() as unknown as Record<string, unknown>);
  }

  getPrometheusMetrics() {
    return Promise.resolve(this.manager.getPrometheusMetrics());
  }

  getStorageStatus() {
    const status = this.manager.getStorageStatus();
    return Promise.resolve({ diskFull: status.diskFull, error: status.error });
  }

  clearJobLogs(id: string, keepLogs?: number) {
    this.manager.clearLogs(toJobId(id), keepLogs);
    return Promise.resolve();
  }

  compactMemory() {
    this.manager.compactMemory();
    return Promise.resolve();
  }

  shutdown() {
    shutdownManager();
  }
}

// ============ TCP Backend ============

import { TcpConnectionPool } from '../client/tcpPool';

export class TcpBackend implements McpBackend {
  private pool: TcpConnectionPool;

  constructor(opts: { host?: string; port?: number; token?: string }) {
    this.pool = new TcpConnectionPool({
      host: opts.host ?? 'localhost',
      port: opts.port ?? 6789,
      token: opts.token,
      poolSize: 2,
    });
  }

  async connect() {
    await this.pool.connect();
  }

  private async send(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.pool.send(cmd);
  }

  private parseJob(j: Record<string, unknown>): SerializedJob {
    return {
      id: String(j.id),
      queue: (j.queue as string) ?? '',
      data: j.data,
      priority: (j.priority as number) ?? 0,
      progress: (j.progress as number) ?? 0,
      attempts: (j.attempts as number) ?? 0,
      maxAttempts: (j.maxAttempts as number) ?? 3,
      createdAt: j.createdAt
        ? new Date(j.createdAt as number).toISOString()
        : new Date().toISOString(),
      startedAt: j.startedAt ? new Date(j.startedAt as number).toISOString() : undefined,
    };
  }

  async addJob(
    queue: string,
    name: string,
    data: unknown,
    opts?: { priority?: number; delay?: number; attempts?: number }
  ) {
    const res = await this.send({
      cmd: 'PUSH',
      queue,
      data: { name, ...(data as object) },
      priority: opts?.priority,
      delay: opts?.delay,
      maxAttempts: opts?.attempts,
    });
    return { jobId: String(res.id) };
  }

  async addJobsBulk(
    queue: string,
    jobs: Array<{ name: string; data: unknown; priority?: number; delay?: number }>
  ) {
    const res = await this.send({
      cmd: 'PUSHB',
      queue,
      jobs: jobs.map((j) => ({
        data: { name: j.name, ...(j.data as object) },
        priority: j.priority,
        delay: j.delay,
      })),
    });
    return { jobIds: ((res.ids as unknown[]) ?? []).map(String) };
  }

  async getJob(id: string) {
    const res = await this.send({ cmd: 'GetJob', id });
    if (!res.job) return null;
    return this.parseJob(res.job as Record<string, unknown>);
  }

  async getJobState(id: string) {
    const res = await this.send({ cmd: 'GetState', id });
    return (res.state as string) ?? 'unknown';
  }

  async getJobResult(id: string) {
    const res = await this.send({ cmd: 'GetResult', id });
    return res.result;
  }

  async cancelJob(id: string) {
    const res = await this.send({ cmd: 'Cancel', id });
    return (res.ok as boolean) ?? false;
  }

  async promoteJob(id: string) {
    const res = await this.send({ cmd: 'Promote', id });
    return (res.ok as boolean) ?? false;
  }

  async updateProgress(id: string, progress: number, message?: string) {
    const res = await this.send({ cmd: 'Progress', id, progress, message });
    return (res.ok as boolean) ?? false;
  }

  async updateJobData(id: string, data: unknown) {
    const res = await this.send({ cmd: 'Update', id, data });
    return (res.ok as boolean) ?? false;
  }

  async changeJobPriority(id: string, priority: number) {
    const res = await this.send({ cmd: 'ChangePriority', id, priority });
    return (res.ok as boolean) ?? false;
  }

  async moveToDelayed(id: string, delay: number) {
    const res = await this.send({ cmd: 'MoveToDelayed', id, delay });
    return (res.ok as boolean) ?? false;
  }

  async discardJob(id: string) {
    const res = await this.send({ cmd: 'Discard', id });
    return (res.ok as boolean) ?? false;
  }

  async getChildrenValues(parentJobId: string) {
    // TCP doesn't have a direct command for this; get job and iterate children
    const res = await this.send({ cmd: 'GetJob', id: parentJobId });
    if (!res.job) return {};
    const job = res.job as Record<string, unknown>;
    const childrenIds = (job.childrenIds as string[]) ?? [];
    const results: Record<string, unknown> = {};
    for (const childId of childrenIds) {
      const childRes = await this.send({ cmd: 'GetResult', id: childId });
      if (childRes.result !== undefined) {
        const childJob = await this.send({ cmd: 'GetJob', id: childId });
        const queue = (childJob.job as Record<string, unknown>)?.queue ?? '';
        results[`${queue}:${childId}`] = childRes.result;
      }
    }
    return results;
  }

  async getJobByCustomId(customId: string) {
    const res = await this.send({ cmd: 'GetJobByCustomId', customId });
    if (!res.job) return null;
    return this.parseJob(res.job as Record<string, unknown>);
  }

  async waitForJobCompletion(id: string, timeoutMs: number) {
    const res = await this.send({ cmd: 'WaitJob', id, timeout: timeoutMs });
    return (res.ok as boolean) ?? false;
  }

  async getProgress(id: string) {
    const res = await this.send({ cmd: 'GetProgress', id });
    if (res.progress === undefined) return null;
    return {
      progress: (res.progress as number) ?? 0,
      message: (res.message as string | null) ?? null,
    };
  }

  async changeDelay(id: string, delay: number) {
    const res = await this.send({ cmd: 'MoveToDelayed', id, delay });
    return (res.ok as boolean) ?? false;
  }

  async extendLock(id: string, token: string, duration: number) {
    const res = await this.send({ cmd: 'JobHeartbeat', id, token, duration });
    return (res.ok as boolean) ?? false;
  }

  async pullJob(queue: string, timeoutMs?: number) {
    const res = await this.send({ cmd: 'PULL', queue, timeout: timeoutMs });
    if (!res.job) return null;
    return this.parseJob(res.job as Record<string, unknown>);
  }

  async pullJobBatch(queue: string, count: number, timeoutMs?: number) {
    const res = await this.send({ cmd: 'PULLB', queue, count, timeout: timeoutMs });
    return ((res.jobs as Array<Record<string, unknown>>) ?? []).map((j) => this.parseJob(j));
  }

  async ackJob(id: string, result?: unknown) {
    await this.send({ cmd: 'ACK', id, result });
  }

  async ackJobBatch(ids: string[]) {
    await this.send({ cmd: 'ACKB', ids });
  }

  async failJob(id: string, error?: string) {
    await this.send({ cmd: 'FAIL', id, error });
  }

  async jobHeartbeat(id: string) {
    const res = await this.send({ cmd: 'JobHeartbeat', id });
    return (res.ok as boolean) ?? false;
  }

  async jobHeartbeatBatch(ids: string[]) {
    const res = await this.send({ cmd: 'JobHeartbeatB', ids });
    return (res.count as number) ?? 0;
  }

  async getJobs(queue: string, opts?: { state?: string; start?: number; end?: number }) {
    const res = await this.send({ cmd: 'GetJobs', queue, ...opts });
    return ((res.jobs as Array<Record<string, unknown>>) ?? []).map((j) => this.parseJob(j));
  }

  async getJobCounts(queue: string): Promise<JobCounts> {
    const res = await this.send({ cmd: 'GetJobCounts', queue });
    return {
      waiting: (res.waiting as number) ?? 0,
      delayed: (res.delayed as number) ?? 0,
      active: (res.active as number) ?? 0,
      completed: (res.completed as number) ?? 0,
      failed: (res.failed as number) ?? 0,
    };
  }

  async pauseQueue(queue: string) {
    await this.send({ cmd: 'Pause', queue });
  }

  async resumeQueue(queue: string) {
    await this.send({ cmd: 'Resume', queue });
  }

  async drainQueue(queue: string) {
    const res = await this.send({ cmd: 'Drain', queue });
    return (res.removed as number) ?? 0;
  }

  async obliterateQueue(queue: string) {
    await this.send({ cmd: 'Obliterate', queue });
  }

  async listQueues() {
    const res = await this.send({ cmd: 'ListQueues' });
    return (res.queues as string[]) ?? [];
  }

  async countJobs(queue: string) {
    const res = await this.send({ cmd: 'Count', queue });
    return (res.count as number) ?? 0;
  }

  async cleanQueue(queue: string, graceMs: number, state?: string, limit?: number) {
    const res = await this.send({ cmd: 'Clean', queue, grace: graceMs, state, limit });
    return (res.removed as number) ?? 0;
  }

  async isPaused(queue: string) {
    const res = await this.send({ cmd: 'IsPaused', queue });
    return (res.paused as boolean) ?? false;
  }

  async getCountsPerPriority(queue: string) {
    const res = await this.send({ cmd: 'GetCountsPerPriority', queue });
    return (res.counts as Record<number, number>) ?? {};
  }

  async getDlq(queue: string, limit?: number) {
    const res = await this.send({ cmd: 'Dlq', queue, count: limit });
    return ((res.jobs as Array<Record<string, unknown>>) ?? []).map((j) => this.parseJob(j));
  }

  async retryDlq(queue: string, id?: string) {
    const res = await this.send({ cmd: 'RetryDlq', queue, id });
    return (res.retried as number) ?? 0;
  }

  async purgeDlq(queue: string) {
    const res = await this.send({ cmd: 'PurgeDlq', queue });
    return (res.purged as number) ?? 0;
  }

  async retryCompleted(queue: string, id?: string) {
    const res = await this.send({ cmd: 'RetryCompleted', queue, id });
    return (res.retried as number) ?? 0;
  }

  async setRateLimit(queue: string, limit: number) {
    await this.send({ cmd: 'RateLimit', queue, limit });
  }

  async clearRateLimit(queue: string) {
    await this.send({ cmd: 'RateLimitClear', queue });
  }

  async setConcurrency(queue: string, limit: number) {
    await this.send({ cmd: 'SetConcurrency', queue, limit });
  }

  async clearConcurrency(queue: string) {
    await this.send({ cmd: 'ClearConcurrency', queue });
  }

  async addCron(input: CronJobInput): Promise<SerializedCron> {
    const res = await this.send({ cmd: 'Cron', ...input });
    return {
      name: input.name,
      queue: input.queue,
      schedule: input.schedule ?? undefined,
      repeatEvery: input.repeatEvery ?? undefined,
      nextRun: res.nextRun ? new Date(res.nextRun as number).toISOString() : null,
      executions: 0,
    };
  }

  async listCrons(): Promise<SerializedCron[]> {
    const res = await this.send({ cmd: 'CronList' });
    return ((res.crons as Array<Record<string, unknown>>) ?? []).map((c) => ({
      name: c.name as string,
      queue: c.queue as string,
      schedule: c.schedule as string | undefined,
      repeatEvery: c.repeatEvery as number | undefined,
      nextRun: c.nextRun ? new Date(c.nextRun as number).toISOString() : null,
      executions: (c.executions as number) ?? 0,
    }));
  }

  async getCron(name: string): Promise<SerializedCron | null> {
    const res = await this.send({ cmd: 'CronList' });
    const crons = (res.crons as Array<Record<string, unknown>>) ?? [];
    const c = crons.find((cr) => cr.name === name);
    if (!c) return null;
    return {
      name: c.name as string,
      queue: c.queue as string,
      schedule: c.schedule as string | undefined,
      repeatEvery: c.repeatEvery as number | undefined,
      nextRun: c.nextRun ? new Date(c.nextRun as number).toISOString() : null,
      executions: (c.executions as number) ?? 0,
    };
  }

  async deleteCron(name: string) {
    const res = await this.send({ cmd: 'CronDelete', name });
    return (res.ok as boolean) ?? true;
  }

  async addWebhook(url: string, events: string[], queue?: string): Promise<WebhookInfo> {
    const res = await this.send({ cmd: 'AddWebhook', url, events, queue });
    return { id: String(res.id ?? '0'), url, events, queue, enabled: true };
  }

  async removeWebhook(id: string) {
    const res = await this.send({ cmd: 'RemoveWebhook', id });
    return (res.ok as boolean) ?? true;
  }

  async listWebhooks(): Promise<WebhookInfo[]> {
    const res = await this.send({ cmd: 'ListWebhooks' });
    return ((res.webhooks as Array<Record<string, unknown>>) ?? []).map((wh) => ({
      id: String(wh.id),
      url: wh.url as string,
      events: (wh.events as string[]) ?? [],
      queue: wh.queue as string | undefined,
      enabled: (wh.enabled as boolean) ?? true,
    }));
  }

  async getStats(): Promise<Record<string, unknown>> {
    return this.send({ cmd: 'Stats' });
  }

  async listWorkers(): Promise<WorkerInfo[]> {
    const res = await this.send({ cmd: 'ListWorkers' });
    return ((res.workers as Array<Record<string, unknown>>) ?? []).map((w) => ({
      id: String(w.id),
      name: w.name as string,
      queues: (w.queues as string[]) ?? [],
      active: (w.activeJobs as number) ?? 0,
      processed: (w.processed as number) ?? 0,
      failed: (w.failed as number) ?? 0,
      lastHeartbeat: (w.lastHeartbeat as number) ?? 0,
    }));
  }

  async getJobLogs(id: string): Promise<JobLogEntry[]> {
    const res = await this.send({ cmd: 'GetLogs', id });
    return (res.logs as JobLogEntry[]) ?? [];
  }

  async addJobLog(id: string, message: string, level?: 'info' | 'warn' | 'error') {
    const res = await this.send({ cmd: 'AddLog', id, message, level });
    return (res.ok as boolean) ?? true;
  }

  async setWebhookEnabled(id: string, enabled: boolean) {
    const res = await this.send({ cmd: 'SetWebhookEnabled', id, enabled });
    return (res.ok as boolean) ?? true;
  }

  async registerWorker(name: string, queues: string[]): Promise<WorkerInfo> {
    const res = await this.send({ cmd: 'RegisterWorker', name, queues });
    return {
      id: String(res.id ?? '0'),
      name,
      queues,
      active: 0,
      processed: 0,
      failed: 0,
      lastHeartbeat: Date.now(),
    };
  }

  async unregisterWorker(id: string) {
    const res = await this.send({ cmd: 'UnregisterWorker', id });
    return (res.ok as boolean) ?? true;
  }

  async workerHeartbeat(id: string) {
    const res = await this.send({ cmd: 'Heartbeat', id });
    return (res.ok as boolean) ?? true;
  }

  async getPerQueueStats(): Promise<Record<string, unknown>> {
    const res = await this.send({ cmd: 'Metrics' });
    return (res.queues as Record<string, unknown>) ?? res;
  }

  async getMemoryStats(): Promise<Record<string, unknown>> {
    const res = await this.send({ cmd: 'Stats' });
    return (res.memory as Record<string, unknown>) ?? {};
  }

  async getPrometheusMetrics() {
    const res = await this.send({ cmd: 'Prometheus' });
    return (res.metrics as string) ?? '';
  }

  async clearJobLogs(id: string, _keepLogs?: number) {
    await this.send({ cmd: 'ClearLogs', id });
  }

  async compactMemory() {
    await this.send({ cmd: 'CompactMemory' });
  }

  async getStorageStatus() {
    // TCP mode doesn't have direct access to storage health; return healthy default
    return { diskFull: false, error: null };
  }

  shutdown() {
    this.pool.close();
  }
}

/** Create backend based on environment configuration */
export function createBackend(): McpBackend {
  const mode = process.env.BUNQUEUE_MODE ?? 'embedded';

  if (mode === 'tcp') {
    const backend = new TcpBackend({
      host: process.env.BUNQUEUE_HOST,
      port: process.env.BUNQUEUE_PORT ? parseInt(process.env.BUNQUEUE_PORT, 10) : undefined,
      token: process.env.BUNQUEUE_TOKEN,
    });
    void backend.connect();
    return backend;
  }

  return new EmbeddedBackend();
}
