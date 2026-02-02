/**
 * Test: verify event payload contains result data
 */

import { QueueManager } from '../application/queueManager';
import { EventType } from '../domain/types/queue';

const qm = new QueueManager();

qm.subscribe((event) => {
  if (event.eventType === EventType.Completed) {
    console.log('\n=== COMPLETED EVENT ===');
    console.log('  jobId:', event.jobId);
    console.log('  queue:', event.queue);
    console.log('  data (result):', JSON.stringify(event.data));
    console.log('=======================\n');
  }
});

async function main() {
  // Push a job
  const job = await qm.push('test-queue', {
    data: { message: 'hello world' },
  });
  console.log('1. Pushed job:', String(job.id));

  // Pull the job
  const pulled = await qm.pull('test-queue', 0);
  console.log('2. Pulled job:', String(pulled?.id));

  // Ack with result - THIS should appear in the event
  const result = {
    success: true,
    output: 'Job processed successfully!',
    processedAt: new Date().toISOString(),
  };

  await qm.ack(pulled!.id, result);
  console.log('3. Acked job with result:', JSON.stringify(result));

  // Wait for event
  await Bun.sleep(100);

  qm.shutdown();
}

void main();
