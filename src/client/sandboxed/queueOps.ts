/**
 * Queue Operations for SandboxedWorker
 * Provides a unified interface for embedded and TCP mode queue operations
 */

import type { Job as DomainJob, JobId } from '../../domain/types/job';
import { jobId } from '../../domain/types/job';
import type { SharedManager } from '../manager';
import type { TcpConnectionPool } from '../tcpPool';
import { parseJobFromResponse } from '../worker/jobParser';

/** Unified queue operations interface */
export interface QueueOps {
  pull(
    queue: string,
    workerId: string,
    timeout: number
  ): Promise<{ job: DomainJob | null; token: string | null }>;
  ack(id: JobId, result: unknown, token?: string): Promise<void>;
  fail(id: JobId, error: string, token?: string): Promise<void>;
  updateProgress(id: JobId, progress: number): Promise<void>;
  addLog(id: JobId, message: string): void;
  sendHeartbeat(ids: string[], tokens: string[]): Promise<void>;
}

/** Create embedded mode operations using shared QueueManager */
export function createEmbeddedOps(manager: SharedManager): QueueOps {
  return {
    pull: (queue, workerId, timeout) => manager.pullWithLock(queue, workerId, timeout),
    ack: (id, result, token) => manager.ack(id, result, token),
    fail: (id, error, token) => manager.fail(id, error, token),
    updateProgress: async (id, progress) => {
      await manager.updateProgress(id, progress);
    },
    addLog: (id, message) => {
      manager.addLog(id, message);
    },
    sendHeartbeat: (ids, tokens) => {
      for (let i = 0; i < ids.length; i++) {
        manager.jobHeartbeat(jobId(ids[i]), tokens[i]);
      }
      return Promise.resolve();
    },
  };
}

/** Create TCP mode operations using connection pool */
export function createTcpOps(tcp: TcpConnectionPool): QueueOps {
  return {
    async pull(queue, workerId, timeout) {
      const res = await tcp.send({ cmd: 'PULL', queue, owner: workerId, timeout });
      if (!res.ok || !res.job) return { job: null, token: null };
      return {
        job: parseJobFromResponse(res.job as Record<string, unknown>, queue),
        token: (res.token as string | null | undefined) ?? null,
      };
    },
    async ack(id, result, token) {
      await tcp.send({ cmd: 'ACK', id: String(id), result, token: token ?? undefined });
    },
    async fail(id, error, token) {
      await tcp.send({ cmd: 'FAIL', id: String(id), error, token: token ?? undefined });
    },
    async updateProgress(id, progress) {
      await tcp.send({ cmd: 'Progress', id: String(id), progress });
    },
    addLog(id, message) {
      tcp.send({ cmd: 'AddLog', id: String(id), message }).catch(() => {});
    },
    async sendHeartbeat(ids, tokens) {
      if (ids.length === 0) return;
      if (ids.length === 1) {
        await tcp.send({ cmd: 'JobHeartbeat', id: ids[0], token: tokens[0] || undefined });
      } else {
        await tcp.send({ cmd: 'JobHeartbeatB', ids, tokens });
      }
    },
  };
}
