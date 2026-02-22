import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Synquer } from '../src/client.js';

describe('Synquer Client', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ received: 1, processed: 1, errors: [] }),
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -- Constructor --

  it('throws if apiKey is empty', () => {
    expect(() => new Synquer({ apiKey: '' })).toThrow('apiKey is required');
  });

  it('creates client with defaults', () => {
    const client = new Synquer({ apiKey: 'sk_dev_test' });
    expect(client).toBeDefined();
  });

  // -- Per-job mode --

  it('sends events immediately on job.done() in per-job mode', async () => {
    const client = new Synquer({ apiKey: 'sk_dev_test', baseUrl: 'http://localhost:3001' });
    const job = client.job({ type: 'order_sync' });
    job.event('Processing');
    await job.done({ result: true });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:3001/v1/events/batch');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Authorization']).toBe('Bearer sk_dev_test');
    expect(opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body);
    expect(body.events).toHaveLength(3);
    expect(body.events[0].type).toBe('job.started');
    expect(body.events[1].type).toBe('job.event');
    expect(body.events[2].type).toBe('job.done');
  });

  it('sends events on job.failed() in per-job mode', async () => {
    const client = new Synquer({ apiKey: 'sk_dev_test', baseUrl: 'http://localhost:3001' });
    const job = client.job({ type: 'order_sync' });
    await job.failed(new Error('Timeout'));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.events).toHaveLength(2);
    expect(body.events[1].type).toBe('job.failed');
  });

  it('strips trailing slash from baseUrl', async () => {
    const client = new Synquer({ apiKey: 'sk_dev_test', baseUrl: 'http://localhost:3001/' });
    const job = client.job({ type: 'test' });
    await job.done();

    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:3001/v1/events/batch');
  });

  // -- Disabled mode --

  it('does not send events when disabled', async () => {
    const client = new Synquer({ apiKey: 'sk_dev_test', disabled: true });
    const job = client.job({ type: 'test' });
    await job.done();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // -- Batch mode --

  it('buffers events and flushes in batch mode', async () => {
    const client = new Synquer({
      apiKey: 'sk_dev_test',
      baseUrl: 'http://localhost:3001',
      mode: 'batch',
      batchInterval: 60_000, // Long interval so we manually flush
    });

    const job1 = client.job({ type: 'order_sync' });
    await job1.done();

    const job2 = client.job({ type: 'inventory_sync' });
    await job2.done();

    // Nothing sent yet (buffered)
    expect(fetchSpy).not.toHaveBeenCalled();

    // Manual flush
    await client.flush();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    // job1: started + done = 2, job2: started + done = 2
    expect(body.events).toHaveLength(4);

    await client.shutdown();
  });

  it('auto-flushes when batchSize is reached', async () => {
    const client = new Synquer({
      apiKey: 'sk_dev_test',
      baseUrl: 'http://localhost:3001',
      mode: 'batch',
      batchSize: 3,
      batchInterval: 60_000,
    });

    // Job with started + done = 2 events
    const job1 = client.job({ type: 'test' });
    await job1.done();

    // Not yet flushed (2 < 3)
    expect(fetchSpy).not.toHaveBeenCalled();

    // Job2 adds started + done = 2 more, total = 4 > 3, should auto-flush
    const job2 = client.job({ type: 'test' });
    await job2.done();

    expect(fetchSpy).toHaveBeenCalled();

    await client.shutdown();
  });

  it('shutdown flushes remaining events', async () => {
    const client = new Synquer({
      apiKey: 'sk_dev_test',
      baseUrl: 'http://localhost:3001',
      mode: 'batch',
      batchInterval: 60_000,
    });

    const job = client.job({ type: 'test' });
    await job.done();

    expect(fetchSpy).not.toHaveBeenCalled();

    await client.shutdown();

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('shutdown is idempotent', async () => {
    const client = new Synquer({
      apiKey: 'sk_dev_test',
      baseUrl: 'http://localhost:3001',
      mode: 'batch',
      batchInterval: 60_000,
    });

    const job = client.job({ type: 'test' });
    await job.done();

    await client.shutdown();
    await client.shutdown();

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  // -- Retry logic --

  it('retries on 500 errors', async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ received: 1, processed: 1, errors: [] }) });

    const client = new Synquer({
      apiKey: 'sk_dev_test',
      baseUrl: 'http://localhost:3001',
      maxRetries: 3,
    });

    const job = client.job({ type: 'test' });
    await job.done();

    // Initial + 2 retries = 3 calls total
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('does not retry on 401 errors', async () => {
    const onError = vi.fn();
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Invalid API key' }),
    });

    const client = new Synquer({
      apiKey: 'sk_dev_invalid',
      baseUrl: 'http://localhost:3001',
      onError,
    });

    const job = client.job({ type: 'test' });
    await job.done();

    // No retries for 401
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toContain('401');
  });

  it('does not retry on 400 errors', async () => {
    const onError = vi.fn();
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'Validation error' }),
    });

    const client = new Synquer({
      apiKey: 'sk_dev_test',
      baseUrl: 'http://localhost:3001',
      onError,
    });

    const job = client.job({ type: 'test' });
    await job.done();

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('calls onError after retries exhausted', async () => {
    const onError = vi.fn();
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });

    const client = new Synquer({
      apiKey: 'sk_dev_test',
      baseUrl: 'http://localhost:3001',
      maxRetries: 1,
      onError,
    });

    const job = client.job({ type: 'test' });
    await job.done();

    // Initial + 1 retry = 2
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('handles fetch network errors', async () => {
    const onError = vi.fn();
    fetchSpy.mockRejectedValue(new Error('Network error'));

    const client = new Synquer({
      apiKey: 'sk_dev_test',
      baseUrl: 'http://localhost:3001',
      maxRetries: 0,
      onError,
    });

    const job = client.job({ type: 'test' });
    await job.done();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toBe('Network error');
  });

  it('accepts 207 as success', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 207,
      json: () => Promise.resolve({ received: 2, processed: 1, errors: [{ index: 1, error: 'oops' }] }),
    });

    const onError = vi.fn();
    const client = new Synquer({
      apiKey: 'sk_dev_test',
      baseUrl: 'http://localhost:3001',
      onError,
    });

    const job = client.job({ type: 'test' });
    await job.done();

    // 207 is treated as success
    expect(onError).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  // -- Multiple jobs --

  it('generates unique job IDs', () => {
    const client = new Synquer({ apiKey: 'sk_dev_test', disabled: true });

    const job1 = client.job({ type: 'test' });
    const job2 = client.job({ type: 'test' });

    expect(job1.id).not.toBe(job2.id);
  });

  // -- Flush edge cases --

  it('flush does nothing when buffer is empty', async () => {
    const client = new Synquer({
      apiKey: 'sk_dev_test',
      mode: 'batch',
      batchInterval: 60_000,
    });

    await client.flush();
    expect(fetchSpy).not.toHaveBeenCalled();

    await client.shutdown();
  });

  it('puts events back in buffer on flush failure', async () => {
    fetchSpy
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) });

    const client = new Synquer({
      apiKey: 'sk_dev_test',
      baseUrl: 'http://localhost:3001',
      mode: 'batch',
      batchInterval: 60_000,
      maxRetries: 0,
    });

    const job = client.job({ type: 'test' });
    await job.done();

    // First flush fails, events should go back to buffer
    await client.flush();

    // Second flush should retry with the same events
    await client.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
    expect(body.events).toHaveLength(2); // started + done

    await client.shutdown();
  });
});
