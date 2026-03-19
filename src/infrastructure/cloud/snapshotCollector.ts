/**
 * Snapshot Collector
 * Two-tier collection: light (every 5s) + heavy (every 30s)
 *
 * Light: stats, throughput, latency, memory, connections — O(SHARD_COUNT)
 * Heavy: recentJobs, dlqEntries, topErrors, workerDetails, queueConfigs, webhooks — O(queues × shards)
 * Queues are always collected but use a single pass with cached counts.
 */

import { hostname } from 'os';
import type { QueueManager } from '../../application/queueManager';
import { throughputTracker } from '../../application/throughputTracker';
import { latencyTracker } from '../../application/latencyTracker';
import { getTaskErrorStats } from '../../application/backgroundTasks';
import { VERSION } from '../../shared/version';
import type { CloudSnapshot } from './types';

/** Cached hostname — computed once */
const HOST = hostname();

/** Optional server handles for connection stats + backup */
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
}

/** Parameters for snapshot collection */
export interface CollectSnapshotParams {
  queueManager: QueueManager;
  instanceId: string;
  instanceName: string;
  startedAt: number;
  sequenceId: number;
  serverHandles?: ServerHandles;
  /** Include heavy data (recentJobs, dlqEntries, topErrors, workerDetails, queueConfigs, webhooks) */
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
export function collectSnapshot(params: CollectSnapshotParams): CloudSnapshot {
  const { queueManager, instanceId, instanceName, startedAt, sequenceId, serverHandles } = params;

  // ─── Light data (O(SHARD_COUNT), every snapshot) ───
  const stats = queueManager.getStats();
  const memStats = queueManager.getMemoryStats();
  const workerStats = queueManager.workerManager.getStats();
  const rates = throughputTracker.getRates();
  const percentiles = latencyTracker.getPercentiles();
  const averages = latencyTracker.getAverages();
  const storage = queueManager.getStorageStatus();
  const mem = process.memoryUsage();

  // Queues: single pass — listQueues + getQueueJobCounts + perQueueStats for DLQ
  // Avoids getQueuesSummary() which internally calls getQueueJobCounts but drops totalCompleted/totalFailed
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

  // Crons (cheap, in-memory list)
  const crons = queueManager.listCrons().map((c) => ({
    name: c.name,
    queue: c.queue,
    schedule: c.schedule ?? null,
    nextRun: c.nextRun,
    executions: c.executions,
    maxLimit: c.maxLimit,
  }));

  // ─── Heavy data (only when requested) ───
  if (params.includeHeavy) {
    const activeQueues = queues.filter((q) => q.waiting > 0 || q.active > 0 || q.delayed > 0);
    const dlqQueues = queues.filter((q) => q.dlq > 0);

    cachedHeavy = {
      recentJobs: collectRecentJobs(
        queueManager,
        activeQueues.map((q) => q.name)
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
      queueConfigs: collectQueueConfigs(queueManager, queueNames),
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

    // Heavy data (fresh or cached)
    ...cachedHeavy,
  };
}

// ─── Heavy data collectors (only called every ~30s) ───

/** Collect recent jobs — only from active queues */
function collectRecentJobs(
  queueManager: QueueManager,
  activeQueueNames: string[]
): CloudSnapshot['recentJobs'] {
  if (activeQueueNames.length === 0) return [];

  const jobs: CloudSnapshot['recentJobs'] = [];
  const perQueue = Math.max(1, Math.floor(50 / activeQueueNames.length));

  for (const name of activeQueueNames) {
    try {
      const queueJobs = queueManager.getJobs(name, {
        state: ['waiting', 'active', 'delayed'],
        start: 0,
        end: perQueue - 1,
      });
      for (const j of queueJobs) {
        const data = j.data as Record<string, unknown> | undefined;
        const state = j.completedAt
          ? 'completed'
          : j.startedAt
            ? 'active'
            : j.runAt > Date.now()
              ? 'delayed'
              : 'waiting';

        jobs.push({
          id: String(j.id),
          name: (data?.name as string | undefined) ?? 'default',
          queue: j.queue,
          state,
          data,
          priority: j.priority,
          createdAt: j.createdAt,
          startedAt: j.startedAt ?? undefined,
          completedAt: j.completedAt ?? undefined,
          failedReason:
            state === 'active' && j.attempts > 0
              ? `Retry ${j.attempts}/${j.maxAttempts}`
              : undefined,
          attempts: j.attempts,
          maxAttempts: j.maxAttempts,
          duration: j.completedAt && j.startedAt ? j.completedAt - j.startedAt : undefined,
          progress: j.progress > 0 ? j.progress : undefined,
        });
      }
    } catch {
      // Skip queue on error
    }
  }

  return jobs.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
}

/** Collect DLQ entries — only from queues with DLQ > 0 */
function collectDlqEntries(
  queueManager: QueueManager,
  dlqQueueNames: string[]
): CloudSnapshot['dlqEntries'] {
  if (dlqQueueNames.length === 0) return [];

  const entries: CloudSnapshot['dlqEntries'] = [];

  for (const name of dlqQueueNames) {
    try {
      const dlq = queueManager.getDlqEntries(name);
      for (const e of dlq.slice(0, 20)) {
        entries.push({
          jobId: String(e.job.id),
          queue: e.job.queue,
          reason: e.reason,
          error: e.error,
          enteredAt: e.enteredAt,
          retryCount: e.retryCount,
          attempts: e.job.attempts,
        });
      }
    } catch {
      // Skip
    }
  }

  return entries.sort((a, b) => b.enteredAt - a.enteredAt).slice(0, 50);
}

/** Collect per-queue config */
function collectQueueConfigs(
  queueManager: QueueManager,
  queueNames: string[]
): CloudSnapshot['queueConfigs'] {
  const configs: CloudSnapshot['queueConfigs'] = {};
  const perQueue = queueManager.getPerQueueStats();

  for (const name of queueNames) {
    try {
      const stall = queueManager.getStallConfig(name);
      const dlq = queueManager.getDlqConfig(name);
      const pq = perQueue.get(name);
      configs[name] = {
        paused: queueManager.isPaused(name),
        rateLimit: null,
        concurrencyLimit: null,
        concurrencyActive: pq?.active ?? 0,
        stallConfig: { stallInterval: stall.stallInterval, maxStalls: stall.maxStalls },
        dlqConfig: { maxRetries: dlq.maxAutoRetries, maxAge: dlq.maxAge ?? 0 },
      };
    } catch {
      // Skip
    }
  }

  return configs;
}

/** Collect webhook delivery stats */
function collectWebhooks(queueManager: QueueManager): CloudSnapshot['webhooks'] {
  try {
    return queueManager.webhookManager.list().map((w) => ({
      id: w.id,
      url: w.url,
      events: w.events,
      queue: w.queue,
      enabled: w.enabled,
      successCount: w.successCount,
      failureCount: w.failureCount,
      lastTriggered: w.lastTriggered,
    }));
  } catch {
    return [];
  }
}

/** Collect top errors — only from queues with DLQ entries */
function collectTopErrors(
  queueManager: QueueManager,
  dlqQueueNames: string[]
): CloudSnapshot['topErrors'] {
  if (dlqQueueNames.length === 0) return [];

  const errorMap = new Map<string, { count: number; queue: string; lastSeen: number }>();

  const allEntries = dlqQueueNames.flatMap((name) => {
    try {
      return queueManager.getDlqEntries(name);
    } catch {
      return [];
    }
  });

  for (const e of allEntries) {
    const msg = e.error ?? e.reason;
    const existing = errorMap.get(msg);
    if (existing) {
      existing.count++;
      if (e.enteredAt > existing.lastSeen) {
        existing.lastSeen = e.enteredAt;
        existing.queue = e.job.queue;
      }
    } else {
      errorMap.set(msg, { count: 1, queue: e.job.queue, lastSeen: e.enteredAt });
    }
  }

  return [...errorMap.entries()]
    .map(([message, data]) => ({ message, ...data }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
}
