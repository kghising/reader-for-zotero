# Reader for Zotero

A remote [MCP](https://modelcontextprotocol.io) server that lets Claude **read** your own Zotero library on claude.ai, Claude Desktop, mobile and Claude Code. You sign in with your own Zotero account; there is no shared API key.

> Independent project. Not affiliated with or endorsed by Zotero or the Corporation for Digital Scholarship.

## What Claude can do with it

All tools are read-only (`readOnlyHint: true`), paginated, and keep responses small.

| Tool | What it does |
|---|---|
| `list_libraries` | Your personal library plus the group libraries you allowed |
| `search_items` | Quick search (title/creator/year) or "everything" (all fields, notes, indexed full text); filter by tag, item type, collection |
| `list_collections` | Top-level collections or subcollections, with counts |
| `list_collection_items` | Items in one collection |
| `get_item` | Full metadata, abstract, attachments, note count |
| `get_item_notes` | Notes as plain text |
| `get_item_annotations` | Highlights and comments made in Zotero's PDF/EPUB reader |
| `get_fulltext` | Extracted text of a PDF/EPUB/snapshot, paged by characters |
| `export_items` | BibTeX, BibLaTeX, RIS or CSL JSON for up to 50 items |

Every tool takes `library`: `"user"` (default) or `"group:<id>"`.

### Example prompts

- "Find the papers in my Zotero library about retrieval-augmented generation from 2023 onward and summarise their main claims."
- "What did I highlight in the Vaswani et al. transformer paper? Group my annotations by theme."
- "Read the full text of the PDF for item ABCD2345 and list its limitations section."
- "Export everything in my 'Thesis – Chapter 2' collection as BibTeX."
- "Which items in the Lab Group library are tagged 'to-read'?"

## Connect it (users)

1. **Claude (web, Desktop, mobile):** Settings → Connectors → *Add custom connector* → URL `https://<your-deployment>/mcp`. Click **Connect**, approve on the consent page, then sign in to zotero.org and accept the read-only key.
2. **Claude Code:**
   ```bash
   claude mcp add --transport http zotero https://<your-deployment>/mcp
   ```
   Then run `/mcp` in Claude Code and choose *Authenticate*.

**Full text** is available only for files that Zotero desktop has indexed and synced. This is on by default (Zotero → Settings → Sync → "Sync full-text content").

**Disconnect:** remove the connector in Claude, then revoke the key named "Reader for Zotero (Claude)" at <https://www.zotero.org/settings/keys>. Revoking the key cuts off access immediately.

## How it works

```
Claude ──OAuth 2.1 (PKCE, CIMD/DCR)──▶ this Worker (authorization server + MCP resource server)
                                         │ consent page → Zotero OAuth 1.0a → zotero.org approval
                                         │ ← Zotero returns a read-only API key for the user
                                         │ key stored encrypted as grant props (only the user's tokens unwrap it)
Claude ──Bearer token──▶ /mcp ──────────▶ api.zotero.org (with the user's Zotero key; our token is never forwarded)
```

- MCP authorization spec **2026-07-28**: Protected Resource Metadata (RFC 9728), AS metadata (RFC 8414), Client ID Metadata Documents (preferred) with DCR as a fallback, S256 PKCE, resource indicators (RFC 8707) with audience checks, `iss` in responses (RFC 9207), and refresh-token rotation. Implemented with [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider).
- MCP transport: Streamable HTTP via the official TypeScript SDK v2 (`@modelcontextprotocol/server`). It's stateless and serves both the 2025 and 2026-07-28 protocol revisions.
- Zotero Web API v3 client: at most 4 concurrent requests, honours `Backoff` and `Retry-After` (429/503), paginates, supports group libraries.
- **Storage:** Workers KV holds OAuth client/grant/token records only. Tokens are stored as hashes, and the Zotero key is encrypted. No library content is stored. See [PRIVACY.md](PRIVACY.md).

## Self-host / deploy (Cloudflare Workers)

Requirements: Node 22+, a Cloudflare account (the free plan is enough to start), and a Zotero account.

1. **Install**
   ```bash
   npm install
   ```
2. **Create the KV namespace**, then paste its `id` into `wrangler.jsonc`:
   ```bash
   npx wrangler kv namespace create OAUTH_KV
   ```
3. **Pick your public URL**, for example `https://reader-for-zotero.<account>.workers.dev` or a custom domain. Set `PUBLIC_URL` and `SUPPORT_EMAIL` in `wrangler.jsonc`.
4. **Register a Zotero OAuth app** at <https://www.zotero.org/oauth/apps>. Use the name "Reader for Zotero" and the callback URL `<PUBLIC_URL>/zotero/callback`. Copy the client key and secret.
5. **Store the secrets** (each command prompts for the value):
   ```bash
   npx wrangler secret put ZOTERO_CLIENT_KEY
   ```
   ```bash
   npx wrangler secret put ZOTERO_CLIENT_SECRET
   ```
6. **Deploy**
   ```bash
   npm run deploy
   ```
7. Add `<PUBLIC_URL>/mcp` as a custom connector in Claude and call each tool once.

### Local development

Copy `.dev.vars.example` to `.dev.vars`, add `PUBLIC_URL=http://localhost:8787`, then run:

```bash
npm run dev
```

You can inspect the server with [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector):

```bash
npx @modelcontextprotocol/inspector
```

### Tests

The tests run inside the Workers runtime (Miniflare) with zotero.org and api.zotero.org mocked, so no credentials are needed. They cover:
- OAuth 1.0a signing against the RFC 5849 test vector
- rate-limit handling
- every tool through a real MCP client
- the full OAuth 2.1 ⇄ Zotero bridge: discovery, registration, consent, PKCE, audience checks, refresh rotation, denial paths, cross-browser callback rejection and Claude Code loopback redirects

```bash
npm test
```

### Cost

On the Cloudflare Workers free plan this costs $0. The free plan's limits are 100k requests/day and 1k KV writes/day; each sign-in or token refresh uses a few KV writes. If usage grows, the Workers Paid plan is $5/month. A custom domain, if you want one, costs about $10/year.

## Support

Open an issue at <https://github.com/kghising/reader-for-zotero/issues> or email the address on the deployment's home page. For security issues, please email rather than opening a public issue.

## License

MIT. See [LICENSE](LICENSE).
