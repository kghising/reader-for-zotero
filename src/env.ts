import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  /** Public origin of this Worker, e.g. https://reader-for-zotero.example.workers.dev (no trailing slash). */
  PUBLIC_URL: string;
  SUPPORT_EMAIL: string;
  ZOTERO_CLIENT_KEY: string;
  ZOTERO_CLIENT_SECRET: string;
  /** Injected by OAuthProvider before the default handler runs. */
  OAUTH_PROVIDER: OAuthHelpers;
}

/** What each grant stores, encrypted by workers-oauth-provider with a key only the user's tokens unwrap. */
export interface GrantProps {
  zoteroUserId: string;
  zoteroKey: string;
  zoteroUsername?: string;
}
