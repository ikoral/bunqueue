/**
 * Cron job domain types
 */

/** Deduplication config for cron-spawned jobs */
export interface CronDedup {
  readonly ttl?: number;
  readonly extend?: boolean;
  readonly replace?: boolean;
}

/** Cron job definition */
export interface CronJob {
  readonly name: string;
  readonly queue: string;
  readonly data: unknown;
  readonly schedule: string | null;
  readonly repeatEvery: number | null;
  readonly priority: number;
  /** IANA timezone for cron schedule (e.g., "Europe/Rome", "America/New_York") */
  readonly timezone: string | null;
  nextRun: number;
  executions: number;
  readonly maxLimit: number | null;
  /** Unique key for deduplication of cron-spawned jobs */
  readonly uniqueKey: string | null;
  /** Deduplication options for cron-spawned jobs */
  readonly dedup: CronDedup | null;
}

/** Input for creating a cron job */
export interface CronJobInput {
  name: string;
  queue: string;
  data: unknown;
  schedule?: string;
  repeatEvery?: number;
  priority?: number;
  maxLimit?: number;
  /** IANA timezone for cron schedule (e.g., "Europe/Rome", "America/New_York") */
  timezone?: string;
  /** Unique key for deduplication of cron-spawned jobs */
  uniqueKey?: string;
  /** Deduplication options for cron-spawned jobs */
  dedup?: CronDedup;
}

/** Create a new cron job */
export function createCronJob(input: CronJobInput, nextRun: number): CronJob {
  if (!input.schedule && !input.repeatEvery) {
    throw new Error('Cron job must have either schedule or repeatEvery');
  }

  return {
    name: input.name,
    queue: input.queue,
    data: input.data,
    schedule: input.schedule ?? null,
    repeatEvery: input.repeatEvery ?? null,
    priority: input.priority ?? 0,
    timezone: input.timezone ?? null,
    nextRun,
    executions: 0,
    maxLimit: input.maxLimit ?? null,
    uniqueKey: input.uniqueKey ?? null,
    dedup: input.dedup ?? null,
  };
}

/** Check if cron job has reached its execution limit */
export function isAtLimit(cron: CronJob): boolean {
  if (cron.maxLimit === null) return false;
  return cron.executions >= cron.maxLimit;
}

/** Check if cron job is due to run */
export function isDue(cron: CronJob, now: number = Date.now()): boolean {
  return cron.nextRun <= now && !isAtLimit(cron);
}
