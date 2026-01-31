/**
 * Command Handler Router
 * Routes commands to appropriate handlers
 */

import type { Command } from '../../domain/types/command';
import type { Response } from '../../domain/types/response';
import * as resp from '../../domain/types/response';
import { constantTimeEqual } from '../../shared/hash';
import type { HandlerContext } from './types';

// Import handlers
import {
  handlePush,
  handlePushBatch,
  handlePull,
  handlePullBatch,
  handleAck,
  handleAckBatch,
  handleFail,
} from './handlers/core';

import {
  handleGetJob,
  handleGetState,
  handleGetResult,
  handleGetJobCounts,
  handleGetCountsPerPriority,
  handleGetJobByCustomId,
  handleGetJobs,
} from './handlers/query';

import {
  handleCancel,
  handleProgress,
  handleGetProgress,
  handlePause,
  handleResume,
  handleDrain,
  handleStats,
  handleMetrics,
} from './handlers/management';

import { handleDlq, handleRetryDlq, handlePurgeDlq, handleRetryCompleted } from './handlers/dlq';

import { handleCron, handleCronDelete, handleCronList } from './handlers/cron';

import {
  handleUpdate,
  handleChangePriority,
  handlePromote,
  handleMoveToDelayed,
  handleDiscard,
  handleWaitJob,
  handleIsPaused,
  handleObliterate,
  handleListQueues,
  handleClean,
  handleCount,
  handleRateLimit,
  handleRateLimitClear,
  handleSetConcurrency,
  handleClearConcurrency,
} from './handlers/advanced';

import {
  handleAddLog,
  handleGetLogs,
  handleHeartbeat,
  handleJobHeartbeat,
  handleJobHeartbeatBatch,
  handlePing,
  handleRegisterWorker,
  handleUnregisterWorker,
  handleListWorkers,
  handleAddWebhook,
  handleRemoveWebhook,
  handleListWebhooks,
  handlePrometheus,
} from './handlers/monitoring';

// Re-export types
export type { HandlerContext } from './types';

/**
 * Handle authentication command
 */
