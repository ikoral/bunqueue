/**
 * Shard - Container for queues within a shard
 * Each shard manages multiple queues and their state
 */

import type { Job, JobId } from '../types/job';
import { type QueueState, createQueueState, RateLimiter, ConcurrencyLimiter } from '../types/queue';
import { IndexedPriorityQueue } from './priorityQueue';

/**
 * Shard contains:
 * - Queues (waiting + delayed jobs)
 * - DLQ (dead letter queue)
 * - Unique keys tracking
 * - Active FIFO groups
 * - Queue state (paused, rate limit, concurrency)
 */
export class Shard {
  /** Priority queues by queue name */
  readonly queues = new Map<string, IndexedPriorityQueue>();

  /** Dead letter queue by queue name */
  readonly dlq = new Map<string, Job[]>();

  /** Unique keys per queue for deduplication */
  readonly uniqueKeys = new Map<string, Set<string>>();

  /** Jobs waiting for dependencies */
  readonly waitingDeps = new Map<JobId, Job>();

  /** Parent jobs waiting for children to complete */
  readonly waitingChildren = new Map<JobId, Job>();

  /** Queue state (pause, rate limit, concurrency) */
  readonly queueState = new Map<string, QueueState>();

  /** Active FIFO groups per queue */
  readonly activeGroups = new Map<string, Set<string>>();

  /** Rate limiters per queue */
  readonly rateLimiters = new Map<string, RateLimiter>();

  /** Concurrency limiters per queue */
  readonly concurrencyLimiters = new Map<string, ConcurrencyLimiter>();

  /** Waiters for new jobs (condition variable pattern) */
  private readonly waiters: Array<() => void> = [];

  /** Notify that jobs are available - wakes all waiters */
  notify(): void {
    const toNotify = this.waiters.splice(0);
    for (const waiter of toNotify) {
      waiter();
    }
  }

  /** Wait for a job to become available (with timeout) */
  waitForJob(timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let resolved = false;

      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        const idx = this.waiters.indexOf(waiterFn);
        if (idx !== -1) this.waiters.splice(idx, 1);
        resolve();
      };

      const waiterFn = () => {
        cleanup();
      };

      // Add to waiters
      this.waiters.push(waiterFn);

