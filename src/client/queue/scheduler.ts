/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Job Scheduler Operations (BullMQ v5 repeatable jobs)
 */

import { getSharedManager } from '../manager';
import type { TcpConnectionPool } from '../tcpPool';
import type { JobOptions } from '../types';

interface SchedulerContext {
  name: string;
  embedded: boolean;
  tcp: TcpConnectionPool | null;
}

interface RepeatOpts {
  pattern?: string;
  every?: number;
  limit?: number;
  immediately?: boolean;
  count?: number;
  prevMillis?: number;
  offset?: number;
  jobId?: string;
}

interface JobTemplate {
  name?: string;
  data?: unknown;
  opts?: JobOptions;
}

export interface SchedulerInfo {
  id: string;
  name: string;
  next: number;
  pattern?: string;
  every?: number;
}

/** Create or update a job scheduler */
export async function upsertJobScheduler(
  ctx: SchedulerContext,
  schedulerId: string,
  repeatOpts: RepeatOpts,
  jobTemplate?: JobTemplate
): Promise<SchedulerInfo | null> {
  const cronPattern = repeatOpts.pattern;
  const repeatEvery = repeatOpts.every;

  if (ctx.embedded) {
    const manager = getSharedManager();
    manager.addCron({
      name: schedulerId,
      queue: ctx.name,
      data: jobTemplate?.data ?? {},
      schedule: cronPattern,
      repeatEvery,
      timezone: 'UTC',
    });
    return {
      id: schedulerId,
      name: jobTemplate?.name ?? 'default',
      next: Date.now() + (repeatEvery ?? 60000),
    };
  }

  const response = await ctx.tcp!.send({
    cmd: 'Cron',
    name: schedulerId,
    queue: ctx.name,
    data: jobTemplate?.data ?? {},
    schedule: cronPattern,
    repeatEvery,
  });

  if (!response.ok) return null;
  return {
    id: schedulerId,
    name: jobTemplate?.name ?? 'default',
    next: (response.nextRun ?? Date.now()) as number,
  };
}

/** Remove a job scheduler */
export async function removeJobScheduler(
  ctx: SchedulerContext,
  schedulerId: string
): Promise<boolean> {
  if (ctx.embedded) {
    getSharedManager().removeCron(schedulerId);
    return true;
  }
  const response = await ctx.tcp!.send({ cmd: 'CronDelete', name: schedulerId });
  return response.ok === true;
}

/** Get a job scheduler by ID */
export async function getJobScheduler(
  ctx: SchedulerContext,
  schedulerId: string
): Promise<SchedulerInfo | null> {
  if (ctx.embedded) {
    const crons = getSharedManager().listCrons();
    const cron = crons.find((c) => c.name === schedulerId);
    if (!cron) return null;
    return {
      id: cron.name,
      name: cron.name,
      next: cron.nextRun,
      pattern: cron.schedule ?? undefined,
      every: cron.repeatEvery ?? undefined,
    };
  }

  const response = await ctx.tcp!.send({ cmd: 'CronList' });
  if (!response.ok) return null;

  type CronEntry = { name: string; nextRun: number; schedule?: string; repeatEvery?: number };
  const crons = (response as { crons?: CronEntry[] }).crons;
  const cron = crons?.find((c) => c.name === schedulerId);
  if (!cron) return null;

  return {
    id: cron.name,
    name: cron.name,
    next: cron.nextRun,
    pattern: cron.schedule ?? undefined,
    every: cron.repeatEvery ?? undefined,
  };
}

/** Get all job schedulers for this queue */
export async function getJobSchedulers(
  ctx: SchedulerContext,
  _start = 0,
  _end = -1,
  _asc = true
): Promise<SchedulerInfo[]> {
  if (ctx.embedded) {
    return getSharedManager()
      .listCrons()
      .filter((c) => c.queue === ctx.name)
      .map((c) => ({
        id: c.name,
        name: c.name,
        next: c.nextRun,
        pattern: c.schedule ?? undefined,
        every: c.repeatEvery ?? undefined,
      }));
  }

  const response = await ctx.tcp!.send({ cmd: 'CronList' });
  if (!response.ok) return [];

  type CronEntry = {
    name: string;
    queue: string;
    nextRun: number;
    schedule?: string;
    repeatEvery?: number;
  };
  const crons = (response as { crons?: CronEntry[] }).crons ?? [];

  return crons
    .filter((c) => c.queue === ctx.name)
    .map((c) => ({
      id: c.name,
      name: c.name,
      next: c.nextRun,
      pattern: c.schedule ?? undefined,
      every: c.repeatEvery ?? undefined,
    }));
}

/** Get count of job schedulers */
export async function getJobSchedulersCount(ctx: SchedulerContext): Promise<number> {
  const schedulers = await getJobSchedulers(ctx);
  return schedulers.length;
}
