/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Tools - Dead Letter Queue Operations
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from '../adapter';

export function registerDlqTools(server: McpServer, backend: McpBackend) {
  server.tool(
    'bunqueue_get_dlq',
    'Get Dead Letter Queue entries for a queue. Shows jobs that permanently failed.',
    {
      queue: z.string().describe('Queue name'),
      limit: z.number().optional().describe('Max entries to return (default: 20)'),
    },
    async ({ queue, limit }) => {
      const jobs = await backend.getDlq(queue, limit ?? 20);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ queue, count: jobs.length, jobs }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    'bunqueue_retry_dlq',
    'Retry jobs from the Dead Letter Queue. Moves them back to waiting state.',
    {
      queue: z.string().describe('Queue name'),
      jobId: z.string().optional().describe('Specific job ID to retry (omit to retry all)'),
    },
    async ({ queue, jobId }) => {
      const retried = await backend.retryDlq(queue, jobId);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ success: true, queue, retried }) },
        ],
      };
    }
  );

  server.tool(
    'bunqueue_purge_dlq',
    'Remove all entries from the Dead Letter Queue permanently.',
    {
      queue: z.string().describe('Queue name'),
    },
    async ({ queue }) => {
      const purged = await backend.purgeDlq(queue);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ success: true, queue, purged }) },
        ],
      };
    }
  );

  server.tool(
    'bunqueue_retry_completed',
    'Retry completed jobs - move them back to waiting state for reprocessing.',
    {
      queue: z.string().describe('Queue name'),
      jobId: z
        .string()
        .optional()
        .describe('Specific job ID to retry (omit to retry all completed)'),
    },
    async ({ queue, jobId }) => {
      const retried = await backend.retryCompleted(queue, jobId);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ success: true, queue, retried }) },
        ],
      };
    }
  );
}
