import type { JobOptions, EventOptions, IngestEvent } from './types.js';

/**
 * Represents a single sync job being tracked.
 *
 * Collects events locally and provides methods to complete the job.
 * In per-job mode, events are sent to the API when done/failed/skip/review is called.
 * In batch mode, events are moved to the global buffer.
 */
export class Job {
  readonly id: string;
  private readonly _events: IngestEvent[] = [];
  private readonly _sendFn: (events: IngestEvent[]) => Promise<void>;
  private _completed = false;

  constructor(
    id: string,
    options: JobOptions,
    sendFn: (events: IngestEvent[]) => Promise<void>,
  ) {
    this.id = id;
    this._sendFn = sendFn;

    // Add the started event immediately
    this._events.push({
      jobId: this.id,
      externalId: options.externalId,
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
   */
  async done(result?: unknown): Promise<void> {
    if (this._completed) return;
    this._completed = true;

    const startTs = this._events[0]?.timestamp ?? Date.now();
    const now = Date.now();

    this._events.push({
      jobId: this.id,
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
  async failed(error: unknown): Promise<void> {
    if (this._completed) return;
    this._completed = true;

    const startTs = this._events[0]?.timestamp ?? Date.now();
    const now = Date.now();

    let errorData: Record<string, unknown>;
    if (error instanceof Error) {
      errorData = {
        message: error.message,
        stack: error.stack,
      };
    } else if (typeof error === 'string') {
      errorData = { message: error };
    } else {
      errorData = { message: String(error) };
    }

    this._events.push({
      jobId: this.id,
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
  async skip(reason: string): Promise<void> {
    if (this._completed) return;
    this._completed = true;

    this._events.push({
      jobId: this.id,
      type: 'job.skipped',
      timestamp: Date.now(),
      data: { message: reason },
    });

    await this._sendFn(this._events);
  }

  /**
   * Mark the job for manual review.
   */
  async review(reason: string): Promise<void> {
    if (this._completed) return;
    this._completed = true;

    this._events.push({
      jobId: this.id,
      type: 'job.review',
      timestamp: Date.now(),
      data: { message: reason },
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
