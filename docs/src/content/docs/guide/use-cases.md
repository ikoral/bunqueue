---
title: Use Cases
description: Real-world examples and production patterns with bunqueue
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/use-cases.png
---

Production-ready patterns for common background job scenarios.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           YOUR APPLICATION                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐      │
│   │   API    │     │  Cron    │     │ Webhooks │     │  Events  │      │
│   │ Handlers │     │Scheduler │     │ Receiver │     │ Triggers │      │
│   └────┬─────┘     └────┬─────┘     └────┬─────┘     └────┬─────┘      │
│        │                │                │                │             │
│        └────────────────┴────────────────┴────────────────┘             │
│                                   │                                      │
│                                   ▼                                      │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │                         QUEUE LAYER                              │   │
│   │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐            │   │
│   │  │ emails  │  │ reports │  │webhooks │  │ payments│  ...       │   │
│   │  └─────────┘  └─────────┘  └─────────┘  └─────────┘            │   │
│   └─────────────────────────────────────────────────────────────────┘   │
│                                   │                                      │
│                                   ▼                                      │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │                        WORKER POOL                               │   │
│   │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐            │   │
│   │  │Worker x3│  │Worker x2│  │Worker x5│  │Worker x3│            │   │
│   │  └─────────┘  └─────────┘  └─────────┘  └─────────┘            │   │
│   └─────────────────────────────────────────────────────────────────┘   │
│                                   │                                      │
│        ┌──────────────────────────┼──────────────────────────┐          │
│        ▼                          ▼                          ▼          │
│   ┌─────────┐              ┌───────────┐              ┌──────────┐      │
│   │   DLQ   │              │  SQLite   │              │  Events  │      │
│   │ (Failed)│              │(Persistence)             │ (Hooks)  │      │
│   └─────────┘              └───────────┘              └──────────┘      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Job Lifecycle

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  QUEUED  │───▶│  ACTIVE  │───▶│COMPLETED │    │  FAILED  │
└──────────┘    └────┬─────┘    └──────────┘    └────┬─────┘
                     │                               │
                     │         ┌──────────┐          │
                     └────────▶│ RETRYING │──────────┘
                               └────┬─────┘
                                    │ max attempts
                                    ▼
                               ┌──────────┐
                               │   DLQ    │
                               └──────────┘
```

---

## Email Delivery System

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Request   │────▶│   Queue     │────▶│   Worker    │────▶│   SMTP/     │
│  (API/Cron) │     │  (emails)   │     │ (render +   │     │   SendGrid  │
└─────────────┘     └─────────────┘     │   send)     │     └─────────────┘
                                        └──────┬──────┘
                                               │
                    ┌──────────────────────────┼──────────────────────────┐
                    ▼                          ▼                          ▼
             ┌───────────┐              ┌───────────┐              ┌───────────┐
             │  Success  │              │  Retry    │              │   DLQ     │
             │ (logged)  │              │ (backoff) │              │ (alert)   │
             └───────────┘              └───────────┘              └───────────┘
```

Reliable email sending with retries, templates, and delivery tracking.

```typescript
import { Queue, Worker, shutdownManager } from 'bunqueue/client';

interface EmailJob {
  to: string;
  template: 'welcome' | 'reset-password' | 'invoice' | 'notification';
  data: Record<string, unknown>;
  attachments?: { name: string; url: string }[];
}

const emailQueue = new Queue<EmailJob>('emails', {
  embedded: true,
  defaultJobOptions: {
    attempts: 5,
    backoff: 2000,        // Exponential backoff
    removeOnComplete: true,
  },
});

const emailWorker = new Worker<EmailJob>('emails', async (job) => {
  const { to, template, data, attachments } = job.data;

  await job.updateProgress(10, 'Loading template...');
  const html = await renderTemplate(template, data);

  await job.updateProgress(30, 'Preparing attachments...');
  const files = attachments ? await downloadAttachments(attachments) : [];

  await job.updateProgress(50, 'Sending email...');
  const result = await sendEmail({ to, html, attachments: files });

  await job.log(`Delivered to ${to} via ${result.provider}`);
  await job.updateProgress(100, 'Delivered');

  return {
    messageId: result.messageId,
    provider: result.provider,
    deliveredAt: new Date().toISOString(),
  };
}, { embedded: true, concurrency: 10 });

// Send welcome email
await emailQueue.add('welcome', {
  to: 'user@example.com',
  template: 'welcome',
  data: { name: 'John', activationLink: 'https://...' },
});

// Send bulk newsletter
const subscribers = await getSubscribers();
await emailQueue.addBulk(
  subscribers.map(sub => ({
    name: 'newsletter',
    data: {
      to: sub.email,
      template: 'notification',
      data: { name: sub.name, content: newsletterContent },
    },
  }))
);
```

---

## Report Generation Pipeline

