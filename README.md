# WordPress MCP Server

A Model Context Protocol (MCP) server that gives ClickUp Brain direct execution access to WordPress — publishing, scheduling, and updating posts, setting featured images, and writing RankMath SEO meta — across every Contractor Scale client site, without relaying through Donna.

Runs on Cloudflare Workers, following the same architecture as the sibling MCPs in this fleet (`google-ads-mcp-cs`, `meta-ads-mcp-cs`, `gsc-mcp-cs`): a single-file Worker, dual SSE/streamable-HTTP transport, static API-key auth, in-memory session map.

## Why this exists

Brain had the WordPress Connector *skill* (knowledge of how to structure WP REST calls) but no execution path of its own — every publish/update request had to be delegated to Donna via the Donna MCP, which introduced stale credential-path bugs and premature "blocked on credentials" messages before Donna even attempted execution. This Worker gives Brain the same publish/edit/schedule capability Donna has, in one loop. See [OPERATIONS-11119](https://app.clickup.com/t/6942940/OPERATIONS-11119).

## Features

- **8 WordPress tools** covering publish/schedule, update, list/query, featured images, RankMath SEO meta, and a raw-request escape hatch (see [Available Tools](#available-tools))
- **Supabase-backed multi-tenant credentials** — reads `wp_credentials` per `client_slug` (54+ client sites), the same table and application-password auth model as `contractor-scale/skills/wordpress`
- **Dual Transport**: SSE (`/sse`) and Streamable HTTP (`/mcp`) — ClickUp Brain connects via `/mcp`
- **Cloudflare Workers**: Serverless, global edge network
- **Fail-closed credential resolution**: a client with no stored application password errors clearly instead of hanging or silently succeeding

## Available Tools

| Tool | Purpose |
|---|---|
| `wp_list_clients` | List every client site configured in Supabase `wp_credentials` (no secrets returned) |
| `wp_list_posts` | Query posts on a client site by status, search term, or slug |
| `wp_get_post` | Get a single post by ID (e.g. to confirm a publish/update landed) |
| `wp_publish_post` | Create a post — `status: "draft"` \| `"publish"` \| `"future"` (+ `date`) for scheduling |
| `wp_update_post` | Update an existing post's content, status, slug, or scheduled date |
| `wp_set_featured_image` | Fetch an image from a URL, upload it to the site's media library, and assign it as a post's featured image |
| `wp_set_seo_meta` | Set RankMath SEO title/description/focus keyword on a post (requires RankMath's `show_in_rest` enabled for those meta keys on the target site) |
| `wp_raw_request` | Escape hatch for anything not covered above (e.g. `DELETE /wp-json/elementor/v1/cache`) — logs a warning so recurring use can graduate to a dedicated tool |

Every tool except `wp_list_clients` takes a `client` argument (the `wp_credentials.client_slug`).

## Getting Started

### 1. Prerequisites

- Node.js 18+ and npm
- A Cloudflare account with Workers enabled
- Access to the `cs-shared` Doppler project (for `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`)

### 2. Clone and install

```bash
git clone https://github.com/isaganiesteron/wordpress-mcp-cs.git
cd wordpress-mcp-cs
npm install
```

### 3. Configure local secrets

```bash
cp wrangler.jsonc.example wrangler.jsonc
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars` with real values (never commit this file — it's gitignored):

```
API_KEY=<any local test value>
SUPABASE_URL=<from Doppler cs-shared/dev>
SUPABASE_SECRET_KEY=<Doppler's SUPABASE_SERVICE_ROLE_KEY value>
```

Pull real values without ever printing them, if Doppler CLI is set up:

```bash
doppler run --project cs-shared --config dev -- <write env vars to .dev.vars>
```

### 4. Test locally

```bash
npm run dev
```

```bash
curl http://localhost:8787/
```

### 5. Deploy to Cloudflare Workers

```bash
npm run deploy
```

`SUPABASE_URL` / `SUPABASE_SECRET_KEY` are synced automatically to the deployed Worker by the centralized pipeline in the `contractor-scale` repo (`tools/scripts/maintenance/sync-doppler-to-cloudflare-worker.js`, `TARGETS.wordpress-mcp`) on a daily cron + Doppler webhook. **`API_KEY` is never auto-synced** (by design, per that script's `NEVER_AUTO` set — it's a unique per-worker secret) and must be set once manually:

```bash
wrangler secret put API_KEY
```

> If you set `API_KEY` and then the sync script runs `wrangler@3 secret bulk` for the Supabase keys, re-verify `API_KEY` still authenticates afterward — during this Worker's initial deploy, that sequence caused `API_KEY` to briefly stop resolving until it was re-set with `wrangler@4`. Only seen once; flagged here in case it recurs.

## Using with ClickUp Brain

1. Deploy this Worker (above)
2. In ClickUp, go to **App Center → MCP Servers → Connect an MCP Server**
3. Fill in:
   - **Name**: `WordPress MCP`
   - **URL**: `https://wordpress-mcp.isagani.workers.dev/mcp` — use `/mcp`, not `/sse`. Brain's setup flow does a GET that expects a response to fully complete; `/sse` holds the connection open indefinitely (that's correct SSE behavior, but it reads as a stuck/hung setup in the UI).
   - **Authentication Method**: if there's no direct "API Key" option, use **Custom Headers** with header name `X-API-Key` and the deployed `API_KEY` value
4. Run the smoke test in [TEST_PROMPT.md](./TEST_PROMPT.md)

## Project Structure

```
.
├── src/
│   └── index.ts          # Entire MCP server: config, Supabase/WP helpers, tools, framework code
├── test/
│   └── index.spec.ts     # Vitest (currently the stock starter test — needs real coverage)
├── postman/               # Postman collection (currently the starter's example-tool requests)
├── TEST_PROMPT.md         # WordPress MCP smoke test prompts (for ClickUp Brain or manual curl)
├── wrangler.jsonc.example # Copy to wrangler.jsonc (gitignored)
├── .dev.vars.example      # Copy to .dev.vars (gitignored) — API_KEY, SUPABASE_URL, SUPABASE_SECRET_KEY
├── package.json
├── tsconfig.json
└── README.md
```

## API Endpoints

### Health check

- `GET /` — server info + available transport endpoints (no API key required)

### Streamable HTTP transport (`/mcp`) — what ClickUp Brain uses

- `POST /mcp` — JSON-RPC message. On `initialize`, the server mints a session ID and returns it in the `Mcp-Session-Id` response header; subsequent requests must include that header.
- `DELETE /mcp` — terminate a session (header shape-validated only, not persisted server-side)

### SSE transport (`/sse`)

- `GET /sse` — opens an SSE stream, emits an `endpoint` event with the session-specific message URL, then keeps the connection open with a 30s keepalive ping
- `POST /sse` — direct HTTP fallback (no open stream)
- `POST /sse/message?sessionId={id}` — send a JSON-RPC message on an active SSE session

## Credential Resolution

Every tool (except `wp_list_clients`) calls `resolveClient(client, env)`, which:

1. Queries Supabase `wp_credentials` for the given `client_slug` via PostgREST (`env.SUPABASE_URL` / `env.SUPABASE_SECRET_KEY`)
2. Fails closed with a clear error if no row exists, `auth_type` isn't `application_password`, or no token is stored
3. Builds a `Basic` auth header (`btoa(username:token)`, spaces stripped from the displayed application password) for the site's own `/wp-json/...` REST API

This mirrors `contractor-scale/skills/wordpress/scripts/_wp.js` — same table, same auth model, same fail-closed error messages — just reading from Worker secrets instead of `process.env`, with no local-file fallback (Workers have no filesystem).

## Known Risks / Things to Verify Per-Site

- **RankMath meta over REST depends on `show_in_rest`** being registered for `rank_math_title`/`rank_math_description`/`rank_math_focus_keyword` on that specific site. Confirmed working on at least one site in production; not guaranteed across all 54+.
- **Redirects are out of scope** — RankMath/Yoast expose no REST redirect route; that's handled separately by `contractor-scale/skills/wordpress/scripts/wp-redirect.js` via the Redirection plugin.
- First request to a given client's live site through a cold Worker isolate can take 10-25s (TLS/DNS through the Workers runtime) — a retry succeeds quickly. Not a bug, just latency to expect on the first call after a deploy.

## Troubleshooting

### "client 'X' has no token stored" / "auth_type='X'; only supports 'application_password'"

The `wp_credentials` row for that slug either doesn't have an application password provisioned, or uses a different auth method. Provision one in WordPress: Users → Profile → Application Passwords.

### ClickUp Brain's "Connect an MCP Server" spinner never finishes

You're pointed at `/sse` instead of `/mcp`. See [Using with ClickUp Brain](#using-with-clickup-brain) above.

### `wp_set_seo_meta` succeeds (HTTP 200) but the meta doesn't show up in RankMath

That site likely doesn't have `show_in_rest` enabled for the RankMath meta keys. This is a per-site WordPress/plugin configuration issue, not a bug in this Worker.

### Deployment fails

- `wrangler login` / confirm the right Cloudflare account (`isagani`, account ID `e9251afb5c2abd46a9504aa5d714aceb`) via `CLOUDFLARE_ACCOUNT_ID`
- Confirm the worker name in `wrangler.jsonc` is `wordpress-mcp`

## Resources

- [MCP Protocol Documentation](https://modelcontextprotocol.io/)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [WordPress REST API Handbook](https://developer.wordpress.org/rest-api/)
- Sibling MCPs in this fleet: `google-ads-mcp-cs`, `meta-ads-mcp-cs`, `gsc-mcp-cs`, `dataforseo-mcp-worker`
- `contractor-scale/skills/wordpress/SKILL.md` — the Node-script equivalent of this Worker's credential/auth model, used by Donna/Paperclip

## License

MIT (scaffolded from [`isaganiesteron/typingmind-mcp-cloudflare-starter`](https://github.com/isaganiesteron/typingmind-mcp-cloudflare-starter))
