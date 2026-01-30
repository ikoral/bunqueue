/**
 * Prepared SQLite statements
 * Pre-compiled SQL for better performance
 */

import type { Database } from 'bun:sqlite';

/** Statement names */
export type StatementName =
  | 'insertJob'
  | 'updateJobState'
  | 'completeJob'
  | 'deleteJob'
  | 'getJob'
  | 'insertResult'
  | 'getResult'
  | 'insertDlq'
  | 'loadDlq'
  | 'deleteDlqEntry'
  | 'clearDlqQueue'
  | 'insertCron';

/** SQL statements */
export const SQL_STATEMENTS: Record<StatementName, string> = {
  insertJob: `
    INSERT INTO jobs (
      id, queue, data, priority, created_at, run_at, attempts,
      max_attempts, backoff, ttl, timeout, unique_key, custom_id,
      depends_on, parent_id, tags, state, lifo, group_id,
      remove_on_complete, remove_on_fail, stall_timeout
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?
    )
  `,

  updateJobState: 'UPDATE jobs SET state = ?, started_at = ? WHERE id = ?',

  completeJob: 'UPDATE jobs SET state = ?, completed_at = ?, progress = 100 WHERE id = ?',

  deleteJob: 'DELETE FROM jobs WHERE id = ?',

  getJob: 'SELECT * FROM jobs WHERE id = ?',

  insertResult:
    'INSERT OR REPLACE INTO job_results (job_id, result, completed_at) VALUES (?, ?, ?)',

  getResult: 'SELECT result FROM job_results WHERE job_id = ?',

  insertDlq: 'INSERT INTO dlq (job_id, queue, entry, entered_at) VALUES (?, ?, ?, ?)',

  loadDlq: 'SELECT * FROM dlq ORDER BY entered_at',

  deleteDlqEntry: 'DELETE FROM dlq WHERE job_id = ?',

  clearDlqQueue: 'DELETE FROM dlq WHERE queue = ?',

  insertCron: `
    INSERT OR REPLACE INTO cron_jobs
    (name, queue, data, schedule, repeat_every, priority, next_run, executions, max_limit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
};

/** Prepare all statements */
export function prepareStatements(
  db: Database
): Map<StatementName, ReturnType<Database['prepare']>> {
  const statements = new Map<StatementName, ReturnType<Database['prepare']>>();

  for (const [name, sql] of Object.entries(SQL_STATEMENTS)) {
    statements.set(name as StatementName, db.prepare(sql));
  }

  return statements;
}

/** Database row type for jobs (BLOB fields are Uint8Array from bun:sqlite) */
export interface DbJob {
  id: string;
  queue: string;
  data: Uint8Array; // MessagePack BLOB
  priority: number;
  created_at: number;
  run_at: number;
  started_at: number | null;
  completed_at: number | null;
  attempts: number;
  max_attempts: number;
  backoff: number;
  ttl: number | null;
  timeout: number | null;
  unique_key: string | null;
  custom_id: string | null;
  depends_on: Uint8Array | null; // MessagePack BLOB
  parent_id: string | null;
  children_ids: Uint8Array | null; // MessagePack BLOB
  tags: Uint8Array | null; // MessagePack BLOB
  state: string;
  lifo: number;
  group_id: string | null;
  progress: number | null;
  progress_msg: string | null;
  remove_on_complete: number;
  remove_on_fail: number;
  stall_timeout: number | null;
  last_heartbeat: number | null;
}

/** Database row type for cron jobs */
export interface DbCron {
  name: string;
  queue: string;
  data: Uint8Array; // MessagePack BLOB
  schedule: string | null;
  repeat_every: number | null;
  priority: number;
  next_run: number;
  executions: number;
  max_limit: number | null;
}
