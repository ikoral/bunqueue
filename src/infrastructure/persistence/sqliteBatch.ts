/**
 * SQLite Batch Operations
 * High-performance batch insert with prepared statement caching
 */

import type { Database } from 'bun:sqlite';
import type { Job } from '../../domain/types/job';
import { pack } from './sqliteSerializer';

/** Batch insert manager with prepared statement caching */
export class BatchInsertManager {
  private readonly db: Database;
  private readonly cache = new Map<number, ReturnType<Database['prepare']>>();

  constructor(db: Database) {
    this.db = db;
  }

  /** Insert batch of jobs using multi-row INSERT for 50-100x speedup */
  insertJobsBatch(jobs: Job[]): void {
    if (jobs.length === 0) return;

    const now = Date.now();
    const COLS_PER_ROW = 23;
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
    let stmt = this.cache.get(size);
    if (!stmt) {
      const rowPlaceholder =
        '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
      const placeholders = Array(size).fill(rowPlaceholder).join(', ');
      const sql = `INSERT INTO jobs (
        id, queue, data, priority, created_at, run_at, attempts, max_attempts,
        backoff, ttl, timeout, unique_key, custom_id, depends_on, parent_id,
        children_ids, tags, state, lifo, group_id, remove_on_complete, remove_on_fail, stall_timeout
      ) VALUES ${placeholders}`;
      stmt = this.db.prepare(sql);
      // Cache statements for common batch sizes (1-100)
      if (size <= 100) {
        this.cache.set(size, stmt);
      }
    }
    return stmt;
  }

  /** Insert a chunk of jobs with single multi-row INSERT */
  private insertJobsChunk(jobs: Job[], now: number): void {
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
        job.childrenIds.length > 0 ? pack(job.childrenIds) : null,
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
}

/** Write buffer for batching inserts */
export class WriteBuffer {
  private buffer: Job[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly batchManager: BatchInsertManager;
  private readonly bufferSize: number;
  private readonly onError: (err: Error, jobCount: number) => void;

  constructor(
    batchManager: BatchInsertManager,
    bufferSize: number,
    flushIntervalMs: number,
    onError: (err: Error, jobCount: number) => void
  ) {
    this.batchManager = batchManager;
    this.bufferSize = bufferSize;
    this.onError = onError;

    // Auto-flush timer
    this.timer = setInterval(() => {
      try {
        this.flush();
      } catch {
        // Error already logged in flush, will retry on next interval
      }
    }, flushIntervalMs);
  }

  /** Add job to buffer */
  add(job: Job): void {
    this.buffer.push(job);
    if (this.buffer.length >= this.bufferSize) {
      this.flush();
    }
  }

  /** Add multiple jobs to buffer */
  addBatch(jobs: Job[]): void {
    for (const job of jobs) {
      this.buffer.push(job);
    }
    if (this.buffer.length >= this.bufferSize) {
      this.flush();
    }
  }

  /** Flush buffer to disk. Returns number of jobs flushed. */
  flush(): number {
    if (this.buffer.length === 0) return 0;

    const jobs = this.buffer;
    this.buffer = [];

    try {
      this.batchManager.insertJobsBatch(jobs);
      return jobs.length;
    } catch (err) {
      // Re-add jobs to buffer on failure so they're not lost
      this.buffer = jobs.concat(this.buffer);
      this.onError(err instanceof Error ? err : new Error(String(err)), jobs.length);
      throw err;
    }
  }

  /** Get pending job count */
  get pendingCount(): number {
    return this.buffer.length;
  }

  /** Stop auto-flush timer */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
