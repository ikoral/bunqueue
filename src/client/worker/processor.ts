/**
 * Job Processor
 * Handles job execution and result reporting
 */

import type { EventEmitter } from 'events';
import type { TcpConnection } from './types';
import type { Processor, Job } from '../types';
import { createPublicJob } from '../types';
import type { Job as InternalJob } from '../../domain/types/job';
import { jobId } from '../../domain/types/job';
import { getSharedManager } from '../manager';
import type { AckBatcher } from './ackBatcher';

/** Processor configuration */
export interface ProcessorConfig<T, R> {
  name: string;
  processor: Processor<T, R>;
  embedded: boolean;
  tcp: TcpConnection | null;
  ackBatcher: AckBatcher;
  emitter: EventEmitter;
}

/**
 * Process a single job
 */
export async function processJob<T, R>(
  internalJob: InternalJob,
  config: ProcessorConfig<T, R>
): Promise<void> {
  const { processor, embedded, tcp, ackBatcher, emitter } = config;
  const jobData = internalJob.data as { name?: string } | null;
  const jobName = jobData?.name ?? 'default';
  const jobIdStr = String(internalJob.id);

  const job = createPublicJob<T>(
    internalJob,
    jobName,
    createProgressHandler(embedded, tcp, emitter),
    createLogHandler(embedded, tcp)
  );

  emitter.emit('active', job);

  try {
    const result = await processor(job);

    if (embedded) {
      const manager = getSharedManager();
      await manager.ack(internalJob.id, result);
    } else {
      ackBatcher.queue(jobIdStr, result);
    }

    (job as { returnvalue?: unknown }).returnvalue = result;
    emitter.emit('completed', job, result);
  } catch (error) {
    await handleJobFailure(internalJob, error, config, job, jobIdStr);
  }
}

function createProgressHandler(
  embedded: boolean,
  tcp: TcpConnection | null,
  emitter: EventEmitter
) {
  return async (id: string, progress: number, message?: string) => {
    if (embedded) {
      const manager = getSharedManager();
      await manager.updateProgress(jobId(id), progress, message);
    } else if (tcp) {
      await tcp.send({ cmd: 'Progress', id, progress, message });
    }
    emitter.emit('progress', null, progress);
  };
}

function createLogHandler(embedded: boolean, tcp: TcpConnection | null) {
  return async (id: string, message: string) => {
    if (embedded) {
      const manager = getSharedManager();
      manager.addLog(jobId(id), message);
    } else if (tcp) {
      await tcp.send({ cmd: 'AddLog', id, message });
    }
  };
}

async function handleJobFailure<T, R>(
  internalJob: InternalJob,
  error: unknown,
  config: ProcessorConfig<T, R>,
  job: Job<T>,
  jobIdStr: string
): Promise<void> {
  const { embedded, tcp, emitter } = config;
  const err = error instanceof Error ? error : new Error(String(error));

  try {
    if (embedded) {
      const manager = getSharedManager();
      await manager.fail(internalJob.id, err.message);
    } else if (tcp) {
      await tcp.send({ cmd: 'FAIL', id: internalJob.id, error: err.message });
    }
  } catch (failError) {
    const wrappedError = failError instanceof Error ? failError : new Error(String(failError));
    emitter.emit('error', Object.assign(wrappedError, { context: 'fail', jobId: jobIdStr }));
  }

  (job as { failedReason?: string }).failedReason = err.message;
  emitter.emit('failed', job, err);
}
