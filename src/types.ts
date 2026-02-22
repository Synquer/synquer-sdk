/**
 * Configuration options for the Synquer client.
 */
export interface SynquerOptions {
  /** API key for authentication (e.g., sk_live_xxx, sk_dev_xxx) */
  apiKey: string;

  /** API base URL. Default: 'https://api.synquer.dev' */
  baseUrl?: string;

  /**
   * Sending mode:
   * - 'per-job': Events stored per job, sent in a single HTTP call on done()/failed(). Best for serverless.
   * - 'batch': Events buffered globally, flushed periodically. Best for long-running processes.
   *
   * Default: 'per-job'
   */
  mode?: 'per-job' | 'batch';

  /** Batch mode: interval in ms between automatic flushes. Default: 2000 */
  batchInterval?: number;

  /** Batch mode: max events before auto-flush. Default: 100 */
  batchSize?: number;

  /** Max retry attempts for failed HTTP requests. Default: 3 */
  maxRetries?: number;

  /** Called when an HTTP send fails after all retries */
  onError?: (error: Error) => void;

  /** When true, disables all HTTP calls. Useful for testing. Default: false */
  disabled?: boolean;
}

/**
 * Options for creating a new job.
 */
export interface JobOptions {
  /** Job type identifier (e.g., 'order_sync', 'inventory_update') */
  type: string;

  /** Entity being synced */
  entity?: {
    type: string;
    id: string;
    ref?: string;
  };

  /** Idempotency key - same externalId = same job in the API */
  externalId?: string;

  /** Arbitrary metadata attached to the job */
  metadata?: Record<string, unknown>;
}

/**
 * Options for logging a job event.
 */
export interface EventOptions {
  message?: string;
  data?: Record<string, unknown>;
}

/**
 * Internal event shape sent to the API.
 */
export interface IngestEvent {
  jobId: string;
  externalId?: string;
  type: 'job.started' | 'job.event' | 'job.done' | 'job.failed' | 'job.skipped' | 'job.review';
  timestamp: number;
  data?: Record<string, unknown>;
}

/**
 * Response from the events batch API.
 */
export interface BatchResponse {
  received: number;
  processed: number;
  errors: Array<{ index: number; error: string }>;
}
