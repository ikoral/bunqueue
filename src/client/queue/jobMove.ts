/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Job Move Operations (BullMQ v5 compatible)
 */

import { getSharedManager } from '../manager';
import type { TcpConnectionPool } from '../tcpPool';
import { jobId } from '../../domain/types/job';

interface JobMoveContext {
  name: string;
  embedded: boolean;
  tcp: TcpConnectionPool | null;
  getJobState: (
    id: string
  ) => Promise<'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'unknown'>;
  getJobDependencies: (
    id: string
  ) => Promise<{ processed: Record<string, unknown>; unprocessed: string[] }>;
}

/** Move job to completed state */
export async function moveJobToCompleted(
  ctx: JobMoveContext,
  id: string,
  returnValue: unknown,
  _token?: string
): Promise<unknown> {
  if (ctx.embedded) {
    await getSharedManager().ack(jobId(id), returnValue);
    return null;
  }
  await ctx.tcp!.send({ cmd: 'ACK', id, result: returnValue });
  return null;
}

/** Move job to failed state */
export async function moveJobToFailed(
  ctx: JobMoveContext,
  id: string,
  error: Error,
  _token?: string
): Promise<void> {
  if (ctx.embedded) {
    await getSharedManager().fail(jobId(id), error.message);
  } else {
    await ctx.tcp!.send({ cmd: 'FAIL', id, error: error.message });
  }
}

/** Move job back to waiting state */
export async function moveJobToWait(
  ctx: JobMoveContext,
  id: string,
  _token?: string
): Promise<boolean> {
  if (ctx.embedded) {
    const manager = getSharedManager();
    const job = await manager.getJob(jobId(id));
    if (!job) return false;

    await manager.push(job.queue, {
      data: job.data,
      priority: job.priority,
      customId: job.customId ?? undefined,
    });
    return true;
  }

  const response = await ctx.tcp!.send({ cmd: 'MoveToWait', id });
  return response.ok === true;
}

/** Move job to delayed state */
export async function moveJobToDelayed(
  ctx: JobMoveContext,
  id: string,
  timestamp: number,
  _token?: string
): Promise<void> {
  if (ctx.embedded) {
    const delay = Math.max(0, timestamp - Date.now());
    await getSharedManager().changeDelay(jobId(id), delay);
  } else {
    await ctx.tcp!.send({ cmd: 'MoveToDelayed', id, timestamp });
  }
}

/** Move job to waiting-children state */
export async function moveJobToWaitingChildren(
  ctx: JobMoveContext,
  id: string,
  _token?: string,
  _opts?: { child?: { id: string; queue: string } }
): Promise<boolean> {
  if (ctx.embedded) {
    const manager = getSharedManager();
    const job = await manager.getJob(jobId(id));
    if (!job) return false;

    const deps = await ctx.getJobDependencies(id);
    return deps.unprocessed.length > 0;
  }
  return false;
}

/** Wait until job has finished */
export async function waitJobUntilFinished(
  ctx: JobMoveContext,
  id: string,
  queueEvents: unknown,
  ttl?: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = ttl
      ? setTimeout(() => {
          cleanup();
          reject(new Error(`Job ${id} timed out after ${ttl}ms`));
        }, ttl)
      : null;

    const events = queueEvents as {
      on: (
        event: string,
        handler: (data: { jobId: string; returnvalue?: unknown; failedReason?: string }) => void
      ) => void;
      off: (
        event: string,
        handler: (data: { jobId: string; returnvalue?: unknown; failedReason?: string }) => void
      ) => void;
    };

    const completedHandler = (data: { jobId: string; returnvalue?: unknown }) => {
      if (data.jobId === id) {
        cleanup();
        resolve(data.returnvalue);
      }
    };

    const failedHandler = (data: { jobId: string; failedReason?: string }) => {
      if (data.jobId === id) {
        cleanup();
        reject(new Error(data.failedReason ?? 'Job failed'));
      }
    };

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      events.off('completed', completedHandler);
      events.off('failed', failedHandler);
    };

    events.on('completed', completedHandler);
    events.on('failed', failedHandler);

    // Check if job is already finished
    void ctx.getJobState(id).then((state) => {
      if (state === 'completed') {
        cleanup();
        if (ctx.embedded) {
          const result = getSharedManager().getResult(jobId(id));
          resolve(result);
        } else {
          resolve(undefined);
        }
      } else if (state === 'failed') {
        cleanup();
        reject(new Error('Job already failed'));
      }
    });
  });
}
