# Synquer SDK

> Lightweight observability SDK for sync jobs. Open source.

## Project Overview

Synquer SDK is a TypeScript library that allows developers to track sync/integration jobs and send telemetry to the Synquer platform. It's designed to work in serverless environments (Cloud Functions, Vercel, AWS Lambda) and long-running processes.

**Repository**: `synquer-sdk` (public, open source)
**npm package**: `synquer`
**Related**: `synquer-platform` (private) - the API and dashboard

---

## Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime | Node.js 22+ (also Bun, Edge) | Modern runtime features |
| Language | TypeScript 5.7+ | Full type safety |
| Dependencies | Zero runtime deps | Keep it lightweight |
| Build | tsup | Fast, simple bundler |
| Test | Vitest | Fast, modern |
| Package | ESM + CJS dual | Maximum compatibility |

---

## Architecture

### Two Modes

1. **`per-job` mode** (default) - For serverless/short-lived processes
   - Events collected per job
   - Single HTTP call on `job.done()` or `job.failed()`
   - No timers, no background processes

2. **`batch` mode** - For long-running processes
   - Events buffered globally
   - Periodic flush (configurable interval)
   - Graceful shutdown handling

### Core API

```typescript
import { Synquer } from 'synquer';

const synquer = new Synquer({
  apiKey: process.env.SYNQUER_API_KEY!,
  mode: 'per-job', // or 'batch'
});

// Create a job
const job = synquer.job({
  type: 'order_sync',
  externalId: 'optional-idempotency-key',
  entity: { type: 'order', id: '12345', ref: '#1001' },
  metadata: { source: 'shopify' },
});

// Track progress
job.event('Fetching order from Shopify');
job.event({ message: 'Processing line items', progress: 50 });

// Complete
try {
  const result = await doSyncWork();
  await job.done({ invoiceId: result.id });
} catch (error) {
  await job.failed(error);
}
```

---

## File Structure

```
synquer-sdk/
├── src/
│   ├── index.ts          # Public exports
│   ├── client.ts         # Synquer class
│   ├── job.ts            # Job class
│   └── types.ts          # All TypeScript types
├── tests/
│   ├── client.test.ts
│   ├── job.test.ts
│   └── integration.test.ts
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── README.md
├── LICENSE              # MIT
├── CHANGELOG.md
└── .github/
    └── workflows/
        └── ci.yml
```

---

## Type Definitions

```typescript
// src/types.ts

export interface SynquerOptions {
  apiKey: string;
  endpoint?: string;      // Default: 'https://api.synquer.dev'
  mode?: 'per-job' | 'batch';
  disabled?: boolean;     // For testing/dev

  // Batch mode options
  batchSize?: number;     // Default: 50
  flushInterval?: number; // Default: 5000ms

  // Retry options
  maxRetries?: number;    // Default: 3
  retryDelay?: number;    // Default: 1000ms
}

export interface JobOptions {
  type: string;           // e.g., 'order_sync', 'inventory_update'
  externalId?: string;    // Idempotency key
  entity?: {
    type: string;         // e.g., 'order', 'product'
    id: string;           // Entity ID
    ref?: string;         // Human-readable reference
  };
  metadata?: Record<string, unknown>;
}

export interface EventOptions {
  message: string;
  progress?: number;      // 0-100
  level?: 'info' | 'warn' | 'error';
  data?: Record<string, unknown>;
}

// Internal types
export interface Event {
  jobId: string;
  type: 'job_started' | 'job_event' | 'job_completed' | 'job_failed';
  timestamp: string;
  payload: Record<string, unknown>;
}
```

---

## Implementation Notes

### HTTP Client
- Use native `fetch` (available in Node 22+, Bun, Edge)
- Implement exponential backoff for retries
- Timeout: 10 seconds per request

### Error Handling
- Never throw on telemetry failures (fire-and-forget)
- Log warnings to console in development
- `disabled: true` skips all HTTP calls

### Batch Mode Internals
```typescript
// Global buffer for batch mode
private globalBuffer: Event[] = [];
private flushTimer?: NodeJS.Timeout;

// Start timer on first event
private startFlushTimer(): void {
  if (this.flushTimer) return;
  this.flushTimer = setInterval(() => this.flush(), this.options.flushInterval);
}

// Graceful shutdown
async shutdown(): Promise<void> {
  if (this.flushTimer) clearInterval(this.flushTimer);
  await this.flush();
}
```

### API Payload Format
```typescript
// POST /api/v1/ingest
{
  events: [
    {
      jobId: "uuid",
      type: "job_started",
      timestamp: "2026-02-20T10:00:00.000Z",
      payload: {
        jobType: "order_sync",
        entity: { type: "order", id: "123", ref: "#1001" }
      }
    },
    {
      jobId: "uuid",
      type: "job_event",
      timestamp: "2026-02-20T10:00:01.000Z",
      payload: {
        message: "Processing",
        progress: 50
      }
    },
    {
      jobId: "uuid",
      type: "job_completed",
      timestamp: "2026-02-20T10:00:02.000Z",
      payload: {
        result: { invoiceId: "INV-001" },
        durationMs: 2000
      }
    }
  ]
}
```

---

## Testing Strategy

1. **Unit tests**: Mock fetch, test event collection
2. **Integration tests**: Use MSW to mock API responses
3. **Edge cases**:
   - API failures (retry logic)
   - Disabled mode
   - Missing optional fields
   - Very long event messages (truncation?)

---

## Implementation Order

1. `src/types.ts` - All interfaces and types
2. `src/job.ts` - Job class (event collection)
3. `src/client.ts` - Synquer class (HTTP, batching)
4. `src/index.ts` - Public exports
5. Tests for each module
6. Build configuration (tsup)
7. README with examples

---

## Commands

```bash
npm install     # Install dev dependencies
npm run build   # Build with tsup
npm run test    # Run vitest
npm run lint    # ESLint
npm run dev     # Watch mode for development
```

---

## Publishing Checklist

Before publishing to npm:
- [ ] All tests pass
- [ ] README is complete with examples
- [ ] CHANGELOG updated
- [ ] Version bumped
- [ ] LICENSE file present (MIT)
- [ ] `.npmignore` or `files` field configured
- [ ] Test with `npm pack` locally
