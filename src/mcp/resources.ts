/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Resources
 * Read-only data resources for AI context
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from './adapter';

function withResourceErrorHandler(
  uri: string,
  fn: () => Promise<{ contents: Array<{ uri: string; text: string; mimeType: string }> }>
) {
  return async () => {
    try {
      return await fn();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        contents: [
          {
            uri,
            text: JSON.stringify({ error: message, isError: true }),
            mimeType: 'application/json',
          },
        ],
      };
    }
  };
}

export function registerResources(server: McpServer, backend: McpBackend) {
  // Global stats resource
  server.resource(
    'stats',
    'bunqueue://stats',
    { description: 'Overall queue server statistics', mimeType: 'application/json' },
    withResourceErrorHandler('bunqueue://stats', async () => {
      const stats = await backend.getStats();
      return {
        contents: [
          {
            uri: 'bunqueue://stats',
            text: JSON.stringify(stats, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    })
  );

  // Queues list resource
  server.resource(
    'queues',
    'bunqueue://queues',
    { description: 'All queues with job counts per state', mimeType: 'application/json' },
    withResourceErrorHandler('bunqueue://queues', async () => {
      const queues = await backend.listQueues();
      const details = await Promise.all(
        queues.map(async (q) => {
          const counts = await backend.getJobCounts(q);
          return { name: q, ...counts };
        })
      );
      return {
        contents: [
          {
            uri: 'bunqueue://queues',
            text: JSON.stringify(details, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    })
  );

  // Cron jobs resource
  server.resource(
    'crons',
    'bunqueue://crons',
    { description: 'All scheduled cron jobs', mimeType: 'application/json' },
    withResourceErrorHandler('bunqueue://crons', async () => {
      const crons = await backend.listCrons();
      return {
        contents: [
          {
            uri: 'bunqueue://crons',
            text: JSON.stringify(crons, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    })
  );

  // Workers resource
  server.resource(
    'workers',
    'bunqueue://workers',
    { description: 'Active workers and their status', mimeType: 'application/json' },
    withResourceErrorHandler('bunqueue://workers', async () => {
      const workers = await backend.listWorkers();
      return {
        contents: [
          {
            uri: 'bunqueue://workers',
            text: JSON.stringify(workers, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    })
  );

  // Webhooks resource
  server.resource(
    'webhooks',
    'bunqueue://webhooks',
    { description: 'Registered webhooks', mimeType: 'application/json' },
    withResourceErrorHandler('bunqueue://webhooks', async () => {
      const webhooks = await backend.listWebhooks();
      return {
        contents: [
          {
            uri: 'bunqueue://webhooks',
            text: JSON.stringify(webhooks, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    })
  );
}
