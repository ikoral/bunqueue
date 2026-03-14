/**
 * HTTP Routes - Crons, Webhooks, Workers, Monitoring
 * All /crons/*, /webhooks/*, /workers/*, /ping endpoints
 */

import { handleCommand } from './handler';
import type { HandlerContext } from './types';
import { jsonResponse } from './httpEndpoints';

type Body = Record<string, unknown>;
const parseBody = (req: Request): Promise<Body> => req.json().catch(() => ({})) as Promise<Body>;

/** Route cron, webhook, worker, and monitoring requests. Returns Response or null. */
export async function routeResourceRoutes(
  req: Request,
  path: string,
  method: string,
  ctx: HandlerContext,
  cors: Set<string>
): Promise<Response | null> {
  // ── Cron ──────────────────────────────────────────────────

  // GET /crons - list all
  if (path === '/crons' && method === 'GET') {
    const r = await handleCommand({ cmd: 'CronList' }, ctx);
    return jsonResponse(r, 200, cors);
  }

  // POST /crons - add cron
  if (path === '/crons' && method === 'POST') {
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400, cors);
    }
    const r = await handleCommand(
      {
        cmd: 'Cron',
        name: body['name'] as string,
        queue: body['queue'] as string,
        data: body['data'],
        schedule: body['schedule'] as string | undefined,
        repeatEvery: body['repeatEvery'] as number | undefined,
        priority: body['priority'] as number | undefined,
        maxLimit: body['maxLimit'] as number | undefined,
        timezone: body['timezone'] as string | undefined,
      } as Parameters<typeof handleCommand>[0],
      ctx
    );
    return jsonResponse(r, r.ok ? 200 : 400, cors);
  }

  // GET /crons/:name
  const cronGetMatch = path.match(/^\/crons\/([^/]+)$/);
  if (cronGetMatch && method === 'GET') {
    const name = decodeURIComponent(cronGetMatch[1]);
    const r = await handleCommand({ cmd: 'CronGet', name }, ctx);
    return jsonResponse(r, r.ok ? 200 : 404, cors);
  }

  // DELETE /crons/:name
  if (cronGetMatch && method === 'DELETE') {
    const name = decodeURIComponent(cronGetMatch[1]);
    const r = await handleCommand({ cmd: 'CronDelete', name }, ctx);
    return jsonResponse(r, r.ok ? 200 : 404, cors);
  }

  // ── Webhooks ──────────────────────────────────────────────

  // GET /webhooks
  if (path === '/webhooks' && method === 'GET') {
    const r = await handleCommand({ cmd: 'ListWebhooks' }, ctx);
    return jsonResponse(r, 200, cors);
  }

  // POST /webhooks
  if (path === '/webhooks' && method === 'POST') {
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400, cors);
    }
    const r = await handleCommand(
      {
        cmd: 'AddWebhook',
        url: body['url'] as string,
        events: body['events'] as string[],
        queue: body['queue'] as string | undefined,
        secret: body['secret'] as string | undefined,
      } as Parameters<typeof handleCommand>[0],
      ctx
    );
    return jsonResponse(r, r.ok ? 200 : 400, cors);
  }

  // DELETE /webhooks/:id
  const webhookMatch = path.match(/^\/webhooks\/([^/]+)$/);
  if (webhookMatch && method === 'DELETE') {
    const r = await handleCommand(
      {
        cmd: 'RemoveWebhook',
        webhookId: webhookMatch[1],
      } as Parameters<typeof handleCommand>[0],
      ctx
    );
    return jsonResponse(r, r.ok ? 200 : 404, cors);
  }

  // PUT /webhooks/:id/enabled
  const webhookEnabledMatch = path.match(/^\/webhooks\/([^/]+)\/enabled$/);
  if (webhookEnabledMatch && method === 'PUT') {
    const body = await parseBody(req);
    const r = await handleCommand(
      {
        cmd: 'SetWebhookEnabled',
        id: webhookEnabledMatch[1],
        enabled: body['enabled'] as boolean,
      } as Parameters<typeof handleCommand>[0],
      ctx
    );
    return jsonResponse(r, r.ok ? 200 : 400, cors);
  }

  // ── Workers ───────────────────────────────────────────────

  // GET /workers
  if (path === '/workers' && method === 'GET') {
    const r = await handleCommand({ cmd: 'ListWorkers' }, ctx);
    return jsonResponse(r, 200, cors);
  }

  // POST /workers
  if (path === '/workers' && method === 'POST') {
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400, cors);
    }
    const r = await handleCommand(
      {
        cmd: 'RegisterWorker',
        name: body['name'] as string,
        queues: body['queues'] as string[],
      } as Parameters<typeof handleCommand>[0],
      ctx
    );
    return jsonResponse(r, r.ok ? 200 : 400, cors);
  }

  // DELETE /workers/:id
  const workerMatch = path.match(/^\/workers\/([^/]+)$/);
  if (workerMatch && method === 'DELETE') {
    const r = await handleCommand(
      {
        cmd: 'UnregisterWorker',
        workerId: workerMatch[1],
      } as Parameters<typeof handleCommand>[0],
      ctx
    );
    return jsonResponse(r, r.ok ? 200 : 404, cors);
  }

  // POST /workers/:id/heartbeat
  const workerHeartbeatMatch = path.match(/^\/workers\/([^/]+)\/heartbeat$/);
  if (workerHeartbeatMatch && method === 'POST') {
    const r = await handleCommand(
      {
        cmd: 'Heartbeat',
        id: workerHeartbeatMatch[1],
      } as Parameters<typeof handleCommand>[0],
      ctx
    );
    return jsonResponse(r, 200, cors);
  }

  // ── Monitoring ────────────────────────────────────────────

  // GET /ping
  if (path === '/ping' && method === 'GET') {
    const r = await handleCommand({ cmd: 'Ping' }, ctx);
    return jsonResponse(r, 200, cors);
  }

  // GET /storage
  if (path === '/storage' && method === 'GET') {
    const r = await handleCommand({ cmd: 'StorageStatus' }, ctx);
    return jsonResponse(r, 200, cors);
  }

  return null;
}