```
┌──────────┐    ┌──────────┐    ┌─────────────────────────────────────┐
│  User    │───▶│  Queue   │───▶│              Worker                 │
│ Request  │    │ (reports)│    │  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐  │
└──────────┘    └──────────┘    │  │Query│▶│Trans│▶│ Gen │▶│Upload│  │
                                │  │ DB  │ │form │ │File │ │ S3  │  │
                                │  └─────┘ └─────┘ └─────┘ └─────┘  │
                                │      10%    40%    70%    90%      │
                                └────────────────┬────────────────────┘
                                                 │
                                                 ▼
                                          ┌────────────┐
                                          │   Notify   │
                                          │   (email)  │
                                          └────────────┘
```

Long-running report generation with progress tracking and file storage.

```typescript
interface ReportJob {
  type: 'sales' | 'inventory' | 'analytics' | 'audit';
  format: 'pdf' | 'xlsx' | 'csv';
  filters: {
    dateRange: { start: string; end: string };
    departments?: string[];
    regions?: string[];
  };
  requestedBy: string;
  notifyEmail: string;
}

const reportQueue = new Queue<ReportJob>('reports', {
  embedded: true,
  defaultJobOptions: {
    attempts: 2,
    timeout: 600000, // 10 minutes max
  },
});

const reportWorker = new Worker<ReportJob>('reports', async (job) => {
  const { type, format, filters, requestedBy, notifyEmail } = job.data;

  // Phase 1: Query data
  await job.updateProgress(10, 'Fetching data...');
  await job.log(`Report type: ${type}, format: ${format}`);
  const data = await fetchReportData(type, filters);

  // Phase 2: Process data
  await job.updateProgress(40, `Processing ${data.length} records...`);
  const processed = await processData(data, type);

  // Phase 3: Generate file
  await job.updateProgress(70, `Generating ${format.toUpperCase()}...`);
  const file = await generateFile(processed, format);

  // Phase 4: Upload to storage
  await job.updateProgress(90, 'Uploading to storage...');
  const url = await uploadToS3(file, `reports/${job.id}.${format}`);

  // Phase 5: Notify user
  await job.updateProgress(95, 'Sending notification...');
  await sendEmail({
    to: notifyEmail,
    template: 'report-ready',
    data: { reportUrl: url, type, format },
  });

  await job.updateProgress(100, 'Complete');

  return {
    url,
    size: file.size,
    records: data.length,
    generatedAt: new Date().toISOString(),
  };
}, { embedded: true, concurrency: 3 });

// Generate monthly sales report
await reportQueue.add('monthly-sales', {
  type: 'sales',
  format: 'xlsx',
  filters: {
    dateRange: { start: '2024-01-01', end: '2024-01-31' },
    regions: ['US', 'EU'],
  },
  requestedBy: 'user-123',
  notifyEmail: 'manager@company.com',
});
```

---

## Webhook Delivery with Circuit Breaker

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────────┐
│  Event   │───▶│  Queue   │───▶│  Worker  │───▶│   Partner    │
│ (order,  │    │(webhooks)│    │  (HTTP   │    │   Endpoint   │
│  user)   │    │          │    │   POST)  │    │              │
└──────────┘    └──────────┘    └────┬─────┘    └──────────────┘
                                     │
           ┌─────────────────────────┼─────────────────────────┐
           │                         │                         │
           ▼                         ▼                         ▼
    ┌────────────┐           ┌────────────┐           ┌────────────┐
    │  Success   │           │   Retry    │           │    DLQ     │
    │   (200)    │           │  (5xx/429) │           │ (8 fails)  │
    └────────────┘           │ exp backoff│           │ auto-retry │
                             │ 5s▶10s▶20s │           │  hourly    │
                             └────────────┘           └────────────┘
```

Reliable webhook delivery with automatic retries and failure tracking.

```typescript
interface WebhookJob {
  endpoint: string;
  event: string;
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
  signature?: string;
}

const webhookQueue = new Queue<WebhookJob>('webhooks', {
  embedded: true,
  defaultJobOptions: {
    attempts: 8,
    backoff: 5000, // Exponential: 5s, 10s, 20s, 40s...
  },
});

// Configure DLQ for permanent failures
webhookQueue.setDlqConfig({
  autoRetry: true,
  autoRetryInterval: 3600000, // Retry DLQ every hour
  maxAutoRetries: 3,
  maxAge: 604800000, // Keep for 7 days
});

const webhookWorker = new Worker<WebhookJob>('webhooks', async (job) => {
  const { endpoint, event, payload, headers, signature } = job.data;

  await job.log(`Delivering ${event} to ${endpoint}`);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Event': event,
      'X-Webhook-Signature': signature || '',
      'X-Webhook-Delivery': job.id,
      ...headers,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000), // 30s timeout
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  return {
    status: response.status,
    deliveredAt: new Date().toISOString(),
    attempt: job.attemptsMade,
  };
}, { embedded: true, concurrency: 20 });

