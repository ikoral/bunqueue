/**
 * SQLite Storage Implementation
 * Persistence layer using Bun's native SQLite
 */

import { Database } from 'bun:sqlite';
import { type Job, type JobId, jobId } from '../../domain/types/job';
import type { CronJob } from '../../domain/types/cron';
import { PRAGMA_SETTINGS, SCHEMA, MIGRATION_TABLE, SCHEMA_VERSION } from './schema';
import { prepareStatements, type StatementName, type DbJob, type DbCron } from './statements';
import { storageLog } from '../../shared/logger';

/** Safely parse JSON with error handling */
function safeJsonParse<T>(json: string, fallback: T, context: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (err) {
    storageLog.error('JSON parse error', { context, error: String(err), json: json.slice(0, 100) });
    return fallback;
  }
}

/** SQLite configuration */
export interface SqliteConfig {
  path: string;
  walMode?: boolean;
  synchronous?: 'OFF' | 'NORMAL' | 'FULL';
  cacheSize?: number;
}

/**
 * SQLite Storage class
 */
export class SqliteStorage {
  private db: Database;
  private readonly statements: Map<StatementName, ReturnType<Database['prepare']>>;

  constructor(config: SqliteConfig) {
    this.db = new Database(config.path, { create: true });
    this.db.run(PRAGMA_SETTINGS);
    this.migrate();
    this.statements = prepareStatements(this.db);
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

  nextJobId(): JobId {
    const result = this.statements.get('nextJobId')!.get() as { value: number };
    return jobId(BigInt(result.value));
  }

  insertJob(job: Job): void {
    this.statements
      .get('insertJob')!
      .run(
        Number(job.id),
        job.queue,
        JSON.stringify(job.data),
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
        job.dependsOn.length > 0 ? JSON.stringify(job.dependsOn.map(String)) : null,
        job.parentId ? Number(job.parentId) : null,
        job.tags.length > 0 ? JSON.stringify(job.tags) : null,
        job.runAt > Date.now() ? 'delayed' : 'waiting',
        job.lifo ? 1 : 0,
        job.groupId,
        job.removeOnComplete ? 1 : 0,
        job.removeOnFail ? 1 : 0,
        job.stallTimeout
      );
  }

  markActive(jobId: JobId, startedAt: number): void {
    this.statements.get('updateJobState')!.run('active', startedAt, Number(jobId));
  }

  markCompleted(jobId: JobId, completedAt: number): void {
    this.statements.get('completeJob')!.run('completed', completedAt, Number(jobId));
  }

  markFailed(job: Job, error: string | null): void {
    this.statements
      .get('insertDlq')!
      .run(Number(job.id), job.queue, JSON.stringify(job.data), error, Date.now(), job.attempts);
  }

  updateForRetry(job: Job): void {
    this.db
      .prepare('UPDATE jobs SET attempts = ?, run_at = ?, state = ? WHERE id = ?')
      .run(job.attempts, job.runAt, 'waiting', Number(job.id));
  }

  deleteJob(jobId: JobId): void {
    this.statements.get('deleteJob')!.run(Number(jobId));
  }

  getJob(id: JobId): Job | null {
    const row = this.statements.get('getJob')!.get(Number(id)) as DbJob | null;
    return row ? this.rowToJob(row) : null;
  }

  storeResult(jobId: JobId, result: unknown): void {
    this.statements.get('insertResult')!.run(Number(jobId), JSON.stringify(result), Date.now());
  }

  getResult(jobId: JobId): unknown {
    const row = this.statements.get('getResult')!.get(Number(jobId)) as { result: string } | null;
    return row ? safeJsonParse(row.result, null, `getResult:${jobId}`) : null;
  }

  // ============ Bulk Operations ============

  insertJobsBatch(jobs: Job[]): void {
    const stmt = this.statements.get('insertJob')!;
    this.db.transaction(() => {
      for (const job of jobs) {
        stmt.run(
          Number(job.id),
          job.queue,
          JSON.stringify(job.data),
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
          job.dependsOn.length > 0 ? JSON.stringify(job.dependsOn.map(String)) : null,
          job.parentId ? Number(job.parentId) : null,
          job.tags.length > 0 ? JSON.stringify(job.tags) : null,
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
        JSON.stringify(cron.data),
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
      data: safeJsonParse(row.data, {}, `loadCronJobs:${row.name}`),
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
      ? safeJsonParse<string[]>(row.depends_on, [], `${jobContext}:dependsOn`)
      : [];
    const childrenIds: string[] = row.children_ids
      ? safeJsonParse<string[]>(row.children_ids, [], `${jobContext}:childrenIds`)
      : [];
    const tags: string[] = row.tags
      ? safeJsonParse<string[]>(row.tags, [], `${jobContext}:tags`)
      : [];

    return {
      id: jobId(BigInt(row.id)),
      queue: row.queue,
      data: safeJsonParse(row.data, {}, `${jobContext}:data`),
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
      dependsOn: dependsOn.map((s) => jobId(BigInt(s))),
      parentId: row.parent_id ? jobId(BigInt(row.parent_id)) : null,
      childrenIds: childrenIds.map((s) => jobId(BigInt(s))),
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
    this.db.close();
  }

  getSize(): number {
    const file = Bun.file(this.db.filename);
    return file.size;
  }
}
