# Connectors Directory checklist

Based on Anthropic's pages, checked 2026-10-03:
- [Submit a connector](https://claude.com/docs/connectors/building/submission)
- [Review criteria](https://claude.com/docs/connectors/building/review-criteria)
- [Authentication](https://claude.com/docs/connectors/building/authentication)
- [Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy)

Re-check these before submitting, because they change.

## Gating item

- [ ] **Written OK from Zotero** for the name and for proxying the Web API (see [zotero-permission-request.md](zotero-permission-request.md)). The review requires servers to call "your own first-party APIs, or APIs you legitimately proxy", and the portal's *Data handling* step asks whether the API is proxied with the partner's permission. Zotero's trademark policy also requires written permission for the name.

## Server and auth (done in code; verify on the deployed URL)

- [x] Remote server over HTTPS, Streamable HTTP transport (SSE isn't accepted)
- [x] OAuth with a user consent step; `401` + `WWW-Authenticate: Bearer resource_metadata=…` on unauthenticated calls
- [x] Protected resource metadata `resource` equals the connector URL exactly (`<PUBLIC_URL>/mcp`); one `authorization_servers` entry
- [x] CIMD advertised (`client_id_metadata_document_supported: true` + `none` in `token_endpoint_auth_methods_supported`); DCR as fallback
- [x] S256 PKCE advertised and enforced
- [x] Redirects: `https://claude.ai/api/mcp/auth_callback`, plus loopback on any port for Claude Code (`localhost` and `127.0.0.1`)
- [x] Consent page shows the redirect host and warns for loopback-only clients
- [x] Refresh tokens rotate; `invalid_grant` is returned when a refresh token is invalid; the token endpoint accepts form-urlencoded bodies
- [ ] Measure the OAuth endpoints on the deployed Worker: they must respond in under 10 s (refresh in under 30 s). Expect well under 1 s.
- [ ] Confirm Anthropic's egress range (`160.79.104.0/21`) isn't blocked (there's no WAF by default)

## Tools

- [x] Every tool has a `title` and `readOnlyHint: true` (also `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`)
- [x] Names are ≤ 64 characters, in snake_case
- [x] Descriptions say what each tool does, without instructions aimed at Claude, links to other tools or hidden text
- [x] No catch-all request tool, and no write tools
- [x] Actionable errors (rate limit with wait time, 403 reconnect hint, missing full-text explanation); no bare "Bad Request"
- [x] Responses are proportionate: pages of 10–25, full text in pages of up to 50k characters, truncation markers
- [x] No collection of conversation data; no access to Claude memory or chat history

## Listing materials

- [ ] Deployed URL (and a custom domain if wanted; the review notes that "the MCP server domain should match your service")
- [ ] Server name: "Reader for Zotero" (≤ 100 characters)
- [ ] One-liner (≤ 200 characters), for example: "Search and read your own Zotero library (items, notes, PDF annotations, full text) and export citations. Read-only."
- [ ] Description (≤ 2,000 characters), including the "not affiliated with Zotero" line
- [ ] 1–5 categories (e.g. Research, Education)
- [ ] Documentation URL (the public README)
- [ ] Privacy policy URL: `<PUBLIC_URL>/privacy`, with the placeholders in PRIVACY.md filled in
- [ ] Support contact (email, plus the GitHub issues link)
- [ ] Icon: an original design, not Zotero's logo
- [ ] At least 3 example prompts (see the README)
- [ ] URL slug (permanent once published)
- [ ] Use cases and prerequisites: "A free Zotero account; full text requires Zotero desktop sync."
- [ ] Reads data only

## Review access

- [ ] Reviewer test account: a separate Zotero account with a fully populated library. It should have collections, PDFs with indexed full text, notes, annotations, and a group library. Give the credentials only in the portal.
- [ ] Every tool tested in MCP Inspector **and** as a custom connector in Claude (the portal asks you to confirm this)
- [ ] Tested in Claude Code (loopback flow)

## Submission

- [ ] Any paid Claude plan; portal at <https://claude.ai/directory/manage> → **Submit new** → **MCP connector**
- [ ] Authentication type: "OAuth with client ID metadata documents" (DCR also works)
- [ ] Data handling: "proxied from a partner with permission", with Zotero's written OK on file
- [ ] All seven compliance acknowledgments
- [ ] Agree to the [Directory Terms](https://support.claude.com/en/articles/13145338-anthropic-software-directory-terms) and Policy; commit to maintaining the server and responding to security issues
- [ ] For escalations, email `mcp-review@anthropic.com`
