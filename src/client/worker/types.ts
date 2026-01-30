/**
 * Worker Types
 * Type definitions for worker module
 */

import type { ConnectionOptions } from '../types';

/** Pending ACK item with result */
export interface PendingAck {
  id: string;
  result: unknown;
  resolve: () => void;
  reject: (err: Error) => void;
}

/** Extended options with all defaults */
export interface ExtendedWorkerOptions {
  concurrency: number;
  autorun: boolean;
  heartbeatInterval: number;
  batchSize: number;
  pollTimeout: number;
  embedded: boolean;
  connection?: ConnectionOptions;
}

/** TCP connection interface */
export interface TcpConnection {
  send: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/** Check if embedded mode should be forced (for tests) */
export const FORCE_EMBEDDED = process.env.BUNQUEUE_EMBEDDED === '1';

/** Worker constants */
export const WORKER_CONSTANTS = {
  MAX_BACKOFF_MS: 30_000,
  BASE_BACKOFF_MS: 100,
  MAX_POLL_TIMEOUT: 30_000,
  DEFAULT_ACK_INTERVAL: 50,
} as const;
