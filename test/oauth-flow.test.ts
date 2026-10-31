// End-to-end OAuth 2.1 ⇄ Zotero OAuth 1.0a bridge, run against the real Worker with zotero.org mocked.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createExecutionContext, env as testEnv } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { resetBackoffForTests } from "../src/zotero/client";
import { API_KEY, fakeFetch, mockLibrary, USER_ID, type FakeFetch } from "./fixtures";

const env = testEnv as unknown as Env;
const BASE = "https://rfz.test.example";
const RESOURCE = `${BASE}/mcp`;
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

const workerFetch = (req: Request) => worker.fetch(req as Parameters<typeof worker.fetch>[0], env, createExecutionContext());

class Browser {
  cookies = new Map<string, string>();
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("Cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await workerFetch(new Request(url, { ...init, headers, redirect: "manual" }));
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const [name, ...v] = pair!.split("=");
      const expired = attrs.some((a) => /max-age=0\b/i.test(a.trim()));
      if (expired) this.cookies.delete(name!.trim());
      else this.cookies.set(name!.trim(), v.join("="));
    }
    return res;
  }
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

function mockZoteroOAuth(f: FakeFetch, opts: { requestToken?: string } = {}) {
  const rt = opts.requestToken ?? "reqtoken1";
  f.on("POST www.zotero.org/oauth/request", () => new Response(`oauth_token=${rt}&oauth_token_secret=reqsecret1&oauth_callback_confirmed=true`));
  f.on("POST www.zotero.org/oauth/access", () =>
    new Response(`oauth_token=acc1&oauth_token_secret=${API_KEY}&userID=${USER_ID}&username=alice`),
  );
}

async function register(redirectUris = [CLAUDE_CALLBACK]): Promise<string> {
  const res = await workerFetch(
    new Request(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Runs consent + Zotero sign-in; returns the browser and the final redirect to the client. */
async function authorize(clientId: string, challenge: string, opts: { redirectUri?: string; zoteroDecline?: boolean } = {}) {
  const browser = new Browser();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: opts.redirectUri ?? CLAUDE_CALLBACK,
    scope: "zotero.read offline_access",
    state: "client-state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  });
  const consent = await browser.fetch(`${BASE}/authorize?${q}`);
  expect(consent.status).toBe(200);
  const html = await consent.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;

  const approve = await browser.fetch(`${BASE}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ handle, action: "approve", offline: "1" }),
  });
  expect(approve.status).toBe(302);
  const zoteroAuthorize = new URL(approve.headers.get("Location")!);

  const cb = new URL(`${BASE}/zotero/callback`);
  cb.searchParams.set("oauth_token", zoteroAuthorize.searchParams.get("oauth_token")!);
  if (!opts.zoteroDecline) cb.searchParams.set("oauth_verifier", "verifier1");
  const back = await browser.fetch(cb.toString());
  return { browser, html, zoteroAuthorize, back };
}

async function token(body: Record<string, string>) {
  return workerFetch(
    new Request(`${BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    }));
}

async function signIn() {
  const clientId = await register();
  const { verifier, challenge } = await pkce();
  const { back } = await authorize(clientId, challenge);
  const code = new URL(back.headers.get("Location")!).searchParams.get("code")!;
  const res = await token({ grant_type: "authorization_code", code, redirect_uri: CLAUDE_CALLBACK, client_id: clientId, code_verifier: verifier, resource: RESOURCE });
  expect(res.status).toBe(200);
  return { clientId, tokens: (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; scope: string } };
}

function mcpClient(accessToken: string, modern = false) {
  const client = new Client({ name: "test", version: "1.0.0" }, modern ? { versionNegotiation: { mode: "auto" } } : undefined);
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    // Cloudflare always sets Host in production; Requests built in tests don't.
    fetch: (url, init) => {
      const req = new Request(url, init);
      req.headers.set("Host", new URL(req.url).host);
      return workerFetch(req);
    },
  });
  return { client, transport };
}