function handleAuth(
  cmd: Extract<Command, { cmd: 'Auth' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  for (const token of ctx.authTokens) {
    if (constantTimeEqual(cmd.token, token)) {
      ctx.authenticated = true;
      return resp.ok(undefined, reqId);
    }
  }
  return resp.error('Invalid token', reqId);
}

/** Route core commands (PUSH, PULL, ACK, FAIL) */
async function routeCoreCommand(
  cmd: Command,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response | null> {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (cmd.cmd) {
    case 'PUSH':
      return handlePush(cmd, ctx, reqId);
    case 'PUSHB':
      return handlePushBatch(cmd, ctx, reqId);
    case 'PULL':
      return handlePull(cmd, ctx, reqId);
    case 'PULLB':
      return handlePullBatch(cmd, ctx, reqId);
    case 'ACK':
      return handleAck(cmd, ctx, reqId);
    case 'ACKB':
      return handleAckBatch(cmd, ctx, reqId);
    case 'FAIL':
      return handleFail(cmd, ctx, reqId);
    default:
      return null;
  }
}

/** Route query commands */
async function routeQueryCommand(
  cmd: Command,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response | null> {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (cmd.cmd) {
    case 'GetJob':
      return handleGetJob(cmd, ctx, reqId);
    case 'GetState':
      return handleGetState(cmd, ctx, reqId);
    case 'GetResult':
      return handleGetResult(cmd, ctx, reqId);
    case 'GetJobCounts':
      return handleGetJobCounts(cmd, ctx, reqId);
    case 'GetCountsPerPriority':
      return handleGetCountsPerPriority(cmd, ctx, reqId);
    case 'GetJobByCustomId':
      return handleGetJobByCustomId(cmd, ctx, reqId);
    case 'GetJobs':
      return handleGetJobs(cmd, ctx, reqId);
    case 'Count':
      return handleCount(cmd, ctx, reqId);
    case 'GetProgress':
      return handleGetProgress(cmd, ctx, reqId);
    default:
      return null;
  }
}

/** Route management commands */
async function routeManagementCommand(
  cmd: Command,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response | null> {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (cmd.cmd) {
    case 'Cancel':
      return handleCancel(cmd, ctx, reqId);
    case 'Progress':
      return handleProgress(cmd, ctx, reqId);
    case 'Update':
      return handleUpdate(cmd, ctx, reqId);
    case 'ChangePriority':
      return handleChangePriority(cmd, ctx, reqId);
    case 'Promote':
      return handlePromote(cmd, ctx, reqId);
    case 'MoveToDelayed':
      return handleMoveToDelayed(cmd, ctx, reqId);
    case 'Discard':
      return handleDiscard(cmd, ctx, reqId);
    case 'WaitJob':
      return handleWaitJob(cmd, ctx, reqId);
    default:
      return null;
  }
}

/** Route queue control commands */
function routeQueueControlCommand(
  cmd: Command,
  ctx: HandlerContext,
  reqId?: string
): Response | null {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (cmd.cmd) {
    case 'Pause':
      return handlePause(cmd, ctx, reqId);
    case 'Resume':
      return handleResume(cmd, ctx, reqId);
    case 'IsPaused':
      return handleIsPaused(cmd, ctx, reqId);
    case 'Drain':
      return handleDrain(cmd, ctx, reqId);
    case 'Obliterate':
      return handleObliterate(cmd, ctx, reqId);
    case 'ListQueues':
      return handleListQueues(cmd, ctx, reqId);
    case 'Clean':
      return handleClean(cmd, ctx, reqId);
    default:
      return null;
  }
}

/** Route DLQ commands */
function routeDlqCommand(cmd: Command, ctx: HandlerContext, reqId?: string): Response | null {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (cmd.cmd) {
    case 'Dlq':
      return handleDlq(cmd, ctx, reqId);
    case 'RetryDlq':
      return handleRetryDlq(cmd, ctx, reqId);
    case 'PurgeDlq':
      return handlePurgeDlq(cmd, ctx, reqId);
    case 'RetryCompleted':
      return handleRetryCompleted(cmd, ctx, reqId);
    default:
      return null;
  }
}

/** Route rate limit commands */
function routeRateLimitCommand(cmd: Command, ctx: HandlerContext, reqId?: string): Response | null {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (cmd.cmd) {
    case 'RateLimit':
      return handleRateLimit(cmd, ctx, reqId);
    case 'RateLimitClear':
      return handleRateLimitClear(cmd, ctx, reqId);
    case 'SetConcurrency':
      return handleSetConcurrency(cmd, ctx, reqId);
    case 'ClearConcurrency':
      return handleClearConcurrency(cmd, ctx, reqId);
    default:
      return null;
  }
}

/** Route cron commands */
function routeCronCommand(cmd: Command, ctx: HandlerContext, reqId?: string): Response | null {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (cmd.cmd) {
    case 'Cron':
      return handleCron(cmd, ctx, reqId);
    case 'CronDelete':
      return handleCronDelete(cmd, ctx, reqId);
    case 'CronList':
      return handleCronList(cmd, ctx, reqId);
    default:
      return null;
  }
}

/** Route monitoring commands */
function routeMonitoringCommand(
  cmd: Command,
  ctx: HandlerContext,
  reqId?: string
): Response | null {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (cmd.cmd) {
    case 'Stats':
      return handleStats(ctx, reqId);
    case 'Metrics':
      return handleMetrics(ctx, reqId);
    case 'Prometheus':
      return handlePrometheus(cmd, ctx, reqId);
    case 'AddLog':
      return handleAddLog(cmd, ctx, reqId);
    case 'GetLogs':
      return handleGetLogs(cmd, ctx, reqId);
    case 'Heartbeat':
      return handleHeartbeat(cmd, ctx, reqId);
    case 'JobHeartbeat':
      return handleJobHeartbeat(cmd, ctx, reqId);
    case 'JobHeartbeatB':
      return handleJobHeartbeatBatch(cmd, ctx, reqId);
    case 'Ping':
      return handlePing(cmd, ctx, reqId);
    case 'RegisterWorker':
      return handleRegisterWorker(cmd, ctx, reqId);
    case 'UnregisterWorker':
      return handleUnregisterWorker(cmd, ctx, reqId);
    case 'ListWorkers':
      return handleListWorkers(cmd, ctx, reqId);
    case 'AddWebhook':
      return handleAddWebhook(cmd, ctx, reqId);
    case 'RemoveWebhook':
      return handleRemoveWebhook(cmd, ctx, reqId);
    case 'ListWebhooks':
      return handleListWebhooks(cmd, ctx, reqId);
    default:
      return null;
  }
}

/**
 * Main command handler - routes to specific handlers
 */
export async function handleCommand(cmd: Command, ctx: HandlerContext): Promise<Response> {
  const reqId = cmd.reqId;

  try {
    // Auth command is always allowed
    if (cmd.cmd === 'Auth') {
      return handleAuth(cmd, ctx, reqId);
    }

    // Check authentication if tokens are configured
    if (ctx.authTokens.size > 0 && !ctx.authenticated) {
      return resp.error('Not authenticated', reqId);
    }

    // Route through command groups
    let result: Response | null;

    result = await routeCoreCommand(cmd, ctx, reqId);
    if (result) return result;

    result = await routeQueryCommand(cmd, ctx, reqId);
    if (result) return result;

    result = await routeManagementCommand(cmd, ctx, reqId);
    if (result) return result;

    result = routeQueueControlCommand(cmd, ctx, reqId);
    if (result) return result;

    result = routeDlqCommand(cmd, ctx, reqId);
    if (result) return result;

    result = routeRateLimitCommand(cmd, ctx, reqId);
    if (result) return result;

    result = routeCronCommand(cmd, ctx, reqId);
    if (result) return result;

    result = routeMonitoringCommand(cmd, ctx, reqId);
    if (result) return result;

    return resp.error(`Unknown command: ${cmd.cmd}`, reqId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return resp.error(message, reqId);
  }
}
