/**
 * Worker - Processa i job dalla coda
 * Di default si connette via TCP a localhost:6789
 *
 * Esegui: bun run worker.ts
 */

import { Worker } from '../src/client';

console.log('Worker connesso al server bunqueue su localhost:6789...');
console.log('In attesa di job...\n');

// TCP mode (default) - si connette al server bunqueue
const worker = new Worker<{ email: string; subject: string }>(
  'emails',
  async (job) => {
    console.log(`Processing job ${job.id}...`);
    console.log(`  Email: ${job.data.email}`);
    console.log(`  Subject: ${job.data.subject}`);

    // Simula lavoro
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Aggiorna progresso
    await job.updateProgress(100, 'Email inviata!');

    console.log(`  Job ${job.id} completato!\n`);

    return { sent: true, timestamp: Date.now() };
  },
  {
    concurrency: 2, // Processa 2 job in parallelo
    // Per embedded mode: embedded: true
  }
);

// Event listeners
worker.on('completed', (job, result) => {
  console.log(`[EVENT] Job ${job.id} completed:`, result);
});

worker.on('failed', (job, error) => {
  console.log(`[EVENT] Job ${job.id} failed:`, error.message);
});

worker.on('error', (error) => {
  console.log(`[ERROR] ${error.message}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down worker...');
  await worker.close();
  process.exit(0);
});
