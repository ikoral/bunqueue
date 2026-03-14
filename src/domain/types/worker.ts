/**
 * Worker domain types
 */

import { uuid } from '../../shared/hash';

/** Worker ID type */
export type WorkerId = string;

/** Worker status */
export interface Worker {
  id: WorkerId;
  name: string;
  queues: string[];
  concurrency: number;
  registeredAt: number;
  lastSeen: number;
  activeJobs: number;
  processedJobs: number;
  failedJobs: number;
  currentJob: string | null;
}

/** Create a new worker */
export function createWorker(name: string, queues: string[], concurrency: number = 1): Worker {
  const now = Date.now();
  return {
    id: uuid(),
    name,
    queues,
    concurrency,
    registeredAt: now,
    lastSeen: now,
    activeJobs: 0,
    processedJobs: 0,
    failedJobs: 0,
    currentJob: null,
  };
}

/** Job log entry */
export interface JobLogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

/** Create log entry */
export function createLogEntry(
  message: string,
  level: 'info' | 'warn' | 'error' = 'info'
): JobLogEntry {
  return {
    timestamp: Date.now(),
    level,
    message,
  };
}
