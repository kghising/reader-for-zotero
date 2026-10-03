// The interactive half of the OAuth bridge. Claude talks OAuth 2.1 to us (workers-oauth-provider
// handles metadata, registration, PKCE, tokens); we sign the user in to Zotero with OAuth 1.0a and
// store the resulting Zotero API key, encrypted, as the grant's props.
//
//   GET  /authorize        consent page (who is asking, where tokens go)
//   POST /authorize        approve → Zotero request token → redirect to zotero.org
//   GET  /zotero/callback  Zotero returns → exchange verifier for API key → code back to Claude

import { AuthorizationError, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import type { Env, GrantProps } from "./env";
import { consentPage, errorPage, htmlResponse, landingPage, layout, renderMarkdown } from "./pages";
import { authorizeUrl, getAccessToken, getRequestToken, ZoteroOAuthError } from "./zotero/oauth1";
import privacyMarkdown from "../PRIVACY.md";

export const SCOPE_READ = "zotero.read";
export const ZOTERO_CALLBACK_PATH = "/zotero/callback";
/** Holds the upstream transaction's state while the user is on zotero.org (Zotero doesn't echo a state param). */
const STATE_COOKIE = "__Host-rfz-upstream-state";

interface UpstreamData {
  requestToken: string;
  requestTokenSecret: string;
}

export const authHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/authorize" && request.method === "GET") return await showConsent(request, env);
      if (url.pathname === "/authorize" && request.method === "POST") return await handleConsent(request, env);
      if (url.pathname === ZOTERO_CALLBACK_PATH && request.method === "GET") return await handleZoteroCallback(request, env);
      if (url.pathname === "/" && request.method === "GET") return htmlResponse(landingPage(env.PUBLIC_URL, env.SUPPORT_EMAIL));
      if (url.pathname === "/privacy" && request.method === "GET") {
        return htmlResponse(layout("Privacy policy – Reader for Zotero", renderMarkdown(privacyMarkdown)));
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return authErrorResponse(e);
    }
  },
};

async function showConsent(request: Request, env: Env): Promise<Response> {
  const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const description = await env.OAUTH_PROVIDER.describeConsent(authRequest);
  const { handle, headers } = await env.OAUTH_PROVIDER.beginConsent(authRequest);
  return htmlResponse(consentPage(description, handle, authRequest.scope.includes("offline_access")), 200, headers);
}

async function handleConsent(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("action") !== "approve") {
    const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle, { description: "The user cancelled" });
    return new Response(null, { status: 302, headers: denied.headers });
  }

  // The library re-checks every approved scope against scopesSupported.
  const pending = await env.OAUTH_PROVIDER.approveConsent(request, handle, {
    scope: approvedScopes(form.get("offline") === "1" ? ["offline_access"] : []),
  });

  let requestToken: { token: string; secret: string };
  try {
    requestToken = await getRequestToken(consumer(env), `${env.PUBLIC_URL}${ZOTERO_CALLBACK_PATH}`);
  } catch (e) {
    console.error("zotero request token failed", e instanceof ZoteroOAuthError ? e.status : "network");
    return redirect(authorizationErrorRedirect(pending.request, "temporarily_unavailable", "Could not reach Zotero"), pending.headers);
  }

  const data: UpstreamData = { requestToken: requestToken.token, requestTokenSecret: requestToken.secret };
  const upstream = await env.OAUTH_PROVIDER.beginUpstream(pending.request, { data, headers: pending.headers });
  upstream.headers.append("Set-Cookie", `${STATE_COOKIE}=${upstream.state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`);

  return redirect(
    authorizeUrl(requestToken.token, {
      name: "Reader for Zotero (Claude)",
      libraryAccess: true,
      notesAccess: true,
      writeAccess: false,
      allGroups: "read",
    }),
    upstream.headers,
  );
}

async function handleZoteroCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = readCookie(request, STATE_COOKIE);
  if (!state) {
    return htmlResponse(
      errorPage("Sign-in expired", "This Zotero sign-in link has expired or was opened in a different browser. Start connecting again from Claude."),
      400,
    );
  }

  // finishUpstream() reads `state` from the URL and checks the browser binding cookie.
  const withState = new URL(url);
  withState.searchParams.set("state", state);
  const resumed = await env.OAUTH_PROVIDER.finishUpstream<UpstreamData>(new Request(withState, request));
  resumed.headers.append("Set-Cookie", `${STATE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);

  const oauthToken = url.searchParams.get("oauth_token");
  const verifier = url.searchParams.get("oauth_verifier");
  if (!oauthToken || !verifier || oauthToken !== resumed.data.requestToken) {
    // Zotero sends the user back without a verifier when they decline.
    return redirect(authorizationErrorRedirect(resumed.request, "access_denied", "Zotero access was not granted"), resumed.headers);
  }

  let access: Awaited<ReturnType<typeof getAccessToken>>;
  try {
    access = await getAccessToken(
      consumer(env),
      { token: resumed.data.requestToken, secret: resumed.data.requestTokenSecret },
      verifier,
    );
  } catch (e) {
    console.error("zotero access token failed", e instanceof ZoteroOAuthError ? e.status : "network");
    return redirect(authorizationErrorRedirect(resumed.request, "server_error", "Zotero key exchange failed"), resumed.headers);
  }

  const props: GrantProps = { zoteroUserId: access.userId, zoteroKey: access.apiKey, zoteroUsername: access.username };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: resumed.request,
    userId: `zotero-${access.userId}`,
    metadata: {},
    scope: resumed.request.scope,
    props,
  });
  return redirect(redirectTo, resumed.headers);
}

/** Always grant the read scope; pass through offline_access (refresh tokens) when the client asked for it. */
export function approvedScopes(requested: string[]): string[] {
  return requested.includes("offline_access") ? [SCOPE_READ, "offline_access"] : [SCOPE_READ];
}

function consumer(env: Env) {
  return { key: env.ZOTERO_CLIENT_KEY, secret: env.ZOTERO_CLIENT_SECRET };
}

function redirect(location: string, headers: Headers): Response {
  const h = new Headers(headers);
  h.set("Location", location);
  h.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers: h });
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || undefined;
  }
  return undefined;
}

function authErrorResponse(e: unknown): Response {
  if (e instanceof AuthorizationError) {
    if (e.redirectTo) return Response.redirect(e.redirectTo, 302);
    return htmlResponse(errorPage("Can't continue", e.description), 400);
  }
  console.error("auth flow error", e instanceof Error ? e.name : typeof e);
  return htmlResponse(errorPage("Something went wrong", "Please start connecting again from Claude."), 500);
}
