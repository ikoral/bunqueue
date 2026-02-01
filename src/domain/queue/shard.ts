/**
 * Shard - Container for queues within a shard
 * Each shard manages multiple queues and their state
 *
 * Refactored to compose smaller modules:
 * - UniqueKeyManager: deduplication with TTL
 * - DlqShard: Dead Letter Queue operations
 * - LimiterManager: rate limiting + concurrency
 * - DependencyTracker: job dependency tracking
 * - TemporalManager: temporal index + delayed job tracking
 */

import type { Job, JobId } from '../types/job';
import type { QueueState } from '../types/queue';
import type { DlqEntry, DlqConfig, DlqFilter } from '../types/dlq';
import { FailureReason } from '../types/dlq';
import type { StallConfig } from '../types/stall';
import type { UniqueKeyEntry } from '../types/deduplication';
import { IndexedPriorityQueue } from './priorityQueue';
import { UniqueKeyManager } from './uniqueKeyManager';
import { DlqShard } from './dlqShard';
import { LimiterManager } from './limiterManager';
import { DependencyTracker } from './dependencyTracker';
import { TemporalManager } from './temporalManager';

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

  /** Unique key manager for deduplication */
  private readonly uniqueKeyManager = new UniqueKeyManager();

  /** DLQ manager */
  private readonly dlqManager: DlqShard;

  /** Limiter manager for rate/concurrency control */
  private readonly limiterManager = new LimiterManager();

  /** Dependency tracker */
  private readonly dependencyTracker = new DependencyTracker();

  /** Temporal manager for index and delayed jobs */
  private readonly temporalManager = new TemporalManager();

  /** Running counters for O(1) stats - updated on every operation */
  private readonly stats: ShardStats = {
    queuedJobs: 0,
    delayedJobs: 0,
    dlqJobs: 0,
  };

  /** Active FIFO groups per queue */
  readonly activeGroups = new Map<string, Set<string>>();

  /** Waiter entry with cancellation flag for O(1) cleanup */
  private readonly waiters: Array<{ resolve: () => void; cancelled: boolean }> = [];

  constructor() {
    this.dlqManager = new DlqShard({
      incrementDlq: () => {
        this.incrementDlq();
      },
      decrementDlq: (count) => {
        this.decrementDlq(count);
      },
    });
  }

  /** Notify that jobs are available - wakes first non-cancelled waiter */
  notify(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (!waiter.cancelled) {
        waiter.resolve();
        break;
      }
    }
  }

  /** Wait for a job to become available (with timeout) */
  waitForJob(timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const waiter = { resolve, cancelled: false };
      const cleanup = () => {
        if (waiter.cancelled) return;
        waiter.cancelled = true;
        resolve();
      };
      this.waiters.push(waiter);
      setTimeout(cleanup, Math.min(timeoutMs, 100));
    });
  }

  // ============ Queue Operations ============

  getQueue(name: string): IndexedPriorityQueue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new IndexedPriorityQueue();
      this.queues.set(name, queue);
    }
    return queue;
  }

  getState(name: string): QueueState {
    return this.limiterManager.getState(name);
  }

  isPaused(name: string): boolean {
    return this.limiterManager.isPaused(name);
  }

  pause(name: string): void {
    this.limiterManager.pause(name);
  }

  resume(name: string): void {
    this.limiterManager.resume(name);
    this.notify();
  }

  // ============ Unique Key Management (delegated) ============

  isUniqueAvailable(queue: string, key: string): boolean {
    return this.uniqueKeyManager.isAvailable(queue, key);
  }

  getUniqueKeyEntry(queue: string, key: string): UniqueKeyEntry | null {
    return this.uniqueKeyManager.getEntry(queue, key);
  }

  registerUniqueKey(queue: string, key: string, jobId: JobId): void {
    this.uniqueKeyManager.register(queue, key, jobId);
  }

  registerUniqueKeyWithTtl(queue: string, key: string, jobId: JobId, ttl?: number): void {
    this.uniqueKeyManager.registerWithTtl(queue, key, jobId, ttl);
  }

  extendUniqueKeyTtl(queue: string, key: string, ttl: number): boolean {
    return this.uniqueKeyManager.extendTtl(queue, key, ttl);
  }

  releaseUniqueKey(queue: string, key: string): void {
    this.uniqueKeyManager.release(queue, key);
  }

  cleanExpiredUniqueKeys(): number {
    return this.uniqueKeyManager.cleanExpired();
  }

  get uniqueKeys(): Map<string, Map<string, UniqueKeyEntry>> {
    return this.uniqueKeyManager.getMap();
  }

  // ============ FIFO Group Management ============

  isGroupActive(queue: string, groupId: string): boolean {
    return this.activeGroups.get(queue)?.has(groupId) ?? false;
  }

  activateGroup(queue: string, groupId: string): void {
    let groups = this.activeGroups.get(queue);
    if (!groups) {
      groups = new Set();
      this.activeGroups.set(queue, groups);
    }
    groups.add(groupId);
  }

  releaseGroup(queue: string, groupId: string): void {
    this.activeGroups.get(queue)?.delete(groupId);
  }

  // ============ Rate & Concurrency Limiting (delegated) ============

  setRateLimit(queue: string, limit: number): void {
    this.limiterManager.setRateLimit(queue, limit);
  }

  clearRateLimit(queue: string): void {
    this.limiterManager.clearRateLimit(queue);
  }

  tryAcquireRateLimit(queue: string): boolean {
    return this.limiterManager.tryAcquireRateLimit(queue);
  }

  setConcurrency(queue: string, limit: number): void {
    this.limiterManager.setConcurrency(queue, limit);
  }

  clearConcurrency(queue: string): void {
    this.limiterManager.clearConcurrency(queue);
  }

  tryAcquireConcurrency(queue: string): boolean {
    return this.limiterManager.tryAcquireConcurrency(queue);
  }

  releaseConcurrency(queue: string): void {
    this.limiterManager.releaseConcurrency(queue);
  }

  get queueState(): Map<string, QueueState> {
    return this.limiterManager.getStateMap();
  }

  /** Clear limiter data for a queue (rate limits, concurrency) */
  clearQueueLimiters(queue: string): void {
    this.limiterManager.deleteQueue(queue);
  }

  // ============ Resource Release ============

  releaseJobResources(queue: string, uniqueKey: string | null, groupId: string | null): void {
    if (uniqueKey) this.releaseUniqueKey(queue, uniqueKey);
    if (groupId) this.releaseGroup(queue, groupId);
    this.releaseConcurrency(queue);
  }

  // ============ Dependency Tracking (delegated) ============

  get waitingDeps(): Map<JobId, Job> {
    return this.dependencyTracker.waitingDeps;
  }

  get dependencyIndex(): Map<JobId, Set<JobId>> {
    return this.dependencyTracker.dependencyIndex;
  }

  get waitingChildren(): Map<JobId, Job> {
    return this.dependencyTracker.waitingChildren;
  }

  registerDependencies(jobId: JobId, dependsOn: JobId[]): void {
    this.dependencyTracker.registerDependencies(jobId, dependsOn);
  }

  unregisterDependencies(jobId: JobId, dependsOn: JobId[]): void {
    this.dependencyTracker.unregisterDependencies(jobId, dependsOn);
  }

  getJobsWaitingFor(depId: JobId): Set<JobId> | undefined {
    return this.dependencyTracker.getJobsWaitingFor(depId);
  }

  // ============ DLQ Operations (delegated) ============

  get dlq(): Map<string, DlqEntry[]> {
    const map = new Map<string, DlqEntry[]>();
    for (const queue of this.dlqManager.getQueueNames()) {
      map.set(queue, this.dlqManager.getEntries(queue));
    }
    for (const queue of this.queues.keys()) {
      if (!map.has(queue)) map.set(queue, []);
    }
    return map;
  }

  get dlqConfig(): Map<string, DlqConfig> {
    const map = new Map<string, DlqConfig>();
    for (const queue of this.getQueueNames()) {
      map.set(queue, this.dlqManager.getConfig(queue));
    }
    return map;
  }

  get stallConfig(): Map<string, StallConfig> {
    const map = new Map<string, StallConfig>();
    for (const queue of this.getQueueNames()) {
      map.set(queue, this.dlqManager.getStallConfig(queue));
    }
    return map;
  }

  getDlqConfig(queue: string): DlqConfig {
    return this.dlqManager.getConfig(queue);
  }

  setDlqConfig(queue: string, config: Partial<DlqConfig>): void {
    this.dlqManager.setConfig(queue, config);
  }

  getStallConfig(queue: string): StallConfig {
    return this.dlqManager.getStallConfig(queue);
  }

  setStallConfig(queue: string, config: Partial<StallConfig>): void {
    this.dlqManager.setStallConfig(queue, config);
  }

  addToDlq(
    job: Job,
    reason: FailureReason = FailureReason.Unknown,
    error: string | null = null
  ): DlqEntry {
    return this.dlqManager.add(job, reason, error);
  }

  /** Restore an existing DlqEntry (for recovery from persistence) */
  restoreDlqEntry(queue: string, entry: DlqEntry): void {
    this.dlqManager.restoreEntry(queue, entry);
  }

  getDlqEntries(queue: string): DlqEntry[] {
    return this.dlqManager.getEntries(queue);
  }

  getDlq(queue: string, count?: number): Job[] {
    return this.dlqManager.getJobs(queue, count);
  }

  getDlqFiltered(queue: string, filter: DlqFilter): DlqEntry[] {
    return this.dlqManager.getFiltered(queue, filter);
  }

  removeFromDlq(queue: string, jobId: JobId): DlqEntry | null {
    return this.dlqManager.remove(queue, jobId);
  }

  getAutoRetryEntries(queue: string, now: number = Date.now()): DlqEntry[] {
    return this.dlqManager.getAutoRetryEntries(queue, now);
  }

  getExpiredEntries(queue: string, now: number = Date.now()): DlqEntry[] {
    return this.dlqManager.getExpiredEntries(queue, now);
  }

  purgeExpired(queue: string, now: number = Date.now()): number {
    return this.dlqManager.purgeExpired(queue, now);
  }

  clearDlq(queue: string): number {
    return this.dlqManager.clear(queue);
  }

  // ============ Queue Stats ============

  getWaitingCount(queue: string): number {
    return this.queues.get(queue)?.size ?? 0;
  }

  getDlqCount(queue: string): number {
    return this.dlqManager.getCount(queue);
  }

  getQueueNames(): string[] {
    const names = new Set<string>();
    for (const name of this.queues.keys()) names.add(name);
    for (const name of this.dlqManager.getQueueNames()) names.add(name);
    for (const name of this.limiterManager.getQueueNames()) names.add(name);
    return Array.from(names);
  }

  getCountsPerPriority(queue: string): Map<number, number> {
    const q = this.queues.get(queue);
    const counts = new Map<number, number>();
    if (!q) return counts;
    for (const job of q.values()) {
      const count = counts.get(job.priority) ?? 0;
      counts.set(job.priority, count + 1);
    }
    return counts;
  }

  // ============ Running Counters (O(1) Stats) ============

  getStats(): ShardStats {
    return { ...this.stats };
  }

  getInternalSizes(): {
    delayedJobIds: number;
    delayedHeap: number;
    delayedRunAt: number;
    temporalIndex: number;
    waiters: number;
  } {
    const sizes = this.temporalManager.getSizes();
    return { ...sizes, waiters: this.waiters.length };
  }

  incrementQueued(
    jobId: JobId,
    isDelayed: boolean,
    createdAt?: number,
    queue?: string,
    runAt?: number
  ): void {
    this.stats.queuedJobs++;
    if (isDelayed) {
      this.stats.delayedJobs++;
      if (runAt !== undefined) {
        this.temporalManager.addDelayed(jobId, runAt);
      }
    }
    if (createdAt !== undefined && queue !== undefined) {
      this.temporalManager.addToIndex(createdAt, jobId, queue);
    }
  }

  decrementQueued(jobId: JobId): void {
    this.stats.queuedJobs = Math.max(0, this.stats.queuedJobs - 1);
    if (this.temporalManager.removeDelayed(jobId)) {
      this.stats.delayedJobs = Math.max(0, this.stats.delayedJobs - 1);
    }
  }

  incrementDlq(): void {
    this.stats.dlqJobs++;
  }

  decrementDlq(count: number = 1): void {
    this.stats.dlqJobs = Math.max(0, this.stats.dlqJobs - count);
  }

  refreshDelayedCount(now: number): void {
    const readyCount = this.temporalManager.refreshDelayed(now);
    this.stats.delayedJobs = Math.max(0, this.stats.delayedJobs - readyCount);
  }

  resetQueuedCounters(): void {
    this.stats.queuedJobs = 0;
    this.stats.delayedJobs = 0;
    this.temporalManager.clearDelayed();
  }

  resetDlqCounter(): void {
    this.stats.dlqJobs = 0;
  }

  // ============ Temporal Index (delegated) ============

  getOldJobs(
    queue: string,
    thresholdMs: number,
    limit: number
  ): Array<{ jobId: JobId; createdAt: number }> {
    return this.temporalManager.getOldJobs(queue, thresholdMs, limit);
  }

  removeFromTemporalIndex(jobId: JobId): void {
    this.temporalManager.removeFromIndex(jobId);
  }

  clearTemporalIndexForQueue(queue: string): void {
    this.temporalManager.clearIndexForQueue(queue);
  }

  cleanOrphanedTemporalEntries(): number {
    if (this.temporalManager.indexSize === 0) return 0;

    const validJobIds = new Set<JobId>();
    for (const pq of this.queues.values()) {
      for (const job of pq.values()) {
        validJobIds.add(job.id);
      }
    }
    return this.temporalManager.cleanOrphaned(validJobIds);
  }

  // ============ Queue Lifecycle ============

  drain(queue: string): { count: number; jobIds: JobId[] } {
    const q = this.queues.get(queue);
    if (!q) return { count: 0, jobIds: [] };

    const count = q.size;
    const jobIds: JobId[] = [];
    for (const job of q.values()) {
      jobIds.push(job.id);
      this.temporalManager.removeDelayed(job.id);
    }
    q.clear();
    this.temporalManager.clearIndexForQueue(queue);
    this.stats.queuedJobs = Math.max(0, this.stats.queuedJobs - count);
    this.stats.delayedJobs = this.temporalManager.delayedCount;
    return { count, jobIds };
  }

  obliterate(queue: string): void {
    const q = this.queues.get(queue);
    if (q) {
      for (const job of q.values()) {
        this.temporalManager.removeDelayed(job.id);
      }
      this.stats.queuedJobs = Math.max(0, this.stats.queuedJobs - q.size);
    }

    const dlqCount = this.dlqManager.deleteQueue(queue);
    if (dlqCount > 0) {
      this.stats.dlqJobs = Math.max(0, this.stats.dlqJobs - dlqCount);
    }

    this.stats.delayedJobs = this.temporalManager.delayedCount;
    this.temporalManager.clearIndexForQueue(queue);

    this.queues.delete(queue);
    this.uniqueKeyManager.clearQueue(queue);
    this.limiterManager.deleteQueue(queue);
    this.activeGroups.delete(queue);
  }
}
