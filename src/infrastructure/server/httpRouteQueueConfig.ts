/**
 * HTTP Routes - Queue config, DLQ, rate-limiting, concurrency
 * All /queues/:queue/{dlq,rate-limit,concurrency,stall-config,dlq-config} endpoints
 */

import { handleCommand } from './handler';
import type { HandlerContext } from './types';
import { jsonResponse } from './httpEndpoints';

type Body = Record<string, unknown>;
const parseBody = (req: Request): Promise<Body> => req.json().catch(() => ({})) as Promise<Body>;

/** Route queue config/admin requests. Returns Response or null if no match. */
export async function routeQueueConfigRoutes(
  req: Request,
  path: string,
  method: string,
  ctx: HandlerContext,
  cors: Set<string>
): Promise<Response | null> {
  // DLQ: GET /queues/:queue/dlq
  const dlqMatch = path.match(/^\/queues\/([^/]+)\/dlq$/);
  if (dlqMatch && method === 'GET') {
    const queue = decodeURIComponent(dlqMatch[1]);
    const count = parseInt(new URL(req.url).searchParams.get('count') ?? '100');
    const r = await handleCommand({ cmd: 'Dlq', queue, count }, ctx);
    return jsonResponse(r, 200, cors);
  }

  // POST /queues/:queue/dlq/retry
  const dlqRetryMatch = path.match(/^\/queues\/([^/]+)\/dlq\/retry$/);
  if (dlqRetryMatch && method === 'POST') {
    const queue = decodeURIComponent(dlqRetryMatch[1]);
    const body = await parseBody(req);
    const r = await handleCommand(
      {
        cmd: 'RetryDlq',
        queue,
        jobId: body['jobId'] as string | undefined,
      } as Parameters<typeof handleCommand>[0],
      ctx
    );
    return jsonResponse(r, 200, cors);
  }

  // POST /queues/:queue/dlq/purge
  const dlqPurgeMatch = path.match(/^\/queues\/([^/]+)\/dlq\/purge$/);
  if (dlqPurgeMatch && method === 'POST') {
    const queue = decodeURIComponent(dlqPurgeMatch[1]);
    const r = await handleCommand({ cmd: 'PurgeDlq', queue }, ctx);
    return jsonResponse(r, 200, cors);
  }

  // Rate limiting: PUT/DELETE /queues/:queue/rate-limit
  const rateLimitMatch = path.match(/^\/queues\/([^/]+)\/rate-limit$/);
  if (rateLimitMatch && method === 'PUT') {
    const queue = decodeURIComponent(rateLimitMatch[1]);
    const body = await parseBody(req);
    const r = await handleCommand(
      {
        cmd: 'RateLimit',
        queue,
        limit: body['limit'] as number,
      } as Parameters<typeof handleCommand>[0],
      ctx
    );
    return jsonResponse(r, 200, cors);
  }
  if (rateLimitMatch && method === 'DELETE') {
    const queue = decodeURIComponent(rateLimitMatch[1]);
    const r = await handleCommand({ cmd: 'RateLimitClear', queue }, ctx);
    return jsonResponse(r, 200, cors);
  }

  // Concurrency: PUT/DELETE /queues/:queue/concurrency
  const concurrencyMatch = path.match(/^\/queues\/([^/]+)\/concurrency$/);
  if (concurrencyMatch && method === 'PUT') {
    const queue = decodeURIComponent(concurrencyMatch[1]);
    const body = await parseBody(req);
    const r = await handleCommand(
      {
        cmd: 'SetConcurrency',
        queue,
        limit: body['limit'] as number,
      } as Parameters<typeof handleCommand>[0],
      ctx
    );
    return jsonResponse(r, 200, cors);
  }
  if (concurrencyMatch && method === 'DELETE') {
    const queue = decodeURIComponent(concurrencyMatch[1]);
    const r = await handleCommand({ cmd: 'ClearConcurrency', queue }, ctx);
    return jsonResponse(r, 200, cors);
  }

  // Config: GET/PUT /queues/:queue/stall-config
  const stallConfigMatch = path.match(/^\/queues\/([^/]+)\/stall-config$/);
  if (stallConfigMatch && method === 'GET') {
    const queue = decodeURIComponent(stallConfigMatch[1]);
    const r = await handleCommand({ cmd: 'GetStallConfig', queue }, ctx);
    return jsonResponse(r, 200, cors);
  }
  if (stallConfigMatch && method === 'PUT') {
    const queue = decodeURIComponent(stallConfigMatch[1]);
    const body = await parseBody(req);
    const r = await handleCommand(
      {
        cmd: 'SetStallConfig',
        queue,
        config: body['config'] ?? body,
      } as Parameters<typeof handleCommand>[0],
      ctx
    );
    return jsonResponse(r, 200, cors);
  }

  // Config: GET/PUT /queues/:queue/dlq-config
  const dlqConfigMatch = path.match(/^\/queues\/([^/]+)\/dlq-config$/);
  if (dlqConfigMatch && method === 'GET') {
    const queue = decodeURIComponent(dlqConfigMatch[1]);
    const r = await handleCommand({ cmd: 'GetDlqConfig', queue }, ctx);
    return jsonResponse(r, 200, cors);
  }
  if (dlqConfigMatch && method === 'PUT') {
    const queue = decodeURIComponent(dlqConfigMatch[1]);
    const body = await parseBody(req);
    const r = await handleCommand(
      {
        cmd: 'SetDlqConfig',
        queue,
        config: body['config'] ?? body,
      } as Parameters<typeof handleCommand>[0],
      ctx
    );
    return jsonResponse(r, 200, cors);
  }

  return null;
}
