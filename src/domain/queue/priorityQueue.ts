/**
 * Indexed Priority Queue
 * Combines binary heap for O(log n) priority operations
 * with Map for O(1) lookups by job ID
 */

import type { Job, JobId } from '../types/job';

/** Heap entry - lightweight metadata for heap operations */
interface HeapEntry {
  jobId: JobId;
  priority: number;
  runAt: number;
  lifo: boolean;
  generation: number;
}

/**
 * Compare two heap entries
 * Order: higher priority first, then:
 *   - LIFO: newer jobs first (by jobId descending, since UUID7 is time-ordered)
 *   - FIFO: earlier runAt first, then older jobs first (by jobId ascending)
 *
 * Uses direct string comparison instead of localeCompare for ~10-50x faster performance.
 * This works because UUID7 is ASCII-only and lexicographically sortable.
 */
function compareEntries(a: HeapEntry, b: HeapEntry): number {
  // Higher priority first
  if (a.priority !== b.priority) {
    return b.priority - a.priority;
  }

  // For LIFO: newer jobs (higher UUID7) should come first
  // UUID7 contains timestamp, so lexicographic comparison gives time order
  if (a.lifo && b.lifo) {
    // Direct comparison mimicking localeCompare(b, a) for descending order
    // b > a means b is newer, should come first (return positive to put b before a)
    if (b.jobId > a.jobId) return 1;
    if (b.jobId < a.jobId) return -1;
    return 0;
  }

  // For FIFO or mixed: earlier runAt first
  if (a.runAt !== b.runAt) {
    return a.runAt - b.runAt;
  }

  // Then by jobId (older first for FIFO)
  // a < b means a is older, should come first (return negative)
  if (a.jobId < b.jobId) return -1;
  if (a.jobId > b.jobId) return 1;
  return 0;
}

/**
 * Indexed Priority Queue implementation
 * O(log n) push, pop, update
 * O(1) find, has
 */
export class IndexedPriorityQueue {
  private heap: HeapEntry[] = [];
  private index: Map<JobId, { job: Job; generation: number }> = new Map();
  private generation = 0n;

  /** Get current size */
  get size(): number {
    return this.index.size;
  }

  /** Check if empty */
  get isEmpty(): boolean {
    return this.index.size === 0;
  }

  /** Push a job into the queue */
  push(job: Job): void {
    const gen = Number(this.generation++);

    // Store in index
    this.index.set(job.id, { job, generation: gen });

    // Add to heap
    const entry: HeapEntry = {
      jobId: job.id,
      priority: job.priority,
      runAt: job.runAt,
      lifo: job.lifo,
      generation: gen,
    };
    this.heap.push(entry);
    this.bubbleUp(this.heap.length - 1);
  }

  /** Pop the highest priority job */
  pop(): Job | null {
    while (this.heap.length > 0) {
      const entry = this.heap[0];
      const indexed = this.index.get(entry.jobId);

      // Skip stale entries (generation mismatch = updated or removed)
      if (indexed?.generation !== entry.generation) {
        this.removeTop();
        continue;
      }

      // Remove from both structures
      this.removeTop();
      this.index.delete(entry.jobId);
      return indexed.job;
    }
    return null;
  }

  /** Peek at the highest priority job without removing */
  peek(): Job | null {
    while (this.heap.length > 0) {
      const entry = this.heap[0];
      const indexed = this.index.get(entry.jobId);

      // Skip stale entries
      if (indexed?.generation !== entry.generation) {
        this.removeTop();
        continue;
      }

      return indexed.job;
    }
    return null;
  }

  /** Find a job by ID - O(1) */
  find(jobId: JobId): Job | null {
    return this.index.get(jobId)?.job ?? null;
  }

  /** Check if job exists - O(1) */
  has(jobId: JobId): boolean {
    return this.index.has(jobId);
  }

  /** Remove a job by ID - O(1) for index, heap cleans lazily */
  remove(jobId: JobId): Job | null {
    const indexed = this.index.get(jobId);
    if (!indexed) return null;

    this.index.delete(jobId);
    // Heap entry becomes stale, will be skipped on pop
    return indexed.job;
  }

  /** Update job priority - O(log n) */
  updatePriority(jobId: JobId, newPriority: number): boolean {
    const indexed = this.index.get(jobId);
    if (!indexed) return false;

    // Update job
    const job = indexed.job;
    (job as { priority: number }).priority = newPriority;

    // Create new heap entry with new generation
    const gen = Number(this.generation++);
    indexed.generation = gen;

    const entry: HeapEntry = {
      jobId: job.id,
      priority: newPriority,
      runAt: job.runAt,
      lifo: job.lifo,
      generation: gen,
    };
    this.heap.push(entry);
    this.bubbleUp(this.heap.length - 1);

    return true;
  }

  /** Update job runAt (for delay changes) - O(log n) */
  updateRunAt(jobId: JobId, newRunAt: number): boolean {
    const indexed = this.index.get(jobId);
    if (!indexed) return false;

    // Update job
    const job = indexed.job;
    job.runAt = newRunAt;

    // Create new heap entry
    const gen = Number(this.generation++);
    indexed.generation = gen;

    const entry: HeapEntry = {
      jobId: job.id,
      priority: job.priority,
      runAt: newRunAt,
      lifo: job.lifo,
      generation: gen,
    };
    this.heap.push(entry);
    this.bubbleUp(this.heap.length - 1);

    return true;
  }

  /** Get all jobs (for iteration) */
  values(): Job[] {
    return Array.from(this.index.values()).map((v) => v.job);
  }

  /** Clear the queue */
  clear(): void {
    this.heap = [];
    this.index.clear();
    this.generation = 0n;
  }

  // ============ Heap Operations ============

  private removeTop(): void {
    if (this.heap.length <= 1) {
      this.heap.pop();
      return;
    }
    this.heap[0] = this.heap.pop()!;
    this.bubbleDown(0);
  }

  private bubbleUp(idx: number): void {
    while (idx > 0) {
      const parentIdx = Math.floor((idx - 1) / 2);
      if (compareEntries(this.heap[idx], this.heap[parentIdx]) >= 0) {
        break;
      }
      this.swap(idx, parentIdx);
      idx = parentIdx;
    }
  }

  private bubbleDown(idx: number): void {
    const length = this.heap.length;
    while (true) {
      const leftIdx = 2 * idx + 1;
      const rightIdx = 2 * idx + 2;
      let smallest = idx;

      if (leftIdx < length && compareEntries(this.heap[leftIdx], this.heap[smallest]) < 0) {
        smallest = leftIdx;
      }
      if (rightIdx < length && compareEntries(this.heap[rightIdx], this.heap[smallest]) < 0) {
        smallest = rightIdx;
      }

      if (smallest === idx) break;
      this.swap(idx, smallest);
      idx = smallest;
    }
  }

  private swap(i: number, j: number): void {
    const temp = this.heap[i];
    this.heap[i] = this.heap[j];
    this.heap[j] = temp;
  }
}
