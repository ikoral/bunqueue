/**
 * Producer - Crea job nella coda
 * Di default si connette via TCP a localhost:6789
 *
 * Esegui: bun run producer.ts
 */

import { Queue } from '../src/client';

// TCP mode (default) - si connette al server bunqueue
const queue = new Queue<{ email: string; subject: string }>('emails');

// Oppure con opzioni esplicite:
// const queue = new Queue('emails', { connection: { host: 'localhost', port: 6789 } });

// Per embedded mode (no server):
// const queue = new Queue('emails', { embedded: true });

async function main() {
  console.log('Connessione al server bunqueue su localhost:6789...\n');
  console.log('Aggiungo 5 job alla coda "emails"...\n');

  for (let i = 1; i <= 5; i++) {
    const job = await queue.add('send-email', {
      email: `user${i}@example.com`,
      subject: `Email numero ${i}`,
    });

    console.log(`Job ${job.id} aggiunto: ${job.data.email}`);
  }

  const counts = await queue.getJobCountsAsync();
  console.log('\nJob counts:', counts);
  console.log('\nProducer terminato. I job sono stati inviati al server.');
}

main().catch(console.error);