// Dispatch webhook
await webhookQueue.add('order.created', {
  endpoint: 'https://partner.com/webhooks',
  event: 'order.created',
  payload: {
    orderId: 'ORD-123',
    total: 99.99,
    items: [{ sku: 'ITEM-1', qty: 2 }],
  },
  signature: generateHmacSignature(payload, secret),
});
```

---

## Image Processing Pipeline

```
┌──────────┐    ┌──────────┐    ┌─────────────────────────────────────────┐
│  Upload  │───▶│  Queue   │───▶│                Worker                   │
│  (S3)    │    │ (images) │    │                                         │
└──────────┘    └──────────┘    │  ┌────────┐    ┌────────────────────┐  │
                                │  │Download│───▶│    Sharp Process    │  │
                                │  │ Source │    │  ┌──────┐ ┌──────┐ │  │
                                │  └────────┘    │  │thumb │ │ card │ │  │
                                │                │  │150px │ │400px │ │  │
                                │                │  └──┬───┘ └──┬───┘ │  │
                                │                │     │        │     │  │
                                │                │  ┌──┴───┐ ┌──┴───┐ │  │
                                │                │  │ full │ │  og  │ │  │
                                │                │  │1200px│ │1200px│ │  │
                                │                │  └──────┘ └──────┘ │  │
                                │                └─────────┬──────────┘  │
                                │                          ▼             │
                                │                   ┌────────────┐       │
                                │                   │ Upload CDN │       │
                                │                   └────────────┘       │
                                └─────────────────────────────────────────┘
```

Multi-stage image processing with variants and CDN upload.

```typescript
interface ImageJob {
  sourceUrl: string;
  variants: Array<{
    name: string;
    width: number;
    height: number;
    format: 'webp' | 'avif' | 'jpeg';
    quality: number;
  }>;
  destination: string;
  metadata?: Record<string, string>;
}

const imageQueue = new Queue<ImageJob>('images', {
  embedded: true,
  defaultJobOptions: {
    attempts: 3,
    timeout: 120000, // 2 minutes
  },
});

const imageWorker = new Worker<ImageJob>('images', async (job) => {
  const { sourceUrl, variants, destination, metadata } = job.data;
  const results: Record<string, string> = {};

  await job.updateProgress(5, 'Downloading source image...');
  const source = await downloadImage(sourceUrl);

  const totalVariants = variants.length;
  for (let i = 0; i < totalVariants; i++) {
    const variant = variants[i];
    const progress = 10 + Math.floor((i / totalVariants) * 80);

    await job.updateProgress(progress, `Processing ${variant.name}...`);

    // Resize and convert
    const processed = await sharp(source)
      .resize(variant.width, variant.height, { fit: 'cover' })
      .toFormat(variant.format, { quality: variant.quality })
      .toBuffer();

    // Upload to CDN
    const path = `${destination}/${variant.name}.${variant.format}`;
    const url = await uploadToCDN(processed, path, metadata);
    results[variant.name] = url;

    await job.log(`Uploaded ${variant.name}: ${url}`);
  }

  await job.updateProgress(100, 'Complete');

  return {
    variants: results,
    processedAt: new Date().toISOString(),
  };
}, { embedded: true, concurrency: 5 });

// Process product image
await imageQueue.add('product-image', {
  sourceUrl: 'https://uploads.example.com/raw/product-123.jpg',
  variants: [
    { name: 'thumbnail', width: 150, height: 150, format: 'webp', quality: 80 },
    { name: 'card', width: 400, height: 300, format: 'webp', quality: 85 },
    { name: 'full', width: 1200, height: 900, format: 'webp', quality: 90 },
    { name: 'og', width: 1200, height: 630, format: 'jpeg', quality: 85 },
  ],
  destination: 'products/123',
  metadata: { 'Cache-Control': 'public, max-age=31536000' },
});
```

---

## Data Export/Import System

Large dataset export with streaming and chunked processing.

```typescript
interface ExportJob {
  type: 'users' | 'orders' | 'products' | 'transactions';
  format: 'csv' | 'json' | 'parquet';
  filters?: Record<string, unknown>;
  notifyEmail: string;
  chunkSize?: number;
}

const exportQueue = new Queue<ExportJob>('exports', {
  embedded: true,
  defaultJobOptions: {
    attempts: 2,
    timeout: 1800000, // 30 minutes
  },
});

