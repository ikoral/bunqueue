/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Worker Query Operations
 */

import { getSharedManager } from '../manager';
import type { TcpConnectionPool } from '../tcpPool';

interface WorkersContext {
  name: string;
  embedded: boolean;
  tcp: TcpConnectionPool | null;
}

export interface WorkerInfo {
  id: string;
  name: string;
  addr?: string;
}

/** Get workers processing this queue */
export async function getWorkers(ctx: WorkersContext): Promise<WorkerInfo[]> {
  if (ctx.embedded) {
    return [];
  }

  const response = await ctx.tcp!.send({ cmd: 'ListWorkers' });
  if (!response.ok) return [];
  return (response as { workers?: WorkerInfo[] }).workers ?? [];
}

/** Get worker count */
export async function getWorkersCount(ctx: WorkersContext): Promise<number> {
  const workers = await getWorkers(ctx);
  return workers.length;
}

/** Get metrics for this queue */
export async function getMetrics(
  ctx: WorkersContext,
  type: 'completed' | 'failed',
  _start?: number,
  _end?: number
): Promise<{ meta: { count: number }; data: number[] }> {
  if (ctx.embedded) {
    const stats = getSharedManager().getStats();
    const count = type === 'completed' ? stats.completed : stats.dlq;
    return { meta: { count }, data: [] };
  }

  const response = await ctx.tcp!.send({ cmd: 'Metrics' });
  if (!response.ok) return { meta: { count: 0 }, data: [] };

  const stats = response.stats as { completed?: number; dlq?: number } | undefined;
  const count = type === 'completed' ? (stats?.completed ?? 0) : (stats?.dlq ?? 0);
  return { meta: { count }, data: [] };
}

/** Trim events (no-op in bunqueue - events are real-time) */
export function trimEvents(_ctx: WorkersContext, _maxLength: number): Promise<number> {
  return Promise.resolve(0);
}
