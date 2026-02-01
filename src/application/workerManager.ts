/**
 * Worker Manager
 * Tracks connected workers and their status
 */

import { type Worker, type WorkerId, createWorker } from '../domain/types/worker';
import { createLogger } from '../shared/logger';

const workerLog = createLogger('Worker');

/** Worker timeout - consider dead after this many ms without heartbeat */
const WORKER_TIMEOUT_MS = parseInt(process.env.WORKER_TIMEOUT_MS ?? '30000', 10);

/** Cleanup interval for stale workers */
const WORKER_CLEANUP_INTERVAL_MS = parseInt(process.env.WORKER_CLEANUP_INTERVAL_MS ?? '60000', 10);

/**
 * Worker Manager
 */
export class WorkerManager {
  private readonly workers = new Map<WorkerId, Worker>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /** Running counters for O(1) stats - avoids O(n) reduce operations */
  private totalProcessedCounter = 0;
  private totalFailedCounter = 0;
  private totalActiveJobsCounter = 0;

  constructor() {
    this.startCleanup();
  }

  /** Register a new worker */
  register(name: string, queues: string[]): Worker {
    const worker = createWorker(name, queues);
    this.workers.set(worker.id, worker);
    workerLog.info('Registered worker', { workerId: worker.id, name, queues });
    return worker;
  }

  /** Unregister a worker */
  unregister(id: WorkerId): boolean {
    const worker = this.workers.get(id);
    if (worker) {
      // Adjust running counters before removal
      this.totalActiveJobsCounter -= worker.activeJobs;
    }
    const removed = this.workers.delete(id);
    if (removed) {
      workerLog.info('Unregistered worker', { workerId: id });
    }
    return removed;
  }

  /** Get worker by ID */
  get(id: WorkerId): Worker | undefined {
    return this.workers.get(id);
  }

  /** Update worker last seen time */
  heartbeat(id: WorkerId): boolean {
    const worker = this.workers.get(id);
    if (!worker) return false;
    worker.lastSeen = Date.now();
    return true;
  }

  /** Increment active jobs count */
  incrementActive(id: WorkerId): void {
    const worker = this.workers.get(id);
    if (worker) {
      worker.activeJobs++;
      this.totalActiveJobsCounter++;
      worker.lastSeen = Date.now();
    }
  }

  /** Decrement active jobs and increment processed */
  jobCompleted(id: WorkerId): void {
    const worker = this.workers.get(id);
    if (worker) {
      if (worker.activeJobs > 0) {
        worker.activeJobs--;
        this.totalActiveJobsCounter--;
      }
      worker.processedJobs++;
      this.totalProcessedCounter++;
      worker.lastSeen = Date.now();
    }
  }

  /** Decrement active jobs and increment failed */
  jobFailed(id: WorkerId): void {
    const worker = this.workers.get(id);
    if (worker) {
      if (worker.activeJobs > 0) {
        worker.activeJobs--;
        this.totalActiveJobsCounter--;
      }
      worker.failedJobs++;
      this.totalFailedCounter++;
      worker.lastSeen = Date.now();
    }
  }

  /** List all workers */
  list(): Worker[] {
    return Array.from(this.workers.values());
  }

  /** List active workers (seen recently) */
  listActive(): Worker[] {
    const now = Date.now();
    return Array.from(this.workers.values()).filter((w) => now - w.lastSeen < WORKER_TIMEOUT_MS);
  }

  /** Get workers for a specific queue */
  getForQueue(queue: string): Worker[] {
    return Array.from(this.workers.values()).filter((w) => w.queues.includes(queue));
  }

  /** Start cleanup interval */
  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupStale();
    }, WORKER_CLEANUP_INTERVAL_MS);
  }

  /** Remove stale workers */
  private cleanupStale(): void {
    const now = Date.now();
    const staleTimeout = WORKER_TIMEOUT_MS * 3; // Give extra time before removal

    for (const [id, worker] of this.workers) {
      if (now - worker.lastSeen > staleTimeout) {
        // Adjust running counters before removal
        this.totalActiveJobsCounter -= worker.activeJobs;
        this.workers.delete(id);
        workerLog.info('Removed stale worker', { workerId: id, name: worker.name });
      }
    }
  }

  /** Stop cleanup */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /** Get stats - O(n) only for active count, O(1) for other metrics */
  getStats() {
    const now = Date.now();
    let activeWorkers = 0;

    // Only iterate once for active count (time-based, can't use counter)
    for (const worker of this.workers.values()) {
      if (now - worker.lastSeen < WORKER_TIMEOUT_MS) {
        activeWorkers++;
      }
    }

    return {
      total: this.workers.size,
      active: activeWorkers,
      totalProcessed: this.totalProcessedCounter,
      totalFailed: this.totalFailedCounter,
      activeJobs: this.totalActiveJobsCounter,
    };
  }
}