const exportWorker = new Worker<ExportJob>('exports', async (job) => {
  const { type, format, filters, notifyEmail, chunkSize = 10000 } = job.data;

  await job.updateProgress(5, 'Counting records...');
  const totalCount = await countRecords(type, filters);
  const totalChunks = Math.ceil(totalCount / chunkSize);

  await job.log(`Exporting ${totalCount} ${type} in ${totalChunks} chunks`);

  // Create temporary file
  const tempFile = await createTempFile(`export-${job.id}.${format}`);
  const writer = await createWriter(tempFile, format);

  // Process in chunks
  for (let chunk = 0; chunk < totalChunks; chunk++) {
    const progress = 10 + Math.floor((chunk / totalChunks) * 80);
    await job.updateProgress(progress, `Processing chunk ${chunk + 1}/${totalChunks}...`);

    const records = await fetchRecords(type, filters, {
      offset: chunk * chunkSize,
      limit: chunkSize,
    });

    await writer.write(records);
  }

  await writer.close();

  // Upload to storage
  await job.updateProgress(95, 'Uploading file...');
  const url = await uploadToS3(tempFile, `exports/${job.id}.${format}`);

  // Send notification
  await sendEmail({
    to: notifyEmail,
    template: 'export-ready',
    data: { downloadUrl: url, type, recordCount: totalCount },
  });

  await job.updateProgress(100, 'Complete');

  return {
    url,
    recordCount: totalCount,
    format,
    size: await getFileSize(tempFile),
  };
}, { embedded: true, concurrency: 2 });

