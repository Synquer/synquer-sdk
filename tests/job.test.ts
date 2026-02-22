import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Job } from '../src/job.js';
import type { IngestEvent } from '../src/types.js';

describe('Job', () => {
  let sendFn: ReturnType<typeof vi.fn>;
  let capturedEvents: IngestEvent[];

  beforeEach(() => {
    capturedEvents = [];
    sendFn = vi.fn(async (events: IngestEvent[]) => {
      capturedEvents = events;
    });
  });

  it('creates a job with a started event', () => {
    const job = new Job('test-id', { type: 'order_sync' }, sendFn);

    expect(job.id).toBe('test-id');
    expect(job.completed).toBe(false);

    const events = job.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('job.started');
    expect(events[0].jobId).toBe('test-id');
    expect(events[0].data?.jobType).toBe('order_sync');
    expect(events[0].timestamp).toBeTypeOf('number');
  });

  it('includes entity info in started event', () => {
    const job = new Job('test-id', {
      type: 'order_sync',
      entity: { type: 'order', id: '123', ref: '#1001' },
      externalId: 'ext-1',
      metadata: { source: 'shopify' },
    }, sendFn);

    const startEvent = job.getEvents()[0];
    expect(startEvent.externalId).toBe('ext-1');
    expect(startEvent.data?.entityType).toBe('order');
    expect(startEvent.data?.entityId).toBe('123');
    expect(startEvent.data?.entityRef).toBe('#1001');
    expect(startEvent.data?.metadata).toEqual({ source: 'shopify' });
  });

  it('collects events via string message', () => {
    const job = new Job('test-id', { type: 'order_sync' }, sendFn);
    job.event('Processing');

    const events = job.getEvents();
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('job.event');
    expect(events[1].data?.message).toBe('Processing');
  });

  it('collects events via EventOptions', () => {
    const job = new Job('test-id', { type: 'order_sync' }, sendFn);
    job.event({ message: 'Progress', data: { step: 1 } });

    const events = job.getEvents();
    expect(events).toHaveLength(2);
    expect(events[1].data?.message).toBe('Progress');
    expect(events[1].data?.step).toBe(1);
  });

  it('marks job as done and sends events', async () => {
    const job = new Job('test-id', { type: 'order_sync' }, sendFn);
    job.event('Step 1');
    await job.done({ invoiceId: 'INV-001' });

    expect(job.completed).toBe(true);
    expect(sendFn).toHaveBeenCalledOnce();
    expect(capturedEvents).toHaveLength(3);

    const doneEvent = capturedEvents[2];
    expect(doneEvent.type).toBe('job.done');
    expect(doneEvent.data?.result).toEqual({ invoiceId: 'INV-001' });
    expect(doneEvent.data?.durationMs).toBeTypeOf('number');
  });

  it('marks job as done without result', async () => {
    const job = new Job('test-id', { type: 'test' }, sendFn);
    await job.done();

    expect(capturedEvents[1].type).toBe('job.done');
    expect(capturedEvents[1].data?.result).toBeUndefined();
  });

  it('marks job as failed with Error', async () => {
    const job = new Job('test-id', { type: 'order_sync' }, sendFn);
    await job.failed(new Error('Connection timeout'));

    expect(job.completed).toBe(true);
    expect(sendFn).toHaveBeenCalledOnce();

    const failedEvent = capturedEvents[1];
    expect(failedEvent.type).toBe('job.failed');
    expect(failedEvent.data?.error).toEqual(
      expect.objectContaining({ message: 'Connection timeout' })
    );
    expect(failedEvent.data?.durationMs).toBeTypeOf('number');
  });

  it('marks job as failed with string', async () => {
    const job = new Job('test-id', { type: 'test' }, sendFn);
    await job.failed('Something went wrong');

    const failedEvent = capturedEvents[1];
    expect(failedEvent.data?.error).toEqual({ message: 'Something went wrong' });
  });

  it('marks job as skipped', async () => {
    const job = new Job('test-id', { type: 'test' }, sendFn);
    await job.skip('Already processed');

    expect(job.completed).toBe(true);
    const skipEvent = capturedEvents[1];
    expect(skipEvent.type).toBe('job.skipped');
    expect(skipEvent.data?.message).toBe('Already processed');
  });

  it('marks job as review', async () => {
    const job = new Job('test-id', { type: 'test' }, sendFn);
    await job.review('Needs manual check');

    expect(job.completed).toBe(true);
    const reviewEvent = capturedEvents[1];
    expect(reviewEvent.type).toBe('job.review');
    expect(reviewEvent.data?.message).toBe('Needs manual check');
  });

  it('ignores events after completion', async () => {
    const job = new Job('test-id', { type: 'test' }, sendFn);
    await job.done();
    job.event('Should be ignored');
    await job.failed('Should also be ignored');

    expect(sendFn).toHaveBeenCalledOnce();
    expect(capturedEvents).toHaveLength(2); // started + done
  });

  it('ignores duplicate done calls', async () => {
    const job = new Job('test-id', { type: 'test' }, sendFn);
    await job.done();
    await job.done();

    expect(sendFn).toHaveBeenCalledOnce();
  });

  it('omits empty metadata from started event', () => {
    const job = new Job('test-id', { type: 'test', metadata: {} }, sendFn);
    const startEvent = job.getEvents()[0];
    expect(startEvent.data?.metadata).toBeUndefined();
  });

  it('preserves event ordering', async () => {
    const job = new Job('test-id', { type: 'test' }, sendFn);
    job.event('Step 1');
    job.event('Step 2');
    job.event('Step 3');
    await job.done();

    expect(capturedEvents.map(e => e.type)).toEqual([
      'job.started',
      'job.event',
      'job.event',
      'job.event',
      'job.done',
    ]);
  });
});
