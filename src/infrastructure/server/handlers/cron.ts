/**
 * Cron Command Handlers
 * Cron, CronDelete, CronList
 */

import type { Command } from '../../../domain/types/command';
import type { Response } from '../../../domain/types/response';
import * as resp from '../../../domain/types/response';
import type { HandlerContext } from '../types';

/** Handle Cron command - add cron job */
export function handleCron(
  cmd: Extract<Command, { cmd: 'Cron' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  try {
    const cron = ctx.queueManager.addCron({
      name: cmd.name,
      queue: cmd.queue,
      data: cmd.data,
      schedule: cmd.schedule,
      repeatEvery: cmd.repeatEvery,
      priority: cmd.priority,
      maxLimit: cmd.maxLimit,
    });
    return {
      ok: true,
      cron: {
        name: cron.name,
        queue: cron.queue,
        schedule: cron.schedule,
        repeatEvery: cron.repeatEvery,
        nextRun: cron.nextRun,
      },
      reqId,
    } as Response;
  } catch (err) {
    return resp.error(err instanceof Error ? err.message : 'Failed to add cron', reqId);
  }
}

/** Handle CronDelete command - delete cron job */
export function handleCronDelete(
  cmd: Extract<Command, { cmd: 'CronDelete' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  const removed = ctx.queueManager.removeCron(cmd.name);
  return removed ? resp.ok(undefined, reqId) : resp.error('Cron job not found', reqId);
}

/** Handle CronList command - list cron jobs */
export function handleCronList(
  _cmd: Extract<Command, { cmd: 'CronList' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  const crons = ctx.queueManager.listCrons();
  return {
    ok: true,
    crons: crons.map((c) => ({
      name: c.name,
      queue: c.queue,
      schedule: c.schedule,
      repeatEvery: c.repeatEvery,
      nextRun: c.nextRun,
      executions: c.executions,
      maxLimit: c.maxLimit,
    })),
    reqId,
  } as Response;
}
