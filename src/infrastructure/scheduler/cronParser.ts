/**
 * Cron Expression Parser
 * Parses 5-6 field cron expressions and calculates next run time
 */

import { Cron } from 'croner';

/**
 * Validate a cron expression
 * @param expression - Cron expression (5 or 6 fields)
 * @param timezone - Optional IANA timezone (e.g., "Europe/Rome")
 * @returns null if valid, error message if invalid
 */
export function validateCronExpression(expression: string, timezone?: string): string | null {
  try {
    new Cron(expression, { timezone });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid cron expression';
  }
}

/**
 * Calculate next run time from a cron expression
 * @param expression - Cron expression
 * @param fromTime - Start time (default: now)
 * @param timezone - Optional IANA timezone (e.g., "Europe/Rome", "America/New_York")
 * @returns Next run timestamp in milliseconds
 */
export function getNextCronRun(
  expression: string,
  fromTime: number = Date.now(),
  timezone?: string
): number {
  const cron = new Cron(expression, { timezone });
  const nextDate = cron.nextRun(new Date(fromTime));
  return nextDate ? nextDate.getTime() : 0;
}

/**
 * Calculate next run time from repeatEvery interval
 * @param intervalMs - Interval in milliseconds
 * @param lastRun - Last run timestamp
 * @returns Next run timestamp
 */
export function getNextIntervalRun(intervalMs: number, lastRun: number = Date.now()): number {
  return lastRun + intervalMs;
}

/**
 * Check if a cron job is due to run
 * @param nextRun - Scheduled next run time
 * @param now - Current time (default: Date.now())
 * @returns true if job should run
 */
export function isDue(nextRun: number, now: number = Date.now()): boolean {
  return nextRun <= now;
}

/**
 * Parse common cron shortcuts
 */
export const CRON_SHORTCUTS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

/**
 * Expand cron shortcut to full expression
 */
export function expandCronShortcut(expression: string): string {
  const trimmed = expression.trim().toLowerCase();
  return CRON_SHORTCUTS[trimmed] ?? expression;
}

/**
 * Get human-readable description of cron schedule
 */
export function describeCron(expression: string): string {
  const expanded = expandCronShortcut(expression);
  const parts = expanded.split(/\s+/);

  if (parts.length < 5) {
    return 'Invalid cron expression';
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Common patterns
  if (minute === '0' && hour === '0' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 'Every day at midnight';
  }
  if (minute === '0' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 'Every hour';
  }
  if (minute === '*' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 'Every minute';
  }

  return `At ${minute} ${hour} on day ${dayOfMonth} of ${month}, day of week ${dayOfWeek}`;
}
