/**
 * bunQ Stress Tests
 * Intensive benchmarks for production validation
 */

import { QueueManager } from '../application/queueManager';
import { EventType } from '../domain/types/queue';

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function memMB(): number {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

// ============ Test 1: High Volume ============
async function testHighVolume(jobs: number): Promise<void> {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🔥 TEST 1: High Volume - ${fmt(jobs)} jobs`);
  console.log('═'.repeat(60));

  const qm = new QueueManager();
  const queue = 'stress-high-volume';
  let completed = 0;

  qm.subscribe((e) => {
    if (e.eventType === EventType.Completed) completed++;
  });

  const startMem = memMB();
  const start = performance.now();

  // Push all
  console.log('📤 Pushing...');
  const pushStart = performance.now();
  for (let i = 0; i < jobs; i++) {
    await qm.push(queue, { data: { i, payload: `job-${i}` } });
  }
  const pushTime = performance.now() - pushStart;
  console.log(
    `   ✓ ${fmt(jobs)} pushed in ${fmt(pushTime)}ms (${fmt((jobs / pushTime) * 1000)}/sec)`
  );

  // Pull and ack all
  console.log('🔄 Processing...');
  const procStart = performance.now();
  for (let i = 0; i < jobs; i++) {
    const job = await qm.pull(queue, 0);
    if (job) await qm.ack(job.id);
  }
  const procTime = performance.now() - procStart;
  console.log(
    `   ✓ ${fmt(jobs)} processed in ${fmt(procTime)}ms (${fmt((jobs / procTime) * 1000)}/sec)`
  );

  await Bun.sleep(100);
  const totalTime = performance.now() - start;
  const endMem = memMB();

  console.log('\n📊 Results:');
  console.log(`   Total time:     ${fmt(totalTime)}ms`);
  console.log(`   Throughput:     ${fmt((jobs / totalTime) * 1000)} jobs/sec`);
  console.log(`   Events:         ${fmt(completed)}/${fmt(jobs)}`);
  console.log(
    `   Memory:         ${startMem.toFixed(1)}MB → ${endMem.toFixed(1)}MB (+${(endMem - startMem).toFixed(1)}MB)`
  );
  console.log(`   Status:         ${completed === jobs ? '✅ PASS' : '❌ FAIL'}`);

  qm.shutdown();
}

// ============ Test 2: Concurrent Queues ============
async function testConcurrentQueues(queues: number, jobsPerQueue: number): Promise<void> {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🔥 TEST 2: Concurrent Queues - ${queues} queues × ${fmt(jobsPerQueue)} jobs`);
  console.log('═'.repeat(60));

  const qm = new QueueManager();
  const totalJobs = queues * jobsPerQueue;
  let completed = 0;

  qm.subscribe((e) => {
    if (e.eventType === EventType.Completed) completed++;
  });

  const start = performance.now();

  // Push to all queues in parallel
  console.log('📤 Pushing to all queues...');
  const pushPromises = [];
  for (let q = 0; q < queues; q++) {
    const queueName = `concurrent-q-${q}`;
    pushPromises.push(
      (async () => {
        for (let i = 0; i < jobsPerQueue; i++) {
          await qm.push(queueName, { data: { q, i } });
        }
      })()
    );
  }
  await Promise.all(pushPromises);
  const afterPush = performance.now();
  console.log(`   ✓ ${fmt(totalJobs)} pushed in ${fmt(afterPush - start)}ms`);

  // Pull from all queues in parallel
  console.log('🔄 Processing all queues...');
  const procPromises = [];
  for (let q = 0; q < queues; q++) {
    const queueName = `concurrent-q-${q}`;
    procPromises.push(
      (async () => {
        for (let i = 0; i < jobsPerQueue; i++) {
          const job = await qm.pull(queueName, 0);
          if (job) await qm.ack(job.id);
        }
      })()
    );
  }
  await Promise.all(procPromises);

  await Bun.sleep(100);
  const totalTime = performance.now() - start;

  console.log('\n📊 Results:');
  console.log(`   Total jobs:     ${fmt(totalJobs)}`);
  console.log(`   Total time:     ${fmt(totalTime)}ms`);
  console.log(`   Throughput:     ${fmt((totalJobs / totalTime) * 1000)} jobs/sec`);
  console.log(`   Events:         ${fmt(completed)}/${fmt(totalJobs)}`);
  console.log(`   Status:         ${completed === totalJobs ? '✅ PASS' : '❌ FAIL'}`);

  qm.shutdown();
}