describe("OAuth bridge", () => {
  let f: FakeFetch;
  beforeEach(() => {
    resetBackoffForTests();
    f = fakeFetch();
    mockZoteroOAuth(f);
    mockLibrary(f);
    vi.stubGlobal("fetch", f.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("answers unauthenticated MCP requests with 401 + resource_metadata", async () => {
    const res = await workerFetch(new Request(RESOURCE, { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/resource_metadata="https:\/\/rfz\.test\.example\/\.well-known\/oauth-protected-resource(\/mcp)?"/);
  });

  it("publishes discovery metadata Claude needs", async () => {
    const prm = (await (await workerFetch(new Request(`${BASE}/.well-known/oauth-protected-resource/mcp`))).json()) as Record<string, unknown>;
    expect(prm.resource).toBe(RESOURCE);
    expect(prm.authorization_servers).toEqual([BASE]);
    expect(prm.scopes_supported).toEqual(["zotero.read"]);

    const as = (await (await workerFetch(new Request(`${BASE}/.well-known/oauth-authorization-server`))).json()) as Record<string, any>;
    expect(as.issuer).toBe(BASE);
    expect(as.code_challenge_methods_supported).toContain("S256");
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.token_endpoint_auth_methods_supported).toContain("none");
    expect(as.registration_endpoint).toBe(`${BASE}/register`);
    expect(as.scopes_supported).toEqual(expect.arrayContaining(["zotero.read", "offline_access"]));
  });

  it("runs the full sign-in, serves tools with the user's Zotero key, and refreshes", async () => {
    const clientId = await register();
    const { verifier, challenge } = await pkce();
    const { html, zoteroAuthorize, back } = await authorize(clientId, challenge);

    // Consent page names the client and where tokens go.
    expect(html).toContain("Claude");
    expect(html).toContain("claude.ai");

    // We asked Zotero for a read-only key, and signed the request-token call with our consumer key.
    expect(zoteroAuthorize.origin + zoteroAuthorize.pathname).toBe("https://www.zotero.org/oauth/authorize");
    expect(zoteroAuthorize.searchParams.get("write_access")).toBe("0");
    const requestCall = f.calls.find((c) => c.url.pathname === "/oauth/request")!;
    const authz = new Headers(requestCall.init?.headers).get("Authorization")!;
    expect(authz).toMatch(/^OAuth /);
    expect(authz).toContain('oauth_consumer_key="test-consumer-key"');
    expect(authz).toContain(`oauth_callback="${encodeURIComponent(`${BASE}/zotero/callback`)}"`);
    expect(authz).toContain('oauth_signature_method="HMAC-SHA1"');

    // The access-token call carries the verifier and request token.
    const accessCall = f.calls.find((c) => c.url.pathname === "/oauth/access")!;
    const accessAuth = new Headers(accessCall.init?.headers).get("Authorization")!;
    expect(accessAuth).toContain('oauth_verifier="verifier1"');
    expect(accessAuth).toContain('oauth_token="reqtoken1"');

    // Back to Claude with a code, the client's state, and our issuer (RFC 9207).
    expect(back.status).toBe(302);
    const redirect = new URL(back.headers.get("Location")!);
    expect(redirect.origin + redirect.pathname).toBe(CLAUDE_CALLBACK);
    expect(redirect.searchParams.get("state")).toBe("client-state-1");
    expect(redirect.searchParams.get("iss")).toBe(BASE);

    const res = await token({
      grant_type: "authorization_code",
      code: redirect.searchParams.get("code")!,
      redirect_uri: CLAUDE_CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(res.status).toBe(200);
    const tokens = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.refresh_token).toBeTruthy();
    // Our token is not the Zotero key (no token passthrough).
    expect(tokens.access_token).not.toContain(API_KEY);

    // MCP calls reach Zotero with the user's key, not our token.
    const { client, transport } = mcpClient(tokens.access_token);
    await client.connect(transport);
    const result = await client.callTool({ name: "search_items", arguments: { query: "attention" } });
    expect(result.isError).toBeFalsy();
    const zoteroCall = f.calls.findLast((c) => c.url.host === "api.zotero.org")!;
    expect(new Headers(zoteroCall.init?.headers).get("Authorization")).toBe(`Bearer ${API_KEY}`);
    expect(zoteroCall.url.pathname).toBe(`/users/${USER_ID}/items/top`);

    // Refresh tokens rotate.
    const refreshed = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId, resource: RESOURCE });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    const { client: c2, transport: t2 } = mcpClient(next.access_token);
    await c2.connect(t2);
    expect((await c2.listTools()).tools.length).toBe(9);
  });

  it("serves the 2026-07-28 protocol revision too", async () => {
    const { tokens } = await signIn();
    const { client, transport } = mcpClient(tokens.access_token, true);
    await client.connect(transport);
    const r = await client.callTool({ name: "list_libraries", arguments: {} });
    expect(r.isError).toBeFalsy();
  });

  it("rejects bad tokens with 401 and refuses tokens for another resource", async () => {
    const bad = await workerFetch(
      new Request(RESOURCE, { method: "POST", headers: { Authorization: "Bearer nope:nope:nope" }, body: "{}" }));
    expect(bad.status).toBe(401);

    const clientId = await register();
    const { verifier, challenge } = await pkce();
    const { back } = await authorize(clientId, challenge);
    const res = await token({
      grant_type: "authorization_code",
      code: new URL(back.headers.get("Location")!).searchParams.get("code")!,
      redirect_uri: CLAUDE_CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
      resource: "https://evil.example/mcp",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_target");
  });

  it("blocks browser requests to /mcp from other sites, even with a valid token", async () => {
    const { tokens } = await signIn();
    const res = await workerFetch(
      new Request(RESOURCE, {
        method: "POST",
        headers: {
          Host: "rfz.test.example",
          Origin: "https://evil.example",
          Authorization: `Bearer ${tokens.access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }));
    expect(res.status).toBe(403);
    expect(f.calls.some((c) => c.url.host === "api.zotero.org")).toBe(false);
  });

  it("requires the right PKCE verifier", async () => {
    const clientId = await register();
    const { challenge } = await pkce();
    const { back } = await authorize(clientId, challenge);
    const res = await token({
      grant_type: "authorization_code",
      code: new URL(back.headers.get("Location")!).searchParams.get("code")!,
      redirect_uri: CLAUDE_CALLBACK,
      client_id: clientId,
      code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier-123",
      resource: RESOURCE,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("returns access_denied when the user cancels on our page or declines at Zotero", async () => {
    const clientId = await register();
    const { challenge } = await pkce();

    const browser = new Browser();
    const q = new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: CLAUDE_CALLBACK, scope: "zotero.read",
      state: "s", code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE,
    });
    const html = await (await browser.fetch(`${BASE}/authorize?${q}`)).text();
    const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
    const cancel = await browser.fetch(`${BASE}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle, action: "deny" }),
    });
    expect(new URL(cancel.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
    expect(f.calls.some((c) => c.url.host === "www.zotero.org")).toBe(false);

    const { back } = await authorize(clientId, challenge, { zoteroDecline: true });
    expect(new URL(back.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("refuses a Zotero callback from a different browser", async () => {
    const clientId = await register();
    const { challenge } = await pkce();
    const { zoteroAuthorize } = await authorize(clientId, challenge);
    const stranger = new Browser();
    const res = await stranger.fetch(`${BASE}/zotero/callback?oauth_token=${zoteroAuthorize.searchParams.get("oauth_token")}&oauth_verifier=v`);
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("accepts Claude Code's loopback redirect on any port and warns on the consent page", async () => {
    const clientId = await register(["http://localhost/callback", "http://127.0.0.1/callback"]);
    const { challenge } = await pkce();
    const browser = new Browser();
    const q = new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: "http://localhost:53682/callback", scope: "zotero.read",
      state: "s", code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE,
    });
    const res = await browser.fetch(`${BASE}/authorize?${q}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("on your own computer");
  });

  it("rejects unregistered redirect URIs without redirecting", async () => {
    const clientId = await register();
    const { challenge } = await pkce();
    const q = new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: "https://evil.example/cb", scope: "zotero.read",
      state: "s", code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE,
    });
    const res = await new Browser().fetch(`${BASE}/authorize?${q}`);
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("consent page lets the post-approval redirects through and blocks double submits", async () => {
    const clientId = await register();
    const { challenge } = await pkce();
    const q = new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: CLAUDE_CALLBACK, scope: "zotero.read",
      state: "s", code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE,
    });
    const res = await new Browser().fetch(`${BASE}/authorize?${q}`);
    const csp = res.headers.get("Content-Security-Policy")!;
    // Chrome applies form-action to the redirect after a POST: zotero.org and the client callback must be allowed.
    expect(csp).toMatch(/form-action 'self' https: http:\/\/localhost:\*/);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
    const html = await res.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain("f.dataset.sent");
  });

  it("serves the landing and privacy pages", async () => {
    const home = await new Browser().fetch(`${BASE}/`);
    expect(await home.text()).toContain(`${BASE}/mcp`);
    const privacy = await new Browser().fetch(`${BASE}/privacy`);
    expect(privacy.status).toBe(200);
    expect(await privacy.text()).toContain("<h2>What we collect and why</h2>");
  });
});
