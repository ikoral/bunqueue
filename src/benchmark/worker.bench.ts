/**
 * bunqueue Worker Benchmark
 * Realistic benchmark: push -> pull -> ack with events
 */

import { QueueManager } from '../application/queueManager';
import { EventType } from '../domain/types/queue';

const QUEUE = 'bench';

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

async function benchmark(name: string, jobCount: number): Promise<void> {
  const qm = new QueueManager();
  let eventsCount = 0;

  // Count completed events
  qm.subscribe((e) => {
    if (e.eventType === EventType.Completed) eventsCount++;
  });

  console.log(`\n${name}`);
  console.log('-'.repeat(50));

  const start = performance.now();

  // Push all jobs
  for (let i = 0; i < jobCount; i++) {
    await qm.push(QUEUE, { data: { id: i } });
  }
  const afterPush = performance.now();

  // Pull and ack all jobs (simulates worker)
  for (let i = 0; i < jobCount; i++) {
    const job = await qm.pull(QUEUE, 0);
    if (job) {
      await qm.ack(job.id, { result: 'ok' });
    }
  }
  const afterAck = performance.now();

  // Wait for pending events
  await Bun.sleep(50);

  const totalMs = afterAck - start;
  const pushMs = afterPush - start;
  const processMs = afterAck - afterPush;

  console.log(`Jobs:        ${fmt(jobCount)}`);
  console.log(`Push time:   ${fmt(pushMs)} ms (${fmt((jobCount / pushMs) * 1000)} jobs/sec)`);
  console.log(`Process:     ${fmt(processMs)} ms (${fmt((jobCount / processMs) * 1000)} jobs/sec)`);
  console.log(`Total:       ${fmt(totalMs)} ms (${fmt((jobCount / totalMs) * 1000)} jobs/sec)`);
  console.log(`Events:      ${fmt(eventsCount)} completed events received`);

  qm.shutdown();
}

async function main(): Promise<void> {
  console.log('bunqueue Worker Benchmark');
  console.log('=====================');

  await benchmark('10,000 jobs', 10_000);
  await benchmark('50,000 jobs', 50_000);
  await benchmark('100,000 jobs', 100_000);

  console.log('\n');
}

main().catch(console.error);
