/**
 * Fast hash functions
 * FNV-1a implementation for consistent hashing
 */

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
  const cores = navigator.hardwareConcurrency || 4; // Fallback to 4 if detection fails

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
 * Generate a UUID v7 using Bun's native implementation
 * ~10x faster than manual Math.random() based UUID v4
 */
export function uuid(): string {
  return Bun.randomUUIDv7();
}

/**
 * Constant-time string comparison
 * Prevents timing attacks on token validation
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const minLen = Math.min(a.length, b.length);
  let result = a.length ^ b.length;
  for (let i = 0; i < minLen; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