// Export all orders for accounting
await exportQueue.add('accounting-export', {
  type: 'orders',
  format: 'csv',
  filters: {
    status: 'completed',
    dateRange: { start: '2024-01-01', end: '2024-12-31' },
  },
  notifyEmail: 'accounting@company.com',
  chunkSize: 5000,
});
```

---

## Multi-Channel Notification System

```
┌──────────┐    ┌──────────┐    ┌─────────────────────────────────────────┐
│  Event   │───▶│  Queue   │───▶│                Worker                   │
│(security,│    │(notifica-│    │  ┌────────────────────────────────────┐│
│ order)   │    │  tions)  │    │  │    Load User Preferences           ││
└──────────┘    └──────────┘    │  └─────────────────┬──────────────────┘│
                                │                    ▼                    │
                                │  ┌─────────────────────────────────────┐│
                                │  │         Fan Out by Channel          ││
                                │  └────┬────────┬────────┬────────┬────┘│
                                │       ▼        ▼        ▼        ▼     │
                                │  ┌───────┐┌───────┐┌───────┐┌───────┐  │
                                │  │ Email ││ Push  ││  SMS  ││In-App │  │
                                │  │       ││ (FCM) ││(Twilio││       │  │
                                │  └───────┘└───────┘└───────┘└───────┘  │
                                └─────────────────────────────────────────┘
```

Send notifications across multiple channels with preferences.

```typescript
interface NotificationJob {
  userId: string;
  type: 'order_update' | 'promotion' | 'security_alert' | 'reminder';
  title: string;
  body: string;
  data?: Record<string, unknown>;
  channels?: ('email' | 'push' | 'sms' | 'in_app')[];
}

const notificationQueue = new Queue<NotificationJob>('notifications', {
  embedded: true,
  defaultJobOptions: {
    attempts: 3,
    backoff: 1000,
  },
});

const notificationWorker = new Worker<NotificationJob>('notifications', async (job) => {
  const { userId, type, title, body, data, channels } = job.data;

  // Get user preferences
  const user = await getUser(userId);
  const prefs = await getNotificationPreferences(userId);

  // Determine channels to use
  const activeChannels = channels || getDefaultChannels(type);
  const allowedChannels = activeChannels.filter(ch => prefs[ch] !== false);

  const results: Record<string, boolean> = {};

  for (const channel of allowedChannels) {
    try {
      switch (channel) {
        case 'email':
          await sendEmail({ to: user.email, subject: title, body });
          break;
        case 'push':
          await sendPushNotification(user.deviceTokens, { title, body, data });
          break;
        case 'sms':
          await sendSMS(user.phone, `${title}: ${body}`);
          break;
        case 'in_app':
          await createInAppNotification(userId, { type, title, body, data });
          break;
      }
      results[channel] = true;
      await job.log(`Sent via ${channel}`);
    } catch (err) {
      results[channel] = false;
      await job.log(`Failed ${channel}: ${err.message}`);
    }
  }

  return {
    userId,
    type,
    channels: results,
    sentAt: new Date().toISOString(),
  };
}, { embedded: true, concurrency: 15 });

// Security alert - high priority, all channels
await notificationQueue.add('security-alert', {
  userId: 'user-123',
  type: 'security_alert',
  title: 'New login detected',
  body: 'A new device logged into your account from San Francisco, CA',
  data: { ip: '192.168.1.1', device: 'Chrome on MacOS' },
  channels: ['email', 'push', 'sms'],
}, { priority: 100 });
```

---

## Payment Processing Queue

```
┌──────────┐    ┌──────────┐    ┌─────────────────────────────────────────┐
│  Order   │───▶│  Queue   │───▶│                Worker                   │
│ Checkout │    │(payments)│    │                                         │
└──────────┘    └──────────┘    │  ┌────────────────────────────────────┐ │
                                │  │     Check Idempotency Key          │ │
                                │  └─────────────────┬──────────────────┘ │
                                │                    ▼                    │
                                │           ┌───────────────┐             │
                                │           │ Already Done? │             │
                                │           └───────┬───────┘             │
                                │              no   │   yes               │
                                │         ┌────────┴────────┐             │
                                │         ▼                 ▼             │
                                │  ┌─────────────┐   ┌─────────────┐      │
                                │  │   Stripe    │   │   Return    │      │
                                │  │  Charge     │   │   Cached    │      │
                                │  └──────┬──────┘   └─────────────┘      │
                                │         ▼                               │
                                │  ┌─────────────┐                        │
                                │  │ Record Txn  │                        │
                                │  │ Audit Log   │                        │
                                │  └─────────────┘                        │
                                └─────────────────────────────────────────┘

                    ⚠️  DLQ: Manual review required (no auto-retry)
```

Secure payment processing with idempotency and audit logging.

```typescript
interface PaymentJob {
  orderId: string;
  amount: number;
  currency: string;
  customerId: string;
  paymentMethodId: string;
  metadata?: Record<string, string>;
  idempotencyKey: string;
}

const paymentQueue = new Queue<PaymentJob>('payments', {
  embedded: true,
  defaultJobOptions: {
    attempts: 3,
    backoff: 5000,
    timeout: 60000,
  },
});

// Configure strict DLQ for failed payments
paymentQueue.setDlqConfig({
  autoRetry: false, // Manual review required
  maxAge: 2592000000, // Keep for 30 days
});

const paymentWorker = new Worker<PaymentJob>('payments', async (job) => {
  const { orderId, amount, currency, customerId, paymentMethodId, idempotencyKey } = job.data;

  await job.log(`Processing payment for order ${orderId}`);

  // Check idempotency
  const existing = await checkIdempotency(idempotencyKey);
  if (existing) {
    await job.log('Payment already processed (idempotent)');
    return existing;
  }

  // Create payment intent
  await job.updateProgress(20, 'Creating payment intent...');
  const intent = await stripe.paymentIntents.create({
    amount: Math.round(amount * 100),
    currency,
    customer: customerId,
    payment_method: paymentMethodId,
    confirm: true,
    idempotency_key: idempotencyKey,
  });

  if (intent.status !== 'succeeded') {
    throw new Error(`Payment failed: ${intent.status}`);
  }

  // Record transaction
  await job.updateProgress(80, 'Recording transaction...');
  await recordTransaction({
    orderId,
    paymentIntentId: intent.id,
    amount,
    currency,
    status: 'completed',
  });

  // Audit log
  await createAuditLog({
    action: 'payment.completed',
    orderId,
    amount,
    paymentIntentId: intent.id,
    jobId: job.id,
  });

  await job.updateProgress(100, 'Complete');

  return {
    paymentIntentId: intent.id,
    status: 'completed',
    processedAt: new Date().toISOString(),
  };
}, { embedded: true, concurrency: 5 });

// Process order payment - CRITICAL: use durable for guaranteed persistence
await paymentQueue.add('charge', {
  orderId: 'ORD-123',
  amount: 99.99,
  currency: 'usd',
  customerId: 'cus_xxx',
  paymentMethodId: 'pm_xxx',
  idempotencyKey: `order-${orderId}-payment`,
}, { durable: true }); // Immediate disk write - no data loss on crash
```

---

## Search Index Synchronization

Keep search indices in sync with database changes.

```typescript
interface IndexJob {
  action: 'index' | 'update' | 'delete';
  entity: 'product' | 'user' | 'article' | 'order';
  id: string;
  data?: Record<string, unknown>;
}

const indexQueue = new Queue<IndexJob>('search-index', {
  embedded: true,
  defaultJobOptions: {
    attempts: 5,
    backoff: 2000,
    removeOnComplete: true,
  },
});

const indexWorker = new Worker<IndexJob>('search-index', async (job) => {
  const { action, entity, id, data } = job.data;
  const indexName = `${entity}s`; // products, users, etc.

  switch (action) {
    case 'index':
    case 'update':
      const document = data || await fetchEntity(entity, id);
      const transformed = transformForSearch(entity, document);
      await elasticsearch.index({
        index: indexName,
        id,
        body: transformed,
      });
      await job.log(`Indexed ${entity}:${id}`);
      break;

    case 'delete':
      await elasticsearch.delete({
        index: indexName,
        id,
        ignore: [404],
      });
      await job.log(`Deleted ${entity}:${id} from index`);
      break;
  }

  return { action, entity, id };
}, { embedded: true, concurrency: 20 });

// Index new product
await indexQueue.add('index-product', {
  action: 'index',
  entity: 'product',
  id: 'prod-123',
  data: {
    name: 'Premium Widget',
    description: 'High-quality widget for professionals',
    price: 49.99,
    categories: ['tools', 'professional'],
    tags: ['premium', 'bestseller'],
  },
});

// Bulk re-index after schema change
const productIds = await getAllProductIds();
await indexQueue.addBulk(
  productIds.map(id => ({
    name: 'reindex',
    data: { action: 'index', entity: 'product', id },
  }))
);
```

---

## Scheduled Tasks with Cron

:::note[Server Mode Feature]
Cron scheduling via `upsertJobScheduler()` is only available in **server mode**. In embedded mode, use `setInterval()` + `queue.add()` for recurring jobs.
:::

Recurring tasks using cron expressions (server mode) or intervals (embedded mode).

### Server Mode (with Cron)

```typescript
// Server mode: use upsertJobScheduler
await scheduledQueue.upsertJobScheduler('daily-cleanup', {
  pattern: '0 3 * * *', // Every day at 3:00 AM
  data: { task: 'cleanup', params: { olderThanDays: 30 } },
});

await scheduledQueue.upsertJobScheduler('health-check', {
  every: 300000, // Every 5 minutes
  data: { task: 'health-check' },
});
```

### Embedded Mode (with setInterval)

```typescript
import { Queue, Worker } from 'bunqueue/client';

interface ScheduledJob {
  task: string;
  params?: Record<string, unknown>;
}

const scheduledQueue = new Queue<ScheduledJob>('scheduled', { embedded: true });

// Recurring job using setInterval
const healthCheckInterval = setInterval(async () => {
  await scheduledQueue.add('health-check', { task: 'health-check' });
}, 300000); // Every 5 minutes

// Daily cleanup (use node-cron or similar for cron expressions)
import cron from 'node-cron';
cron.schedule('0 3 * * *', async () => {
  await scheduledQueue.add('cleanup', {
    task: 'cleanup',
    params: { olderThanDays: 30 },
  });
});

const scheduledWorker = new Worker<ScheduledJob>('scheduled', async (job) => {
  const { task, params } = job.data;

  switch (task) {
    case 'cleanup':
      const deleted = await cleanupOldRecords(params?.olderThanDays);
      return { deleted };

    case 'health-check':
      const status = await checkSystemHealth();
      if (!status.healthy) {
        await alertOps(status);
      }
      return status;
  }
}, { embedded: true });

// Clean up on shutdown
process.on('SIGINT', () => {
  clearInterval(healthCheckInterval);
  scheduledWorker.close();
});
```

---

## Multi-Tenant Queue Isolation

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         MULTI-TENANT ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌────────────────────────────────┐  ┌────────────────────────────────┐ │
│  │          TENANT A              │  │          TENANT B              │ │
│  │    QueueGroup('tenant-a')      │  │    QueueGroup('tenant-b')      │ │
│  │  ┌────────┐ ┌────────┐        │  │  ┌────────┐ ┌────────┐        │ │
│  │  │emails  │ │reports │ ...    │  │  │emails  │ │reports │ ...    │ │
│  │  └────────┘ └────────┘        │  │  └────────┘ └────────┘        │ │
│  │                                │  │                                │ │
│  │  • Isolated namespace          │  │  • Isolated namespace          │ │
│  │  • Independent pause/resume    │  │  • Independent pause/resume    │ │
│  │  • Separate DLQ                │  │  • Separate DLQ                │ │
│  │  • Own rate limits             │  │  • Own rate limits             │ │
│  └────────────────────────────────┘  └────────────────────────────────┘ │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                     SHARED INFRASTRUCTURE                         │   │
│  │              SQLite (single DB, prefixed keys)                    │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

Isolated queues per tenant with resource limits.

```typescript
import { QueueGroup } from 'bunqueue/client';

interface TenantJob {
  action: string;
  data: Record<string, unknown>;
}

// Create isolated queue groups per tenant
function createTenantQueues(tenantId: string) {
  const group = new QueueGroup(tenantId);

  return {
    emails: group.getQueue<TenantJob>('emails', {
      embedded: true,
      defaultJobOptions: { attempts: 3 },
    }),
    reports: group.getQueue<TenantJob>('reports', {
      embedded: true,
      defaultJobOptions: { timeout: 300000 },
    }),
    webhooks: group.getQueue<TenantJob>('webhooks', {
      embedded: true,
      defaultJobOptions: { attempts: 5 },
    }),
    group,
  };
}

// Tenant A
const tenantA = createTenantQueues('tenant-a');
await tenantA.emails.add('send', { action: 'welcome', data: { userId: '123' } });

// Tenant B (completely isolated)
const tenantB = createTenantQueues('tenant-b');
await tenantB.emails.add('send', { action: 'welcome', data: { userId: '456' } });

// Pause all queues for a tenant (maintenance)
tenantA.group.pauseAll();

// Resume
tenantA.group.resumeAll();

// List tenant's queues
console.log(tenantA.group.listQueues()); // ['emails', 'reports', 'webhooks']
```

---

## Rate-Limited API Calls

:::note[Server Mode Feature]
Rate limiting via `setRateLimit()` is only available in **server mode**. In embedded mode, control throughput using worker `concurrency` and job `backoff` options.
:::

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     THROUGHPUT CONTROL                                    │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│   SERVER MODE: setRateLimit(100, 60000)  →  Token bucket algorithm       │
│   EMBEDDED MODE: concurrency + backoff   →  Parallel limit + retry delay │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

External API integration with controlled throughput.

```typescript
interface ApiJob {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

const apiQueue = new Queue<ApiJob>('external-api', {
  embedded: true,
  defaultJobOptions: {
    attempts: 5,
    backoff: 10000, // 10 second base backoff for retries
  },
});

// Control throughput via worker concurrency
const apiWorker = new Worker<ApiJob>('external-api', async (job) => {
  const { endpoint, method, body, headers } = job.data;

  const response = await fetch(endpoint, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // Handle rate limiting from external API
  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get('Retry-After') || '60');
    throw new Error(`Rate limited. Retry after ${retryAfter}s`);
  }

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return await response.json();
}, {
  embedded: true,
  concurrency: 10, // Max 10 parallel requests (controls throughput)
});

// Queue many API calls
for (const item of items) {
  await apiQueue.add('sync', {
    endpoint: 'https://api.external.com/items',
    method: 'POST',
    body: item,
    headers: { 'Authorization': `Bearer ${token}` },
  });
}
```

---

## Parent-Child Job Workflows

```
                         ┌─────────────────────────────────────┐
                         │         ORDER FULFILLMENT           │
                         │           (Parent Job)              │
                         └─────────────────┬───────────────────┘
                                           │
              ┌────────────────────────────┼────────────────────────────┐
              ▼                            ▼                            ▼
     ┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐
     │    Validate     │        │    Validate     │        │   Calculate     │
     │   Inventory     │        │    Payment      │        │    Shipping     │
     │   (Child 1)     │        │   (Child 2)     │        │   (Child 3)     │
     └────────┬────────┘        └────────┬────────┘        └────────┬────────┘
              │                          │                          │
              └──────────────────────────┼──────────────────────────┘
                                         │
                                         ▼
                              ┌─────────────────────┐
                              │   Parent Executes   │
                              │  (all children done)│
                              └─────────────────────┘


                    SEQUENTIAL CHAIN: Extract → Transform → Load
  ┌───────────┐         ┌───────────┐         ┌───────────┐
  │  Extract  │────────▶│ Transform │────────▶│   Load    │
  │  (CSV)    │ result  │  (clean)  │ result  │(warehouse)│
  └───────────┘         └───────────┘         └───────────┘


                    PARALLEL THEN MERGE
        ┌───────────┐
        │  Chunk 1  │──────┐
        └───────────┘      │
        ┌───────────┐      │      ┌───────────┐
        │  Chunk 2  │──────┼─────▶│   Merge   │
        └───────────┘      │      │  Results  │
        ┌───────────┐      │      └───────────┘
        │  Chunk 3  │──────┘
        └───────────┘
```

Complex workflows with dependencies using FlowProducer.

```typescript
import { FlowProducer, Queue, Worker } from 'bunqueue/client';

const flow = new FlowProducer();

// Order fulfillment workflow
const orderFlow = await flow.add({
  name: 'fulfill-order',
  queueName: 'orders',
  data: { orderId: 'ORD-123' },
  children: [
    // These run in parallel first
    {
      name: 'validate-inventory',
      queueName: 'inventory',
      data: { orderId: 'ORD-123' },
    },
    {
      name: 'validate-payment',
      queueName: 'payments',
      data: { orderId: 'ORD-123' },
    },
    {
      name: 'calculate-shipping',
      queueName: 'shipping',
      data: { orderId: 'ORD-123' },
    },
  ],
});

// Sequential chain: A → B → C
const pipeline = await flow.addChain([
  { name: 'extract', queueName: 'etl', data: { source: 's3://bucket/data.csv' } },
  { name: 'transform', queueName: 'etl', data: {} }, // Gets result from extract
  { name: 'load', queueName: 'etl', data: { target: 'warehouse' } },
]);

// Parallel batch then merge
const batchFlow = await flow.addBulkThen(
  // These run in parallel
  [
    { name: 'process-chunk-1', queueName: 'processing', data: { chunk: 1 } },
    { name: 'process-chunk-2', queueName: 'processing', data: { chunk: 2 } },
    { name: 'process-chunk-3', queueName: 'processing', data: { chunk: 3 } },
  ],
  // This runs after all chunks complete
  { name: 'merge-results', queueName: 'processing', data: {} }
);

// Workers can access parent results
const mergeWorker = new Worker('processing', async (job) => {
  if (job.name === 'merge-results') {
    const childResults = await flow.getParentResults(job);
    // childResults = [{ chunk: 1, result: ... }, { chunk: 2, result: ... }, ...]
    return combineResults(childResults);
  }
  // Process individual chunk
  return processChunk(job.data.chunk);
}, { embedded: true });
```

---

## Video Transcoding Pipeline

Multi-resolution video transcoding with progress tracking.

```typescript
interface TranscodeJob {
  sourceUrl: string;
  outputPath: string;
  resolutions: Array<{
    name: string;
    width: number;
    height: number;
    bitrate: string;
  }>;
  format: 'mp4' | 'webm' | 'hls';
  webhookUrl?: string;
}

const transcodeQueue = new Queue<TranscodeJob>('transcode', {
  embedded: true,
  defaultJobOptions: {
    attempts: 2,
    timeout: 3600000, // 1 hour
  },
});

const transcodeWorker = new Worker<TranscodeJob>('transcode', async (job) => {
  const { sourceUrl, outputPath, resolutions, format, webhookUrl } = job.data;
  const results: Record<string, string> = {};

  await job.updateProgress(5, 'Downloading source video...');
  const sourcePath = await downloadVideo(sourceUrl);

  const totalResolutions = resolutions.length;
  for (let i = 0; i < totalResolutions; i++) {
    const res = resolutions[i];
    const progress = 10 + Math.floor((i / totalResolutions) * 85);

    await job.updateProgress(progress, `Transcoding ${res.name}...`);
    await job.log(`Starting ${res.name}: ${res.width}x${res.height} @ ${res.bitrate}`);

    const output = await ffmpeg(sourcePath)
      .size(`${res.width}x${res.height}`)
      .videoBitrate(res.bitrate)
      .format(format)
      .output(`${outputPath}/${res.name}.${format}`)
      .run();

    const url = await uploadToCDN(output, `${outputPath}/${res.name}.${format}`);
    results[res.name] = url;

    await job.log(`Completed ${res.name}: ${url}`);
  }

  // Generate thumbnail
  await job.updateProgress(98, 'Generating thumbnail...');
  const thumbnail = await generateThumbnail(sourcePath);
  results.thumbnail = await uploadToCDN(thumbnail, `${outputPath}/thumb.jpg`);

  // Webhook notification
  if (webhookUrl) {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id, status: 'completed', results }),
    });
  }

  await job.updateProgress(100, 'Complete');

  return {
    outputs: results,
    completedAt: new Date().toISOString(),
  };
}, { embedded: true, concurrency: 2 });

