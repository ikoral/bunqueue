/**
 * Task Error Tracking - Circuit breaker for background tasks
 * Extracted for reuse by both backgroundTasks.ts and queueManager.ts
 */

import { queueLog } from '../shared/logger';

/** Maximum consecutive failures before critical warning */
const MAX_CONSECUTIVE_FAILURES = 5;

/** Track consecutive failures per task type */
export interface TaskErrorState {
  consecutiveFailures: number;
  lastError?: string;
  lastFailureAt?: number;
}

const taskErrors: Record<string, TaskErrorState> = {
  cleanup: { consecutiveFailures: 0 },
  dependency: { consecutiveFailures: 0 },
  lockExpiration: { consecutiveFailures: 0 },
};

/**
 * Handle task error with tracking and circuit breaker pattern
 */
export function handleTaskError(taskName: string, err: unknown): void {
  const state = taskErrors[taskName];
  if (!state) return;

  state.consecutiveFailures++;
  state.lastError = String(err);
  state.lastFailureAt = Date.now();

  queueLog.error(`${taskName} task failed`, {
    error: state.lastError,
    consecutiveFailures: state.consecutiveFailures,
    willRetry: state.consecutiveFailures < MAX_CONSECUTIVE_FAILURES,
  });

  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    queueLog.error(`CRITICAL: Background ${taskName} repeatedly failing`, {
      consecutiveFailures: state.consecutiveFailures,
      lastError: state.lastError,
    });
  }
}

/**
 * Reset error state on successful task completion
 */
export function handleTaskSuccess(taskName: string): void {
  const state = taskErrors[taskName];
  if (state) {
    state.consecutiveFailures = 0;
  }
}

/**
 * Get error statistics for monitoring
 */
export function getTaskErrorStats(): Record<string, TaskErrorState> {
  return { ...taskErrors };
}
