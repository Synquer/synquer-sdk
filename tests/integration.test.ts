/**
 * Integration test: SDK against the live Synquer API.
 *
 * Prerequisites:
 * - API running at http://localhost:3001
 * - DATABASE_URL set in environment
 * - Plans seeded in database
 * - Test user and environment set up
 *
 * Run with: npx vitest run tests/integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { createHash, randomBytes } from 'node:crypto';
import { Synquer } from '../src/client.js';

const API_URL = 'http://localhost:3001';
const TEST_EMAIL = 'sdk-integration@synquer.dev';

// These are set during setup
let sql: ReturnType<typeof postgres>;
let apiKey: string;
let envId: string;
let sessionToken: string;

function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

// Simple HTTP helper for verifying results via API
async function api(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; apiKey?: string } = {}
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`;

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

describe('SDK Integration', () => {
  beforeAll(async () => {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error('DATABASE_URL not set');
    sql = postgres(dbUrl);

    // Check API is running
    const health = await fetch(`${API_URL}/health`).catch(() => null);
    if (!health?.ok) throw new Error('API not running at ' + API_URL);

    // Seed plans if needed
    const plans = await sql`SELECT id FROM plans LIMIT 1`;
    if (plans.length === 0) {
      await sql`INSERT INTO plans (id, name, events_limit, retention_days, projects_limit, members_limit, price_monthly)
        VALUES ('free', 'Free', 10000, 30, 2, 2, 0)`;
    }

    // Clean up previous test data
    const existingUser = await sql`SELECT id FROM users WHERE email = ${TEST_EMAIL}`;
    if (existingUser.length > 0) {
      await sql`DELETE FROM login_codes WHERE email = ${TEST_EMAIL}`;
      await sql`DELETE FROM sessions WHERE user_id = ${existingUser[0].id}`;
      await sql`DELETE FROM organisation_members WHERE user_id = ${existingUser[0].id}`;
    }
    await sql`DELETE FROM organisations WHERE slug = 'sdk-int-test'`;
    await sql`DELETE FROM users WHERE email = ${TEST_EMAIL}`;

    // Create test user, org, project, environment
    const [user] = await sql`INSERT INTO users (email, name) VALUES (${TEST_EMAIL}, 'SDK Test') RETURNING id`;

    // Auth flow: send code, read from DB, verify
    await api('POST', '/v1/auth/send-code', { body: { email: TEST_EMAIL } });
    const [code] = await sql`SELECT code FROM login_codes WHERE email = ${TEST_EMAIL} AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`;
    const verifyResult = await api('POST', '/v1/auth/verify-code', { body: { email: TEST_EMAIL, code: code.code } });
    sessionToken = verifyResult.data.token;

    // Create org
    const orgResult = await api('POST', '/v1/orgs', {
      token: sessionToken,
      body: { name: 'SDK Integration Test', slug: 'sdk-int-test' },
    });
    const orgSlug = orgResult.data.organization.slug;

    // Create project
    const projResult = await api('POST', `/v1/orgs/${orgSlug}/projects`, {
      token: sessionToken,
      body: { name: 'SDK Test Project', slug: 'sdk-test-project' },
    });
    const projectId = projResult.data.project.id;

    // Create environment
    const envResult = await api('POST', `/v1/projects/${projectId}/environments`, {
      token: sessionToken,
      body: { name: 'development', type: 'development' },
    });
    apiKey = envResult.data.apiKey;
    envId = envResult.data.environment.id;
  }, 30_000);

  afterAll(async () => {
    // Clean up
    const existingUser = await sql`SELECT id FROM users WHERE email = ${TEST_EMAIL}`;
    if (existingUser.length > 0) {
      await sql`DELETE FROM login_codes WHERE email = ${TEST_EMAIL}`;
      await sql`DELETE FROM sessions WHERE user_id = ${existingUser[0].id}`;
      await sql`DELETE FROM organisation_members WHERE user_id = ${existingUser[0].id}`;
    }
    await sql`DELETE FROM organisations WHERE slug = 'sdk-int-test'`;
    await sql`DELETE FROM users WHERE email = ${TEST_EMAIL}`;
    await sql.end();
  });

  it('sends a successful job in per-job mode', async () => {
    const synquer = new Synquer({
      apiKey,
      baseUrl: API_URL,
      mode: 'per-job',
    });

    const job = synquer.job({
      type: 'order_sync',
      entity: { type: 'order', id: 'ORD-123', ref: '#1001' },
      externalId: `sdk-test-${Date.now()}`,
      metadata: { source: 'shopify' },
    });

    job.event('Fetching order');
    job.event({ message: 'Processing line items', data: { count: 5 } });
    await job.done({ invoiceId: 'INV-001' });

    // Verify via API
    const detail = await api('GET', `/v1/jobs/${job.id}`, { token: sessionToken });
    expect(detail.status).toBe(200);
    expect(detail.data.job.status).toBe('succeeded');
    expect(detail.data.job.jobType).toBe('order_sync');
    expect(detail.data.job.entityRef).toBe('#1001');
    expect(detail.data.events).toHaveLength(4); // started + 2 events + done
    expect(detail.data.job.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('sends a failed job in per-job mode', async () => {
    const synquer = new Synquer({ apiKey, baseUrl: API_URL });

    const job = synquer.job({ type: 'inventory_sync' });
    job.event('Connecting to API');
    await job.failed(new Error('Connection refused'));

    const detail = await api('GET', `/v1/jobs/${job.id}`, { token: sessionToken });
    expect(detail.status).toBe(200);
    expect(detail.data.job.status).toBe('failed');
    expect(detail.data.job.errorMessage).toBe('Connection refused');
    expect(detail.data.events).toHaveLength(3); // started + event + failed
  });

  it('sends a skipped job', async () => {
    const synquer = new Synquer({ apiKey, baseUrl: API_URL });

    const job = synquer.job({ type: 'order_sync' });
    await job.skip('Already processed');

    const detail = await api('GET', `/v1/jobs/${job.id}`, { token: sessionToken });
    expect(detail.data.job.status).toBe('skipped');
  });

  it('sends a review job', async () => {
    const synquer = new Synquer({ apiKey, baseUrl: API_URL });

    const job = synquer.job({ type: 'order_sync' });
    await job.review('Needs manual review');

    const detail = await api('GET', `/v1/jobs/${job.id}`, { token: sessionToken });
    expect(detail.data.job.status).toBe('manual_review');
  });

  it('sends multiple jobs in batch mode', async () => {
    const synquer = new Synquer({
      apiKey,
      baseUrl: API_URL,
      mode: 'batch',
      batchInterval: 60_000, // Manual flush
    });

    const job1 = synquer.job({ type: 'order_sync', entity: { type: 'order', id: 'B1' } });
    job1.event('Processing');
    await job1.done({ result: 'ok' });

    const job2 = synquer.job({ type: 'inventory_sync', entity: { type: 'product', id: 'B2' } });
    await job2.done();

    // Flush manually
    await synquer.flush();

    // Verify both jobs exist
    const detail1 = await api('GET', `/v1/jobs/${job1.id}`, { token: sessionToken });
    expect(detail1.data.job.status).toBe('succeeded');
    expect(detail1.data.events).toHaveLength(3); // started + event + done

    const detail2 = await api('GET', `/v1/jobs/${job2.id}`, { token: sessionToken });
    expect(detail2.data.job.status).toBe('succeeded');

    await synquer.shutdown();
  });

  it('shutdown flushes remaining batch events', async () => {
    const synquer = new Synquer({
      apiKey,
      baseUrl: API_URL,
      mode: 'batch',
      batchInterval: 60_000,
    });

    const job = synquer.job({ type: 'order_sync' });
    await job.done();

    // Shutdown should flush
    await synquer.shutdown();

    const detail = await api('GET', `/v1/jobs/${job.id}`, { token: sessionToken });
    expect(detail.data.job.status).toBe('succeeded');
  });

  it('disabled mode sends nothing', async () => {
    const synquer = new Synquer({
      apiKey,
      baseUrl: API_URL,
      disabled: true,
    });

    const job = synquer.job({ type: 'order_sync' });
    await job.done();

    // Job should NOT exist in the API
    const detail = await api('GET', `/v1/jobs/${job.id}`, { token: sessionToken });
    expect(detail.status).toBe(404);
  });

  it('handles invalid API key gracefully', async () => {
    const errors: Error[] = [];
    const synquer = new Synquer({
      apiKey: 'sk_dev_invalid',
      baseUrl: API_URL,
      maxRetries: 0,
      onError: (err) => errors.push(err),
    });

    const job = synquer.job({ type: 'test' });
    await job.done(); // Should not throw

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('401');
  });

  it('jobs appear in stats', async () => {
    // Check that the jobs we created show up in stats
    const overview = await api('GET', `/v1/stats/overview?envId=${envId}`, { token: sessionToken });
    expect(overview.status).toBe(200);
    expect(overview.data.totals.jobs).toBeGreaterThanOrEqual(5); // At least our test jobs
    expect(overview.data.totals.succeeded).toBeGreaterThanOrEqual(3);
    expect(overview.data.totals.failed).toBeGreaterThanOrEqual(1);
  });
});
