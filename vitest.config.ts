import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Test-only values; outbound calls to zotero.org are mocked in every test.
        bindings: {
          PUBLIC_URL: "https://rfz.test.example",
          SUPPORT_EMAIL: "support@test.example",
          ZOTERO_CLIENT_KEY: "test-consumer-key",
          ZOTERO_CLIENT_SECRET: "test-consumer-secret",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
