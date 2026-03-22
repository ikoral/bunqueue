/**
 * Snapshot Collector
 * Two-tier collection: light (every 15s) + heavy (every 90s)
 *
 * Light: stats, throughput, latency, memory, connections — O(SHARD_COUNT)
 * Heavy: recentJobs, dlqEntries, topErrors, workerDetails, queueConfigs, webhooks — O(queues × shards)
 */

import { hostname, arch, platform, cpus } from 'os';
import type { QueueManager } from '../../application/queueManager';
import { throughputTracker } from '../../application/throughputTracker';
import { latencyTracker } from '../../application/latencyTracker';
import { getTaskErrorStats } from '../../application/backgroundTasks';
import { VERSION } from '../../shared/version';
import type { CloudSnapshot } from './types';
import {
  collectRecentJobs,
  collectDlqEntries,
  collectTopErrors,
  collectQueueConfigs,
  collectWebhooks,
  collectQueueThroughput,
  collectWorkerUtilization,
  collectDurationHistogram,
  collectQueueWaitTime,
  collectQueueRetryRate,
  collectBacklogVelocity,
  collectStallDetails,
  collectPriorityDistribution,
} from './snapshotHelpers';

/** Cached hostname — computed once */
const HOST = hostname();

/** Cached runtime info — computed once */
const RUNTIME = {
  bunVersion: typeof Bun !== 'undefined' ? Bun.version : 'unknown',
  os: platform(),
  arch: arch(),
  cpus: cpus().length,
};

/** Optional server handles for connection stats + backup + storage */
export interface ServerHandles {
  getConnectionCount: () => number;
  getWsClientCount: () => number;
  getSseClientCount: () => number;
  getBackupStatus?: () => {
    enabled: boolean;
    bucket: string;
    endpoint: string;
    intervalMs: number;
    retention: number;
    isRunning: boolean;
  } | null;
  getSqliteStats?: () => { dbSizeBytes: number; writeBufferPending: number } | null;
  getMcpOperations?: () => {
    operations: Array<{
      tool: string;
      queue: string | null;
      timestamp: number;
      durationMs: number;
      success: boolean;
      error: string | null;
    }>;
    summary: {
      totalInvocations: number;
      successCount: number;
      failureCount: number;
      avgDurationMs: number;
      topTools: Array<{ tool: string; count: number }>;
    };
  };
}

/** Parameters for snapshot collection */
export interface CollectSnapshotParams {
  queueManager: QueueManager;
  instanceId: string;
  instanceName: string;
  startedAt: number;
  sequenceId: number;
  serverHandles?: ServerHandles;
  includeHeavy: boolean;
}

/** Cached heavy data — reused between snapshots until refreshed */
let cachedHeavy: Pick<
  CloudSnapshot,
  | 'recentJobs'
  | 'dlqEntries'
  | 'topErrors'
  | 'workerDetails'
  | 'queueConfigs'
  | 'webhooks'
  | 's3Backup'
> = {
  recentJobs: [],
  dlqEntries: [],
  topErrors: [],
  workerDetails: [],
  queueConfigs: {},
  webhooks: [],
  s3Backup: null,
};

