import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler, hostHeaderValidationResponse, originValidationResponse } from "@modelcontextprotocol/server";
import { authHandler, SCOPE_READ } from "./auth";
import type { Env, GrantProps } from "./env";
import { buildServer } from "./mcp/server";

export const MCP_PATH = "/mcp";

// One stateless MCP handler for the isolate; each request builds a server bound to that user's key.
const mcp = createMcpHandler((ctx) => buildServer(ctx.authInfo?.extra?.props as GrantProps));

/** Runs only after workers-oauth-provider has validated the bearer token for this resource. */
const mcpApiHandler: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const host = new URL(env.PUBLIC_URL).hostname;
    // Browsers must not be able to drive the endpoint from other sites (DNS rebinding / CSRF).
    const rejected =
      hostHeaderValidationResponse(request, [host, "localhost", "127.0.0.1"]) ??
      originValidationResponse(request, [host, "localhost", "127.0.0.1"]);
    if (rejected) return rejected;

    const props = (ctx as ExecutionContext & { props: GrantProps }).props;
    return mcp.fetch(request, {
      authInfo: { token: "", clientId: "", scopes: [SCOPE_READ], extra: { props } },
    });
  },
};

const providers = new Map<string, OAuthProvider<Env>>();

export function getProvider(env: Env): OAuthProvider<Env> {
  let provider = providers.get(env.PUBLIC_URL);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: MCP_PATH,
      apiHandler: mcpApiHandler as never,
      defaultHandler: authHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register", // DCR fallback; Claude prefers CIMD when advertised.
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [SCOPE_READ, "offline_access"],
      requiredScopes: [SCOPE_READ],
      resourceMetadata: {
        resource: `${env.PUBLIC_URL}${MCP_PATH}`,
        authorization_servers: [env.PUBLIC_URL],
        resource_name: "Reader for Zotero",
      },
      accessTokenTTL: 60 * 60,
      // A grant lives while it's used: expires after 90 idle days. Refresh tokens rotate.
      refreshTokenTTL: 90 * 24 * 60 * 60,
      refreshTokenIdleTTL: 90 * 24 * 60 * 60,
      cookiePrefix: "__Host-rfz-",
    });
    providers.set(env.PUBLIC_URL, provider);
  }
  return provider;
}

export default {
  fetch(request, env, ctx) {
    return getProvider(env).fetch(request, env, ctx);
  },
  async scheduled(_controller, env) {
    await getProvider(env).purgeExpiredData(env);
  },
} satisfies ExportedHandler<Env>;
