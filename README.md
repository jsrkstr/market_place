# Secondhand Marketplace (MCP, ChatGPT first)

A standalone secondhand marketplace whose only interface, for now, is ChatGPT. It connects as a custom connector/app through the Apps SDK, which implements MCP.

- **Sellers** describe items in text, in a voice note (transcribed by ChatGPT) or in photos. ChatGPT extracts structured attributes and tags each one with its provenance (`seller_stated | ai_inferred | ai_estimated`). The server validates and normalises them, then stores the listing.
- **Buyers** describe what they want. The server splits hard constraints from soft preferences, matches right away, and keeps matching new listings over time. New results land in the buyer's inbox (and an email digest).
- The server owns the truth: listings, requests, matches, interest, messages and contact consent.

## Architecture

```
ChatGPT (Apps SDK / MCP client)
   │  OAuth 2.1 (PKCE, DCR)  +  Streamable HTTP  POST /mcp
   ▼
src/http.ts        express app: /mcp, /.well-known/*, /register, /authorize, /token, /revoke, /oauth/login/*, /upload/:token, /img/:signed, /healthz
src/auth/          OAuth 2.1 authorization server (+ DEV_AUTH_TOKENS for local testing)
src/mcp/           thin adapter: tool schema → domain service → structured result + short text summary
  server.ts        per-request McpServer + server instructions (the model's behaviour contract)
  tools/           seller.ts, buyer.ts, shared.ts (+ common.ts schemas/annotations/formatters)
  respond.ts       structuredContent + text; DomainError → isError (no stack traces)
src/domain/        all business logic: listings, requests, matching engine, interactions, inbox, privacy
src/infra/         embeddings (OpenAI | fake), geocoder (Nominatim | fake), blob storage, mailer, pg-boss jobs
src/jobs/          async handlers: listing↔request matching, stale propagation, sweeps, email digest
Postgres + pgvector (Aiven in production, docker locally)
```

Design rules:
- The domain layer knows nothing about MCP. The tools only parse input, call one service and format the result.
- ChatGPT does the perception work (photos, voice). The server validates input, normalises it, scores matches and explains them deterministically.
- Matching is hybrid: SQL hard filters, then pgvector similarity, then a structured score with a stored breakdown. "Possible matches" (computed) and "interested buyers" (explicit actions) are always reported separately.
- The MCP endpoint is **stateless**. Each `POST /mcp` builds a fresh `McpServer` and `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`, JSON responses), bound to the caller authenticated by the bearer token. `GET` and `DELETE /mcp` return 405, as the spec allows for stateless servers.

## Local setup

Requirements: Node 20+ (24 recommended), pnpm, Docker.

```bash
pnpm install
pnpm db:up                 # docker compose: Postgres 16 + pgvector on localhost:5544
cp .env.example .env       # then edit; for fully offline dev set EMBEDDINGS_PROVIDER=fake GEOCODER=fake
pnpm db:migrate            # applies migrations (creates the vector extension)
pnpm seed                  # ~50 realistic Paris listings + a few requests
pnpm dev                   # http://localhost:3000, MCP at /mcp
```

Jobs:
- `JOBS_MODE=inline` (the default) runs async matching and notifications inside the web process. This is fine for dev.
- `JOBS_MODE=queue` uses pg-boss on the same Postgres. Run `pnpm worker` alongside `pnpm dev`; the worker also runs the cron sweeps (expiry, availability checks, email digest).

Tests use their own database and offline providers:

```bash
pnpm test
# or a single area against a dedicated DB:
TEST_DATABASE_URL=postgres://market:market@localhost:5544/market_test_mcp npx vitest run test/mcp test/e2e.journeys.test.ts
```

## Aiven for PostgreSQL setup

1. In the Aiven console, create a **PostgreSQL** service. A small plan is fine for an MVP.
2. Enable pgvector. `pnpm db:migrate` runs `CREATE EXTENSION IF NOT EXISTS vector` for you. Extensions are per database, so if you use a database other than `defaultdb`, run it there.
3. Download the **CA certificate** from the service overview and save it, e.g. `./certs/aiven-ca.pem`. Then set `DATABASE_CA_CERT=./certs/aiven-ca.pem`.
4. Copy the **Service URI** into `DATABASE_URL`, e.g. `postgres://avnadmin:…@my-pg-project.aivencloud.com:12345/defaultdb?sslmode=require`. With the CA configured, the connection is verified TLS.
5. Keep `DATABASE_POOL_MAX` small (around 5). Small Aiven plans have tight connection limits, and pg-boss opens a couple of its own.
6. Run `pnpm db:migrate`, then `pnpm db:check`. It prints the server version, the pgvector version, and the HNSW indexes on `listings` and `buyer_requests`. Optionally run `pnpm seed` to load demo data.

