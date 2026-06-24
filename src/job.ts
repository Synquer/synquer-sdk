import type { JobOptions, EventOptions, IngestEvent } from './types.js';

/**
 * Serialize an arbitrary value to JSON without throwing on circular
 * references (e.g. an axios/node-soap error whose `response` holds a live
 * socket) and without producing an unbounded payload. Telemetry must never
 * throw into application code, so this always returns a string.
 */
function safeStringify(value: unknown, maxLen = 2000): string {
  const seen = new WeakSet<object>();
  let out: string;
  try {
    out =
      JSON.stringify(value, (_key, val) => {
        if (typeof val === 'bigint') return val.toString();
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        return val;
      }) ?? String(value);
  } catch {
    out = String(value);
  }
  return out.length > maxLen ? out.slice(0, maxLen) + '…[truncated]' : out;
}

/**
 * Extract a readable `{ message, stack? }` from whatever an application throws.
 *
 * Crucially, a non-Error object (a node-soap SOAP fault, a rejected plain
 * object, an axios error) is no longer collapsed to the useless string
 * "[object Object]": we use its `.message` if present, otherwise serialize it
 * so the real detail survives.
 */
function normalizeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  if (typeof error === 'string') {
    return { message: error };
  }
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    const stack = typeof e.stack === 'string' ? e.stack : undefined;
    if (typeof e.message === 'string' && e.message.length > 0) {
      return { message: e.message, ...(stack && { stack }) };
    }
    return { message: safeStringify(error), ...(stack && { stack }) };
  }
  return { message: String(error) };
}

/**
 * Represents a single sync job being tracked.
 *
 * Collects events locally and provides methods to complete the job.
 * In per-job mode, events are sent to the API when done/failed/skip/review is called.
 * In batch mode, events are moved to the global buffer.
 */
export class Job {
  readonly id: string;
  private _externalId: string | undefined;
  private readonly _events: IngestEvent[] = [];
  private readonly _sendFn: (events: IngestEvent[]) => Promise<void>;
  private _completed = false;

  constructor(
    id: string,
    options: JobOptions,
    sendFn: (events: IngestEvent[]) => Promise<void>,
  ) {
    this.id = id;
    this._externalId = options.externalId;
    this._sendFn = sendFn;

    // Add the started event immediately
    this._events.push({
      jobId: this.id,
      externalId: this._externalId,
      type: 'job.started',
      timestamp: Date.now(),
      data: {
        jobType: options.type,
        ...(options.entity?.type && { entityType: options.entity.type }),
        ...(options.entity?.id && { entityId: options.entity.id }),
        ...(options.entity?.ref && { entityRef: options.entity.ref }),
        ...(options.metadata && Object.keys(options.metadata).length > 0 && { metadata: options.metadata }),
      },
    });
  }

  /**
   * Current external ID (idempotency key). Undefined until set.
   */
  get externalId(): string | undefined {
    return this._externalId;
  }

  /**
   * Set or update the external ID after job creation. Use this when the
   * upstream system returns its ID only after the work runs (e.g. SAP order
   * number, Stripe payment intent).
   *
   * In per-job mode the started event hasn't been sent yet, so the new value
   * is also stamped onto it — the server's first ingest matches on it.
   * In batch mode the started event may already have flushed; the externalId
   * is stamped onto the next terminal event, and the server fills it in.
   *
   * No-op if the job is already completed.
   */
  setExternalId(externalId: string): void {
    if (this._completed) return;
    this._externalId = externalId;
    const startedEvent = this._events[0];
    if (startedEvent && startedEvent.type === 'job.started') {
      startedEvent.externalId = externalId;
    }
  }

  /**
   * Log an event during job processing.
   */
  event(message: string): void;
  event(options: EventOptions): void;
  event(messageOrOptions: string | EventOptions): void {
    if (this._completed) return;

    const opts: EventOptions = typeof messageOrOptions === 'string'
      ? { message: messageOrOptions }
      : messageOrOptions;

    this._events.push({
      jobId: this.id,
      type: 'job.event',
      timestamp: Date.now(),
      data: {
        ...(opts.message && { message: opts.message }),
        ...opts.data,
      },
    });
  }

  /**
   * Mark the job as successfully completed.
   *
   * Pass `{ externalId }` to set the idempotency key at completion time
   * (e.g. when the upstream system only returns its ID on success).
   */
  async done(
    result?: unknown,
    options?: { externalId?: string },
  ): Promise<void> {
    if (this._completed) return;
    if (options?.externalId) this.setExternalId(options.externalId);
    this._completed = true;

    const startTs = this._events[0]?.timestamp ?? Date.now();
    const now = Date.now();

    this._events.push({
      jobId: this.id,
      externalId: this._externalId,
      type: 'job.done',
      timestamp: now,
      data: {
        ...(result !== undefined && { result }),
        durationMs: now - startTs,
      },
    });

    await this._sendFn(this._events);
  }

  /**
   * Mark the job as failed.
   */
  async failed(
    error: unknown,
    options?: { externalId?: string },
  ): Promise<void> {
    if (this._completed) return;
    if (options?.externalId) this.setExternalId(options.externalId);
    this._completed = true;

    const startTs = this._events[0]?.timestamp ?? Date.now();
    const now = Date.now();

    const errorData = normalizeError(error);

    this._events.push({
      jobId: this.id,
      externalId: this._externalId,
      type: 'job.failed',
      timestamp: now,
      data: {
        error: errorData,
        durationMs: now - startTs,
      },
    });

    await this._sendFn(this._events);
  }

  /**
   * Mark the job as skipped.
   */
  async skip(
    reason: string,
    options?: { externalId?: string },
  ): Promise<void> {
    if (this._completed) return;
    if (options?.externalId) this.setExternalId(options.externalId);
    this._completed = true;

    const startTs = this._events[0]?.timestamp ?? Date.now();
    const now = Date.now();

    this._events.push({
      jobId: this.id,
      externalId: this._externalId,
      type: 'job.skipped',
      timestamp: now,
      data: {
        message: reason,
        durationMs: now - startTs,
      },
    });

    await this._sendFn(this._events);
  }

  /**
   * Mark the job for manual review.
   */
  async review(
    reason: string,
    options?: { externalId?: string },
  ): Promise<void> {
    if (this._completed) return;
    if (options?.externalId) this.setExternalId(options.externalId);
    this._completed = true;

    const startTs = this._events[0]?.timestamp ?? Date.now();
    const now = Date.now();

    this._events.push({
      jobId: this.id,
      externalId: this._externalId,
      type: 'job.review',
      timestamp: now,
      data: {
        message: reason,
        durationMs: now - startTs,
      },
    });

    await this._sendFn(this._events);
  }

  /**
   * Returns the collected events (for internal use / testing).
   */
  getEvents(): ReadonlyArray<IngestEvent> {
    return this._events;
  }

  /**
   * Whether this job has been completed (done/failed/skip/review).
   */
  get completed(): boolean {
    return this._completed;
  }
}
