/**
 * Cron Scheduler
 * Manages scheduled jobs and executes them on time
 * Uses min-heap for O(k log n) tick instead of O(n) full scan
 */

import { type CronJob, type CronJobInput, createCronJob, isAtLimit } from '../../domain/types/cron';
import type { JobInput } from '../../domain/types/job';
import {
  validateCronExpression,
  getNextCronRun,
  getNextIntervalRun,
  expandCronShortcut,
} from './cronParser';
import { cronLog } from '../../shared/logger';
import { MinHeap } from '../../shared/minHeap';

/** Cron scheduler configuration */
export interface CronSchedulerConfig {
  checkIntervalMs?: number;
}

const DEFAULT_CONFIG: Required<CronSchedulerConfig> = {
  checkIntervalMs: 1000,
};

/** Push job callback type */
export type PushJobCallback = (queue: string, input: JobInput) => Promise<void>;

/** Heap entry with generation for lazy deletion */
interface CronHeapEntry {
  cron: CronJob;
  generation: number;
}

/**
 * Cron Scheduler
 * Periodically checks and executes due cron jobs
 * Optimized with min-heap for O(k log n) tick where k = due crons
 * Uses lazy deletion with generation numbers for O(1) remove
 */
export class CronScheduler {
  private readonly config: Required<CronSchedulerConfig>;
  /** Map for O(1) lookup by name with generation tracking */
  private readonly cronJobs = new Map<string, { cron: CronJob; generation: number }>();
  /** Min-heap ordered by nextRun for O(k log n) tick */
  private readonly cronHeap = new MinHeap<CronHeapEntry>((a, b) => a.cron.nextRun - b.cron.nextRun);
  /** Current generation counter */
  private generation = 0;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private pushJob: PushJobCallback | null = null;

  constructor(config: CronSchedulerConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set the push job callback
   */
  setPushCallback(callback: PushJobCallback): void {
    this.pushJob = callback;
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.checkInterval) return;

    this.checkInterval = setInterval(() => {
      void this.tick();
    }, this.config.checkIntervalMs);

    cronLog.info('Scheduler started');
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    cronLog.info('Scheduler stopped');
  }

  /**
   * Add a cron job
   */
  add(input: CronJobInput): CronJob {
    // Validate
    if (!input.schedule && !input.repeatEvery) {
      throw new Error('Cron job must have either schedule or repeatEvery');
    }

    if (input.schedule) {
      const expanded = expandCronShortcut(input.schedule);
      const error = validateCronExpression(expanded, input.timezone);
      if (error) {
        throw new Error(`Invalid cron expression: ${error}`);
      }
    }

    // Calculate next run
    const now = Date.now();
    let nextRun: number;

    if (input.schedule) {
      const expanded = expandCronShortcut(input.schedule);
      nextRun = getNextCronRun(expanded, now, input.timezone);
    } else {
      nextRun = getNextIntervalRun(input.repeatEvery!, now);
    }

    // Create cron job with generation tracking
    const cron = createCronJob(input, nextRun);
    const gen = this.generation++;
    this.cronJobs.set(cron.name, { cron, generation: gen });
    this.cronHeap.push({ cron, generation: gen });

    cronLog.info('Added job', { name: cron.name, nextRun: new Date(nextRun).toISOString() });

    return cron;
  }

  /**
   * Remove a cron job - O(1) with lazy deletion
   * The heap entry becomes stale and will be skipped in tick()
   */
  remove(name: string): boolean {
    const entry = this.cronJobs.get(name);
    if (!entry) return false;

    // Just remove from map - heap entry becomes stale (lazy deletion)
    this.cronJobs.delete(name);
    cronLog.info('Removed job', { name });
    return true;
  }

  /**
   * Get a cron job by name
   */
  get(name: string): CronJob | undefined {
    return this.cronJobs.get(name)?.cron;
  }

  /**
   * List all cron jobs
   */
  list(): CronJob[] {
    return Array.from(this.cronJobs.values()).map((e) => e.cron);
  }

  /**
   * Load cron jobs from storage
   */
  load(crons: CronJob[]): void {
    const entries: CronHeapEntry[] = [];
    for (const cron of crons) {
      const gen = this.generation++;
      this.cronJobs.set(cron.name, { cron, generation: gen });
      entries.push({ cron, generation: gen });
    }
    // Rebuild heap from loaded crons - O(n)
    this.cronHeap.buildFrom(entries);
    cronLog.info('Loaded jobs', { count: crons.length });
  }

  /**
   * Check and execute due cron jobs
   * O(k log n) where k = number of due crons, instead of O(n) full scan
   * Skips stale entries (lazy deletion) automatically
   */
  private async tick(): Promise<void> {
    if (!this.pushJob) return;

    const now = Date.now();
    const toReinsert: CronHeapEntry[] = [];
    const toRemove: string[] = [];

    // Process only due crons from heap - O(k log n)
    while (!this.cronHeap.isEmpty) {
      const entry = this.cronHeap.peek();
      if (!entry || entry.cron.nextRun > now) break;

      // Remove from heap
      this.cronHeap.pop();

      // Check if stale (cron was removed or updated)
      const current = this.cronJobs.get(entry.cron.name);
      if (current?.generation !== entry.generation) {
        // Stale entry, skip
        continue;
      }

      const cron = entry.cron;

      // Check if at limit
      if (isAtLimit(cron)) {
        cronLog.info('Job reached execution limit', { name: cron.name });
        toRemove.push(cron.name);
        continue;
      }

      try {
        // Push the job
        await this.pushJob(cron.queue, {
          data: cron.data,
          priority: cron.priority,
        });

        // Update execution count
        cron.executions++;

        // Calculate next run
        if (cron.schedule) {
          const expanded = expandCronShortcut(cron.schedule);
          cron.nextRun = getNextCronRun(expanded, now, cron.timezone ?? undefined);
        } else if (cron.repeatEvery) {
          cron.nextRun = getNextIntervalRun(cron.repeatEvery, now);
        }

        // Re-insert with same generation (not stale)
        toReinsert.push(entry);

        cronLog.info('Executed job', {
          name: cron.name,
          executions: cron.executions,
          nextRun: new Date(cron.nextRun).toISOString(),
        });
      } catch (err) {
        cronLog.error('Failed to execute job', { name: cron.name, error: String(err) });
        // Re-insert even on failure to retry next tick
        toReinsert.push(entry);
      }
    }

    // Re-insert processed crons with updated nextRun
    for (const entry of toReinsert) {
      this.cronHeap.push(entry);
    }

    // Remove limit-reached crons from map
    for (const name of toRemove) {
      this.cronJobs.delete(name);
    }
  }

  /**
   * Get scheduler stats
   * O(1) for nextRun using min-heap peek (skips stale entries)
   */
  getStats(): { total: number; pending: number; nextRun: number | null } {
    // Find first non-stale entry for nextRun
    let nextRun: number | null = null;

    // Peek and skip stale entries to find valid nextRun
    // This is typically O(1) as stale entries are cleaned during tick()
    const entry = this.cronHeap.peek();
    if (entry) {
      const current = this.cronJobs.get(entry.cron.name);
      if (current?.generation === entry.generation && !isAtLimit(entry.cron)) {
        nextRun = entry.cron.nextRun;
      }
    }

    // Count pending (crons not at limit) - still O(n) but called rarely
    let pending = 0;
    for (const { cron } of this.cronJobs.values()) {
      if (!isAtLimit(cron)) {
        pending++;
      }
    }

    return {
      total: this.cronJobs.size,
      pending,
      nextRun,
    };
  }
}
