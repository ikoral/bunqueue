/**
 * LRU (Least Recently Used) Cache implementations
 * Bounded collections with automatic eviction
 */

import { MinHeap } from './minHeap';

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

/** Node in the doubly-linked list for LRU tracking */
interface LRUNode<K, V> {
  key: K;
  value: V;
  prev: LRUNode<K, V> | null;
  next: LRUNode<K, V> | null;
}

/**
 * LRU Map - automatically evicts least recently used entries
 * Optimized with doubly-linked list for O(1) move-to-front
 * without delete+re-insert overhead
 */
export class LRUMap<K, V> implements MapLike<K, V> {
  private readonly cache = new Map<K, LRUNode<K, V>>();
  private readonly maxSize: number;
  private readonly onEvict?: (key: K, value: V) => void;

  // Doubly-linked list head (most recent) and tail (least recent)
  private head: LRUNode<K, V> | null = null;
  private tail: LRUNode<K, V> | null = null;

  constructor(maxSize: number, onEvict?: (key: K, value: V) => void) {
    this.maxSize = maxSize;
    this.onEvict = onEvict;
  }

  /** Move node to front (most recently used) - O(1) */
  private moveToFront(node: LRUNode<K, V>): void {
    if (node === this.head) return; // Already at front

    // Detach from current position
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (node === this.tail) this.tail = node.prev;

    // Move to front
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    this.tail ??= node;
  }

  /** Remove node from list - O(1) */
  private removeNode(node: LRUNode<K, V>): void {
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (node === this.head) this.head = node.next;
    if (node === this.tail) this.tail = node.prev;
  }

  /** Add node to front - O(1) */
  private addToFront(node: LRUNode<K, V>): void {
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    this.tail ??= node;
  }

  get(key: K): V | undefined {
    const node = this.cache.get(key);
    if (!node) return undefined;

    // Move to front - O(1) without delete+re-insert
    this.moveToFront(node);
    return node.value;
  }

  set(key: K, value: V): void {
    const existing = this.cache.get(key);

    if (existing) {
      // Update value and move to front
      existing.value = value;
      this.moveToFront(existing);
    } else {
      // Evict if at capacity
      if (this.cache.size >= this.maxSize && this.tail) {
        const evicted = this.tail;
        this.cache.delete(evicted.key);
        this.removeNode(evicted);
        this.onEvict?.(evicted.key, evicted.value);
      }

      // Add new node
      const node: LRUNode<K, V> = { key, value, prev: null, next: null };
      this.cache.set(key, node);
      this.addToFront(node);
    }
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  delete(key: K): boolean {
    const node = this.cache.get(key);
    if (!node) return false;

    this.removeNode(node);
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
    this.head = null;
    this.tail = null;
  }

  get size(): number {
    return this.cache.size;
  }

  *keys(): IterableIterator<K> {
    // Iterate from tail (oldest) to head (newest) to match original Map behavior
    let current = this.tail;
    while (current) {
      yield current.key;
      current = current.prev;
    }
  }

  *values(): IterableIterator<V> {
    // Iterate from tail (oldest) to head (newest) to match original Map behavior
    let current = this.tail;
    while (current) {
      yield current.value;
      current = current.prev;
    }
  }

  *entries(): IterableIterator<[K, V]> {
    // Iterate from tail (oldest) to head (newest) to match original Map behavior
    let current = this.tail;
    while (current) {
      yield [current.key, current.value];
      current = current.prev;
    }
  }

  forEach(callback: (value: V, key: K) => void): void {
    // Iterate from tail (oldest) to head (newest) to match original Map behavior
    let current = this.tail;
    while (current) {
      callback(current.value, current.key);
      current = current.prev;
    }
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }
}

/** Node in the doubly-linked list for LRUSet */
interface LRUSetNode<T> {
  value: T;
  prev: LRUSetNode<T> | null;
  next: LRUSetNode<T> | null;
}

/**
 * LRU Set - automatically evicts least recently used entries
 * Optimized with doubly-linked list for O(1) move-to-front
 */
export class LRUSet<T> implements SetLike<T> {
  private readonly cache = new Map<T, LRUSetNode<T>>();
  private readonly maxSize: number;
  private readonly onEvict?: (value: T) => void;

  // Doubly-linked list head (most recent) and tail (least recent)
  private head: LRUSetNode<T> | null = null;
  private tail: LRUSetNode<T> | null = null;

  constructor(maxSize: number, onEvict?: (value: T) => void) {
    this.maxSize = maxSize;
    this.onEvict = onEvict;
  }

  /** Move node to front - O(1) */
  private moveToFront(node: LRUSetNode<T>): void {
    if (node === this.head) return;

    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (node === this.tail) this.tail = node.prev;

    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    this.tail ??= node;
  }

  /** Remove node from list - O(1) */
  private removeNode(node: LRUSetNode<T>): void {
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (node === this.head) this.head = node.next;
    if (node === this.tail) this.tail = node.prev;
  }

  /** Add node to front - O(1) */
  private addToFront(node: LRUSetNode<T>): void {
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    this.tail ??= node;
  }

