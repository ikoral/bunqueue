/**
 * DLQ Command Handlers
 * Dlq, RetryDlq, PurgeDlq
 */

import type { Command } from '../../../domain/types/command';
import type { Response } from '../../../domain/types/response';
import * as resp from '../../../domain/types/response';
import { jobId } from '../../../domain/types/job';
import type { HandlerContext } from '../types';

/** Handle Dlq command - get DLQ jobs */
export function handleDlq(
  cmd: Extract<Command, { cmd: 'Dlq' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  const jobs = ctx.queueManager.getDlq(cmd.queue, cmd.count);
  return resp.jobs(jobs, reqId);
}

/** Handle RetryDlq command - retry DLQ jobs */
export function handleRetryDlq(
  cmd: Extract<Command, { cmd: 'RetryDlq' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  const jid = cmd.jobId ? jobId(cmd.jobId) : undefined;
  const count = ctx.queueManager.retryDlq(cmd.queue, jid);
  return {
    ok: true,
    count,
    reqId,
  } as Response;
}

/** Handle PurgeDlq command - clear DLQ */
export function handlePurgeDlq(
  cmd: Extract<Command, { cmd: 'PurgeDlq' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  const count = ctx.queueManager.purgeDlq(cmd.queue);
  return {
    ok: true,
    count,
    reqId,
  } as Response;
}
