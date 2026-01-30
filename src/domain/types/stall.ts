/**
 * Stall Detection Types
 * Configuration and handling for stalled jobs
 */

import type { Job } from './job';

/** Stall detection configuration per queue */
export interface StallConfig {
  /** Enable stall detection (default: true) */
  enabled: boolean;
  /** Stall timeout in ms - job is stalled if no heartbeat (default: 30s) */
  stallInterval: number;
  /** Max stalls before moving to DLQ (default: 3) */
  maxStalls: number;
  /** Grace period after job start before stall detection (default: 5s) */
  gracePeriod: number;
}

/** Default stall configuration */
export const DEFAULT_STALL_CONFIG: StallConfig = {
  enabled: true,
  stallInterval: 30_000, // 30 seconds
  maxStalls: 3,
  gracePeriod: 5_000, // 5 seconds
};

/** Stall check result */
export interface StallCheckResult {
  /** Is the job stalled? */
  isStalled: boolean;
  /** Time since last heartbeat in ms */
  stalledFor: number;
  /** Should move to DLQ? (exceeded max stalls) */
  shouldMoveToDlq: boolean;
  /** Stall count after this check */
  newStallCount: number;
}

/** Check if a job is stalled */
export function checkStall(
  job: Job,
  config: StallConfig = DEFAULT_STALL_CONFIG,
  now: number = Date.now()
): StallCheckResult {
  // Not processing = not stalled
  if (job.startedAt === null) {
    return {
      isStalled: false,
      stalledFor: 0,
      shouldMoveToDlq: false,
      newStallCount: job.stallCount,
    };
  }

  // Grace period - don't check immediately after start
  if (now - job.startedAt < config.gracePeriod) {
    return {
      isStalled: false,
      stalledFor: 0,
      shouldMoveToDlq: false,
      newStallCount: job.stallCount,
    };
  }

  // Use job-specific or default stall timeout
  const stallInterval = job.stallTimeout ?? config.stallInterval;
  const stalledFor = now - job.lastHeartbeat;
  const isStalled = stalledFor > stallInterval;

  if (!isStalled) {
    return {
      isStalled: false,
      stalledFor,
      shouldMoveToDlq: false,
      newStallCount: job.stallCount,
    };
  }

  const newStallCount = job.stallCount + 1;
  const shouldMoveToDlq = newStallCount >= config.maxStalls;

  return {
    isStalled: true,
    stalledFor,
    shouldMoveToDlq,
    newStallCount,
  };
}

/** Stalled job action */
export const enum StallAction {
  /** Retry the job */
  Retry = 'retry',
  /** Move to DLQ */
  MoveToDlq = 'move_to_dlq',
  /** Keep active (still within grace) */
  Keep = 'keep',
}

/** Determine action for stalled job */
export function getStallAction(
  job: Job,
  config: StallConfig = DEFAULT_STALL_CONFIG,
  now: number = Date.now()
): StallAction {
  const result = checkStall(job, config, now);

  if (!result.isStalled) {
    return StallAction.Keep;
  }

  if (result.shouldMoveToDlq) {
    return StallAction.MoveToDlq;
  }

  return StallAction.Retry;
}

/** Update job heartbeat */
export function updateHeartbeat(job: Job, now: number = Date.now()): void {
  job.lastHeartbeat = now;
}

/** Reset stall count (after successful retry) */
export function resetStallCount(job: Job): void {
  job.stallCount = 0;
}

/** Increment stall count */
export function incrementStallCount(job: Job): number {
  job.stallCount++;
  return job.stallCount;
}
