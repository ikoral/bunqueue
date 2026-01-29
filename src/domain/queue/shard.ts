/**
 * Shard - Container for queues within a shard
 * Each shard manages multiple queues and their state
 */

import type { Job, JobId } from '../types/job';
import { type QueueState, createQueueState, RateLimiter, ConcurrencyLimiter } from '../types/queue';
import { IndexedPriorityQueue } from './priorityQueue';

/** Shard statistics counters for O(1) stats retrieval */
export interface ShardStats {
  /** Total jobs in all queues (waiting + delayed) */
  queuedJobs: number;
  /** Jobs with runAt > now at time of push */
  delayedJobs: number;
  /** Total jobs in DLQ */
  dlqJobs: number;
}

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

  /** Running counters for O(1) stats - updated on every operation */
  private readonly stats: ShardStats = {
    queuedJobs: 0,
    delayedJobs: 0,
    dlqJobs: 0,
  };

  /** Set of delayed job IDs for tracking when they become ready */
  private readonly delayedJobIds = new Set<JobId>();

  /**
   * Temporal index: sorted array of (createdAt, jobId) for efficient cleanQueue
   * Kept sorted by createdAt for O(log n) binary search + O(k) cleanup
   */
  private readonly temporalIndex: Array<{ createdAt: number; jobId: JobId; queue: string }> = [];

  /** Unique keys per queue for deduplication */
  readonly uniqueKeys = new Map<string, Set<string>>();

  /** Jobs waiting for dependencies */
  readonly waitingDeps = new Map<JobId, Job>();

  /**
   * Reverse index: depId -> Set of jobIds waiting for that dependency
   * Enables O(1) lookup when a dependency completes instead of O(n) scan
   */
  readonly dependencyIndex = new Map<JobId, Set<JobId>>();

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

  // ============ Dependency Index Operations ============

  /**
   * Register a job's dependencies in the reverse index
   * Call when adding a job to waitingDeps
   */
  registerDependencies(jobId: JobId, dependsOn: JobId[]): void {
    for (const depId of dependsOn) {
      let waiters = this.dependencyIndex.get(depId);
      if (!waiters) {
        waiters = new Set();
        this.dependencyIndex.set(depId, waiters);
      }
      waiters.add(jobId);
    }
  }

  /**
   * Unregister a job's dependencies from the reverse index
   * Call when removing a job from waitingDeps
   */
  unregisterDependencies(jobId: JobId, dependsOn: JobId[]): void {
    for (const depId of dependsOn) {
      const waiters = this.dependencyIndex.get(depId);
      if (waiters) {
        waiters.delete(jobId);
        if (waiters.size === 0) {
          this.dependencyIndex.delete(depId);
        }
      }
    }
  }

  /**
   * Get jobs waiting for a specific dependency - O(1)
   */
  getJobsWaitingFor(depId: JobId): Set<JobId> | undefined {
    return this.dependencyIndex.get(depId);
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
    this.incrementDlq();
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
    this.decrementDlq();
    return dlq.splice(idx, 1)[0];
  }

  /** Clear DLQ for queue */
  clearDlq(queue: string): number {
    const dlq = this.dlq.get(queue);
    if (!dlq) return 0;
    const count = dlq.length;
    this.dlq.delete(queue);
    this.decrementDlq(count);
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

  // ============ Running Counters (O(1) Stats) ============

  /** Get shard statistics - O(1) */
  getStats(): ShardStats {
    return { ...this.stats };
  }

  /** Increment queued jobs counter and add to temporal index */
  incrementQueued(jobId: JobId, isDelayed: boolean, createdAt?: number, queue?: string): void {
    this.stats.queuedJobs++;
    if (isDelayed) {
      this.stats.delayedJobs++;
      this.delayedJobIds.add(jobId);
    }
    // Add to temporal index for efficient cleanQueue
    if (createdAt !== undefined && queue !== undefined) {
      this.addToTemporalIndex(createdAt, jobId, queue);
    }
  }

  /** Decrement queued jobs counter and remove from temporal index */
  decrementQueued(jobId: JobId): void {
    this.stats.queuedJobs = Math.max(0, this.stats.queuedJobs - 1);
    if (this.delayedJobIds.has(jobId)) {
      this.stats.delayedJobs = Math.max(0, this.stats.delayedJobs - 1);
      this.delayedJobIds.delete(jobId);
    }
    // Remove from temporal index (lazy removal - will be cleaned on next cleanQueue)
  }

  /** Increment DLQ counter */
  incrementDlq(): void {
    this.stats.dlqJobs++;
  }

  /** Decrement DLQ counter */
  decrementDlq(count: number = 1): void {
    this.stats.dlqJobs = Math.max(0, this.stats.dlqJobs - count);
  }

  /** Update delayed jobs that have become ready (call periodically) */
  refreshDelayedCount(now: number): void {
    const toRemove: JobId[] = [];
    for (const jobId of this.delayedJobIds) {
      // Find job in queues to check runAt
      for (const q of this.queues.values()) {
        const job = q.find(jobId);
        if (job && job.runAt <= now) {
          toRemove.push(jobId);
          break;
        }
      }
    }
    for (const jobId of toRemove) {
      this.delayedJobIds.delete(jobId);
      this.stats.delayedJobs = Math.max(0, this.stats.delayedJobs - 1);
    }
  }

  /** Reset all counters (used after drain/obliterate) */
  resetQueuedCounters(): void {
    this.stats.queuedJobs = 0;
    this.stats.delayedJobs = 0;
    this.delayedJobIds.clear();
  }

  /** Reset DLQ counter */
  resetDlqCounter(): void {
    this.stats.dlqJobs = 0;
  }

  // ============ Temporal Index (for efficient cleanQueue) ============

  /** Add job to temporal index - maintains sorted order by createdAt */
  private addToTemporalIndex(createdAt: number, jobId: JobId, queue: string): void {
    // Binary search to find insertion point
    let lo = 0;
    let hi = this.temporalIndex.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.temporalIndex[mid].createdAt < createdAt) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this.temporalIndex.splice(lo, 0, { createdAt, jobId, queue });
  }

  /**
   * Get old jobs from temporal index - O(log n + k) where k = returned jobs
   * Returns jobs older than threshold, up to limit
   */
  getOldJobs(
    queue: string,
    thresholdMs: number,
    limit: number
  ): Array<{ jobId: JobId; createdAt: number }> {
    const now = Date.now();
    const threshold = now - thresholdMs;
    const result: Array<{ jobId: JobId; createdAt: number }> = [];

    // Temporal index is sorted by createdAt ascending (oldest first)
    // Iterate from start until we find jobs newer than threshold
    for (const entry of this.temporalIndex) {
      if (entry.createdAt > threshold) break;
      if (entry.queue === queue) {
        result.push({ jobId: entry.jobId, createdAt: entry.createdAt });
        if (result.length >= limit) break;
      }
    }

    return result;
  }

  /** Remove job from temporal index (called after job is cleaned) */
  removeFromTemporalIndex(jobId: JobId): void {
    const idx = this.temporalIndex.findIndex((e) => e.jobId === jobId);
    if (idx !== -1) {
      this.temporalIndex.splice(idx, 1);
    }
  }

  /** Clear temporal index for a queue */
  clearTemporalIndexForQueue(queue: string): void {
    // Filter out entries for this queue
    for (let i = this.temporalIndex.length - 1; i >= 0; i--) {
      if (this.temporalIndex[i].queue === queue) {
        this.temporalIndex.splice(i, 1);
      }
    }
  }

  /** Drain all waiting jobs from queue */
  drain(queue: string): number {
    const q = this.queues.get(queue);
    if (!q) return 0;
    const count = q.size;
    // Remove delayed job tracking for drained jobs
    for (const job of q.values()) {
      this.delayedJobIds.delete(job.id);
    }
    q.clear();
    // Clear temporal index for this queue
    this.clearTemporalIndexForQueue(queue);
    // Update counters
    this.stats.queuedJobs = Math.max(0, this.stats.queuedJobs - count);
    this.stats.delayedJobs = Math.max(0, this.stats.delayedJobs);
    return count;
  }

  /** Obliterate queue completely */
  obliterate(queue: string): void {
    // Update counters before deleting
    const q = this.queues.get(queue);
    if (q) {
      for (const job of q.values()) {
        this.delayedJobIds.delete(job.id);
      }
      this.stats.queuedJobs = Math.max(0, this.stats.queuedJobs - q.size);
    }
    const dlqJobs = this.dlq.get(queue);
    if (dlqJobs) {
      this.stats.dlqJobs = Math.max(0, this.stats.dlqJobs - dlqJobs.length);
    }
    // Recalculate delayed count
    this.stats.delayedJobs = this.delayedJobIds.size;
    // Clear temporal index for this queue
    this.clearTemporalIndexForQueue(queue);

    this.queues.delete(queue);
    this.dlq.delete(queue);
    this.uniqueKeys.delete(queue);
    this.queueState.delete(queue);
    this.activeGroups.delete(queue);
    this.rateLimiters.delete(queue);
    this.concurrencyLimiters.delete(queue);
  }
}
