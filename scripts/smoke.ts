// Live smoke test: calls the running server's /mcp with a dev bearer token.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.env.SMOKE_URL ?? 'http://localhost:3000';
const token = process.env.SMOKE_TOKEN ?? 'dev-buyer';
const c = new Client({ name: 'smoke', version: '0' });
await c.connect(
  new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
);
console.log('tools:', (await c.listTools()).tools.length);
const r = (await c.callTool({
  name: 'search_listings',
  arguments: {
    rawText: 'two modern beige or off-white dining chairs, preferably wooden legs, good condition, max €80 each, within 2 km of Paris 11e',
    category: 'dining chair',
    location: { text: process.env.SMOKE_PLACE ?? 'paris 11e' },
    hardConstraints: { maxPriceCents: 8000, maxDistanceKm: 2, minCondition: 'good' },
    softPreferences: [
      { attribute: 'colour', values: ['beige', 'off-white'], weight: 0.8 },
      { attribute: 'legs_material', values: ['wood'], weight: 0.6 },
      { attribute: 'style', values: ['modern'], weight: 0.5 },
    ],
  },
})) as { content: { text: string }[] };
console.log(r.content[0].text);
await c.close();
