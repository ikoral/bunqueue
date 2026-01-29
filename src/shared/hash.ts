/**
 * Fast hash functions
 * FNV-1a implementation for consistent hashing
 */

import { cpus } from 'os';

const FNV_PRIME = 0x01000193;
const FNV_OFFSET = 0x811c9dc5;

/**
 * FNV-1a hash function (32-bit)
 * Fast, good distribution for strings
 */
export function fnv1a(str: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0; // Convert to unsigned 32-bit
}

/**
 * Calculate optimal shard count based on CPU cores
 * - Must be power of 2 for fast bitwise AND
 * - At least equal to CPU cores for parallelism
 * - Capped at 64 to avoid excessive memory overhead
 */
function calculateShardCount(): number {
  const cores = cpus().length || 4; // Fallback to 4 if detection fails

  // Find next power of 2 >= cores, capped at 64
  let shards = 1;
  while (shards < cores && shards < 64) {
    shards *= 2;
  }

  return shards;
}

/**
 * Shard configuration - auto-detected from hardware
 * Uses power of 2 for fast bitwise mask
 */
export const SHARD_COUNT = calculateShardCount();
export const SHARD_MASK = SHARD_COUNT - 1;

export function shardIndex(key: string): number {
  return fnv1a(key) & SHARD_MASK;
}

/**
 * Calculate processing shard index from job ID (UUIDv7 string)
 */
export function processingShardIndex(jobId: string): number {
  return fnv1a(jobId) & SHARD_MASK;
}

/**
 * Generate a simple UUID v4
 */
export function uuid(): string {
  const hex = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      result += '-';
    } else if (i === 14) {
      result += '4';
    } else if (i === 19) {
      result += hex[(Math.random() * 4) | 8];
    } else {
      result += hex[(Math.random() * 16) | 0];
    }
  }
  return result;
}

/**
 * Constant-time string comparison
 * Prevents timing attacks on token validation
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
