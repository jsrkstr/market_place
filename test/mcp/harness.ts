/** Starts the real express app on an ephemeral port and connects MCP SDK clients with dev bearer tokens. */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from '../../src/http.js';
import { registerAllHandlers } from '../../src/jobs/handlers.js';

export interface Harness {
  baseUrl: string;
  connect(token: string): Promise<McpUser>;
  close(): Promise<void>;
}

export interface McpUser {
  client: Client;
  /** Calls a tool and returns structuredContent; throws if the tool reported an error. */
  call<T = any>(name: string, args?: Record<string, unknown>): Promise<T & { _text: string }>;
  /** Calls a tool and returns the raw result (for asserting on errors). */
  raw(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
}

export async function startHarness(): Promise<Harness> {
  registerAllHandlers();
  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clients: Client[] = [];

  return {
    baseUrl,
    async connect(token) {
      const client = new Client({ name: 'test', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      await client.connect(transport);
      clients.push(client);
      const raw = async (name: string, args: Record<string, unknown> = {}) =>
        (await client.callTool({ name, arguments: args })) as CallToolResult;
      return {
        client,
        raw,
        async call(name, args = {}) {
          const r = await raw(name, args);
          const text = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
          if (r.isError) throw new Error(`${name} failed: ${text}`);
          return { ...(r.structuredContent as any), _text: text };
        },
      };
    },
    async close() {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
