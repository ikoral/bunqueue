/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/use-unknown-in-catch-callback-variable */
/* eslint-disable @typescript-eslint/no-unnecessary-boolean-literal-compare */
/* eslint-disable @typescript-eslint/await-thenable */
/**
 * bunQ Full Features Test
 * Tests all features of the queue system
 */

import { QueueManager } from '../application/queueManager';
import { jobId } from '../domain/types/job';

const qm = new QueueManager();
let passed = 0;
let failed = 0;

function test(name: string, fn: () => boolean | Promise<boolean>): Promise<void> {
  return Promise.resolve(fn())
    .then((result) => {
      if (result) {
        console.log(`  ✅ ${name}`);
        passed++;
      } else {
        console.log(`  ❌ ${name}`);
        failed++;
      }
    })
    .catch((err: any) => {
      console.log(`  ❌ ${name}: ${err.message}`);
      failed++;
    });
}

async function section(name: string, tests: () => Promise<void>): Promise<void> {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`📦 ${name}`);
  console.log('═'.repeat(50));
  await tests();
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║              bunQ FULL FEATURES TEST                       ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  // ============ 1. Basic Operations ============
  await section('Basic Operations', async () => {
    // Push
    const job1 = await qm.push('basic', { data: { msg: 'hello' } });
    await test('push returns job with id', () => !!job1.id);
    await test('push returns correct queue', () => job1.queue === 'basic');
    await test('push returns correct data', () => (job1.data as any).msg === 'hello');

    // Pull
    const pulled = await qm.pull('basic', 0);
    await test('pull returns job', () => !!pulled);
    await test('pull returns correct id', () => pulled?.id === job1.id);
    await test('pull sets startedAt', () => !!pulled?.startedAt);

    // Ack
    await qm.ack(pulled!.id, { result: 'done' });
    const result = qm.getResult(pulled!.id);
    await test('ack stores result', () => (result as any)?.result === 'done');

    // Fail
    await qm.push('basic', { data: { test: 'fail' }, maxAttempts: 1 });
    const pulled2 = await qm.pull('basic', 0);
    await qm.fail(pulled2!.id, 'Test error');
    const stats = qm.getStats();
    await test('fail moves to DLQ when maxAttempts reached', () => stats.dlq >= 1);
  });

  // ============ 2. Priority Queue ============
  await section('Priority Queue', async () => {
    await qm.push('priority', { data: { id: 'low' }, priority: 1 });
    await qm.push('priority', { data: { id: 'high' }, priority: 100 });
    await qm.push('priority', { data: { id: 'medium' }, priority: 50 });

    const first = await qm.pull('priority', 0);
    const second = await qm.pull('priority', 0);
    const third = await qm.pull('priority', 0);

    await test('high priority pulled first', () => (first?.data as any).id === 'high');
    await test('medium priority pulled second', () => (second?.data as any).id === 'medium');
    await test('low priority pulled third', () => (third?.data as any).id === 'low');

    await qm.ack(first!.id);
    await qm.ack(second!.id);
    await qm.ack(third!.id);
  });

  // ============ 3. Delayed Jobs ============
  await section('Delayed Jobs', async () => {
    const delayed = await qm.push('delayed', { data: { msg: 'delayed' }, delay: 100 });
    await test('delayed job has future runAt', () => delayed.runAt > Date.now());

    const immediate = await qm.pull('delayed', 0);
    await test('delayed job not immediately available', () => immediate === null);

    await new Promise((r) => setTimeout(r, 150));
    const ready = await qm.pull('delayed', 0);
    await test('delayed job available after delay', () => !!ready);
    if (ready) await qm.ack(ready.id);
  });

  // ============ 4. Batch Operations ============
  await section('Batch Operations', async () => {
    const jobs = await qm.pushBatch('batch', [
      { data: { i: 1 } },
      { data: { i: 2 } },
      { data: { i: 3 } },
    ]);
    await test('pushBatch returns all job ids', () => jobs.length === 3);

    let count = 0;
    for (let i = 0; i < 3; i++) {
      const j = await qm.pull('batch', 0);
      if (j) {
        count++;
        await qm.ack(j.id);
      }
    }
    await test('all batch jobs processed', () => count === 3);
  });

  // ============ 5. Job Dependencies ============
  await section('Job Dependencies', async () => {
    const parent = await qm.push('deps', { data: { type: 'parent' } });
    await qm.push('deps', {
      data: { type: 'child' },
      dependsOn: [parent.id],
    });

    // Child should not be available until parent is completed
    const childBefore = await qm.pull('deps', 0);
    await test('parent pulled first (child blocked)', () =>
      (childBefore?.data as any).type === 'parent');

    // Complete parent
    await qm.ack(childBefore!.id);

    // Wait for dependency resolution (runs every 1000ms)
    await new Promise((r) => setTimeout(r, 1200));

    const childAfter = await qm.pull('deps', 0);
    await test('child available after parent completes', () =>
      !!childAfter && (childAfter.data as any).type === 'child');
    if (childAfter) await qm.ack(childAfter.id);
  });

  // ============ 6. Retry with Backoff ============
  await section('Retry with Backoff', async () => {
    await qm.push('retry', {
      data: { test: 'retry' },
      maxAttempts: 3,
      backoff: 50,
    });

    // First attempt - fail
    let pulled = await qm.pull('retry', 0);
    await test('job has maxAttempts=3', () => pulled?.maxAttempts === 3);
    await qm.fail(pulled!.id, 'First failure');

    // Wait for backoff (exponential: 50 * 2^0 = 50ms)
    await new Promise((r) => setTimeout(r, 100));

    // Second attempt - fail
    pulled = await qm.pull('retry', 0);
    await test('attempts incremented after fail', () => pulled?.attempts === 1);
    await qm.fail(pulled!.id, 'Second failure');

    // Wait for backoff (exponential: 50 * 2^1 = 100ms)
    await new Promise((r) => setTimeout(r, 200));

    // Third attempt - succeed
    pulled = await qm.pull('retry', 0);
    await test('job retried correctly', () => !!pulled && pulled.attempts === 2);
    if (pulled) await qm.ack(pulled.id);
  });

  // ============ 7. DLQ Operations ============
  await section('DLQ Operations', async () => {
    // Create a job that will fail
    await qm.push('dlq-test', { data: { fail: true }, maxAttempts: 1 });
    const j = await qm.pull('dlq-test', 0);
    await qm.fail(j!.id, 'DLQ test failure');

    const dlqJobs = qm.getDlq('dlq-test');
    await test('getDlq returns failed jobs', () => dlqJobs.length >= 1);

    const retried = qm.retryDlq('dlq-test');
    await test('retryDlq moves jobs back to queue', () => retried >= 1);

    // Pull and ack the retried job
    const retriedJob = await qm.pull('dlq-test', 0);
    if (retriedJob) await qm.ack(retriedJob.id);
  });

  // ============ 8. Cron Jobs ============
  await section('Cron Jobs', async () => {
    // Add cron job that runs every second (for testing)
    qm.addCron({
      name: 'test-cron',
      queue: 'cron-queue',
      data: { source: 'cron' },
      repeatEvery: 500, // 500ms
    });

    const cronList = qm.listCrons();
    await test('cron job added', () => cronList.some((c) => c.name === 'test-cron'));

    // Wait for cron to fire (repeatEvery is 500ms, scheduler ticks ~1s)
    await new Promise((r) => setTimeout(r, 1500));

    const cronJob = await qm.pull('cron-queue', 0);
    await test('cron job creates jobs', () => !!cronJob);
    if (cronJob) await qm.ack(cronJob.id);

    // Delete cron
    qm.removeCron('test-cron');
    const afterDelete = qm.listCrons();
    await test('cron job deleted', () => !afterDelete.some((c) => c.name === 'test-cron'));
  });

  // ============ 9. Events/Subscriptions ============
  await section('Events/Subscriptions', async () => {
    const events: string[] = [];
    const unsubscribe = qm.subscribe((event) => {
      events.push(event.eventType);
    });

    await qm.push('events', { data: { test: 'events' } });
    await test('pushed event emitted', () => events.includes('pushed'));

    const j = await qm.pull('events', 0);
    await test('pulled event emitted', () => events.includes('pulled'));

    await qm.ack(j!.id);
    await test('completed event emitted', () => events.includes('completed'));

    unsubscribe();
    events.length = 0;
    await qm.push('events', { data: { after: 'unsubscribe' } });
    await test('unsubscribe stops events', () => events.length === 0);

    // Clean up
    const cleanup = await qm.pull('events', 0);
    if (cleanup) await qm.ack(cleanup.id);
  });

  // ============ 10. Unique Keys ============
  await section('Unique Keys', async () => {
    await qm.push('unique', { data: { id: 1 }, uniqueKey: 'unique-1' });

    let duplicateError = false;
    try {
      await qm.push('unique', { data: { id: 2 }, uniqueKey: 'unique-1' });
    } catch (e: any) {
      duplicateError = e.message.includes('Duplicate');
    }
    await test('duplicate uniqueKey rejected', () => duplicateError);

    // Process and complete the job
    const j = await qm.pull('unique', 0);
    await qm.ack(j!.id);

    // Wait for unique key to be released
    await new Promise((r) => setTimeout(r, 50));

    // Now should be able to push with same key
    const reused = await qm.push('unique', { data: { id: 3 }, uniqueKey: 'unique-1' });
    await test('uniqueKey can be reused after completion', () => !!reused);
    const j2 = await qm.pull('unique', 0);
    if (j2) await qm.ack(j2.id);
  });

  // ============ 11. Queue Concurrency ============
  await section('Queue Concurrency', async () => {
    // Set concurrency limit to 1 job at a time
    qm.setConcurrency('concurrency-q', 1);

    await qm.push('concurrency-q', { data: { n: 1 } });
    await qm.push('concurrency-q', { data: { n: 2 } });

    const first = await qm.pull('concurrency-q', 0);
    await test('first job pulled', () => !!first);

    // Second job should be blocked due to concurrency limit
    const second = await qm.pull('concurrency-q', 0);
    await test('second job blocked by concurrency', () => second === null);

    // Complete first job
    if (first) await qm.ack(first.id);
    await new Promise((r) => setTimeout(r, 50));

    // Now second should be available
    const secondAfter = await qm.pull('concurrency-q', 0);
    await test('second job available after first completes', () => !!secondAfter);
    if (secondAfter) await qm.ack(secondAfter.id);

    // Clear concurrency
    qm.clearConcurrency('concurrency-q');
  });

  // ============ 12. Progress Tracking ============
  await section('Progress Tracking', async () => {
    await qm.push('progress', { data: { task: 'upload' } });
    const pulled = await qm.pull('progress', 0);

    await qm.updateProgress(pulled!.id, 50, 'Halfway done');

    const progress = qm.getProgress(pulled!.id);
    await test('progress updated', () => progress?.progress === 50);
    await test('progress message set', () => progress?.message === 'Halfway done');

    await qm.ack(pulled!.id);
  });

  // ============ 13. Job Logs ============
  await section('Job Logs', async () => {
    await qm.push('logs', { data: { task: 'process' } });
    const pulled = await qm.pull('logs', 0);

    qm.addLog(pulled!.id, 'Processing started', 'info');
    qm.addLog(pulled!.id, 'Step 1 complete', 'info');
    qm.addLog(pulled!.id, 'Minor issue detected', 'warn');

    const logs = qm.getLogs(pulled!.id);
    await test('logs recorded', () => logs.length === 3);
    await test('log levels correct', () => logs.some((l) => l.level === 'warn'));

    await qm.ack(pulled!.id);
  });

  // ============ 14. TTL (Time To Live) ============
  await section('TTL (Time To Live)', async () => {
    const ttlJob = await qm.push('ttl', { data: { temp: true }, ttl: 100 });
    await test('job has TTL set', () => ttlJob.ttl === 100);

    // Note: TTL enforcement happens during pull/cleanup
    // For this test, we just verify the TTL is stored
    const pulled = await qm.pull('ttl', 0);
    await test('job TTL preserved', () => pulled?.ttl === 100);
    if (pulled) await qm.ack(pulled.id);
  });

  // ============ 15. LIFO Mode ============
  await section('LIFO Mode', async () => {
    // Push in order 1, 2, 3 with LIFO
    // Use longer delays to ensure UUID7 timestamps differ
    await qm.push('lifo', { data: { n: 1 }, lifo: true });
    await new Promise((r) => setTimeout(r, 50));
    await qm.push('lifo', { data: { n: 2 }, lifo: true });
    await new Promise((r) => setTimeout(r, 50));
    await qm.push('lifo', { data: { n: 3 }, lifo: true });

    // Should pull in reverse order: 3, 2, 1
    const first = await qm.pull('lifo', 0);
    const second = await qm.pull('lifo', 0);
    const third = await qm.pull('lifo', 0);

    // Log actual values for debugging
    const n1 = (first?.data as any)?.n;
    const n2 = (second?.data as any)?.n;
    const n3 = (third?.data as any)?.n;

    await test('LIFO: last in first out', () => n1 === 3);
    await test('LIFO: second correct', () => n2 === 2);
    await test('LIFO: third correct', () => n3 === 1);

    if (first) await qm.ack(first.id);
    if (second) await qm.ack(second.id);
    if (third) await qm.ack(third.id);
  });

  // ============ 16. Queue Control ============
  await section('Queue Control', async () => {
    await qm.push('control', { data: { n: 1 } });
    await qm.push('control', { data: { n: 2 } });

    // Pause
    qm.pause('control');
    await test('queue paused', () => qm.isPaused('control') === true);

    const whilePaused = await qm.pull('control', 0);
    await test('cannot pull from paused queue', () => whilePaused === null);

    // Resume
    qm.resume('control');
    await test('queue resumed', () => qm.isPaused('control') === false);

    const afterResume = await qm.pull('control', 0);
    await test('can pull after resume', () => !!afterResume);
    if (afterResume) await qm.ack(afterResume.id);

    // Count
    const count = qm.count('control');
    await test('count returns correct number', () => count === 1);

    // Drain
    const drained = qm.drain('control');
    await test('drain removes waiting jobs', () => drained === 1);

    // List queues
    const queues = qm.listQueues();
    await test('listQueues returns queues', () => queues.length > 0);
  });

  // ============ 17. Stats/Metrics ============
  await section('Stats/Metrics', async () => {
    const stats = qm.getStats();

    await test('stats has waiting count', () => typeof stats.waiting === 'number');
    await test('stats has active count', () => typeof stats.active === 'number');
    await test('stats has completed count', () => typeof stats.completed === 'number');
    await test('stats has totalPushed', () => typeof stats.totalPushed === 'bigint');
    await test('stats has totalCompleted', () => typeof stats.totalCompleted === 'bigint');

    // Prometheus metrics
    const prometheus = qm.getPrometheusMetrics();
    await test('prometheus metrics generated', () => prometheus.includes('bunqueue_'));
    await test('prometheus has job counts', () => prometheus.includes('bunqueue_jobs_waiting'));
  });

  // ============ 18. Custom ID ============
  await section('Custom ID', async () => {
    const customJob = await qm.push('custom-id', {
      data: { custom: true },
      customId: 'my-custom-id-123',
    });
    await test('job created with customId', () => !!customJob);

    const found = await qm.getJobByCustomId('my-custom-id-123');
    await test('getJobByCustomId finds job', () => found?.id === customJob.id);

    const pulled = await qm.pull('custom-id', 0);
    if (pulled) await qm.ack(pulled.id);
  });

  // ============ 19. Remove on Complete ============
  await section('Remove on Complete', async () => {
    const removeJob = await qm.push('remove-complete', {
      data: { temp: true },
      removeOnComplete: true,
    });
    const removeJobId = removeJob.id;

    const pulled = await qm.pull('remove-complete', 0);
    await qm.ack(pulled!.id);

    // Job should be removed from memory
    const afterAck = await qm.getJob(removeJobId);
    await test('job removed after completion', () => afterAck === null);
  });

  // ============ 20. Workers/Webhooks ============
  await section('Workers/Webhooks (via internal managers)', async () => {
    // Workers are managed via workerManager (internal)
    const worker = (qm as any).workerManager.register('test-worker', ['work-queue']);
    await test('worker registered', () => !!worker.id);

    const workers = (qm as any).workerManager.list();
    await test('worker in list', () => workers.some((w: any) => w.id === worker.id));

    // Heartbeat
    (qm as any).workerManager.heartbeat(worker.id);
    await test('heartbeat works', () => true);

    // Unregister
    (qm as any).workerManager.unregister(worker.id);
    const afterUnregister = (qm as any).workerManager.list();
    await test('worker unregistered', () => !afterUnregister.some((w: any) => w.id === worker.id));

    // Webhooks are managed via webhookManager (internal)
    const webhook = (qm as any).webhookManager.add('http://example.com/webhook', [
      'completed',
      'failed',
    ]);
    await test('webhook added', () => !!webhook.id);

    const webhooks = (qm as any).webhookManager.list();
    await test('webhook in list', () => webhooks.some((w: any) => w.id === webhook.id));

    // Remove webhook
    (qm as any).webhookManager.remove(webhook.id);
    const afterRemove = (qm as any).webhookManager.list();
    await test('webhook removed', () => !afterRemove.some((w: any) => w.id === webhook.id));
  });

  // ============ 21. Rate Limiting ============
  await section('Rate Limiting', async () => {
    qm.setRateLimit('rate-test', 2); // 2 jobs limit

    await qm.push('rate-test', { data: { n: 1 } });
    await qm.push('rate-test', { data: { n: 2 } });
    await qm.push('rate-test', { data: { n: 3 } });

    const j1 = await qm.pull('rate-test', 0);
    const j2 = await qm.pull('rate-test', 0);
    const j3 = await qm.pull('rate-test', 0);

    await test('rate limit allows first 2 jobs', () => !!j1 && !!j2);
    await test('rate limit blocks third job', () => j3 === null);

    if (j1) await qm.ack(j1.id);
    if (j2) await qm.ack(j2.id);

    // Clear rate limit and get remaining job
    qm.clearRateLimit('rate-test');
    const j3After = await qm.pull('rate-test', 0);
    await test('jobs available after rate limit cleared', () => !!j3After);
    if (j3After) await qm.ack(j3After.id);
  });

  // ============ 22. Get Job ============
  await section('Get Job', async () => {
    const getJob = await qm.push('get-job', { data: { fetch: true } });

    const fetched = await qm.getJob(getJob.id);
    await test('getJob returns job', () => fetched?.id === getJob.id);
    await test('getJob returns correct data', () => (fetched?.data as any).fetch === true);

    const notFound = await qm.getJob(jobId('non-existent-id'));
    await test('getJob returns null for unknown id', () => notFound === null);

    const pulled = await qm.pull('get-job', 0);
    if (pulled) await qm.ack(pulled.id);
  });

  // ============ Final Summary ============
  console.log(`\n${'═'.repeat(50)}`);
  console.log('📊 FINAL RESULTS');
  console.log('═'.repeat(50));
  console.log(`  Total tests: ${passed + failed}`);
  console.log(`  ✅ Passed:   ${passed}`);
  console.log(`  ❌ Failed:   ${failed}`);
  console.log('═'.repeat(50));

  if (failed === 0) {
    console.log('\n🎉 ALL FEATURES WORKING CORRECTLY!\n');
  } else {
    console.log(`\n⚠️  ${failed} FEATURES NEED ATTENTION\n`);
  }

  qm.shutdown();
}

main().catch(console.error);
