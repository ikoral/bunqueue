/**
 * Worker Types
 * Type definitions for worker module
 */

import type { ConnectionOptions } from '../types';

/** Pending ACK item with result and optional lock token */
export interface PendingAck {
  id: string;
  result: unknown;
  token?: string; // Lock token for ownership verification
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
  useLocks: boolean;
  skipLockRenewal: boolean;
  skipStalledCheck: boolean;
  drainDelay: number;
  lockDuration: number;
  maxStalledCount: number;
  removeOnComplete?: boolean | number | { age?: number; count?: number };
  removeOnFail?: boolean | number | { age?: number; count?: number };
  connection?: ConnectionOptions;
}

/** TCP connection interface */
export interface TcpConnection {
  send: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/** Check if embedded mode should be forced (for tests) */
export const FORCE_EMBEDDED = Bun.env.BUNQUEUE_EMBEDDED === '1';

/** Worker constants */
export const WORKER_CONSTANTS = {
  MAX_BACKOFF_MS: 30_000,
  BASE_BACKOFF_MS: 100,
  MAX_POLL_TIMEOUT: 30_000,
  DEFAULT_ACK_INTERVAL: 50,
} as const;
