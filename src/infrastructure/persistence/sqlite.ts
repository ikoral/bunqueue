/**
 * SQLite Storage Implementation
 * Persistence layer using Bun's native SQLite
 * Uses MessagePack for ~2-3x faster serialization than JSON
 */

import { Database } from 'bun:sqlite';
import { encode, decode } from '@msgpack/msgpack';
import { type Job, type JobId, jobId } from '../../domain/types/job';
import type { CronJob } from '../../domain/types/cron';
import { PRAGMA_SETTINGS, SCHEMA, MIGRATION_TABLE, SCHEMA_VERSION } from './schema';
import { prepareStatements, type StatementName, type DbJob, type DbCron } from './statements';
import { storageLog } from '../../shared/logger';

/** Encode data to MessagePack buffer */
function pack(data: unknown): Uint8Array {
  return encode(data);
}

/** Decode MessagePack buffer to data */
function unpack<T>(buffer: Uint8Array | null, fallback: T, context: string): T {
  if (!buffer) return fallback;
  try {
    return decode(buffer) as T;
  } catch (err) {
    storageLog.error('MessagePack decode error', { context, error: String(err) });
    return fallback;
  }
}

/** SQLite configuration */
export interface SqliteConfig {
  path: string;
  walMode?: boolean;
  synchronous?: 'OFF' | 'NORMAL' | 'FULL';
  cacheSize?: number;
  /** Write buffer size (default: 100) */
  writeBufferSize?: number;
  /** Write buffer flush interval in ms (default: 50) */
  writeBufferFlushMs?: number;
}

/**
 * SQLite Storage class with write buffering for high throughput
 */
export class SqliteStorage {
  private readonly db: Database;
  private readonly statements: Map<StatementName, ReturnType<Database['prepare']>>;

