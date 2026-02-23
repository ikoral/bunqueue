/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Tools - Job Consumption (Pull/Ack/Fail cycle)
 * Heartbeat, lock management
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from '../adapter';
import { withErrorHandler } from './withErrorHandler';

export function registerConsumptionTools(server: McpServer, backend: McpBackend) {
  server.tool(
    'bunqueue_pull_job',
    'Pull a single job from a queue for processing. Returns null if no jobs available.',
    {
      queue: z.string().describe('Queue name'),
      timeoutMs: z
        .number()
        .min(0)
        .max(30000)
        .optional()
        .describe('Long-poll timeout in ms (0 = no wait)'),
    },
    withErrorHandler(async ({ queue, timeoutMs }) => {
      const job = await backend.pullJob(queue, timeoutMs);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(job ? { job } : { job: null }, null, 2) },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_pull_job_batch',
    'Pull multiple jobs from a queue in one operation.',
    {
      queue: z.string().describe('Queue name'),
      count: z.number().min(1).max(1000).describe('Number of jobs to pull'),
      timeoutMs: z
        .number()
        .min(0)
        .max(30000)
        .optional()
        .describe('Long-poll timeout in ms (0 = no wait)'),
    },
    withErrorHandler(async ({ queue, count, timeoutMs }) => {
      const jobs = await backend.pullJobBatch(queue, count, timeoutMs);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ count: jobs.length, jobs }, null, 2) },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_ack_job',
    'Acknowledge a job as completed with an optional result.',
    {
      jobId: z.string().describe('Job ID to acknowledge'),
      result: z.unknown().optional().describe('Optional result data'),
    },
    withErrorHandler(async ({ jobId, result }) => {
      await backend.ackJob(jobId, result);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, jobId }) }],
      };
    })
  );

  server.tool(
    'bunqueue_ack_job_batch',
    'Acknowledge multiple jobs as completed in one operation.',
    {
      jobIds: z.array(z.string()).min(1).describe('Array of job IDs to acknowledge'),
    },
    withErrorHandler(async ({ jobIds }) => {
      await backend.ackJobBatch(jobIds);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ success: true, count: jobIds.length }) },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_fail_job',
    'Mark a job as failed with an optional error message.',
    {
      jobId: z.string().describe('Job ID to fail'),
      error: z.string().optional().describe('Error message'),
    },
    withErrorHandler(async ({ jobId, error }) => {
      await backend.failJob(jobId, error);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, jobId }) }],
      };
    })
  );

  server.tool(
    'bunqueue_job_heartbeat',
    'Send a heartbeat for an active job to prevent stall detection.',
    {
      jobId: z.string().describe('Job ID'),
    },
    withErrorHandler(async ({ jobId }) => {
      const success = await backend.jobHeartbeat(jobId);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success, jobId }) }] };
    })
  );

  server.tool(
    'bunqueue_job_heartbeat_batch',
    'Send heartbeats for multiple active jobs at once.',
    {
      jobIds: z.array(z.string()).min(1).describe('Array of job IDs'),
    },
    withErrorHandler(async ({ jobIds }) => {
      const count = await backend.jobHeartbeatBatch(jobIds);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ success: true, acknowledged: count }) },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_extend_lock',
    'Extend the lock on an active job to prevent it from being reclaimed.',
    {
      jobId: z.string().describe('Job ID'),
      token: z.string().describe('Lock token'),
      duration: z.number().min(1000).describe('Extension duration in milliseconds'),
    },
    withErrorHandler(async ({ jobId, token, duration }) => {
      const success = await backend.extendLock(jobId, token, duration);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success, jobId }) }] };
    })
  );
}
