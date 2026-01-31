/**
 * Advanced Deduplication Types
 * Supports TTL, extend, replace, and debounce strategies
 */

import type { JobId } from './job';

/** Deduplication strategy when a duplicate is detected */
export type DeduplicationStrategy = 'reject' | 'extend' | 'replace';

/**
 * Deduplication options for job creation
 */
export interface DeduplicationOptions {
  /** Unique deduplication key (maps to job.uniqueKey) */
  id: string;
  /** TTL in milliseconds for the unique key (optional - no expiry if not set) */
  ttl?: number;
  /** When true, reset TTL on duplicate instead of rejecting */
  extend?: boolean;
  /** When true, replace job data on duplicate instead of rejecting */
  replace?: boolean;
}

/**
 * Internal tracking entry for unique keys with TTL
 */
export interface UniqueKeyEntry {
  /** The job ID that owns this unique key */
  jobId: JobId;
  /** When the unique key expires (null = never) */
  expiresAt: number | null;
  /** Original registration timestamp */
  registeredAt: number;
}

/**
 * Determine the deduplication strategy from options
 */
export function getDeduplicationStrategy(opts: DeduplicationOptions): DeduplicationStrategy {
  if (opts.replace) return 'replace';
  if (opts.extend) return 'extend';
  return 'reject';
}

/**
 * Check if a unique key entry has expired
 */
export function isUniqueKeyExpired(entry: UniqueKeyEntry, now: number = Date.now()): boolean {
  return entry.expiresAt !== null && entry.expiresAt <= now;
}

/**
 * Calculate expiration time from TTL
 */
export function calculateExpiration(
  ttl: number | undefined,
  now: number = Date.now()
): number | null {
  return ttl !== undefined ? now + ttl : null;
}
