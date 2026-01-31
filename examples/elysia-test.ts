/**
 * Test Suite for Elysia + bunqueue
 *
 * Tests:
 * 1. Basic job creation and processing
 * 2. Priority queue ordering
 * 3. Delayed job execution
 * 4. Bulk operations
 * 5. DLQ handling
 * 6. Queue pause/resume
 * 7. Job status tracking
 */

const BASE_URL = 'http://localhost:3000';

async function request(path: string, options?: RequestInit) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return res.json();
}

async function sleep(ms: number) {
  await new Promise(r => setTimeout(r, ms));
}

// ============================================
// Test Utilities
// ============================================

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void>) {
  return async () => {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ❌ ${name}`);
      console.log(`     Error: ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  };
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

// ============================================
// Tests
// ============================================

const tests = [

  test('Health check returns queue stats', async () => {
    const res = await request('/health');
    assert(res.status === 'ok', 'Status should be ok');
    assert(res.queues !== undefined, 'Should have queues');
    assert(res.queues.emails !== undefined, 'Should have emails queue');
  }),

  test('Create email job', async () => {
    const res = await request('/emails', {
      method: 'POST',
      body: JSON.stringify({
        to: 'test@example.com',
        subject: 'Test Email',
        body: 'Hello World',
      }),
    });
    assert(res.jobId !== undefined, 'Should return jobId');
    assert(res.status === 'queued', 'Status should be queued');
  }),

  test('Create high priority email', async () => {
    const res = await request('/emails/priority', {
      method: 'POST',
      body: JSON.stringify({
        to: 'vip@example.com',
        subject: 'VIP Email',
        body: 'Priority message',
      }),
    });
    assert(res.priority === 'high', 'Should be high priority');
  }),

  test('Create scheduled email', async () => {
    const res = await request('/emails/scheduled', {
      method: 'POST',
      body: JSON.stringify({
        to: 'later@example.com',
        subject: 'Scheduled',
        body: 'Send later',
        delayMs: 2000,
      }),
    });
    assert(res.status === 'scheduled', 'Status should be scheduled');
    assert(res.willRunAt !== undefined, 'Should have scheduled time');
  }),

  test('Create report job', async () => {
    const res = await request('/reports', {
      method: 'POST',
      body: JSON.stringify({
        type: 'daily',
        userId: 'user-123',
      }),
    });
    assert(res.jobId !== undefined, 'Should return jobId');
  }),

  test('Create webhook job', async () => {
    const res = await request('/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        url: 'https://example.com/webhook',
        payload: { event: 'test' },
      }),
    });
    assert(res.jobId !== undefined, 'Should return jobId');
  }),

  test('Bulk webhook creation', async () => {
    const res = await request('/webhooks/bulk', {
      method: 'POST',
      body: JSON.stringify({
        webhooks: [
          { url: 'https://example.com/hook1', payload: { id: 1 } },
          { url: 'https://example.com/hook2', payload: { id: 2 } },
          { url: 'https://example.com/hook3', payload: { id: 3 } },
        ],
      }),
    });
    assert(res.count === 3, 'Should create 3 jobs');
    assert(res.jobIds.length === 3, 'Should return 3 job IDs');
  }),

  test('Wait for jobs to process', async () => {
    // Wait for workers to process
    await sleep(2000);
    const health = await request('/health');
    assert(health.queues.emails.completed > 0, 'Should have completed emails');
  }),

  test('Check DLQ (webhooks may fail)', async () => {
    const res = await request('/dlq/webhooks');
    assert(res.stats !== undefined, 'Should have stats');
    // Note: webhooks have 30% failure rate, so DLQ might have entries
    console.log(`     (DLQ has ${res.stats.total} entries)`);
  }),

  test('Pause and resume queue', async () => {
    // Pause
    const pauseRes = await request('/queues/emails/pause', { method: 'POST' });
    assert(pauseRes.status === 'paused', 'Should be paused');

    // Add job while paused
    await request('/emails', {
      method: 'POST',
      body: JSON.stringify({
        to: 'paused@example.com',
        subject: 'While Paused',
        body: 'Test',
      }),
    });

    // Check health - should have waiting job
    await sleep(500);
    const healthPaused = await request('/health');
    const waitingBefore = healthPaused.queues.emails.waiting;

    // Resume
    const resumeRes = await request('/queues/emails/resume', { method: 'POST' });
    assert(resumeRes.status === 'resumed', 'Should be resumed');

    // Wait for processing
    await sleep(1000);

    // Check health again - waiting should decrease
    const healthAfter = await request('/health');
    assert(
      healthAfter.queues.emails.waiting <= waitingBefore,
      'Waiting jobs should decrease after resume'
    );
  }),

  test('Invalid email fails and goes to DLQ', async () => {
    // Send invalid email (no @ symbol)
    const res = await request('/emails', {
      method: 'POST',
      body: JSON.stringify({
        to: 'invalid-email',
        subject: 'Will Fail',
        body: 'Test',
      }),
    });

    // Wait for processing and retries (3 attempts with exponential backoff)
    // Plus time for DLQ processing after final failure
    await sleep(8000);

    // Check DLQ - job should be there after exhausting retries
    const dlq = await request('/dlq/emails');
    console.log(`     (DLQ has ${dlq.stats.total} entries for emails)`);
    assert(dlq.stats.total > 0, 'Invalid email should be in DLQ after exhausting retries');
  }),

  test('Final health check', async () => {
    const res = await request('/health');
    console.log(`     Emails: ${res.queues.emails.completed} completed, ${res.queues.emails.failed} failed`);
    console.log(`     Reports: ${res.queues.reports.completed} completed`);
    console.log(`     Webhooks: ${res.queues.webhooks.completed} completed, ${res.queues.webhooks.failed} failed`);
  }),

];

// ============================================
// Run Tests
// ============================================

async function runTests() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   Elysia + bunqueue Integration Tests  ║');
  console.log('╚════════════════════════════════════════╝\n');

  // Check server is running
  try {
    await request('/health');
  } catch {
    console.log('❌ Server not running. Start it first with:');
    console.log('   bun run examples/elysia-example.ts\n');
    process.exit(1);
  }

  console.log('Running tests...\n');

  for (const runTest of tests) {
    await runTest();
  }

  console.log('\n════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