// ============ Test 3: Large Payloads ============
async function testLargePayloads(jobs: number, payloadKB: number): Promise<void> {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🔥 TEST 3: Large Payloads - ${fmt(jobs)} jobs × ${payloadKB}KB`);
  console.log('═'.repeat(60));

  const qm = new QueueManager();
  const queue = 'stress-large-payload';
  const payload = { data: 'x'.repeat(payloadKB * 1024), timestamp: Date.now() };
  let completed = 0;

  qm.subscribe((e) => {
    if (e.eventType === EventType.Completed) completed++;
  });

  const startMem = memMB();
  const start = performance.now();

  console.log('📤 Pushing large payloads...');
  for (let i = 0; i < jobs; i++) {
    await qm.push(queue, { data: { ...payload, i } });
  }
  const afterPush = performance.now();
  console.log(`   ✓ ${fmt(jobs)} pushed in ${fmt(afterPush - start)}ms`);

  console.log('🔄 Processing...');
  for (let i = 0; i < jobs; i++) {
    const job = await qm.pull(queue, 0);
    if (job) await qm.ack(job.id);
  }

  await Bun.sleep(100);
  const totalTime = performance.now() - start;
  const endMem = memMB();
  const totalDataMB = (jobs * payloadKB) / 1024;

  console.log('\n📊 Results:');
  console.log(`   Data processed: ${totalDataMB.toFixed(1)}MB`);
  console.log(`   Total time:     ${fmt(totalTime)}ms`);
  console.log(`   Throughput:     ${fmt((totalDataMB / totalTime) * 1000 * 1000)} MB/sec`);
  console.log(`   Events:         ${fmt(completed)}/${fmt(jobs)}`);
  console.log(`   Memory:         ${startMem.toFixed(1)}MB → ${endMem.toFixed(1)}MB`);
  console.log(`   Status:         ${completed === jobs ? '✅ PASS' : '❌ FAIL'}`);

  qm.shutdown();
}

// ============ Test 4: Priority Stress ============
async function testPriorityStress(jobs: number): Promise<void> {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🔥 TEST 4: Priority Queue Stress - ${fmt(jobs)} jobs`);
  console.log('═'.repeat(60));

  const qm = new QueueManager();
  const queue = 'stress-priority';
  const priorities = [0, 1, 5, 10, 50, 100];

  const start = performance.now();

  // Push with varied priorities
  console.log('📤 Pushing with random priorities...');
  for (let i = 0; i < jobs; i++) {
    const priority = priorities[Math.floor(Math.random() * priorities.length)];
    await qm.push(queue, { data: { i }, priority });
  }
  const afterPush = performance.now();
  console.log(`   ✓ ${fmt(jobs)} pushed in ${fmt(afterPush - start)}ms`);

  // Pull and verify priority order
  console.log('🔄 Processing and verifying order...');
  let lastPriority = Infinity;
  let orderViolations = 0;
  let processed = 0;

  for (let i = 0; i < jobs; i++) {
    const job = await qm.pull(queue, 0);
    if (job) {
      if (job.priority > lastPriority) orderViolations++;
      lastPriority = job.priority;
      await qm.ack(job.id);
      processed++;
    }
  }

  const totalTime = performance.now() - start;

  console.log('\n📊 Results:');
  console.log(`   Processed:      ${fmt(processed)}/${fmt(jobs)}`);
  console.log(`   Order errors:   ${orderViolations}`);
  console.log(`   Total time:     ${fmt(totalTime)}ms`);
  console.log(`   Throughput:     ${fmt((jobs / totalTime) * 1000)} jobs/sec`);
  console.log(
    `   Status:         ${processed === jobs && orderViolations === 0 ? '✅ PASS' : '❌ FAIL'}`
  );

  qm.shutdown();
}

// ============ Test 5: Retry Storm ============
async function testRetryStorm(jobs: number, failRate: number): Promise<void> {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(
    `🔥 TEST 5: Retry Storm - ${fmt(jobs)} jobs, ${(failRate * 100).toFixed(0)}% fail rate`
  );
  console.log('═'.repeat(60));

  const qm = new QueueManager();
  const queue = 'stress-retry';
  let totalAttempts = 0;
  let completed = 0;
  let failed = 0;

  const start = performance.now();

  // Push jobs with retry config
  console.log('📤 Pushing jobs with retries...');
  for (let i = 0; i < jobs; i++) {
    await qm.push(queue, { data: { i }, maxAttempts: 3, backoff: 1 });
  }

  // Process with simulated failures
  console.log('🔄 Processing with failures...');
  while (completed + failed < jobs) {
    const job = await qm.pull(queue, 100);
    if (!job) continue;

    totalAttempts++;
    if (Math.random() < failRate && job.attempts < job.maxAttempts - 1) {
      await qm.fail(job.id, 'Simulated failure');
    } else {
      await qm.ack(job.id);
      completed++;
    }
  }

  const stats = qm.getStats();
  failed = Number(stats.totalFailed);
  const totalTime = performance.now() - start;

  console.log('\n📊 Results:');
  console.log(`   Completed:      ${fmt(completed)}`);
  console.log(`   Failed (DLQ):   ${fmt(failed)}`);
  console.log(`   Total attempts: ${fmt(totalAttempts)}`);
  console.log(`   Retry ratio:    ${((totalAttempts / jobs - 1) * 100).toFixed(1)}%`);
  console.log(`   Total time:     ${fmt(totalTime)}ms`);
  console.log(`   Status:         ${completed + failed === jobs ? '✅ PASS' : '❌ FAIL'}`);

  qm.shutdown();
}

