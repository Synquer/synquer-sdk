# Synquer

> Lightweight observability SDK for sync jobs

Synquer helps you track and monitor integration/sync jobs in your applications. Send telemetry to the Synquer platform and get visibility into your sync operations.

## Installation

```bash
npm install synquer
```

## Quick Start

```typescript
import { Synquer } from 'synquer';

const synquer = new Synquer({
  apiKey: process.env.SYNQUER_API_KEY!,
});

// Create a job
const job = synquer.job({
  type: 'order_sync',
  entity: { type: 'order', id: '12345', ref: '#1001' },
});

// Track progress
job.event('Fetching order from Shopify');
job.event({ message: 'Processing', progress: 50 });

// Complete the job
try {
  const result = await syncOrder();
  await job.done({ invoiceId: result.id });
} catch (error) {
  await job.failed(error);
}
```

## Modes

### Per-Job Mode (Default)

Best for serverless environments (Cloud Functions, Vercel, Lambda). Events are collected per job and sent in a single HTTP call when the job completes.

```typescript
const synquer = new Synquer({
  apiKey: process.env.SYNQUER_API_KEY!,
  mode: 'per-job',
});
```

### Batch Mode

Best for long-running processes. Events are buffered globally and sent periodically.

```typescript
const synquer = new Synquer({
  apiKey: process.env.SYNQUER_API_KEY!,
  mode: 'batch',
  batchSize: 50,
  flushInterval: 5000,
});

// Don't forget to flush on shutdown
process.on('SIGTERM', async () => {
  await synquer.shutdown();
  process.exit(0);
});
```

## API

### `new Synquer(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | required | Your Synquer API key |
| `endpoint` | `string` | `'https://api.synquer.dev'` | API endpoint |
| `mode` | `'per-job' \| 'batch'` | `'per-job'` | Operating mode |
| `disabled` | `boolean` | `false` | Disable all telemetry |
| `batchSize` | `number` | `50` | Batch mode: flush after N events |
| `flushInterval` | `number` | `5000` | Batch mode: flush interval (ms) |

### `synquer.job(options)`

| Option | Type | Description |
|--------|------|-------------|
| `type` | `string` | Job type (e.g., 'order_sync') |
| `externalId` | `string?` | Optional idempotency key |
| `entity` | `object?` | Entity being processed |
| `entity.type` | `string` | Entity type (e.g., 'order') |
| `entity.id` | `string` | Entity ID |
| `entity.ref` | `string?` | Human-readable reference |
| `metadata` | `object?` | Additional metadata |

### `job.event(options)`

```typescript
// Simple message
job.event('Processing order');

// With options
job.event({
  message: 'Sending to ERP',
  progress: 75,
  level: 'info',
  data: { erpId: 'ERP-123' },
});
```

### `job.done(result?)`

Mark job as completed. Optionally include result data.

### `job.failed(error)`

Mark job as failed. Accepts any error object.

## License

MIT
