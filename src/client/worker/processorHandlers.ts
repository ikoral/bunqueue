/**
 * Processor Handler Factories
 * Creates callback handlers for job operations during processing
 */

import type { EventEmitter } from 'events';
import type { TcpConnection } from './types';
import type { Job, FlowJobData, JobStateType } from '../types';
import type { Job as InternalJob } from '../../domain/types/job';
import { jobId } from '../../domain/types/job';
import { getSharedManager } from '../manager';
import type { AckBatcher } from './ackBatcher';

export function createProgressHandler<T extends FlowJobData>(
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

export function createLogHandler<T extends FlowJobData>(
  embedded: boolean,
  tcp: TcpConnection | null,
  emitter: EventEmitter,
  jobHolder: { current: Job<T> | null }
) {
  return async (id: string, message: string) => {
    if (embedded) {
      const manager = getSharedManager();
      manager.addLog(jobId(id), message);
    } else if (tcp) {
      await tcp.send({ cmd: 'AddLog', id, message });
    }
    emitter.emit('log', jobHolder.current, message);
  };
}

export function createGetStateHandler(embedded: boolean, tcp: TcpConnection | null) {
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

export function createGetChildrenValuesHandler(embedded: boolean, tcp: TcpConnection | null) {
  return async (id: string): Promise<Record<string, unknown>> => {
    if (embedded) {
      const manager = getSharedManager();
      return manager.getChildrenValues(jobId(id));
    } else if (tcp) {
      const response = await tcp.send({ cmd: 'GetChildrenValues', id });
      const data = (response as { data?: { values?: Record<string, unknown> } }).data;
      return data?.values ?? {};
    }
    return {};
  };
}

export function createGetFailedChildrenValuesHandler(
  embedded: boolean,
  tcp: TcpConnection | null
): (id: string) => Promise<Record<string, string>> {
  return async (id: string) => {
    if (embedded) {
      const manager = getSharedManager();
      return manager.getFailedChildrenValues(jobId(id));
    }
    if (!tcp) return {};
    const res = await tcp.send({ cmd: 'GetFailedChildrenValues', id });
    return (res.values as Record<string, string> | undefined) ?? {};
  };
}

export function createGetIgnoredChildrenFailuresHandler(
  embedded: boolean,
  tcp: TcpConnection | null
): (id: string) => Promise<Record<string, string>> {
  return async (id: string) => {
    if (embedded) {
      const manager = getSharedManager();
      return manager.getIgnoredChildrenFailures(jobId(id));
    }
    if (!tcp) return {};
    const res = await tcp.send({ cmd: 'GetIgnoredChildrenFailures', id });
    return (res.values as Record<string, string> | undefined) ?? {};
  };
}

export function createRemoveChildDependencyHandler(
  embedded: boolean,
  tcp: TcpConnection | null
): (id: string) => Promise<boolean> {
  return async (id: string) => {
    if (embedded) {
      const manager = getSharedManager();
      return manager.removeChildDependency(jobId(id));
    }
    if (!tcp) return false;
    const res = await tcp.send({ cmd: 'RemoveChildDependency', id });
    return res.ok === true;
  };
}

export function createRemoveUnprocessedChildrenHandler(
  embedded: boolean,
  tcp: TcpConnection | null
): (id: string) => Promise<void> {
  return async (id: string) => {
    if (embedded) {
      const manager = getSharedManager();
      return manager.removeUnprocessedChildren(jobId(id));
    }
    if (!tcp) return;
    await tcp.send({ cmd: 'RemoveUnprocessedChildren', id });
  };
}

/** Issue #82: Create moveToFailed handler for use inside processor */
export function createMoveToFailedHandler(
  embedded: boolean,
  tcp: TcpConnection | null,
  internalJob: InternalJob,
  token: string | null | undefined,
  onCalled: (error: Error) => void
): (id: string, error: Error, _lockToken?: string) => Promise<void> {
  return async (_id: string, error: Error, _lockToken?: string) => {
    if (embedded) {
      const manager = getSharedManager();
      await manager.fail(internalJob.id, error.message, token ?? undefined);
    } else if (tcp) {
      await tcp.send({
        cmd: 'FAIL',
        id: internalJob.id,
        error: error.message,
        ...(token ? { token } : {}),
      });
    }
    onCalled(error);
  };
}

/** Issue #82: Create moveToCompleted handler for use inside processor */
export function createMoveToCompletedHandler(
  embedded: boolean,
  ackBatcher: AckBatcher,
  internalJob: InternalJob,
  token: string | null | undefined,
  onCalled: (value: unknown) => void
): (id: string, returnValue: unknown, _lockToken?: string) => Promise<unknown> {
  return async (_id: string, returnValue: unknown, _lockToken?: string) => {
    if (embedded) {
      const manager = getSharedManager();
      await manager.ack(internalJob.id, returnValue, token ?? undefined);
    } else {
      await ackBatcher.queue(String(internalJob.id), returnValue, token ?? undefined);
    }
    onCalled(returnValue);
    return null;
  };
}
