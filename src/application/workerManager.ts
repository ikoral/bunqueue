/**
 * Worker Manager
 * Tracks connected workers and their status
 */

import { type Worker, type WorkerId, createWorker } from '../domain/types/worker';
import { createLogger } from '../shared/logger';

const workerLog = createLogger('Worker');

/** Worker timeout - consider dead after this many ms without heartbeat */
const WORKER_TIMEOUT_MS = 30_000;

/**
 * Worker Manager
 */
export class WorkerManager {
  private workers = new Map<WorkerId, Worker>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

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
      worker.lastSeen = Date.now();
    }
  }

  /** Decrement active jobs and increment processed */
  jobCompleted(id: WorkerId): void {
    const worker = this.workers.get(id);
    if (worker) {
      worker.activeJobs = Math.max(0, worker.activeJobs - 1);
      worker.processedJobs++;
      worker.lastSeen = Date.now();
    }
  }

  /** Decrement active jobs and increment failed */
  jobFailed(id: WorkerId): void {
    const worker = this.workers.get(id);
    if (worker) {
      worker.activeJobs = Math.max(0, worker.activeJobs - 1);
      worker.failedJobs++;
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
    }, 60_000);
  }

  /** Remove stale workers */
  private cleanupStale(): void {
    const now = Date.now();
    const staleTimeout = WORKER_TIMEOUT_MS * 3; // Give extra time before removal

    for (const [id, worker] of this.workers) {
      if (now - worker.lastSeen > staleTimeout) {
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

  /** Get stats */
  getStats() {
    const workers = Array.from(this.workers.values());
    const now = Date.now();
    const active = workers.filter((w) => now - w.lastSeen < WORKER_TIMEOUT_MS);

    return {
      total: workers.length,
      active: active.length,
      totalProcessed: workers.reduce((sum, w) => sum + w.processedJobs, 0),
      totalFailed: workers.reduce((sum, w) => sum + w.failedJobs, 0),
      activeJobs: workers.reduce((sum, w) => sum + w.activeJobs, 0),
    };
  }
}