/** Collect a snapshot. Light data always fresh, heavy data cached between refreshes. */
export async function collectSnapshot(params: CollectSnapshotParams): Promise<CloudSnapshot> {
  const { queueManager, instanceId, instanceName, startedAt, sequenceId, serverHandles } = params;

  // ─── MCP operations (drain buffer into snapshot) ───
  const mcpData = serverHandles?.getMcpOperations?.();

  // ─── Light data (O(SHARD_COUNT), every snapshot) ───
  const stats = queueManager.getStats();
  const memStats = queueManager.getMemoryStats();
  const workerStats = queueManager.workerManager.getStats();
  const rates = throughputTracker.getRates();
  const percentiles = latencyTracker.getPercentiles();
  const averages = latencyTracker.getAverages();
  const storage = queueManager.getStorageStatus();
  const mem = process.memoryUsage();

  const queueNames = queueManager.listQueues();
  const perQueue = queueManager.getPerQueueStats();
  const queues = queueNames.map((name) => {
    const counts = queueManager.getQueueJobCounts(name);
    return {
      name,
      waiting: counts.waiting,
      delayed: counts.delayed,
      active: counts.active,
      dlq: perQueue.get(name)?.dlq ?? 0,
      paused: queueManager.isPaused(name),
      totalCompleted: counts.totalCompleted,
      totalFailed: counts.totalFailed,
    };
  });

  const crons = queueManager.listCrons().map((c) => ({
    name: c.name,
    queue: c.queue,
    schedule: c.schedule ?? null,
    nextRun: c.nextRun,
    executions: c.executions,
    maxLimit: c.maxLimit,
    lastRun: c.executions > 0 && c.repeatEvery ? c.nextRun - c.repeatEvery : null,
  }));

  // ─── Heavy data (only when requested) ───
  if (params.includeHeavy) {
    const activeQueues = queues.filter((q) => q.waiting > 0 || q.active > 0 || q.delayed > 0);
    const allQueuesForJobs = queues.length <= 20 ? queues : activeQueues;
    const dlqQueues = queues.filter((q) => q.dlq > 0);

    cachedHeavy = {
      recentJobs: collectRecentJobs(
        queueManager,
        allQueuesForJobs.map((q) => q.name)
      ),
      dlqEntries: collectDlqEntries(
        queueManager,
        dlqQueues.map((q) => q.name)
      ),
      topErrors: collectTopErrors(
        queueManager,
        dlqQueues.map((q) => q.name)
      ),
      workerDetails: queueManager.workerManager.list().map((w) => ({
        id: w.id,
        name: w.name,
        queues: w.queues,
        concurrency: w.concurrency,
        hostname: w.hostname,
        pid: w.pid,
        lastSeen: w.lastSeen,
        activeJobs: w.activeJobs,
        processedJobs: w.processedJobs,
        failedJobs: w.failedJobs,
        currentJob: w.currentJob,
      })),
      queueConfigs: collectQueueConfigs(queueManager, new Set(queueNames)),
      webhooks: collectWebhooks(queueManager),
      s3Backup: serverHandles?.getBackupStatus?.() ?? null,
    };
  }

  return {
    instanceId,
    instanceName,
    version: VERSION,
    hostname: HOST,
    pid: process.pid,
    startedAt,
    timestamp: Date.now(),
    sequenceId,

    stats: {
      waiting: stats.waiting,
      delayed: stats.delayed,
      active: stats.active,
      dlq: stats.dlq,
      completed: stats.completed,
      stalled: memStats.stalledCandidates,
      paused: queues.filter((q) => q.paused).length,
      totalPushed: String(stats.totalPushed),
      totalPulled: String(stats.totalPulled),
      totalCompleted: String(stats.totalCompleted),
      totalFailed: String(stats.totalFailed),
      uptime: stats.uptime,
      cronJobs: stats.cronJobs,
      cronPending: stats.cronPending,
    },

    throughput: rates,
    latency: { averages, percentiles },

    memory: {
      heapUsed: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
      heapTotal: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
      rss: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
      external: Math.round((mem.external / 1024 / 1024) * 100) / 100,
    },

    collections: {
      jobIndex: memStats.jobIndex,
      completedJobs: memStats.completedJobs,
      jobResults: memStats.jobResults,
      jobLogs: memStats.jobLogs,
      customIdMap: memStats.customIdMap,
      jobLocks: memStats.jobLocks,
      processingTotal: memStats.processingTotal,
      queuedTotal: memStats.queuedTotal,
      temporalIndexTotal: memStats.temporalIndexTotal,
      delayedHeapTotal: memStats.delayedHeapTotal,
    },

    queues,
    workers: workerStats,
    crons,
    storage: { diskFull: storage.diskFull, error: storage.error },
    taskErrors: getTaskErrorStats(),

    connections: {
      tcp: serverHandles?.getConnectionCount() ?? 0,
      ws: serverHandles?.getWsClientCount() ?? 0,
      sse: serverHandles?.getSseClientCount() ?? 0,
    },

    // Analytics
    queueThroughput: collectQueueThroughput(queues),
    durationHistogram: collectDurationHistogram(cachedHeavy.recentJobs),
    workerUtilization: collectWorkerUtilization(queueManager),
    sqliteStats: serverHandles?.getSqliteStats?.() ?? null,
    runtime: RUNTIME,
    queueWaitTime: collectQueueWaitTime(cachedHeavy.recentJobs),
    queueRetryRate: collectQueueRetryRate(cachedHeavy.recentJobs),
    queueBacklogVelocity: collectBacklogVelocity(queues),
    stallDetails: await collectStallDetails(queueManager),
    queuePriorityDistribution: collectPriorityDistribution(cachedHeavy.recentJobs),

    // MCP telemetry
    ...(mcpData && mcpData.operations.length > 0
      ? { mcpOperations: mcpData.operations, mcpSummary: mcpData.summary }
      : {}),

    ...cachedHeavy,
  };
}