// Transcode uploaded video
await transcodeQueue.add('transcode-video', {
  sourceUrl: 'https://uploads.example.com/raw/video-123.mov',
  outputPath: 'videos/123',
  resolutions: [
    { name: '1080p', width: 1920, height: 1080, bitrate: '5000k' },
    { name: '720p', width: 1280, height: 720, bitrate: '2500k' },
    { name: '480p', width: 854, height: 480, bitrate: '1000k' },
    { name: '360p', width: 640, height: 360, bitrate: '500k' },
  ],
  format: 'mp4',
  webhookUrl: 'https://api.example.com/webhooks/transcode',
});
```

---

## Graceful Shutdown Pattern

Production-ready shutdown handling for all workers.

```typescript
import { Queue, Worker, shutdownManager } from 'bunqueue/client';

// Initialize all queues and workers
const queues = {
  emails: new Queue('emails', { embedded: true }),
  reports: new Queue('reports', { embedded: true }),
  webhooks: new Queue('webhooks', { embedded: true }),
};

const workers = {
  emails: new Worker('emails', emailProcessor, { embedded: true, concurrency: 10 }),
  reports: new Worker('reports', reportProcessor, { embedded: true, concurrency: 3 }),
  webhooks: new Worker('webhooks', webhookProcessor, { embedded: true, concurrency: 20 }),
};

