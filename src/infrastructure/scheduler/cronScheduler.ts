/**
 * Cron Scheduler
 * Manages scheduled jobs and executes them on time
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
 */
export class CronScheduler {
  private readonly config: Required<CronSchedulerConfig>;
  private readonly cronJobs = new Map<string, CronJob>();
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

    cronLog.info('Added job', { name: cron.name, nextRun: new Date(nextRun).toISOString() });

    return cron;
  }

  /**
   * Remove a cron job
   */
  remove(name: string): boolean {
    const deleted = this.cronJobs.delete(name);
    if (deleted) {
      cronLog.info('Removed job', { name });
    }
    return deleted;
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
    cronLog.info('Loaded jobs', { count: crons.length });
  }

  /**
   * Check and execute due cron jobs
   */
  private async tick(): Promise<void> {
    if (!this.pushJob) return;

    const now = Date.now();

    for (const [name, cron] of this.cronJobs) {
      // Skip if not due
      if (cron.nextRun > now) continue;

      // Skip if at limit
      if (isAtLimit(cron)) {
        cronLog.info('Job reached execution limit', { name });
        this.cronJobs.delete(name);
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

        cronLog.info('Executed job', {
          name,
          executions: cron.executions,
          nextRun: new Date(cron.nextRun).toISOString(),
        });
      } catch (err) {
        cronLog.error('Failed to execute job', { name, error: String(err) });
      }
    }
  }

  /**
   * Get scheduler stats
   */
  getStats(): { total: number; pending: number; nextRun: number | null } {
    let nextRun: number | null = null;
    let pending = 0;

    for (const cron of this.cronJobs.values()) {
      if (!isAtLimit(cron)) {
        pending++;
        if (nextRun === null || cron.nextRun < nextRun) {
          nextRun = cron.nextRun;
        }
      }
    }

    return {
      total: this.cronJobs.size,
      pending,
      nextRun,
    };
  }
}