      // Timeout fallback
      setTimeout(cleanup, Math.min(timeoutMs, 100)); // Max 100ms wait to allow checking other conditions
    });
  }

  // ============ Queue Operations ============

  /** Get or create queue */
  getQueue(name: string): IndexedPriorityQueue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new IndexedPriorityQueue();
      this.queues.set(name, queue);
    }
    return queue;
  }

  /** Get queue state */
  getState(name: string): QueueState {
    let state = this.queueState.get(name);
    if (!state) {
      state = createQueueState(name);
      this.queueState.set(name, state);
    }
    return state;
  }

  /** Check if queue is paused */
  isPaused(name: string): boolean {
    return this.queueState.get(name)?.paused ?? false;
  }

  /** Pause queue */
  pause(name: string): void {
    this.getState(name).paused = true;
  }

  /** Resume queue */
  resume(name: string): void {
    this.getState(name).paused = false;
    this.notify();
  }

  // ============ Unique Key Management ============

  /** Check if unique key is available */
  isUniqueAvailable(queue: string, key: string): boolean {
    return !this.uniqueKeys.get(queue)?.has(key);
  }

  /** Register unique key */
  registerUniqueKey(queue: string, key: string): void {
    let keys = this.uniqueKeys.get(queue);
    if (!keys) {
      keys = new Set();
      this.uniqueKeys.set(queue, keys);
    }
    keys.add(key);
  }

  /** Release unique key */
  releaseUniqueKey(queue: string, key: string): void {
    this.uniqueKeys.get(queue)?.delete(key);
  }

  // ============ FIFO Group Management ============

  /** Check if FIFO group is active */
  isGroupActive(queue: string, groupId: string): boolean {
    return this.activeGroups.get(queue)?.has(groupId) ?? false;
  }

  /** Mark FIFO group as active */
  activateGroup(queue: string, groupId: string): void {
    let groups = this.activeGroups.get(queue);
    if (!groups) {
      groups = new Set();
      this.activeGroups.set(queue, groups);
    }
    groups.add(groupId);
  }

  /** Release FIFO group */
  releaseGroup(queue: string, groupId: string): void {
    this.activeGroups.get(queue)?.delete(groupId);
  }

  // ============ Rate & Concurrency Limiting ============

  /** Set rate limit for queue */
  setRateLimit(queue: string, limit: number): void {
    this.rateLimiters.set(queue, new RateLimiter(limit));
    this.getState(queue).rateLimit = limit;
  }

  /** Clear rate limit */
  clearRateLimit(queue: string): void {
    this.rateLimiters.delete(queue);
    const state = this.queueState.get(queue);
    if (state) state.rateLimit = null;
  }

  /** Try to acquire rate limit token */
  tryAcquireRateLimit(queue: string): boolean {
    const limiter = this.rateLimiters.get(queue);
    return !limiter || limiter.tryAcquire();
  }

  /** Set concurrency limit for queue */
  setConcurrency(queue: string, limit: number): void {
    let limiter = this.concurrencyLimiters.get(queue);
    if (limiter) {
      limiter.setLimit(limit);
    } else {
      limiter = new ConcurrencyLimiter(limit);
      this.concurrencyLimiters.set(queue, limiter);
    }
    this.getState(queue).concurrencyLimit = limit;
  }

  /** Clear concurrency limit */
  clearConcurrency(queue: string): void {
    this.concurrencyLimiters.delete(queue);
    const state = this.queueState.get(queue);
    if (state) state.concurrencyLimit = null;
  }

  /** Try to acquire concurrency slot */
  tryAcquireConcurrency(queue: string): boolean {
    const limiter = this.concurrencyLimiters.get(queue);
    return !limiter || limiter.tryAcquire();
  }

  /** Release concurrency slot */
  releaseConcurrency(queue: string): void {
    this.concurrencyLimiters.get(queue)?.release();
  }

  // ============ Resource Release ============

  /** Release all resources for a job */
  releaseJobResources(queue: string, uniqueKey: string | null, groupId: string | null): void {
    if (uniqueKey) {
      this.releaseUniqueKey(queue, uniqueKey);
    }
    if (groupId) {
      this.releaseGroup(queue, groupId);
    }
    this.releaseConcurrency(queue);
  }

  // ============ DLQ Operations ============

  /** Add job to DLQ */
  addToDlq(job: Job): void {
    let dlq = this.dlq.get(job.queue);
    if (!dlq) {
      dlq = [];
      this.dlq.set(job.queue, dlq);
    }
    dlq.push(job);
  }

  /** Get DLQ jobs */
  getDlq(queue: string, count?: number): Job[] {
    const dlq = this.dlq.get(queue);
    if (!dlq) return [];
    return count ? dlq.slice(0, count) : [...dlq];
  }

  /** Remove job from DLQ */
  removeFromDlq(queue: string, jobId: JobId): Job | null {
    const dlq = this.dlq.get(queue);
    if (!dlq) return null;
    const idx = dlq.findIndex((j) => j.id === jobId);
    if (idx === -1) return null;
    return dlq.splice(idx, 1)[0];
  }

  /** Clear DLQ for queue */
  clearDlq(queue: string): number {
    const dlq = this.dlq.get(queue);
    if (!dlq) return 0;
    const count = dlq.length;
    this.dlq.delete(queue);
    return count;
  }

  // ============ Queue Stats ============

  /** Get waiting job count for queue */
  getWaitingCount(queue: string): number {
    return this.queues.get(queue)?.size ?? 0;
  }

  /** Get DLQ count for queue */
  getDlqCount(queue: string): number {
    return this.dlq.get(queue)?.length ?? 0;
  }

  /** Get all queue names in this shard */
  getQueueNames(): string[] {
    const names = new Set<string>();
    for (const name of this.queues.keys()) names.add(name);
    for (const name of this.dlq.keys()) names.add(name);
    for (const name of this.queueState.keys()) names.add(name);
    return Array.from(names);
  }

  /** Drain all waiting jobs from queue */
  drain(queue: string): number {
    const q = this.queues.get(queue);
    if (!q) return 0;
    const count = q.size;
    q.clear();
    return count;
  }

  /** Obliterate queue completely */
  obliterate(queue: string): void {
    this.queues.delete(queue);
    this.dlq.delete(queue);
    this.uniqueKeys.delete(queue);
    this.queueState.delete(queue);
    this.activeGroups.delete(queue);
    this.rateLimiters.delete(queue);
    this.concurrencyLimiters.delete(queue);
  }
}
