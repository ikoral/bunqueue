/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Tools - Monitoring, Stats, Workers, Logs
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from '../adapter';

export function registerMonitoringTools(server: McpServer, backend: McpBackend) {
  server.tool(
    'bunqueue_get_stats',
    'Get overall queue server statistics including throughput, memory usage, and uptime.',
    {},
    async () => {
      const stats = await backend.getStats();
      return { content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }] };
    }
  );

  server.tool(
    'bunqueue_get_queue_stats',
    'Get detailed statistics for a specific queue including job counts per state.',
    {
      queue: z.string().describe('Queue name'),
    },
    async ({ queue }) => {
      const counts = await backend.getJobCounts(queue);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ queue, ...counts }, null, 2) }],
      };
    }
  );

  server.tool(
    'bunqueue_list_workers',
    'List all registered workers with their status, queues, and processing stats.',
    {},
    async () => {
      const workers = await backend.listWorkers();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ count: workers.length, workers }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    'bunqueue_get_job_logs',
    'Get log entries for a specific job.',
    {
      jobId: z.string().describe('Job ID'),
    },
    async ({ jobId }) => {
      const logs = await backend.getJobLogs(jobId);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ jobId, count: logs.length, logs }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    'bunqueue_add_job_log',
    'Add a log entry to a job.',
    {
      jobId: z.string().describe('Job ID'),
      message: z.string().describe('Log message'),
      level: z.enum(['info', 'warn', 'error']).optional().describe('Log level (default: info)'),
    },
    async ({ jobId, message, level }) => {
      const success = await backend.addJobLog(jobId, message, level);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success, jobId }) }] };
    }
  );

  server.tool(
    'bunqueue_get_storage_status',
    'Get storage health status. Reports if disk is full or has errors.',
    {},
    async () => {
      const status = await backend.getStorageStatus();
      return { content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }] };
    }
  );

  server.tool(
    'bunqueue_get_per_queue_stats',
    'Get detailed statistics broken down per queue (throughput, latency, etc.).',
    {},
    async () => {
      const stats = await backend.getPerQueueStats();
      return { content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }] };
    }
  );

  server.tool(
    'bunqueue_get_memory_stats',
    'Get memory usage statistics (jobIndex, completedJobs, cache sizes, etc.).',
    {},
    async () => {
      const stats = await backend.getMemoryStats();
      return { content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }] };
    }
  );

  server.tool(
    'bunqueue_get_prometheus_metrics',
    'Get metrics in Prometheus exposition format for monitoring.',
    {},
    async () => {
      const metrics = await backend.getPrometheusMetrics();
      return { content: [{ type: 'text' as const, text: metrics }] };
    }
  );

  server.tool(
    'bunqueue_clear_job_logs',
    'Clear log entries for a specific job, optionally keeping the last N entries.',
    {
      jobId: z.string().describe('Job ID'),
      keepLogs: z
        .number()
        .min(0)
        .optional()
        .describe('Number of recent log entries to keep (default: 0 = clear all)'),
    },
    async ({ jobId, keepLogs }) => {
      await backend.clearJobLogs(jobId, keepLogs);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, jobId }) }],
      };
    }
  );

  server.tool(
    'bunqueue_compact_memory',
    'Force memory compaction to free unused memory.',
    {},
    async () => {
      await backend.compactMemory();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true, message: 'Memory compaction triggered' }),
          },
        ],
      };
    }
  );
}
