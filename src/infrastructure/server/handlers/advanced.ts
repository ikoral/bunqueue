/**
 * Advanced Command Handlers
 * Job management, queue control, rate limiting
 */

import type { Command } from '../../../domain/types/command';
import type { Response } from '../../../domain/types/response';
import * as resp from '../../../domain/types/response';
import { jobId } from '../../../domain/types/job';
import type { HandlerContext } from '../types';

// ============ Job Management ============

/** Handle Update command - update job data */
export async function handleUpdate(
  cmd: Extract<Command, { cmd: 'Update' }>,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const success = await ctx.queueManager.updateJobData(jobId(cmd.id), cmd.data);
  if (success) ctx.queueManager.emitDashboardEvent('job:data-updated', { jobId: cmd.id });
  return success
    ? resp.ok(undefined, reqId)
    : resp.error('Job not found or cannot be updated', reqId);
}

/** Handle ChangePriority command */
export async function handleChangePriority(
  cmd: Extract<Command, { cmd: 'ChangePriority' }>,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const success = await ctx.queueManager.changePriority(jobId(cmd.id), cmd.priority);
  if (success) {
    ctx.queueManager.emitDashboardEvent('job:priority-changed', {
      jobId: cmd.id,
      newPriority: cmd.priority,
    });
  }
  return success ? resp.ok(undefined, reqId) : resp.error('Job not found or not in queue', reqId);
}

/** Handle Promote command - move delayed to waiting */
export async function handlePromote(
  cmd: Extract<Command, { cmd: 'Promote' }>,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const success = await ctx.queueManager.promote(jobId(cmd.id));
  if (success) ctx.queueManager.emitDashboardEvent('job:promoted', { jobId: cmd.id });
  return success ? resp.ok(undefined, reqId) : resp.error('Job not found or not delayed', reqId);
}

/** Handle MoveToDelayed command */
export async function handleMoveToDelayed(
  cmd: Extract<Command, { cmd: 'MoveToDelayed' }>,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const success = await ctx.queueManager.moveToDelayed(jobId(cmd.id), cmd.delay);
  if (success) {
    ctx.queueManager.emitDashboardEvent('job:moved-to-delayed', {
      jobId: cmd.id,
      delay: cmd.delay,
    });
  }
  return success ? resp.ok(undefined, reqId) : resp.error('Job not found or not active', reqId);
}

/** Handle Discard command - move to DLQ */
export async function handleDiscard(
  cmd: Extract<Command, { cmd: 'Discard' }>,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const success = await ctx.queueManager.discard(jobId(cmd.id));
  if (success) ctx.queueManager.emitDashboardEvent('job:discarded', { jobId: cmd.id });
  return success ? resp.ok(undefined, reqId) : resp.error('Job not found', reqId);
}

/** Handle WaitJob command - wait for job completion (event-driven, no polling) */
export async function handleWaitJob(
  cmd: Extract<Command, { cmd: 'WaitJob' }>,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const jid = jobId(cmd.id);
  const timeout = cmd.timeout ?? 30000;

  // First check if job exists and is already completed
  const job = await ctx.queueManager.getJob(jid);
  if (!job) return resp.error('Job not found', reqId);
  if (job.completedAt) {
    const result = ctx.queueManager.getResult(jid);
    return { ok: true, completed: true, result, reqId } as Response;
  }

  // Wait for completion event - event-driven, no polling
  const completed = await ctx.queueManager.waitForJobCompletion(jid, timeout);

  if (completed) {
    const result = ctx.queueManager.getResult(jid);
    return { ok: true, completed: true, result, reqId } as Response;
  }

  return { ok: true, completed: false, reqId } as Response;
}

// ============ Queue Control ============