// Graceful shutdown handler
async function gracefulShutdown(signal: string) {
  console.log(`\nReceived ${signal}. Starting graceful shutdown...`);

  // 1. Stop accepting new jobs
  console.log('Pausing all workers...');
  for (const worker of Object.values(workers)) {
    worker.pause();
  }

  // 2. Wait for active jobs to complete (with timeout)
  console.log('Waiting for active jobs to complete...');
  const shutdownTimeout = 30000; // 30 seconds

  try {
    await Promise.race([
      Promise.all(Object.values(workers).map(w => w.close())),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Shutdown timeout')), shutdownTimeout)
      ),
    ]);
    console.log('All workers closed gracefully');
  } catch (err) {
    console.log('Forcing worker shutdown...');
    await Promise.all(Object.values(workers).map(w => w.close(true)));
  }

  // 3. Close queue connections
  console.log('Closing queue connections...');
  await Promise.all(Object.values(queues).map(q => q.close()));

  // 4. Shutdown the embedded manager (flushes SQLite)
  shutdownManager();

  console.log('Shutdown complete');
  process.exit(0);
}

// Register signal handlers
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught errors
process.on('uncaughtException', async (err) => {
  console.error('Uncaught exception:', err);
  await gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', async (reason) => {
  console.error('Unhandled rejection:', reason);
  await gracefulShutdown('unhandledRejection');
});
```
