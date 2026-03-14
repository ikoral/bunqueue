/**
 * Job Processor
 * Handles job execution and result reporting
 */

import type { EventEmitter } from 'events';
import type { TcpConnection } from './types';
import type { Processor, Job, FlowJobData, JobStateType } from '../types';
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
  token?: string | null; // Lock token for ownership verification
}

/**
 * Process a single job
 */
export async function processJob<T, R>(
  internalJob: InternalJob,
  config: ProcessorConfig<T, R>
): Promise<void> {
  const { processor, embedded, tcp, ackBatcher, emitter, token } = config;
  const jobData = internalJob.data as { name?: string } | null;
  const jobName = jobData?.name ?? 'default';
  const jobIdStr = String(internalJob.id);

  // Use a holder to break the circular reference between job and progress handler
  type JobData = T & FlowJobData;
  const jobHolder: { current: Job<JobData> | null } = { current: null };

  const job = createPublicJob<JobData>({
    job: internalJob,
    name: jobName,
    updateProgress: createProgressHandler(embedded, tcp, emitter, jobHolder),
    log: createLogHandler(embedded, tcp),
    getState: createGetStateHandler(embedded, tcp),
    getChildrenValues: createGetChildrenValuesHandler(embedded, tcp),
  });

  jobHolder.current = job;

  emitter.emit('active', job);

  try {
    const result = await processor(job);

    try {
      if (embedded) {
        const manager = getSharedManager();
        // Pass token for lock verification
        await manager.ack(internalJob.id, result, token ?? undefined);
      } else {
        // Queue with token for batch ACK
        void ackBatcher.queue(jobIdStr, result, token ?? undefined);
      }
    } catch (ackErr) {
      // If stall detection already removed the job from processing,
      // the ACK will fail with "Job not found". This is expected
      // behavior (Issue #33) - emit error event but don't re-throw.
      const ackError = ackErr instanceof Error ? ackErr : new Error(String(ackErr));
      if (isJobNotFoundError(ackError)) {
        emitter.emit('error', Object.assign(ackError, { context: 'ack-stale', jobId: jobIdStr }));
        return;
      }
      throw ackErr;
    }

    (job as { returnvalue?: unknown }).returnvalue = result;
    emitter.emit('completed', job, result);
  } catch (error) {
    await handleJobFailure(internalJob, error, config, { job, jobIdStr, token });
  }
}

function createProgressHandler<T extends FlowJobData>(
  embedded: boolean,
  tcp: TcpConnection | null,
  emitter: EventEmitter,
  jobHolder: { current: Job<T> | null }
) {
  return async (id: string, progress: number, message?: string) => {
    if (embedded) {
      const manager = getSharedManager();
      await manager.updateProgress(jobId(id), progress, message);
    } else if (tcp) {
      await tcp.send({ cmd: 'Progress', id, progress, message });
    }
    emitter.emit('progress', jobHolder.current, progress);
  };
}

function createLogHandler(embedded: boolean, tcp: TcpConnection | null) {
  return async (id: string, message: string) => {
    if (embedded) {
      const manager = getSharedManager();
      // addLog is synchronous (in-memory Map update)
      manager.addLog(jobId(id), message);
    } else if (tcp) {
      await tcp.send({ cmd: 'AddLog', id, message });
    }
  };
}

function createGetStateHandler(embedded: boolean, tcp: TcpConnection | null) {
  return async (id: string): Promise<JobStateType> => {
    if (embedded) {
      const manager = getSharedManager();
      return (await manager.getJobState(jobId(id))) as JobStateType;
    } else if (tcp) {
      const response = await tcp.send({ cmd: 'GetState', id });
      return ((response as { state?: string }).state ?? 'unknown') as JobStateType;
    }
    return 'unknown' as JobStateType;
  };
}

function createGetChildrenValuesHandler(embedded: boolean, tcp: TcpConnection | null) {
  return async (id: string): Promise<Record<string, unknown>> => {
    if (embedded) {
      const manager = getSharedManager();
      return manager.getChildrenValues(jobId(id));
    } else if (tcp) {
      const response = await tcp.send({ cmd: 'GetChildrenValues', id });
      return (response as { values?: Record<string, unknown> }).values ?? {};
    }
    return {};
  };
}

interface FailureContext<T extends FlowJobData> {
  job: Job<T>;
  jobIdStr: string;
  token?: string | null;
}

/** Check if error is a "job not found" error from stale ACK/FAIL (Issue #33) */
function isJobNotFoundError(err: Error): boolean {
  return err.message.includes('not found') || err.message.includes('not in processing');
}

async function handleJobFailure<T, R>(
  internalJob: InternalJob,
  error: unknown,
  config: ProcessorConfig<T, R>,
  context: FailureContext<T & FlowJobData>
): Promise<void> {
  const { embedded, tcp, emitter } = config;
  const { job, jobIdStr, token } = context;
  const err = error instanceof Error ? error : new Error(String(error));

  try {
    if (embedded) {
      const manager = getSharedManager();
      // Pass token for lock verification
      await manager.fail(internalJob.id, err.message, token ?? undefined);
    } else if (tcp) {
      // Include token for lock verification (only if defined)
      await tcp.send({
        cmd: 'FAIL',
        id: internalJob.id,
        error: err.message,
        ...(token ? { token } : {}),
      });
    }
  } catch (failError) {
    const wrappedError = failError instanceof Error ? failError : new Error(String(failError));
    // If stall detection already removed the job, the FAIL will throw
    // "Job not found". This is expected (Issue #33) - don't emit as error.
    if (isJobNotFoundError(wrappedError)) {
      return;
    }
    emitter.emit('error', Object.assign(wrappedError, { context: 'fail', jobId: jobIdStr }));
  }

  (job as { failedReason?: string }).failedReason = err.message;
  emitter.emit('failed', job, err);
}
