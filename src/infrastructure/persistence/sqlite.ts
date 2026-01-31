/**
 * SQLite Storage Implementation
 * Persistence layer using Bun's native SQLite
 * Uses MessagePack for ~2-3x faster serialization than JSON
 */

import { Database } from 'bun:sqlite';
import { encode, decode } from '@msgpack/msgpack';
import { type Job, type JobId, jobId } from '../../domain/types/job';
import type { CronJob } from '../../domain/types/cron';
import type { DlqEntry } from '../../domain/types/dlq';
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

  // Prepared statement cache for batch inserts - avoids recompiling SQL
  private readonly batchInsertCache = new Map<number, ReturnType<Database['prepare']>>();

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
      try {
        this.flushWriteBuffer();
      } catch {
        // Error already logged in flushWriteBuffer, will retry on next interval
      }
    }, flushInterval);
  }

  /** Flush write buffer to disk. Returns number of jobs flushed, or throws on error. */
  flushWriteBuffer(): number {
    if (this.writeBuffer.length === 0) return 0;

    const jobs = this.writeBuffer;
    this.writeBuffer = [];

    try {
      this.insertJobsBatchInternal(jobs);
      return jobs.length;
    } catch (err) {
      // Re-add jobs to buffer on failure so they're not lost
      this.writeBuffer = jobs.concat(this.writeBuffer);
      storageLog.error('Write buffer flush failed', {
        jobCount: jobs.length,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
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
    // Legacy method - use saveDlqEntry for full metadata
    this.statements.get('insertDlq')!.run(job.id, job.queue, pack({ job, error }), Date.now());
  }

  /** Save DLQ entry with full metadata */
  saveDlqEntry(entry: DlqEntry): void {
    this.statements
      .get('insertDlq')!
      .run(entry.job.id, entry.job.queue, pack(entry), entry.enteredAt);
  }

  /** Delete DLQ entry by job ID */
  deleteDlqEntry(jobId: JobId): void {
    this.statements.get('deleteDlqEntry')!.run(jobId);
  }

  /** Clear all DLQ entries for a queue */
  clearDlqQueue(queue: string): void {
    this.statements.get('clearDlqQueue')!.run(queue);
  }

  /** Load all DLQ entries */
  loadDlq(): Map<string, DlqEntry[]> {
    interface DbDlqRow {
      job_id: string;
      queue: string;
      entry: Uint8Array;
      entered_at: number;
    }
    const rows = this.statements.get('loadDlq')!.all() as DbDlqRow[];
    const result = new Map<string, DlqEntry[]>();

    for (const row of rows) {
      const entry = unpack<DlqEntry | null>(row.entry, null, `loadDlq:${row.job_id}`);
      if (!entry?.job) continue;

      // Reconstruct jobId type (MessagePack serializes it as string)
      const reconstructedEntry: DlqEntry = {
        ...entry,
        job: {
          ...entry.job,
          id: jobId(String(entry.job.id)),
          dependsOn: entry.job.dependsOn.map((id) => jobId(String(id))),
          parentId: entry.job.parentId ? jobId(String(entry.job.parentId)) : null,
          childrenIds: entry.job.childrenIds.map((id) => jobId(String(id))),
        },
      };

      let queueEntries = result.get(row.queue);
      if (!queueEntries) {
        queueEntries = [];
        result.set(row.queue, queueEntries);
      }
      queueEntries.push(reconstructedEntry);
    }

    storageLog.info('Loaded DLQ entries', { count: rows.length });
    return result;
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

  /** Internal: Insert batch directly using multi-row INSERT for 50-100x speedup */
  private insertJobsBatchInternal(jobs: Job[]): void {
    if (jobs.length === 0) return;

    const now = Date.now();
    const COLS_PER_ROW = 22;
    // SQLite has a limit of ~999 variables, so batch in chunks
    const MAX_ROWS_PER_INSERT = Math.floor(999 / COLS_PER_ROW);

    this.db.transaction(() => {
      for (let offset = 0; offset < jobs.length; offset += MAX_ROWS_PER_INSERT) {
        const chunk = jobs.slice(offset, offset + MAX_ROWS_PER_INSERT);
        this.insertJobsChunk(chunk, now);
      }
    })();
  }

  /** Get or create cached prepared statement for batch insert */
  private getBatchInsertStmt(size: number): ReturnType<Database['prepare']> {
    let stmt = this.batchInsertCache.get(size);
    if (!stmt) {
      const rowPlaceholder = '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
      const placeholders = Array(size).fill(rowPlaceholder).join(', ');
      const sql = `INSERT INTO jobs (
        id, queue, data, priority, created_at, run_at, attempts, max_attempts,
        backoff, ttl, timeout, unique_key, custom_id, depends_on, parent_id,
        tags, state, lifo, group_id, remove_on_complete, remove_on_fail, stall_timeout
      ) VALUES ${placeholders}`;
      stmt = this.db.prepare(sql);
      // Cache statements for common batch sizes (1-100)
      if (size <= 100) {
        this.batchInsertCache.set(size, stmt);
      }
    }
    return stmt;
  }

  /** Insert a chunk of jobs with single multi-row INSERT */
  private insertJobsChunk(jobs: Job[], now: number): void {
    // Get cached prepared statement
    const stmt = this.getBatchInsertStmt(jobs.length);

    // Flatten all values
    const values: unknown[] = [];
    for (const job of jobs) {
      values.push(
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
        job.runAt > now ? 'delayed' : 'waiting',
        job.lifo ? 1 : 0,
        job.groupId,
        job.removeOnComplete ? 1 : 0,
        job.removeOnFail ? 1 : 0,
        job.stallTimeout
      );
    }

    stmt.run(...(values as (string | number | bigint | null | Uint8Array)[]));
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
        cron.maxLimit,
        cron.timezone
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
      timezone: row.timezone,
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
      repeat: null,
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
    try {
      const flushed = this.flushWriteBuffer();
      if (flushed > 0) {
        storageLog.info('Flushed write buffer on close', { jobCount: flushed });
      }
    } catch (err) {
      // Log error but continue with close - data may be lost
      storageLog.error('Failed to flush write buffer on close', {
        bufferedJobs: this.writeBuffer.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.db.close();
  }

  getSize(): number {
    const file = Bun.file(this.db.filename);
    return file.size;
  }
}