  add(value: T): void {
    const existing = this.cache.get(value);

    if (existing) {
      // Move to front
      this.moveToFront(existing);
    } else {
      // Evict if at capacity
      if (this.cache.size >= this.maxSize && this.tail) {
        const evicted = this.tail;
        this.cache.delete(evicted.value);
        this.removeNode(evicted);
        this.onEvict?.(evicted.value);
      }

      // Add new node
      const node: LRUSetNode<T> = { value, prev: null, next: null };
      this.cache.set(value, node);
      this.addToFront(node);
    }
  }

  has(value: T): boolean {
    return this.cache.has(value);
  }

  delete(value: T): boolean {
    const node = this.cache.get(value);
    if (!node) return false;

    this.removeNode(node);
    return this.cache.delete(value);
  }

  clear(): void {
    this.cache.clear();
    this.head = null;
    this.tail = null;
  }

  get size(): number {
    return this.cache.size;
  }

  *values(): IterableIterator<T> {
    // Iterate from tail (oldest) to head (newest) to match original Set behavior
    let current = this.tail;
    while (current) {
      yield current.value;
      current = current.prev;
    }
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.values();
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
 * Optimized with MinHeap for O(log n) insert and O(k) cleanup
 *
 * Memory leak prevention:
 * - Each heap entry stores (expiresAt, key)
 * - During cleanup, we verify the key still exists in cache AND has matching expiresAt
 * - Stale entries (deleted keys or updated TTLs) are skipped and removed from heap
 * - Periodic compaction rebuilds heap when stale ratio exceeds threshold
 */
export class TTLMap<K, V> {
  private readonly cache = new Map<K, { value: V; expiresAt: number }>();
  private readonly ttlMs: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Expiry heap: MinHeap of (expiresAt, key) for efficient cleanup
   * O(log n) insert instead of O(n) with array splice
   */
  private readonly expiryHeap = new MinHeap<{ expiresAt: number; key: K }>(
    (a, b) => a.expiresAt - b.expiresAt
  );

  /** Count of stale entries in heap (deleted or updated keys) */
  private staleCount = 0;

  /** Rebuild heap when stale entries exceed this ratio of heap size */
  private static readonly COMPACTION_THRESHOLD = 0.5;

  /** Minimum heap size before considering compaction (avoid frequent rebuilds for small heaps) */
  private static readonly MIN_COMPACTION_SIZE = 100;

  constructor(ttlMs: number, cleanupIntervalMs: number = 60_000) {
    this.ttlMs = ttlMs;
    this.startCleanup(cleanupIntervalMs);
  }

  private startCleanup(intervalMs: number): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, intervalMs);
  }

  /** O(k log n) cleanup where k = expired entries */
  private cleanup(): void {
    const now = Date.now();

    // Remove expired entries from heap - O(k log n)
    while (!this.expiryHeap.isEmpty) {
      const top = this.expiryHeap.peek();
      if (!top || top.expiresAt > now) break;

      this.expiryHeap.pop();
      const { key, expiresAt } = top;

      // Verify entry still exists and has same expiry (might have been updated or deleted)
      const entry = this.cache.get(key);
      if (entry?.expiresAt === expiresAt) {
        // Valid expired entry - delete from cache
        this.cache.delete(key);
      } else {
        // Stale heap entry (key deleted or TTL updated) - already removed, decrement counter
        if (this.staleCount > 0) this.staleCount--;
      }
    }

    // Compact heap if too many stale entries accumulated
    this.maybeCompact();
  }

  /**
   * Rebuild heap if stale entry ratio exceeds threshold
   * This prevents unbounded heap growth from delete() and set() updates
   */
  private maybeCompact(): void {
    const heapSize = this.expiryHeap.size;
    if (
      heapSize >= TTLMap.MIN_COMPACTION_SIZE &&
      this.staleCount / heapSize > TTLMap.COMPACTION_THRESHOLD
    ) {
      this.rebuildHeap();
    }
  }

  /** Rebuild heap with only valid entries - O(n log n) */
  private rebuildHeap(): void {
    this.expiryHeap.clear();
    this.staleCount = 0;

    // Re-add all valid cache entries to heap
    for (const [key, entry] of this.cache) {
      this.expiryHeap.push({ expiresAt: entry.expiresAt, key });
    }
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      this.staleCount++; // Heap entry is now stale
      return undefined;
    }
    return entry.value;
  }

  /** O(log n) insert with MinHeap instead of O(n) with array splice */
  set(key: K, value: V, ttlMs?: number): void {
    const expiresAt = Date.now() + (ttlMs ?? this.ttlMs);

    // Check if key already exists - old heap entry becomes stale
    if (this.cache.has(key)) {
      this.staleCount++;
    }

    this.cache.set(key, { value, expiresAt });

    // Add to expiry heap - O(log n) with MinHeap
    this.expiryHeap.push({ expiresAt, key });
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    const existed = this.cache.delete(key);
    if (existed) {
      // Heap entry is now stale - will be cleaned up lazily or during compaction
      this.staleCount++;
    }
    return existed;
  }

  clear(): void {
    this.cache.clear();
    this.expiryHeap.clear();
    this.staleCount = 0;
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

  /** Get heap size (for debugging/monitoring) */
  get heapSize(): number {
    return this.expiryHeap.size;
  }

  /** Get count of stale heap entries (for debugging/monitoring) */
  get staleEntryCount(): number {
    return this.staleCount;
  }
}
