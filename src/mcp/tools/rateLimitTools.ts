/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Tools - Rate Limiting & Concurrency Control
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from '../adapter';
import { withErrorHandler } from './withErrorHandler';

export function registerRateLimitTools(server: McpServer, backend: McpBackend) {
  server.tool(
    'bunqueue_set_rate_limit',
    'Set rate limit for a queue (max jobs processed per second).',
    {
      queue: z.string().describe('Queue name'),
      limit: z.number().min(1).describe('Max jobs per second'),
    },
    withErrorHandler('bunqueue_set_rate_limit', async ({ queue, limit }) => {
      await backend.setRateLimit(queue, limit);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true, queue, rateLimit: limit }),
          },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_clear_rate_limit',
    'Remove rate limit from a queue, allowing unlimited throughput.',
    {
      queue: z.string().describe('Queue name'),
    },
    withErrorHandler('bunqueue_clear_rate_limit', async ({ queue }) => {
      await backend.clearRateLimit(queue);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true, queue, message: 'Rate limit cleared' }),
          },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_set_concurrency',
    'Set concurrency limit for a queue (max simultaneous active jobs).',
    {
      queue: z.string().describe('Queue name'),
      limit: z.number().min(1).describe('Max concurrent jobs'),
    },
    withErrorHandler('bunqueue_set_concurrency', async ({ queue, limit }) => {
      await backend.setConcurrency(queue, limit);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true, queue, concurrency: limit }),
          },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_clear_concurrency',
    'Remove concurrency limit from a queue.',
    {
      queue: z.string().describe('Queue name'),
    },
    withErrorHandler('bunqueue_clear_concurrency', async ({ queue }) => {
      await backend.clearConcurrency(queue);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true, queue, message: 'Concurrency limit cleared' }),
          },
        ],
      };
    })
  );
}
