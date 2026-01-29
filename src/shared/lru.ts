/**
 * LRU (Least Recently Used) Cache implementations
 * Bounded collections with automatic eviction
 */

/** Map-like interface for LRU compatibility */
export interface MapLike<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  has(key: K): boolean;
  delete(key: K): boolean;
  clear(): void;
  readonly size: number;
}

/** Set-like interface for LRU compatibility */
export interface SetLike<T> {
  add(value: T): void;
  has(value: T): boolean;
  delete(value: T): boolean;
  clear(): void;
  readonly size: number;
}

/**
 * LRU Map - automatically evicts least recently used entries
 */
export class LRUMap<K, V> implements MapLike<K, V> {
  private readonly cache = new Map<K, V>();
  private readonly maxSize: number;
  private readonly onEvict?: (key: K, value: V) => void;

  constructor(maxSize: number, onEvict?: (key: K, value: V) => void) {
    this.maxSize = maxSize;
    this.onEvict = onEvict;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    // If key exists, delete and re-add to update position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest entry
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        const evictedValue = this.cache.get(firstKey);
        this.cache.delete(firstKey);
        if (evictedValue !== undefined) {
          this.onEvict?.(firstKey, evictedValue);
        }
      }
    }
    this.cache.set(key, value);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  keys(): IterableIterator<K> {
    return this.cache.keys();
  }

  values(): IterableIterator<V> {
    return this.cache.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.cache.entries();
  }

  forEach(callback: (value: V, key: K) => void): void {
    this.cache.forEach(callback);
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.cache[Symbol.iterator]();
  }
}

/**
 * LRU Set - automatically evicts least recently used entries
 */
export class LRUSet<T> implements SetLike<T> {
  private readonly cache = new Set<T>();
  private readonly maxSize: number;
  private readonly onEvict?: (value: T) => void;

  constructor(maxSize: number, onEvict?: (value: T) => void) {
    this.maxSize = maxSize;
    this.onEvict = onEvict;
  }

  add(value: T): void {
    // If value exists, delete and re-add to update position
    if (this.cache.has(value)) {
      this.cache.delete(value);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest entry
      const firstValue = this.cache.values().next().value;
      if (firstValue !== undefined) {
        this.cache.delete(firstValue);
        this.onEvict?.(firstValue);
      }
    }
    this.cache.add(value);
  }

  has(value: T): boolean {
    return this.cache.has(value);
  }

  delete(value: T): boolean {
    return this.cache.delete(value);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  values(): IterableIterator<T> {
    return this.cache.values();
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.cache[Symbol.iterator]();
  }
}

/**
 * Bounded Set - fast FIFO eviction without LRU tracking
 * Optimized for high-throughput scenarios where recency doesn't matter
 * Uses batch eviction to avoid per-item iterator overhead
 */
export class BoundedSet<T> implements SetLike<T> {
  private readonly cache = new Set<T>();
  private readonly maxSize: number;
  private readonly onEvict?: (value: T) => void;
  /** Evict 10% of items at once to amortize iterator cost */
  private readonly evictBatchSize: number;

  constructor(maxSize: number, onEvict?: (value: T) => void) {
    this.maxSize = maxSize;
    this.onEvict = onEvict;
    this.evictBatchSize = Math.max(1, Math.floor(maxSize * 0.1));
  }

  add(value: T): void {
    // Fast path: already exists - no-op
    if (this.cache.has(value)) return;

    // Batch evict if at capacity - amortizes iterator cost
    if (this.cache.size >= this.maxSize) {
      this.evictBatch();
    }
    this.cache.add(value);
  }

  /** Evict multiple items at once - more efficient than one at a time */
  private evictBatch(): void {
    const toEvict: T[] = [];
    const iter = this.cache.values();
    for (let i = 0; i < this.evictBatchSize; i++) {
      const { value, done } = iter.next();
      if (done) break;
      toEvict.push(value);
    }
    for (const value of toEvict) {
      this.cache.delete(value);
      this.onEvict?.(value);
    }
  }

