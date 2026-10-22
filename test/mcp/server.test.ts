import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDb, setupTestDb } from '../helpers/db.js';
import { startHarness, type Harness } from './harness.js';

const TOOLS = {
  seller: ['create_listing', 'attach_listing_photos', 'get_photo_upload_link', 'update_listing', 'publish_listing', 'set_listing_status', 'get_my_listings', 'get_listing_demand', 'respond_to_interest'],
  buyer: ['search_listings', 'create_buyer_request', 'update_buyer_request', 'set_buyer_request_status', 'get_my_requests', 'get_request_matches', 'give_match_feedback', 'get_listing_details', 'express_interest'],
  shared: ['get_inbox', 'mark_inbox_read', 'send_message', 'get_conversation', 'list_my_conversations', 'get_price_guidance', 'set_default_location', 'update_profile'],
};
const ALL = [...TOOLS.seller, ...TOOLS.buyer, ...TOOLS.shared];
const READ_ONLY = ['get_my_listings', 'get_listing_demand', 'search_listings', 'get_my_requests', 'get_request_matches', 'get_listing_details', 'get_inbox', 'get_conversation', 'list_my_conversations', 'get_price_guidance'];

let h: Harness;

beforeAll(async () => {
  await setupTestDb();
  await resetDb();
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

describe('MCP endpoint', () => {
  it('rejects requests without a token with 401 + WWW-Authenticate', async () => {
    const res = await fetch(`${h.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/i);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata');
  });

  it('rejects an invalid token', async () => {
    const res = await fetch(`${h.baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBeTruthy();
  });

  it('answers CORS preflight and health checks', async () => {
    const pre = await fetch(`${h.baseUrl}/mcp`, { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect((await fetch(`${h.baseUrl}/healthz`)).status).toBe(200);
  });

  it('exposes instructions and every tool with annotations and Apps SDK metadata', async () => {
    const u = await h.connect('tok-seller');
    expect(u.client.getInstructions()).toMatch(/get_inbox/);
    const { tools } = await u.client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of ALL) expect(names, name).toContain(name);
    expect(names).toHaveLength(ALL.length);

    for (const t of tools) {
      expect(t.description, t.name).toBeTruthy();
      expect(t.annotations?.openWorldHint, t.name).toBe(false);
      expect(t.annotations?.readOnlyHint, t.name).toBe(READ_ONLY.includes(t.name));
      expect(t._meta?.['openai/toolInvocation/invoking'], t.name).toBeTruthy();
      expect(t._meta?.securitySchemes, t.name).toEqual([{ type: 'oauth2', scopes: ['marketplace'] }]);
    }
    expect(tools.find((t) => t.name === 'set_listing_status')!.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'get_inbox')!.description).toContain('Call this at the start of any marketplace conversation');
  });

  it('declares fileParams on attach_listing_photos', async () => {
    const u = await h.connect('tok-seller');
    const { tools } = await u.client.listTools();
    const t = tools.find((x) => x.name === 'attach_listing_photos')!;
    expect(t._meta?.['openai/fileParams']).toEqual(['files']);
    const files = (t.inputSchema.properties as any).files;
    expect(files.type).toBe('array');
    expect(Object.keys(files.items.properties).sort()).toEqual(['download_url', 'file_id', 'file_name', 'mime_type']);
    expect(files.items.required.sort()).toEqual(['download_url', 'file_id']);
  });

  it('create_listing schema carries provenance and publish/idempotency', async () => {
    const u = await h.connect('tok-seller');
    const { tools } = await u.client.listTools();
    const t = tools.find((x) => x.name === 'create_listing')!;
    const props = t.inputSchema.properties as any;
    expect(props.publish).toBeTruthy();
    expect(props.idempotencyKey).toBeTruthy();
    expect(props.priceEstimate).toBeTruthy();
    expect(JSON.stringify(props.attributes)).toContain('seller_stated');
    expect(JSON.stringify(props.attributes)).toContain('ai_estimated');
  });

  it('maps domain errors to isError results without stack traces', async () => {
    const u = await h.connect('tok-buyer');
    const r = await u.raw('get_conversation', { interestId: 'int_doesnotexist' });
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/not found/i);
    expect(text).not.toMatch(/at .*\.ts:\d+/);
  });

  it('runs a simple shared tool end to end', async () => {
    const u = await h.connect('tok-buyer');
    const r = await u.call('set_default_location', { location: { text: 'Paris 12e' } });
    expect(r.defaultLocation.label).toBeTruthy();
    const p = await u.call('update_profile', { displayName: 'Bea', notifyEmail: false });
    expect(p.profile).toEqual({ displayName: 'Bea', notifyEmail: false, defaultLocation: r.defaultLocation.label });
    expect(JSON.stringify(p)).not.toContain('@test.dev');
  });
});
