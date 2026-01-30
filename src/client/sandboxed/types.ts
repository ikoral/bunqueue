/**
 * Sandboxed Worker Types
 * Type definitions for sandboxed worker processes
 */

import type { SharedManager } from '../manager';
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
  };
}

/** IPC message from worker to main */
export interface IPCResponse {
  type: 'result' | 'error' | 'progress';
  jobId: string;
  result?: unknown;
  error?: string;
  progress?: number;
}