// ============ Test 6: Memory Stability ============
async function testMemoryStability(iterations: number, batchSize: number): Promise<void> {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🔥 TEST 6: Memory Stability - ${iterations} iterations × ${fmt(batchSize)} jobs`);
  console.log('═'.repeat(60));

  const qm = new QueueManager();
  const queue = 'stress-memory';
  const memSamples: number[] = [];
  const totalJobs = iterations * batchSize;

  const startMem = memMB();
  const start = performance.now();

  for (let iter = 0; iter < iterations; iter++) {
    // Push batch
    for (let i = 0; i < batchSize; i++) {
      await qm.push(queue, { data: { iter, i, payload: 'x'.repeat(100) } });
    }

    // Pull and ack batch
    for (let i = 0; i < batchSize; i++) {
      const job = await qm.pull(queue, 0);
      if (job) await qm.ack(job.id);
    }

    memSamples.push(memMB());

    if ((iter + 1) % 10 === 0) {
      process.stdout.write(`\r   Progress: ${iter + 1}/${iterations} iterations`);
    }
  }
  console.log('');

  const totalTime = performance.now() - start;
  const endMem = memMB();
  const memGrowth = endMem - startMem;
  const maxMem = Math.max(...memSamples);
  const minMem = Math.min(...memSamples);

  console.log('\n📊 Results:');
  console.log(`   Total jobs:     ${fmt(totalJobs)}`);
  console.log(`   Total time:     ${fmt(totalTime)}ms`);
  console.log(`   Throughput:     ${fmt((totalJobs / totalTime) * 1000)} jobs/sec`);
  console.log(`   Memory start:   ${startMem.toFixed(1)}MB`);
  console.log(`   Memory end:     ${endMem.toFixed(1)}MB`);
  console.log(`   Memory growth:  ${memGrowth.toFixed(1)}MB`);
  console.log(`   Memory range:   ${minMem.toFixed(1)}MB - ${maxMem.toFixed(1)}MB`);
  console.log(`   Status:         ${memGrowth < 50 ? '✅ PASS' : '⚠️ MEMORY GROWTH'}`);

  qm.shutdown();
}

// ============ Test 7: Batch Operations ============
async function testBatchOperations(totalJobs: number, batchSize: number): Promise<void> {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🔥 TEST 7: Batch Operations - ${fmt(totalJobs)} jobs, batch=${batchSize}`);
  console.log('═'.repeat(60));

  const qm = new QueueManager();
  const queue = 'stress-batch';
  const batches = Math.ceil(totalJobs / batchSize);
  const jobs = Array.from({ length: batchSize }, (_, i) => ({ data: { i } }));

  const start = performance.now();

  // Batch push
  console.log('📤 Batch pushing...');
  const pushStart = performance.now();
  for (let b = 0; b < batches; b++) {
    await qm.pushBatch(queue, jobs);
  }
  const pushTime = performance.now() - pushStart;
  const actualJobs = batches * batchSize;
  console.log(
    `   ✓ ${fmt(actualJobs)} pushed in ${fmt(pushTime)}ms (${fmt((actualJobs / pushTime) * 1000)}/sec)`
  );

  // Individual pull/ack
  console.log('🔄 Processing...');
  const procStart = performance.now();
  let processed = 0;
  for (let i = 0; i < actualJobs; i++) {
    const job = await qm.pull(queue, 0);
    if (job) {
      await qm.ack(job.id);
      processed++;
    }
  }
  const procTime = performance.now() - procStart;
  console.log(
    `   ✓ ${fmt(processed)} processed in ${fmt(procTime)}ms (${fmt((processed / procTime) * 1000)}/sec)`
  );

  const totalTime = performance.now() - start;

  console.log('\n📊 Results:');
  console.log(`   Total time:     ${fmt(totalTime)}ms`);
  console.log(`   Batch push:     ${fmt((actualJobs / pushTime) * 1000)} jobs/sec`);
  console.log(`   Processing:     ${fmt((processed / procTime) * 1000)} jobs/sec`);
  console.log(`   Status:         ${processed === actualJobs ? '✅ PASS' : '❌ FAIL'}`);

  qm.shutdown();
}

// ============ Main ============
async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║                    bunQ STRESS TESTS                           ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  const startTime = performance.now();

  // Run all tests
  await testHighVolume(100_000);
  await testConcurrentQueues(10, 10_000);
  await testLargePayloads(5_000, 10);
  await testPriorityStress(50_000);
  await testRetryStorm(10_000, 0.5);
  await testMemoryStability(100, 1_000);
  await testBatchOperations(100_000, 1_000);

  const totalTime = (performance.now() - startTime) / 1000;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`✅ All stress tests completed in ${totalTime.toFixed(1)}s`);
  console.log('═'.repeat(60));
}

main().catch(console.error);
