/**
 * Core Command Handlers
 * Push, Pull, Ack, Fail operations
 */

import type { Command } from '../../../domain/types/command';
import type { Response } from '../../../domain/types/response';
import * as resp from '../../../domain/types/response';
import { jobId } from '../../../domain/types/job';
import type { HandlerContext } from '../types';
import {
  validateQueueName,
  validateJobData,
  validateJobOptions,
  validateNumericField,
} from '../protocol';

/** Handle PUSH command */
export async function handlePush(
  cmd: Extract<Command, { cmd: 'PUSH' }>,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const queueError = validateQueueName(cmd.queue);
  if (queueError) return resp.error(queueError, reqId);

  const dataError = validateJobData(cmd.data);
  if (dataError) return resp.error(dataError, reqId);

  // Validate numeric fields
  const optionsError = validateJobOptions({
    priority: cmd.priority,
    delay: cmd.delay,
    timeout: cmd.timeout,
    maxAttempts: cmd.maxAttempts,
    backoff: cmd.backoff,
    ttl: cmd.ttl,
  });
  if (optionsError) return resp.error(optionsError, reqId);

  // Validate dependsOn references exist
  if (cmd.dependsOn && cmd.dependsOn.length > 0) {
    for (const depId of cmd.dependsOn) {
      const depJobId = jobId(depId);
      const exists =
        ctx.queueManager.getJobIndex().has(depJobId) ||
        ctx.queueManager.getCompletedJobs().has(depJobId);
      if (!exists) {
        return resp.error(`Dependency job not found: ${depId}`, reqId);
      }
    }
  }

  const job = await ctx.queueManager.push(cmd.queue, {
    data: cmd.data,
    priority: cmd.priority,
    delay: cmd.delay,
    maxAttempts: cmd.maxAttempts,
    backoff: cmd.backoff,
    ttl: cmd.ttl,
    timeout: cmd.timeout,
    uniqueKey: cmd.uniqueKey,
    customId: cmd.jobId,
    dependsOn: cmd.dependsOn?.map((id) => jobId(id)),
    tags: cmd.tags,
    groupId: cmd.groupId,
    lifo: cmd.lifo,
    removeOnComplete: cmd.removeOnComplete,
    removeOnFail: cmd.removeOnFail,
  });

  return resp.ok(job.id, reqId);
}

/** Handle PUSHB (batch push) command */
export async function handlePushBatch(
  cmd: Extract<Command, { cmd: 'PUSHB' }>,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const queueError = validateQueueName(cmd.queue);
  if (queueError) return resp.error(queueError, reqId);

  const ids = await ctx.queueManager.pushBatch(cmd.queue, cmd.jobs);
  return resp.batch(ids, reqId);
}

/** Handle PULL command */
export async function handlePull(
  cmd: Extract<Command, { cmd: 'PULL' }>,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const queueError = validateQueueName(cmd.queue);
  if (queueError) return resp.error(queueError, reqId);

  // Validate timeout
  const timeoutError = validateNumericField(cmd.timeout, 'timeout', { min: 0, max: 60000 });
  if (timeoutError) return resp.error(timeoutError, reqId);

  const job = await ctx.queueManager.pull(cmd.queue, cmd.timeout);
  return resp.nullableJob(job, reqId);
}

/** Handle PULLB (batch pull) command - uses optimized single-lock batch pull */
export async function handlePullBatch(
  cmd: Extract<Command, { cmd: 'PULLB' }>,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const queueError = validateQueueName(cmd.queue);
  if (queueError) return resp.error(queueError, reqId);

  // Validate count
  const countError = validateNumericField(cmd.count, 'count', { min: 1, max: 1000 });
  if (countError) return resp.error(countError, reqId);

  // Use optimized batch pull - O(1) lock instead of O(n) locks
  const jobs = await ctx.queueManager.pullBatch(cmd.queue, cmd.count, 0);
  return resp.jobs(jobs, reqId);
}

/** Handle ACK command */
export async function handleAck(
  cmd: Extract<Command, { cmd: 'ACK' }>,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  await ctx.queueManager.ack(jobId(cmd.id), cmd.result);
  return resp.ok(undefined, reqId);
}

/** Handle ACKB (batch ack) command - uses Promise.all for parallel execution */
export async function handleAckBatch(
  cmd: Extract<Command, { cmd: 'ACKB' }>,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  // Use optimized batch ack with Promise.all for parallel execution
  await ctx.queueManager.ackBatch(cmd.ids.map((id) => jobId(id)));
  return resp.ok(undefined, reqId);
}

/** Handle FAIL command */
export async function handleFail(
  cmd: Extract<Command, { cmd: 'FAIL' }>,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  await ctx.queueManager.fail(jobId(cmd.id), cmd.error);
  return resp.ok(undefined, reqId);
}
