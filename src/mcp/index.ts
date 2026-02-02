#!/usr/bin/env bun
/**
 * bunqueue MCP Server
 *
 * Model Context Protocol server for bunqueue job queue management.
 * Allows AI assistants to manage queues, jobs, DLQ, and cron schedules.
 *
 * @example
 * Add to Claude Desktop config:
 * ```json
 * {
 *   "mcpServers": {
 *     "bunqueue": {
 *       "command": "bunx",
 *       "args": ["bunqueue-mcp"]
 *     }
 *   }
 * }
 * ```
 */

import { shutdownManager } from '../client/manager';
import { VERSION } from '../shared/version';
import { TOOLS } from './mcpTools';
import { handleToolCall, type ToolArgs } from './mcpHandlers';

interface McpRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function createResponse(id: number | string, result: unknown): McpResponse {
  return { jsonrpc: '2.0', id, result };
}

function createError(id: number | string, code: number, message: string): McpResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRequest(request: McpRequest): Promise<McpResponse> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case 'initialize':
        return createResponse(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'bunqueue-mcp', version: VERSION },
        });

      case 'tools/list':
        return createResponse(id, { tools: TOOLS });

      case 'tools/call': {
        const toolName = params?.name as string;
        const args = (params?.arguments ?? {}) as ToolArgs;
        const result = await handleToolCall(toolName, args);
        return createResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return createResponse(id, {});

      default:
        return createError(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return createError(id, -32603, message);
  }
}

async function main() {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  process.stderr.write('bunqueue MCP server started\n');

  let buffer = '';

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    shutdownManager();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    shutdownManager();
    process.exit(0);
  });

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk);

    let headerEnd = buffer.indexOf('\r\n\r\n');
    while (headerEnd !== -1) {
      const header = buffer.slice(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length: (\d+)/i);
      if (!contentLengthMatch) {
        buffer = buffer.slice(headerEnd + 4);
        headerEnd = buffer.indexOf('\r\n\r\n');
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (buffer.length < messageEnd) break;

      const message = buffer.slice(messageStart, messageEnd);
      buffer = buffer.slice(messageEnd);

      try {
        const request = JSON.parse(message) as McpRequest;
        const response = await handleRequest(request);
        const responseJson = JSON.stringify(response);
        const responseHeader = `Content-Length: ${encoder.encode(responseJson).byteLength}\r\n\r\n`;
        process.stdout.write(encoder.encode(responseHeader + responseJson));
      } catch {
        process.stderr.write(`Failed to parse message: ${message}\n`);
      }

      headerEnd = buffer.indexOf('\r\n\r\n');
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
