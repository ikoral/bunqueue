/**
 * Query Command Handlers
 * GetJob, GetState, GetResult, GetJobCounts, GetJobByCustomId, GetJobs
 */

import type { Command } from '../../../domain/types/command';
import type { Response } from '../../../domain/types/response';
import * as resp from '../../../domain/types/response';
import { jobId } from '../../../domain/types/job';
import type { HandlerContext } from '../types';

/** Handle GetJob command */
export async function handleGetJob(
  cmd: Extract<Command, { cmd: 'GetJob' }>,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const job = await ctx.queueManager.getJob(jobId(cmd.id));
  return job ? resp.job(job, reqId) : resp.error('Job not found', reqId);
}

/** Handle GetState command */
export async function handleGetState(
  cmd: Extract<Command, { cmd: 'GetState' }>,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const job = await ctx.queueManager.getJob(jobId(cmd.id));
  if (!job) return resp.error('Job not found', reqId);

  let state: string;
  if (job.completedAt) {
    state = 'completed';
  } else if (job.startedAt) {
    state = 'active';
  } else if (job.runAt > Date.now()) {
    state = 'delayed';
  } else {
    state = 'waiting';
  }

  return { ok: true, id: cmd.id, state, reqId } as Response;
}

/** Handle GetResult command */
export function handleGetResult(
  cmd: Extract<Command, { cmd: 'GetResult' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  const result = ctx.queueManager.getResult(jobId(cmd.id));
  return { ok: true, id: cmd.id, result, reqId } as Response;
}

/** Handle GetJobCounts command */
export function handleGetJobCounts(
  _cmd: Extract<Command, { cmd: 'GetJobCounts' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  const stats = ctx.queueManager.getStats();
  // For a specific queue, we'd need per-queue stats
  // For now return global stats
  return resp.counts(
    {
      waiting: stats.waiting,
      delayed: stats.delayed,
      active: stats.active,
      completed: stats.completed,
      failed: Number(stats.totalFailed),
    },
    reqId
  );
}

/** Handle GetCountsPerPriority command */
export function handleGetCountsPerPriority(
  cmd: Extract<Command, { cmd: 'GetCountsPerPriority' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  const counts = ctx.queueManager.getCountsPerPriority(cmd.queue);
  return { ok: true, queue: cmd.queue, counts, reqId } as Response;
}

/** Handle GetJobByCustomId command */
export function handleGetJobByCustomId(
  cmd: Extract<Command, { cmd: 'GetJobByCustomId' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  const job = ctx.queueManager.getJobByCustomId(cmd.customId);
  return job ? resp.job(job, reqId) : resp.error('Job not found', reqId);
}

/** Handle GetJobs command - list jobs with filtering and pagination */
export function handleGetJobs(
  cmd: Extract<Command, { cmd: 'GetJobs' }>,
  ctx: HandlerContext,
  reqId?: string
): Response {
  const jobs = ctx.queueManager.getJobs(cmd.queue, {
    state: cmd.state as 'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | undefined,
    start: cmd.offset ?? 0,
    end: (cmd.offset ?? 0) + (cmd.limit ?? 100),
    asc: true,
  });

  return resp.jobs(jobs, reqId);
}