  // Write buffer for batching inserts
  private writeBuffer: Job[] = [];
  private readonly writeBufferSize: number;
  private writeBufferTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: SqliteConfig) {
    this.db = new Database(config.path, { create: true });
    this.db.run(PRAGMA_SETTINGS);
    this.migrate();
    this.statements = prepareStatements(this.db);

    // Initialize write buffer
    this.writeBufferSize = config.writeBufferSize ?? 100;
    const flushInterval = config.writeBufferFlushMs ?? 50;

    // Auto-flush timer
    this.writeBufferTimer = setInterval(() => {
      this.flushWriteBuffer();
    }, flushInterval);
  }

  /** Flush write buffer to disk */
  flushWriteBuffer(): void {
    if (this.writeBuffer.length === 0) return;

    const jobs = this.writeBuffer;
    this.writeBuffer = [];

    this.insertJobsBatchInternal(jobs);
  }

  private migrate(): void {
    this.db.run(MIGRATION_TABLE);
    const currentVersion =
      this.db.query<{ version: number }, []>('SELECT MAX(version) as version FROM migrations').get()
        ?.version ?? 0;

    if (currentVersion < SCHEMA_VERSION) {
      this.db.run(SCHEMA);
      this.db
        .prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)')
        .run(SCHEMA_VERSION, Date.now());
    }
  }

  // ============ Job Operations ============

  /** Insert job using write buffer for better throughput */
  insertJob(job: Job): void {
    this.writeBuffer.push(job);

    // Flush if buffer is full
    if (this.writeBuffer.length >= this.writeBufferSize) {
      this.flushWriteBuffer();
    }
  }

  /** Insert job immediately (bypass buffer) */
  insertJobImmediate(job: Job): void {
    this.statements
      .get('insertJob')!
      .run(
        job.id,
        job.queue,
        pack(job.data),
        job.priority,
        job.createdAt,
        job.runAt,
        job.attempts,
        job.maxAttempts,
        job.backoff,
        job.ttl,
        job.timeout,
        job.uniqueKey,
        job.customId,
        job.dependsOn.length > 0 ? pack(job.dependsOn) : null,
        job.parentId,
        job.tags.length > 0 ? pack(job.tags) : null,
        job.runAt > Date.now() ? 'delayed' : 'waiting',
        job.lifo ? 1 : 0,
        job.groupId,
        job.removeOnComplete ? 1 : 0,
        job.removeOnFail ? 1 : 0,
        job.stallTimeout
      );
  }

  markActive(jobId: JobId, startedAt: number): void {
    this.statements.get('updateJobState')!.run('active', startedAt, jobId);
  }

  markCompleted(jobId: JobId, completedAt: number): void {
    this.statements.get('completeJob')!.run('completed', completedAt, jobId);
  }

  markFailed(job: Job, error: string | null): void {
    this.statements
      .get('insertDlq')!
      .run(job.id, job.queue, pack(job.data), error, Date.now(), job.attempts);
  }

  updateForRetry(job: Job): void {
    this.db
      .prepare('UPDATE jobs SET attempts = ?, run_at = ?, state = ? WHERE id = ?')
      .run(job.attempts, job.runAt, 'waiting', job.id);
  }

  deleteJob(jobId: JobId): void {
    this.statements.get('deleteJob')!.run(jobId);
  }

  getJob(id: JobId): Job | null {
    const row = this.statements.get('getJob')!.get(id) as DbJob | null;
    return row ? this.rowToJob(row) : null;
  }

  storeResult(jobId: JobId, result: unknown): void {
    this.statements.get('insertResult')!.run(jobId, pack(result), Date.now());
  }

  getResult(jobId: JobId): unknown {
    const row = this.statements.get('getResult')!.get(jobId) as { result: Uint8Array } | null;
    return row ? unpack(row.result, null, `getResult:${jobId}`) : null;
  }

  // ============ Bulk Operations ============

  /** Insert batch of jobs (adds to buffer) */
  insertJobsBatch(jobs: Job[]): void {
    for (const job of jobs) {
      this.writeBuffer.push(job);
    }
    // Flush if buffer is full
    if (this.writeBuffer.length >= this.writeBufferSize) {
      this.flushWriteBuffer();
    }
  }

  /** Internal: Insert batch directly with transaction */
  private insertJobsBatchInternal(jobs: Job[]): void {
    if (jobs.length === 0) return;

    const stmt = this.statements.get('insertJob')!;
    this.db.transaction(() => {
      for (const job of jobs) {
        stmt.run(
          job.id,
          job.queue,
          pack(job.data),
          job.priority,
          job.createdAt,
          job.runAt,
          job.attempts,
          job.maxAttempts,
          job.backoff,
          job.ttl,
          job.timeout,
          job.uniqueKey,
          job.customId,
          job.dependsOn.length > 0 ? pack(job.dependsOn) : null,
          job.parentId,
          job.tags.length > 0 ? pack(job.tags) : null,
          job.runAt > Date.now() ? 'delayed' : 'waiting',
          job.lifo ? 1 : 0,
          job.groupId,
          job.removeOnComplete ? 1 : 0,
          job.removeOnFail ? 1 : 0,
          job.stallTimeout
        );
      }
    })();
  }

  // ============ Query Operations ============

  loadPendingJobs(): Job[] {
    const rows = this.db
      .query<DbJob, []>("SELECT * FROM jobs WHERE state IN ('waiting', 'delayed') ORDER BY id")
      .all();
    return rows.map((row) => this.rowToJob(row));
  }

  loadActiveJobs(): Job[] {
    const rows = this.db
      .query<DbJob, []>("SELECT * FROM jobs WHERE state = 'active' ORDER BY id")
      .all();
    return rows.map((row) => this.rowToJob(row));
  }

  // ============ Cron Operations ============

  saveCron(cron: CronJob): void {
    this.statements
      .get('insertCron')!
      .run(
        cron.name,
        cron.queue,
        pack(cron.data),
        cron.schedule,
        cron.repeatEvery,
        cron.priority,
        cron.nextRun,
        cron.executions,
        cron.maxLimit
      );
  }

  loadCronJobs(): CronJob[] {
    const rows = this.db.query<DbCron, []>('SELECT * FROM cron_jobs').all();
    return rows.map((row) => ({
      name: row.name,
      queue: row.queue,
      data: unpack(row.data, {}, `loadCronJobs:${row.name}`),
      schedule: row.schedule,
      repeatEvery: row.repeat_every,
      priority: row.priority,
      nextRun: row.next_run,
      executions: row.executions,
      maxLimit: row.max_limit,
    }));
  }

  deleteCron(name: string): void {
    this.db.prepare('DELETE FROM cron_jobs WHERE name = ?').run(name);
  }

  // ============ Utilities ============

  private rowToJob(row: DbJob): Job {
    const jobContext = `rowToJob:${row.id}`;
    const dependsOn: string[] = row.depends_on
      ? unpack<string[]>(row.depends_on, [], `${jobContext}:dependsOn`)
      : [];
    const childrenIds: string[] = row.children_ids
      ? unpack<string[]>(row.children_ids, [], `${jobContext}:childrenIds`)
      : [];
    const tags: string[] = row.tags ? unpack<string[]>(row.tags, [], `${jobContext}:tags`) : [];

    return {
      id: jobId(row.id),
      queue: row.queue,
      data: unpack(row.data, {}, `${jobContext}:data`),
      priority: row.priority,
      createdAt: row.created_at,
      runAt: row.run_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      backoff: row.backoff,
      ttl: row.ttl,
      timeout: row.timeout,
      uniqueKey: row.unique_key,
      customId: row.custom_id,
      dependsOn: dependsOn.map((s) => jobId(s)),
      parentId: row.parent_id ? jobId(row.parent_id) : null,
      childrenIds: childrenIds.map((s) => jobId(s)),
      childrenCompleted: 0,
      tags,
      lifo: row.lifo === 1,
      groupId: row.group_id,
      progress: row.progress ?? 0,
      progressMessage: row.progress_msg,
      removeOnComplete: row.remove_on_complete === 1,
      removeOnFail: row.remove_on_fail === 1,
      lastHeartbeat: row.last_heartbeat ?? row.created_at,
      stallTimeout: row.stall_timeout,
      stallCount: 0,
    };
  }

  close(): void {
    // Stop auto-flush timer
    if (this.writeBufferTimer) {
      clearInterval(this.writeBufferTimer);
      this.writeBufferTimer = null;
    }

    // Flush any remaining buffered writes
    this.flushWriteBuffer();

    this.db.close();
  }

  getSize(): number {
    const file = Bun.file(this.db.filename);
    return file.size;
  }
}
