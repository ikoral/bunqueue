/**
 * SQLite Storage Implementation
 * Persistence layer using Bun's native SQLite
 * Uses MessagePack for ~2-3x faster serialization than JSON
 */

import { Database } from 'bun:sqlite';
import type { Job, JobId } from '../../domain/types/job';
import type { CronJob } from '../../domain/types/cron';
import type { DlqEntry } from '../../domain/types/dlq';
import { PRAGMA_SETTINGS, SCHEMA, MIGRATION_TABLE, SCHEMA_VERSION } from './schema';
import { prepareStatements, type StatementName, type DbJob, type DbCron } from './statements';
import { pack, unpack, rowToJob, reconstructDlqEntry } from './sqliteSerializer';
import { BatchInsertManager, WriteBuffer } from './sqliteBatch';
import { storageLog } from '../../shared/logger';

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
  private readonly batchManager: BatchInsertManager;
  private readonly writeBuffer: WriteBuffer;

  constructor(config: SqliteConfig) {
    this.db = new Database(config.path, { create: true });
    this.db.run(PRAGMA_SETTINGS);
    this.migrate();
    this.statements = prepareStatements(this.db);

    // Initialize batch manager and write buffer
    this.batchManager = new BatchInsertManager(this.db);
    this.writeBuffer = new WriteBuffer(
      this.batchManager,
      config.writeBufferSize ?? 100,
      config.writeBufferFlushMs ?? 10,
      (err, jobCount) => {
        storageLog.error('Write buffer flush failed', {
          jobCount,
          error: err.message,
        });
      }
    );
  }

  /** Flush write buffer to disk. Returns number of jobs flushed. */
  flushWriteBuffer(): number {
    return this.writeBuffer.flush();
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

  /**
   * Insert job using write buffer for better throughput.
   * @param job The job to insert
   * @param durable If true, bypasses write buffer and writes immediately to disk
   */
  insertJob(job: Job, durable?: boolean): void {
    if (durable) {
      this.insertJobImmediate(job);
      return;
    }
    this.writeBuffer.add(job);
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
        job.childrenIds.length > 0 ? pack(job.childrenIds) : null,
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

      const reconstructedEntry = reconstructDlqEntry(entry);

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
    return row ? rowToJob(row) : null;
  }

  storeResult(jobId: JobId, result: unknown): void {
    this.statements.get('insertResult')!.run(jobId, pack(result), Date.now());
  }

  getResult(jobId: JobId): unknown {
    const row = this.statements.get('getResult')!.get(jobId) as { result: Uint8Array } | null;
    return row ? unpack(row.result, null, `getResult:${jobId}`) : null;
  }

  /** Check if a job result exists (for dependency checking during recovery) */
  hasResult(jobId: JobId): boolean {
    const row = this.db
      .query<{ job_id: string }, [string]>('SELECT job_id FROM job_results WHERE job_id = ?')
      .get(String(jobId));
    return row !== null;
  }

  /** Load all completed job IDs (for dependency recovery) */
  loadCompletedJobIds(): Set<JobId> {
    const rows = this.db.query<{ job_id: string }, []>('SELECT job_id FROM job_results').all();
    return new Set(rows.map((r) => r.job_id as JobId));
  }

  // ============ Bulk Operations ============

  /** Insert batch of jobs (adds to buffer) */
  insertJobsBatch(jobs: Job[]): void {
    this.writeBuffer.addBatch(jobs);
  }

  // ============ Query Operations ============

  /**
   * Load pending jobs with pagination for efficient recovery.
   * Orders by priority (desc) and run_at (asc) to process urgent jobs first.
   * @param limit Max jobs to return (default: 10000)
   * @param offset Skip first N jobs (default: 0)
   */
  loadPendingJobs(limit: number = 10000, offset: number = 0): Job[] {
    const rows = this.db
      .query<
        DbJob,
        [number, number]
      >("SELECT * FROM jobs WHERE state IN ('waiting', 'delayed') ORDER BY priority DESC, run_at ASC LIMIT ? OFFSET ?")
      .all(limit, offset);
    return rows.map((row) => rowToJob(row));
  }

  /**
   * Load active jobs with pagination.
   * @param limit Max jobs to return (default: 10000)
   * @param offset Skip first N jobs (default: 0)
   */
  loadActiveJobs(limit: number = 10000, offset: number = 0): Job[] {
    const rows = this.db
      .query<
        DbJob,
        [number, number]
      >("SELECT * FROM jobs WHERE state = 'active' ORDER BY started_at ASC LIMIT ? OFFSET ?")
      .all(limit, offset);
    return rows.map((row) => rowToJob(row));
  }

  /**
   * Count pending jobs (for pagination)
   */
  countPendingJobs(): number {
    const result = this.db
      .query<
        { count: number },
        []
      >("SELECT COUNT(*) as count FROM jobs WHERE state IN ('waiting', 'delayed')")
      .get();
    return result?.count ?? 0;
  }

  /**
   * Count active jobs (for pagination)
   */
  countActiveJobs(): number {
    const result = this.db
      .query<{ count: number }, []>("SELECT COUNT(*) as count FROM jobs WHERE state = 'active'")
      .get();
    return result?.count ?? 0;
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

  /** Update cron job execution state (executions count and next run time) */
  updateCron(name: string, executions: number, nextRun: number): void {
    this.statements.get('updateCron')!.run(executions, nextRun, name);
  }

  // ============ Utilities ============

  close(): void {
    this.writeBuffer.stop();

    try {
      const flushed = this.writeBuffer.flush();
      if (flushed > 0) {
        storageLog.info('Flushed write buffer on close', { jobCount: flushed });
      }
    } catch (err) {
      storageLog.error('Failed to flush write buffer on close', {
        bufferedJobs: this.writeBuffer.pendingCount,
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
