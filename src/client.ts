import { Job } from './job.js';
import type { SynquerOptions, JobOptions, IngestEvent } from './types.js';

const DEFAULT_BASE_URL = 'https://api.synquer.dev';
const DEFAULT_MODE = 'per-job';
const DEFAULT_BATCH_INTERVAL = 2000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_RETRIES = 3;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Main Synquer client.
 *
 * Create a single instance per process and use it to create jobs.
 */
export class Synquer {
  private readonly _options: Required<Pick<SynquerOptions, 'apiKey' | 'baseUrl' | 'mode' | 'batchInterval' | 'batchSize' | 'maxRetries' | 'disabled'>> & {
    onError?: (error: Error) => void;
  };

  private _buffer: IngestEvent[] = [];
  private _flushTimer: ReturnType<typeof setInterval> | null = null;
  private _flushing = false;
  private _shutdownCalled = false;

  constructor(options: SynquerOptions) {
    if (!options.apiKey) {
      throw new Error('Synquer: apiKey is required');
    }

    this._options = {
      apiKey: options.apiKey,
      baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
      mode: options.mode ?? DEFAULT_MODE,
      batchInterval: options.batchInterval ?? DEFAULT_BATCH_INTERVAL,
      batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      disabled: options.disabled ?? false,
      onError: options.onError,
    };
  }

  /**
   * Create a new job to track a sync operation.
   */
  job(options: JobOptions): Job {
    const id = crypto.randomUUID();

    const sendFn = async (events: IngestEvent[]): Promise<void> => {
      if (this._options.mode === 'per-job') {
        // Per-job mode: send immediately (fire-and-forget, never throw)
        try {
          await this._send(events);
        } catch {
          // Silently ignore - telemetry should never break the app
        }
      } else {
        // Batch mode: add to global buffer
        this._buffer.push(...events);
        this._ensureFlushTimer();

        // Auto-flush if buffer is full
        if (this._buffer.length >= this._options.batchSize) {
          await this.flush();
        }
      }
    };

    return new Job(id, options, sendFn);
  }

  /**
   * Manually flush all buffered events to the API.
   * Only relevant in batch mode.
   */
  async flush(): Promise<void> {
    if (this._buffer.length === 0 || this._flushing) return;
    this._flushing = true;

    const events = this._buffer.splice(0);

    try {
      await this._send(events);
    } catch {
      // Put events back at the front of the buffer on failure
      this._buffer.unshift(...events);
    } finally {
      this._flushing = false;
    }
  }

  /**
   * Gracefully shutdown: flush remaining events and stop timers.
   */
  async shutdown(): Promise<void> {
    if (this._shutdownCalled) return;
    this._shutdownCalled = true;

    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }

    // Final flush
    if (this._buffer.length > 0) {
      await this.flush();
    }
  }

  /**
   * Send events to the API with retry logic.
   */
  private async _send(events: IngestEvent[]): Promise<void> {
    if (this._options.disabled || events.length === 0) return;

    const url = `${this._options.baseUrl}/v1/events/batch`;
    const body = JSON.stringify({ events });

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this._options.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this._options.apiKey}`,
          },
          body,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.ok || response.status === 207) {
          return; // Success (200 or 207 partial)
        }

        // Non-retryable status codes
        if (response.status === 400 || response.status === 401) {
          const data = await response.json().catch(() => ({})) as Record<string, unknown>;
          lastError = new Error(`Synquer API error ${response.status}: ${data.error ?? 'Unknown error'}`);
          break; // Don't retry 400/401
        }

        // Retryable errors (500, 502, 503, 429, etc.)
        lastError = new Error(`Synquer API error ${response.status}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }

      // Exponential backoff before retry
      if (attempt < this._options.maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10_000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // All retries exhausted
    if (lastError) {
      if (this._options.onError) {
        this._options.onError(lastError);
      }
      throw lastError;
    }
  }

  /**
   * Start the periodic flush timer for batch mode.
   */
  private _ensureFlushTimer(): void {
    if (this._flushTimer || this._shutdownCalled) return;

    this._flushTimer = setInterval(() => {
      this.flush().catch(() => {
        // Silently ignore flush errors - events remain in buffer
      });
    }, this._options.batchInterval);

    // Unref the timer so it doesn't keep the process alive
    if (typeof this._flushTimer === 'object' && 'unref' in this._flushTimer) {
      this._flushTimer.unref();
    }
  }
}
