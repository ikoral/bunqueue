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

/**
 * Cron Scheduler
 * Periodically checks and executes due cron jobs
 * Optimized with min-heap for O(k log n) tick where k = due crons
 */
export class CronScheduler {
  private readonly config: Required<CronSchedulerConfig>;
  /** Map for O(1) lookup by name */
  private readonly cronJobs = new Map<string, CronJob>();
  /** Min-heap ordered by nextRun for O(k log n) tick */
  private readonly cronHeap = new MinHeap<CronJob>((a, b) => a.nextRun - b.nextRun);
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
      const error = validateCronExpression(expanded);
      if (error) {
        throw new Error(`Invalid cron expression: ${error}`);
      }
    }

    // Calculate next run
    const now = Date.now();
    let nextRun: number;

    if (input.schedule) {
      const expanded = expandCronShortcut(input.schedule);
      nextRun = getNextCronRun(expanded, now);
    } else {
      nextRun = getNextIntervalRun(input.repeatEvery!, now);
    }

    // Create cron job
    const cron = createCronJob(input, nextRun);
    this.cronJobs.set(cron.name, cron);
    this.cronHeap.push(cron);

    cronLog.info('Added job', { name: cron.name, nextRun: new Date(nextRun).toISOString() });

    return cron;
  }

  /**
   * Remove a cron job
   */
  remove(name: string): boolean {
    const cron = this.cronJobs.get(name);
    if (!cron) return false;

    this.cronJobs.delete(name);
    // Remove from heap - O(n) but rare operation
    this.cronHeap.removeWhere((c) => c.name === name);
    cronLog.info('Removed job', { name });
    return true;
  }

  /**
   * Get a cron job by name
   */
  get(name: string): CronJob | undefined {
    return this.cronJobs.get(name);
  }

  /**
   * List all cron jobs
   */
  list(): CronJob[] {
    return Array.from(this.cronJobs.values());
  }

  /**
   * Load cron jobs from storage
   */
  load(crons: CronJob[]): void {
    for (const cron of crons) {
      this.cronJobs.set(cron.name, cron);
    }
    // Rebuild heap from loaded crons - O(n)
    this.cronHeap.buildFrom(crons);
    cronLog.info('Loaded jobs', { count: crons.length });
  }

  /**
   * Check and execute due cron jobs
   * O(k log n) where k = number of due crons, instead of O(n) full scan
   */
  private async tick(): Promise<void> {
    if (!this.pushJob) return;

    const now = Date.now();
    const toReinsert: CronJob[] = [];
    const toRemove: string[] = [];

    // Process only due crons from heap - O(k log n)
    while (!this.cronHeap.isEmpty) {
      const cron = this.cronHeap.peek();
      if (!cron || cron.nextRun > now) break;

      // Remove from heap
      this.cronHeap.pop();

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
          cron.nextRun = getNextCronRun(expanded, now);
        } else if (cron.repeatEvery) {
          cron.nextRun = getNextIntervalRun(cron.repeatEvery, now);
        }

        // Re-insert with new nextRun
        toReinsert.push(cron);

        cronLog.info('Executed job', {
          name: cron.name,
          executions: cron.executions,
          nextRun: new Date(cron.nextRun).toISOString(),
        });
      } catch (err) {
        cronLog.error('Failed to execute job', { name: cron.name, error: String(err) });
        // Re-insert even on failure to retry next tick
        toReinsert.push(cron);
      }
    }

    // Re-insert processed crons with updated nextRun
    for (const cron of toReinsert) {
      this.cronHeap.push(cron);
    }

    // Remove limit-reached crons from map
    for (const name of toRemove) {
      this.cronJobs.delete(name);
    }
  }

  /**
   * Get scheduler stats
   * O(1) for nextRun using min-heap peek
   */
  getStats(): { total: number; pending: number; nextRun: number | null } {
    // Use heap peek for O(1) nextRun instead of O(n) scan
    const nextCron = this.cronHeap.peek();
    const nextRun = nextCron && !isAtLimit(nextCron) ? nextCron.nextRun : null;

    // Count pending (crons not at limit) - still O(n) but called rarely
    let pending = 0;
    for (const cron of this.cronJobs.values()) {
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
