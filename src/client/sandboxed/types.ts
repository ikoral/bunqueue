/**
 * Sandboxed Worker Types
 * Type definitions for sandboxed worker processes
 */

import type { SharedManager } from '../manager';
import type { ConnectionOptions } from '../types';
import type { Job as DomainJob } from '../../domain/types/job';

/** Sandboxed worker configuration */
export interface SandboxedWorkerOptions {
  /** Path to processor file (must export default async function) */
  processor: string;
  /** Number of worker processes (default: 1) */
  concurrency?: number;
  /** Max memory per worker in MB - uses smol mode if <= 64 (default: 256) */
  maxMemory?: number;
  /** Job timeout in ms (default: 30000) */
  timeout?: number;
  /** Auto-restart crashed workers (default: true) */
  autoRestart?: boolean;
  /** Max restarts before giving up (default: 10) */
  maxRestarts?: number;
  /** Poll interval when no workers are idle (default: 10ms) */
  pollInterval?: number;
  /** Custom QueueManager (for testing, defaults to shared manager) */
  manager?: SharedManager;
  /** TCP connection options (if provided, uses TCP mode instead of embedded) */
  connection?: ConnectionOptions;
  /** Heartbeat interval in ms for TCP lock renewal (default: 10000 for TCP, 0 for embedded) */
  heartbeatInterval?: number;
}

/** Required options with defaults applied */
export interface RequiredSandboxedWorkerOptions {
  processor: string;
  concurrency: number;
  maxMemory: number;
  timeout: number;
  autoRestart: boolean;
  maxRestarts: number;
  pollInterval: number;
}

/** Worker process state */
export interface WorkerProcess {
  worker: Worker;
  busy: boolean;
  currentJob: DomainJob | null;
  currentToken: string | null;
  restarts: number;
  timeoutId: Timer | null;
}

/** IPC message from main to worker */
export interface IPCRequest {
  type: 'job';
  job: {
    id: string;
    data: unknown;
    queue: string;
    attempts: number;
    parentId?: string;
  };
}

/** IPC message from worker to main */
export interface IPCResponse {
  type: 'result' | 'error' | 'progress' | 'log' | 'fail' | 'ready';
  jobId?: string;
  result?: unknown;
  error?: string;
  progress?: number;
  message?: string;
}