## Connecting ChatGPT

1. Start the server and expose it publicly with a tunnel:
   ```bash
   cloudflared tunnel --url http://localhost:3000     # or: ngrok http 3000
   ```
2. Set `PUBLIC_BASE_URL` to the tunnel URL, e.g. `https://abc.trycloudflare.com`, and restart. OAuth metadata, upload links and image URLs are built from it.
3. In ChatGPT, turn on **developer mode** (Settings → Apps & Connectors → Advanced). This needs an eligible plan.
4. Add a connector with URL `https://<tunnel>/mcp` and authentication **OAuth**. ChatGPT discovers `/.well-known/oauth-protected-resource`, registers itself dynamically and opens the sign-in page. Sign in with an email one-time code.
5. Try:
   - *"I want to sell my white IKEA chair, 20 euros, I'm in Paris 11e"*, with a photo attached.
   - *"I'm looking for two beige or off-white dining chairs, max €80, within 2 km of Bastille."*

## Testing with MCP Inspector

1. Set a dev token in `.env`, e.g. `DEV_AUTH_TOKENS=dev-seller:seller@example.com,dev-buyer:buyer@example.com`.
2. Run `npx @modelcontextprotocol/inspector`.
3. Choose transport **Streamable HTTP**, URL `http://localhost:3000/mcp`, and add the header `Authorization: Bearer dev-seller`.
4. Use `dev-buyer` in a second Inspector tab to play the other side.

## Tools

Every tool returns `structuredContent` plus a short text summary. Prices are in minor units (cents) and default to EUR. All tools carry `readOnlyHint`/`destructiveHint`/`openWorldHint: false` annotations. Apps SDK `_meta` carries the `openai/toolInvocation/*` status strings and `securitySchemes: [{type: 'oauth2', scopes: ['marketplace']}]`.

| Side | Tool | Purpose |
|---|---|---|
| Seller | `create_listing` | Draft or publish from the seller's words and photos; attributes with provenance; idempotent |
| | `attach_listing_photos` | Attach chat photos (`openai/fileParams: ["files"]`) |
| | `get_photo_upload_link` | One-time browser upload link (fallback) |
| | `update_listing`, `publish_listing` | Edit / publish (matching re-runs) |
| | `set_listing_status` | pause / reactivate / mark_sold / withdraw / confirm_available |
| | `get_my_listings` | Own listings, or one in full detail |
| | `get_listing_demand` | Possible matches vs. interested buyers, kept separate |
| | `respond_to_interest` | accept / decline / reply / share_contact |
| Buyer | `search_listings` | Quick search; nothing is saved |
| | `create_buyer_request`, `update_buyer_request` | Save a request and get immediate explained matches |
| | `set_buyer_request_status` | pause / resume / cancel / fulfilled |
| | `get_my_requests`, `get_request_matches` | Saved requests and their current matches |
| | `give_match_feedback` | Dismiss (with a reason) / undo |
| | `get_listing_details` | Public projection: approximate area/distance, photos, provenance |
| | `express_interest` | Contact the seller through the relay |
| Shared | `get_inbox`, `mark_inbox_read` | What's new: matches, interest, messages, unavailable items |
| | `send_message`, `get_conversation`, `list_my_conversations` | Relayed conversations and contact opt-in |
| | `get_price_guidance` | Comparables from our own inventory plus a labelled estimate |
| | `set_default_location`, `update_profile` | Usual area, display name, email digest |

## Platform limitations

- **No push into ChatGPT.** An MCP server can't start a conversation. Async discovery (new matches, buyer interest, replies) reaches users in two ways: the inbox, which the model is told to check at the start of every marketplace conversation, and an optional email digest.
- **Photos.**
  - `openai/fileParams` is ChatGPT-specific, and uploaded files aren't automatically in the model's context. Other MCP clients, or failures, fall back to the one-time `/upload/:token` link from `get_photo_upload_link`.
  - Buyers see photos through signed image URLs. A visual widget (listing carousel) is a later phase.
- **Developer mode.** Until the app is submitted and approved, connecting a custom connector needs ChatGPT developer mode on an eligible plan. Local testing needs a public tunnel.
- **Extraction quality depends on the client model.** The server validates, normalises and enforces provenance, but it can't verify a brand or model guess. Such values stay labelled `ai_inferred` / `ai_estimated` and are shown as "possibly".
- **Price guidance has no external market data.** It uses only comparables from this marketplace plus the model's labelled estimate.
- **Geocoding.** Nominatim's usage policy (max 1 request/s, an identifying User-Agent, results cached) is fine for an MVP. Swap in a commercial geocoder for production.
- **Aiven.** `CREATE EXTENSION vector` is per database. Use the CA cert for verified TLS and keep the pool small.
