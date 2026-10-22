/**
 * Express app factory: OAuth routes, the MCP endpoint, photo upload/image routes and a health check.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { authenticateBearer, mountAuth, wwwAuthenticateHeader, type AuthenticatedPrincipal } from './auth/index.js';
import { mountImageRoutes } from './http/images.js';
import { mountUploadRoutes } from './http/uploads.js';
import { createMcpServer } from './mcp/server.js';

type AuthedRequest = Request & { auth?: AuthInfo; principal?: AuthenticatedPrincipal };

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind one proxy hop (cloudflared/ngrok/load balancer): honour X-Forwarded-* for protocol and client IP.
  app.set('trust proxy', 1);

  app.use(requestLogger);
  app.use(['/mcp', '/.well-known'], cors);

  mountAuth(app);

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/mcp', express.json({ limit: '2mb' }));
  app.post('/mcp', requireBearer, handleMcp);
  // Stateless server: no standalone SSE stream and no sessions to delete.
  app.get('/mcp', requireBearer, methodNotAllowed);
  app.delete('/mcp', requireBearer, methodNotAllowed);

  mountUploadRoutes(app);
  mountImageRoutes(app);

  app.use(errorHandler);
  return app;
}

async function handleMcp(req: AuthedRequest, res: Response): Promise<void> {
  const server = createMcpServer(req.principal!);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] request failed', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
}

/** Validates the bearer token; on success exposes the principal (and MCP `authInfo`) to downstream handlers. */
async function requireBearer(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  const principal = match ? await authenticateBearer(match[1].trim()) : null;
  if (!principal) {
    res
      .status(401)
      .set('WWW-Authenticate', wwwAuthenticateHeader())
      .json({ error: match ? 'invalid_token' : 'unauthorized', error_description: 'Sign in to the marketplace to continue.' });
    return;
  }
  req.principal = principal;
  req.auth = {
    token: match![1].trim(),
    clientId: principal.clientId,
    scopes: principal.scopes,
    expiresAt: principal.expiresAt,
    extra: { userId: principal.userId },
  };
  next();
}

function methodNotAllowed(_req: Request, res: Response): void {
  res
    .status(405)
    .set('Allow', 'POST')
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: use POST)' }, id: null });
}

function cors(req: Request, res: Response, next: NextFunction): void {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
    'Access-Control-Max-Age': '86400',
  });
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}

function requestLogger(req: Request, res: Response, next: NextFunction): void {
  if (process.env.NODE_ENV === 'test' && !process.env.LOG_REQUESTS) return next();
  const start = performance.now();
  res.on('finish', () => {
    // Path only: query strings can carry signed tokens.
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Math.round(performance.now() - start)}ms`);
  });
  next();
}

function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) console.error('[http] unhandled error', err);
  if (res.headersSent) return;
  res.status(status).json({ error: status >= 500 ? 'internal_error' : 'bad_request' });
}
