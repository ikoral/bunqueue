/**
 * Issue #77 - Queue prefixKey for environment isolation
 * https://github.com/egeominotti/bunqueue/issues/77
 *
 * Allows two Queue/Worker instances that share the same broker to be
 * isolated when they pass different `prefixKey` values. The same logical
 * queue name (e.g. `'emails'`) is namespaced into separate server-side
 * queues (`'dev:emails'`, `'prod:emails'`), so jobs, workers, cron
 * schedulers, counts, pause/resume, and DLQ never cross environments.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { Queue } from '../src/client/queue';
import { Worker } from '../src/client/worker';
import { Bunqueue } from '../src/client/bunqueue';

describe('Issue #77 - Queue prefixKey isolation', () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanup.length) {
      try {
        await cleanup.pop()!();
      } catch {
        // best-effort
      }
    }
  });

  test('keeps the user-facing logical name on Queue.name', () => {
    const q = new Queue('emails', { embedded: true, prefixKey: 'dev:' });
    cleanup.push(() => q.close());
    expect(q.name).toBe('emails');
  });

  test('jobs added through different prefixKeys do not cross over', async () => {
    const dev = new Queue<{ env: string }>('emails', {
      embedded: true,
      prefixKey: 'dev:',
    });
    const prod = new Queue<{ env: string }>('emails', {
      embedded: true,
      prefixKey: 'prod:',
    });
    cleanup.push(() => dev.close());
    cleanup.push(() => prod.close());

    await dev.add('send', { env: 'dev' }, { durable: true });
    await dev.add('send', { env: 'dev' }, { durable: true });
    await prod.add('send', { env: 'prod' }, { durable: true });

    // Each namespace sees only its own jobs.
    expect(await dev.count()).toBe(2);
    expect(await prod.count()).toBe(1);
  });

  test('a worker only consumes jobs from its own prefixKey namespace', async () => {
    const dev = new Queue<{ env: string }>('jobs', {
      embedded: true,
      prefixKey: 'dev:',
    });
    const prod = new Queue<{ env: string }>('jobs', {
      embedded: true,
      prefixKey: 'prod:',
    });
    cleanup.push(() => dev.close());
    cleanup.push(() => prod.close());

    await dev.add('task', { env: 'dev' }, { durable: true });
    await prod.add('task', { env: 'prod' }, { durable: true });

    const devSeen: string[] = [];
    const devWorker = new Worker<{ env: string }>(
      'jobs',
      async (job) => {
        devSeen.push(job.data.env);
        return { ok: true };
      },
      { embedded: true, prefixKey: 'dev:', autorun: true }
    );
    cleanup.push(() => devWorker.close(true));

    const deadline = Date.now() + 2000;
    while (devSeen.length < 1 && Date.now() < deadline) {
      await Bun.sleep(20);
    }

    expect(devSeen).toEqual(['dev']);
    // The prod job is untouched and still pending in its own namespace.
    expect(await prod.count()).toBe(1);
    expect(await dev.count()).toBe(0);
  });

  test('a worker without prefixKey does not see prefixed jobs', async () => {
    const prefixed = new Queue<{ tag: string }>('shared', {
      embedded: true,
      prefixKey: 'dev:',
    });
    cleanup.push(() => prefixed.close());

    await prefixed.add('task', { tag: 'prefixed' }, { durable: true });

    const seen: string[] = [];
    const plainWorker = new Worker<{ tag: string }>(
      'shared',
      async (job) => {
        seen.push(job.data.tag);
        return { ok: true };
      },
      { embedded: true, autorun: true }
    );
    cleanup.push(() => plainWorker.close(true));

    // Give the worker a chance to (incorrectly) pick the job up.
    await Bun.sleep(200);

    expect(seen).toEqual([]);
    expect(await prefixed.count()).toBe(1);
  });

  test('pause/resume only affects the prefixed namespace', async () => {
    const dev = new Queue('control', { embedded: true, prefixKey: 'dev:' });
    const prod = new Queue('control', { embedded: true, prefixKey: 'prod:' });
    cleanup.push(() => dev.close());
    cleanup.push(() => prod.close());

    dev.pause();
    // Pause is async via the write buffer; give it a tick.
    await Bun.sleep(20);

    expect(await dev.isPausedAsync()).toBe(true);
    expect(await prod.isPausedAsync()).toBe(false);
  });

  test('cron schedulers are isolated per prefixKey', async () => {
    const dev = new Bunqueue('reports', {
      embedded: true,
      prefixKey: 'dev:',
      processor: async () => ({ ok: true }),
      autorun: false,
    });
    const prod = new Bunqueue('reports', {
      embedded: true,
      prefixKey: 'prod:',
      processor: async () => ({ ok: true }),
      autorun: false,
    });
    cleanup.push(() => dev.close(true));
    cleanup.push(() => prod.close(true));

    // Same logical scheduler id `daily-report` in both namespaces — must NOT
    // collide on the global cron-name PRIMARY KEY.
    await dev.cron('daily-report', '0 9 * * *');
    await prod.cron('daily-report', '0 9 * * *');

    const devCrons = await dev.listCrons();
    const prodCrons = await prod.listCrons();

    expect(devCrons.length).toBe(1);
    expect(prodCrons.length).toBe(1);
    // Each side reports its scheduler under the original logical id.
    expect(devCrons[0].id).toBe('daily-report');
    expect(prodCrons[0].id).toBe('daily-report');
  });

  test('removeCron in one namespace does not touch the other', async () => {
    const dev = new Queue('cron-remove', { embedded: true, prefixKey: 'dev:' });
    const prod = new Queue('cron-remove', { embedded: true, prefixKey: 'prod:' });
    cleanup.push(() => dev.close());
    cleanup.push(() => prod.close());

    await dev.upsertJobScheduler('hourly', { every: 60_000 });
    await prod.upsertJobScheduler('hourly', { every: 60_000 });

    await dev.removeJobScheduler('hourly');

    expect((await dev.getJobSchedulers()).length).toBe(0);
    expect((await prod.getJobSchedulers()).length).toBe(1);
  });

  test('omitting prefixKey preserves existing behavior', async () => {
    const a = new Queue<{ n: number }>('legacy-77', { embedded: true });
    const b = new Queue<{ n: number }>('legacy-77', { embedded: true });
    cleanup.push(() => a.close());
    cleanup.push(() => b.close());

    await a.add('task', { n: 1 }, { durable: true });

    // Without prefixKey, both Queue instances point at the same logical
    // queue, so b sees the job a added.
    expect(await b.count()).toBe(1);
  });
});
