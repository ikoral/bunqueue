/**
 * Flow Push Operations
 * Handles job push logic for FlowProducer
 */

import { getSharedManager } from './manager';
import type { TcpConnectionPool } from './tcpPool';
import { jobId } from '../domain/types/job';
import type { JobOptions } from './types';

export interface PushContext {
  embedded: boolean;
  tcp: TcpConnectionPool | null;
}

/** Parse removeOnComplete/removeOnFail options */
function parseRemoveOptions(opts: JobOptions): {
  removeOnComplete: boolean;
  removeOnFail: boolean;
} {
  return {
    removeOnComplete: typeof opts.removeOnComplete === 'boolean' ? opts.removeOnComplete : false,
    removeOnFail: typeof opts.removeOnFail === 'boolean' ? opts.removeOnFail : false,
  };
}

/** Push a job via embedded manager or TCP */
export async function pushJob(
  ctx: PushContext,
  queueName: string,
  data: unknown,
  opts: JobOptions = {},
  dependsOn?: string[]
): Promise<string> {
  if (ctx.embedded) {
    const manager = getSharedManager();
    const { removeOnComplete, removeOnFail } = parseRemoveOptions(opts);
    const job = await manager.push(queueName, {
      data,
      priority: opts.priority,
      delay: opts.delay,
      maxAttempts: opts.attempts,
      backoff: opts.backoff,
      timeout: opts.timeout,
      customId: opts.jobId,
      removeOnComplete,
      removeOnFail,
      dependsOn: dependsOn?.map((id) => jobId(id)),
    });
    return String(job.id);
  }

  if (!ctx.tcp) throw new Error('TCP connection not initialized');
  const response = await ctx.tcp.send({
    cmd: 'PUSH',
    queue: queueName,
    data,
    priority: opts.priority,
    delay: opts.delay,
    maxAttempts: opts.attempts,
    backoff: opts.backoff,
    timeout: opts.timeout,
    jobId: opts.jobId,
    removeOnComplete: opts.removeOnComplete,
    removeOnFail: opts.removeOnFail,
    dependsOn,
  });

  if (!response.ok) {
    throw new Error((response.error as string | undefined) ?? 'Failed to add job');
  }
  return response.id as string;
}

export interface PushWithParentOpts {
  queueName: string;
  data: unknown;
  opts: JobOptions;
  parentRef: { id: string; queue: string } | null;
  childIds: string[];
}

/** Push a job with parent/children tracking */
export async function pushJobWithParent(
  ctx: PushContext,
  params: PushWithParentOpts
): Promise<string> {
  const { queueName, data, opts, parentRef, childIds } = params;
  if (ctx.embedded) {
    const manager = getSharedManager();
    const { removeOnComplete, removeOnFail } = parseRemoveOptions(opts);
    const childJobIds = childIds.map((id) => jobId(id));
    const job = await manager.push(queueName, {
      data,
      priority: opts.priority,
      delay: opts.delay,
      maxAttempts: opts.attempts,
      backoff: opts.backoff,
      timeout: opts.timeout,
      customId: opts.jobId,
      removeOnComplete,
      removeOnFail,
      parentId: parentRef ? jobId(parentRef.id) : undefined,
      dependsOn: childJobIds.length > 0 ? childJobIds : undefined,
      childrenIds: childJobIds.length > 0 ? childJobIds : undefined,
    });

    if (childIds.length > 0) {
      for (const childIdStr of childIds) {
        await manager.updateJobParent(jobId(childIdStr), job.id);
      }
    }

    return String(job.id);
  }

  if (!ctx.tcp) throw new Error('TCP connection not initialized');
  const response = await ctx.tcp.send({
    cmd: 'PUSH',
    queue: queueName,
    data,
    priority: opts.priority,
    delay: opts.delay,
    maxAttempts: opts.attempts,
    backoff: opts.backoff,
    timeout: opts.timeout,
    jobId: opts.jobId,
    removeOnComplete: opts.removeOnComplete,
    removeOnFail: opts.removeOnFail,
    parentId: parentRef?.id,
    childrenIds: childIds.length > 0 ? childIds : undefined,
    dependsOn: childIds.length > 0 ? childIds : undefined,
  });

  if (!response.ok) {
    throw new Error((response.error as string | undefined) ?? 'Failed to add job');
  }
  return response.id as string;
}

/** Cleanup jobs that were created before a failure occurred */
export async function cleanupJobs(ctx: PushContext, jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;

  if (ctx.embedded) {
    const manager = getSharedManager();
    const cleanupPromises = jobIds.map(async (id) => {
      try {
        await manager.cancel(jobId(id));
      } catch {
        // Ignore errors during cleanup
      }
    });
    await Promise.all(cleanupPromises);
  } else if (ctx.tcp) {
    const cleanupPromises = jobIds.map(async (id) => {
      try {
        await ctx.tcp?.send({ cmd: 'Cancel', id });
      } catch {
        // Ignore errors during cleanup
      }
    });
    await Promise.all(cleanupPromises);
  }
}
