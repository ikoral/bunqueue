/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Tools - Cron Job Management
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from '../adapter';
import { withErrorHandler } from './withErrorHandler';

export function registerCronTools(server: McpServer, backend: McpBackend) {
  server.tool(
    'bunqueue_add_cron',
    'Add a recurring cron job. Use either a cron pattern or repeatEvery interval.',
    {
      name: z.string().describe('Unique cron job name'),
      queue: z.string().describe('Target queue name'),
      data: z.record(z.string(), z.unknown()).describe('Job payload data'),
      schedule: z.string().optional().describe('Cron pattern (e.g., "0 * * * *" for hourly)'),
      repeatEvery: z.number().optional().describe('Alternative: repeat every N milliseconds'),
      priority: z.number().optional().describe('Job priority'),
    },
    withErrorHandler(
      'bunqueue_add_cron',
      async ({ name, queue, data, schedule, repeatEvery, priority }) => {
        const cron = await backend.addCron({ name, queue, data, schedule, repeatEvery, priority });
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ success: true, ...cron }, null, 2) },
          ],
        };
      }
    )
  );

  server.tool(
    'bunqueue_list_crons',
    'List all scheduled cron jobs with their next run times.',
    {},
    withErrorHandler('bunqueue_list_crons', async () => {
      const crons = await backend.listCrons();
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ count: crons.length, crons }, null, 2) },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_get_cron',
    'Get details of a specific cron job by name.',
    {
      name: z.string().describe('Cron job name'),
    },
    withErrorHandler('bunqueue_get_cron', async ({ name }) => {
      const cron = await backend.getCron(name);
      if (!cron) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: 'Cron not found', name }) },
          ],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(cron, null, 2) }] };
    })
  );

  server.tool(
    'bunqueue_delete_cron',
    'Delete a cron job by name.',
    {
      name: z.string().describe('Cron job name to delete'),
    },
    withErrorHandler('bunqueue_delete_cron', async ({ name }) => {
      const success = await backend.deleteCron(name);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success, name }) }] };
    })
  );
}
