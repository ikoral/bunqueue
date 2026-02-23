#!/usr/bin/env bun
/**
 * bunqueue MCP Server
 *
 * Model Context Protocol server for bunqueue job queue management.
 * Uses the official @modelcontextprotocol/sdk for protocol compliance.
 *
 * Supports two connection modes:
 * - embedded (default): Direct SQLite access via QueueManager
 * - tcp: Connect to a remote bunqueue server
 *
 * @example Embedded mode (Claude Desktop):
 * ```json
 * {
 *   "mcpServers": {
 *     "bunqueue": {
 *       "command": "bunx",
 *       "args": ["bunqueue-mcp"],
 *       "env": { "DATA_PATH": "./data/bunq.db" }
 *     }
 *   }
 * }
 * ```
 *
 * @example TCP mode (remote server):
 * ```json
 * {
 *   "mcpServers": {
 *     "bunqueue": {
 *       "command": "bunx",
 *       "args": ["bunqueue-mcp"],
 *       "env": {
 *         "BUNQUEUE_MODE": "tcp",
 *         "BUNQUEUE_HOST": "localhost",
 *         "BUNQUEUE_PORT": "6789",
 *         "BUNQUEUE_TOKEN": "secret"
 *       }
 *     }
 *   }
 * }
 * ```
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VERSION } from '../shared/version';
import { createBackend } from './adapter';
import { registerResources } from './resources';
import { registerJobTools } from './tools/jobTools';
import { registerJobMgmtTools } from './tools/jobMgmtTools';
import { registerConsumptionTools } from './tools/consumptionTools';
import { registerQueueTools } from './tools/queueTools';
import { registerDlqTools } from './tools/dlqTools';
import { registerCronTools } from './tools/cronTools';
import { registerRateLimitTools } from './tools/rateLimitTools';
import { registerWebhookTools } from './tools/webhookTools';
import { registerWorkerMgmtTools } from './tools/workerMgmtTools';
import { registerMonitoringTools } from './tools/monitoringTools';

async function main() {
  const backend = createBackend();
  const mode = process.env.BUNQUEUE_MODE ?? 'embedded';

  const server = new McpServer({
    name: 'bunqueue-mcp',
    version: VERSION,
  });

  // Register all tools (66 total)
  registerJobTools(server, backend);
  registerJobMgmtTools(server, backend);
  registerConsumptionTools(server, backend);
  registerQueueTools(server, backend);
  registerDlqTools(server, backend);
  registerCronTools(server, backend);
  registerRateLimitTools(server, backend);
  registerWebhookTools(server, backend);
  registerWorkerMgmtTools(server, backend);
  registerMonitoringTools(server, backend);

  // Register resources
  registerResources(server, backend);

  // Graceful shutdown
  const shutdown = () => {
    backend.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(`bunqueue MCP server started (mode: ${mode}, version: ${VERSION})\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
