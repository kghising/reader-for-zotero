// Minimal OAuth 1.0a (RFC 5849, HMAC-SHA1) client for Zotero's key exchange.
// Zotero uses OAuth only to mint an API key: the access token's secret *is* the API key.
// https://www.zotero.org/support/dev/web_api/v3/oauth

export const ZOTERO_OAUTH = {
  requestTokenUrl: "https://www.zotero.org/oauth/request",
  authorizeUrl: "https://www.zotero.org/oauth/authorize",
  accessTokenUrl: "https://www.zotero.org/oauth/access",
} as const;

export interface ConsumerCredentials {
  key: string;
  secret: string;
}

/** RFC 3986 percent-encoding, as RFC 5849 §3.6 requires (encodeURIComponent leaves !'()* alone). */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** RFC 5849 §3.4.1 signature base string. `url` may carry query parameters; they are signed too. */
export function signatureBaseString(method: string, url: string, params: Record<string, string>): string {
  const parsed = new URL(url);
  const pairs: Array<[string, string]> = [];
  parsed.searchParams.forEach((v, k) => pairs.push([percentEncode(k), percentEncode(v)]));
  for (const [k, v] of Object.entries(params)) pairs.push([percentEncode(k), percentEncode(v)]);
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const normalizedParams = pairs.map(([k, v]) => `${k}=${v}`).join("&");
  const baseUri = `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname}`;
  return [method.toUpperCase(), percentEncode(baseUri), percentEncode(normalizedParams)].join("&");
}

export async function hmacSha1Base64(key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-1" }, false, [
    "sign",
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data)));
  let binary = "";
  for (const b of sig) binary += String.fromCharCode(b);
  return btoa(binary);
}

export async function sign(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret = "",
): Promise<string> {
  const base = signatureBaseString(method, url, params);
  return hmacSha1Base64(`${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`, base);
}

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function authorizationHeader(
  method: string,
  url: string,
  consumer: ConsumerCredentials,
  extra: Record<string, string>,
  tokenSecret?: string,
): Promise<string> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumer.key,
    oauth_nonce: nonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: "1.0",
    ...extra,
  };
  oauthParams.oauth_signature = await sign(method, url, oauthParams, consumer.secret, tokenSecret);
  return (
    "OAuth " +
    Object.entries(oauthParams)
      .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
      .join(", ")
  );
}

export class ZoteroOAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ZoteroOAuthError";
  }
}

async function postForForm(url: string, authorization: string): Promise<URLSearchParams> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Length": "0" },
    signal: AbortSignal.timeout(8000),
  });
  const body = await res.text();
  if (!res.ok) {
    // Never echo the upstream body: it can contain token material.
    throw new ZoteroOAuthError(`Zotero OAuth endpoint returned HTTP ${res.status}`, res.status);
  }
  return new URLSearchParams(body);
}

/** Step 1: get a temporary request token. `callbackUrl` is where Zotero sends the user back. */
export async function getRequestToken(
  consumer: ConsumerCredentials,
  callbackUrl: string,
): Promise<{ token: string; secret: string }> {
  const auth = await authorizationHeader("POST", ZOTERO_OAUTH.requestTokenUrl, consumer, {
    oauth_callback: callbackUrl,
  });
  const form = await postForForm(ZOTERO_OAUTH.requestTokenUrl, auth);
  const token = form.get("oauth_token");
  const secret = form.get("oauth_token_secret");
  if (!token || !secret || form.get("oauth_callback_confirmed") !== "true") {
    throw new ZoteroOAuthError("Zotero returned an incomplete request token");
  }
  return { token, secret };
}

export interface ZoteroPermissions {
  /** Shown to the user on Zotero's page and as the key's name in their settings. */
  name: string;
  libraryAccess: boolean;
  notesAccess: boolean;
  writeAccess: boolean;
  allGroups: "none" | "read" | "write";
}

/** Step 2: the zotero.org page where the user approves the key's permissions. */
export function authorizeUrl(requestToken: string, perms: ZoteroPermissions): string {
  const url = new URL(ZOTERO_OAUTH.authorizeUrl);
  url.searchParams.set("oauth_token", requestToken);
  url.searchParams.set("name", perms.name);
  url.searchParams.set("library_access", perms.libraryAccess ? "1" : "0");
  url.searchParams.set("notes_access", perms.notesAccess ? "1" : "0");
  url.searchParams.set("write_access", perms.writeAccess ? "1" : "0");
  url.searchParams.set("all_groups", perms.allGroups);
  return url.toString();
}

/** Step 3: exchange the verified request token for the permanent API key. */
export async function getAccessToken(
  consumer: ConsumerCredentials,
  requestToken: { token: string; secret: string },
  verifier: string,
): Promise<{ apiKey: string; userId: string; username?: string }> {
  const auth = await authorizationHeader(
    "POST",
    ZOTERO_OAUTH.accessTokenUrl,
    consumer,
    { oauth_token: requestToken.token, oauth_verifier: verifier },
    requestToken.secret,
  );
  const form = await postForForm(ZOTERO_OAUTH.accessTokenUrl, auth);
  const apiKey = form.get("oauth_token_secret");
  const userId = form.get("userID");
  if (!apiKey || !userId || !/^\d+$/.test(userId)) {
    throw new ZoteroOAuthError("Zotero returned an incomplete access token");
  }
  return { apiKey, userId, username: form.get("username") ?? undefined };
}