/** Handle IsPaused command */
export function handleIsPaused(
  cmd: Extract<Command, { cmd: 'IsPaused' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  const paused = ctx.queueManager.isPaused(cmd.queue);
  return { ok: true, paused, reqId } as Response;
}

/** Handle Obliterate command */
export function handleObliterate(
  cmd: Extract<Command, { cmd: 'Obliterate' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  ctx.queueManager.obliterate(cmd.queue);
  return resp.ok(undefined, reqId);
}

/** Handle ListQueues command */
export function handleListQueues(
  _cmd: Extract<Command, { cmd: 'ListQueues' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  const queues = ctx.queueManager.listQueues();
  return { ok: true, queues, reqId } as Response;
}

/** Handle Clean command */
export function handleClean(
  cmd: Extract<Command, { cmd: 'Clean' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  const count = ctx.queueManager.clean(cmd.queue, cmd.grace, cmd.state, cmd.limit);
  if (count > 0) {
    ctx.queueManager.emitDashboardEvent('queue:cleaned', {
      queue: cmd.queue,
      state: cmd.state,
      count,
    });
  }
  return { ok: true, count, reqId } as Response;
}

/** Handle Count command */
export function handleCount(
  cmd: Extract<Command, { cmd: 'Count' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  const count = ctx.queueManager.count(cmd.queue);
  return { ok: true, count, reqId } as Response;
}

// ============ Rate Limiting ============

/** Handle RateLimit command */
export function handleRateLimit(
  cmd: Extract<Command, { cmd: 'RateLimit' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  ctx.queueManager.setRateLimit(cmd.queue, cmd.limit);
  ctx.queueManager.emitDashboardEvent('ratelimit:set', { queue: cmd.queue, max: cmd.limit });
  return resp.ok(undefined, reqId);
}

/** Handle RateLimitClear command */
export function handleRateLimitClear(
  cmd: Extract<Command, { cmd: 'RateLimitClear' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  ctx.queueManager.clearRateLimit(cmd.queue);
  ctx.queueManager.emitDashboardEvent('ratelimit:cleared', { queue: cmd.queue });
  return resp.ok(undefined, reqId);
}

/** Handle SetConcurrency command */
export function handleSetConcurrency(
  cmd: Extract<Command, { cmd: 'SetConcurrency' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  ctx.queueManager.setConcurrency(cmd.queue, cmd.limit);
  ctx.queueManager.emitDashboardEvent('concurrency:set', {
    queue: cmd.queue,
    concurrency: cmd.limit,
  });
  return resp.ok(undefined, reqId);
}

/** Handle ClearConcurrency command */
export function handleClearConcurrency(
  cmd: Extract<Command, { cmd: 'ClearConcurrency' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  ctx.queueManager.clearConcurrency(cmd.queue);
  ctx.queueManager.emitDashboardEvent('concurrency:cleared', { queue: cmd.queue });
  return resp.ok(undefined, reqId);
}

// ============ Config Commands ============

/** Handle SetStallConfig command */
export function handleSetStallConfig(
  cmd: Extract<Command, { cmd: 'SetStallConfig' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  ctx.queueManager.setStallConfig(cmd.queue, cmd.config);
  ctx.queueManager.emitDashboardEvent('config:stall-changed', {
    queue: cmd.queue,
    config: cmd.config,
  });
  return resp.ok(undefined, reqId);
}

/** Handle GetStallConfig command */
export function handleGetStallConfig(
  cmd: Extract<Command, { cmd: 'GetStallConfig' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  const config = ctx.queueManager.getStallConfig(cmd.queue);
  return { ok: true, config, reqId } as Response;
}

/** Handle SetDlqConfig command */
export function handleSetDlqConfig(
  cmd: Extract<Command, { cmd: 'SetDlqConfig' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  ctx.queueManager.setDlqConfig(cmd.queue, cmd.config);
  ctx.queueManager.emitDashboardEvent('config:dlq-changed', {
    queue: cmd.queue,
    config: cmd.config,
  });
  return resp.ok(undefined, reqId);
}

/** Handle GetDlqConfig command */
export function handleGetDlqConfig(
  cmd: Extract<Command, { cmd: 'GetDlqConfig' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  const config = ctx.queueManager.getDlqConfig(cmd.queue);
  return { ok: true, config, reqId } as Response;
}

/** Handle ChangeDelay command - change delay for a delayed/active job */
export async function handleChangeDelay(
  cmd: Extract<Command, { cmd: 'ChangeDelay' }>,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const success = await ctx.queueManager.changeDelay(jobId(cmd.id), cmd.delay);
  if (success) {
    ctx.queueManager.emitDashboardEvent('job:delay-changed', {
      jobId: cmd.id,
      newDelay: cmd.delay,
    });
  }
  return success
    ? resp.ok(undefined, reqId)
    : resp.error('Job not found or cannot change delay', reqId);
}

/** Handle MoveToWait command - promote a delayed job to waiting */
export async function handleMoveToWait(
  cmd: Extract<Command, { cmd: 'MoveToWait' }>,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const success = await ctx.queueManager.promote(jobId(cmd.id));
  return success ? resp.ok(undefined, reqId) : resp.error('Job not found or not delayed', reqId);
}

/** Handle PromoteJobs command - promote all delayed jobs in a queue */
export async function handlePromoteJobs(
  cmd: Extract<Command, { cmd: 'PromoteJobs' }>,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const delayed = ctx.queueManager.getJobs(cmd.queue, { state: 'delayed' });
  const limit = cmd.count ?? delayed.length;
  let count = 0;
  for (let i = 0; i < Math.min(limit, delayed.length); i++) {
    const success = await ctx.queueManager.promote(delayed[i].id);
    if (success) count++;
  }
  return { ok: true, count, reqId } as Response;
}