  has(value: T): boolean {
    return this.cache.has(value);
  }

  delete(value: T): boolean {
    return this.cache.delete(value);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  values(): IterableIterator<T> {
    return this.cache.values();
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.cache[Symbol.iterator]();
  }
}

/**
 * Bounded Map - fast FIFO eviction without LRU tracking
 * Optimized for high-throughput scenarios where recency doesn't matter
 * Uses batch eviction to avoid per-item iterator overhead
 */
export class BoundedMap<K, V> implements MapLike<K, V> {
  private readonly cache = new Map<K, V>();
  private readonly maxSize: number;
  private readonly onEvict?: (key: K, value: V) => void;
  /** Evict 10% of items at once to amortize iterator cost */
  private readonly evictBatchSize: number;

  constructor(maxSize: number, onEvict?: (key: K, value: V) => void) {
    this.maxSize = maxSize;
    this.onEvict = onEvict;
    this.evictBatchSize = Math.max(1, Math.floor(maxSize * 0.1));
  }

  get(key: K): V | undefined {
    return this.cache.get(key);
  }

  set(key: K, value: V): void {
    // Fast path: key already exists - update in place
    if (this.cache.has(key)) {
      this.cache.set(key, value);
      return;
    }

    // Batch evict if at capacity
    if (this.cache.size >= this.maxSize) {
      this.evictBatch();
    }
    this.cache.set(key, value);
  }

  /** Evict multiple items at once - more efficient than one at a time */
  private evictBatch(): void {
    const toEvict: Array<{ key: K; value: V }> = [];
    const iter = this.cache.entries();
    for (let i = 0; i < this.evictBatchSize; i++) {
      const { value, done } = iter.next();
      if (done) break;
      toEvict.push({ key: value[0], value: value[1] });
    }
    for (const { key, value } of toEvict) {
      this.cache.delete(key);
      this.onEvict?.(key, value);
    }
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  keys(): IterableIterator<K> {
    return this.cache.keys();
  }

  values(): IterableIterator<V> {
    return this.cache.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.cache.entries();
  }

  forEach(callback: (value: V, key: K) => void): void {
    this.cache.forEach(callback);
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.cache[Symbol.iterator]();
  }
}

/**
 * TTL Map - entries expire after timeout
 * Optimized with expiry heap for O(k) cleanup instead of O(n)
 */
export class TTLMap<K, V> {
  private readonly cache = new Map<K, { value: V; expiresAt: number }>();
  private readonly ttlMs: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Expiry heap: sorted array of (expiresAt, key) for efficient cleanup
   * Oldest expiry at index 0
   */
  private readonly expiryHeap: Array<{ expiresAt: number; key: K }> = [];

  constructor(ttlMs: number, cleanupIntervalMs: number = 60_000) {
    this.ttlMs = ttlMs;
    this.startCleanup(cleanupIntervalMs);
  }

  private startCleanup(intervalMs: number): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, intervalMs);
  }

  /** O(k) cleanup where k = expired entries, instead of O(n) full scan */
  private cleanup(): void {
    const now = Date.now();

    // Remove expired entries from heap head - O(k)
    while (this.expiryHeap.length > 0 && this.expiryHeap[0].expiresAt <= now) {
      const item = this.expiryHeap.shift();
      if (!item) break;
      const { key, expiresAt } = item;

      // Verify entry still exists and has same expiry (might have been updated)
      const entry = this.cache.get(key);
      if (entry?.expiresAt === expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): void {
    const expiresAt = Date.now() + (ttlMs ?? this.ttlMs);
    this.cache.set(key, { value, expiresAt });

    // Add to expiry heap - binary search for insertion point
    let lo = 0;
    let hi = this.expiryHeap.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.expiryHeap[mid].expiresAt < expiresAt) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this.expiryHeap.splice(lo, 0, { expiresAt, key });
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    // Note: we don't remove from expiryHeap - it will be cleaned up lazily
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
    this.expiryHeap.length = 0;
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  get size(): number {
    return this.cache.size;
  }
}
