import { beforeEach, describe, expect, it } from "vitest";
import { describeRequest, parseLibrary, resetBackoffForTests, USER_AGENT, ZoteroApiError, ZoteroClient } from "../src/zotero/client";
import { API_KEY, fakeFetch, json } from "./fixtures";

const ITEMS = "GET api.zotero.org/users/1/items";

function setup() {
  const f = fakeFetch();
  const sleeps: number[] = [];
  let now = 1_000_000;
  const client = new ZoteroClient({
    apiKey: API_KEY,
    fetch: f.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    now: () => now,
  });
  return { f, client, sleeps, advance: (ms: number) => (now += ms) };
}

describe("ZoteroClient", () => {
  beforeEach(() => resetBackoffForTests());

  it("sends API v3 + bearer key headers and reads Total-Results", async () => {
    const { f, client } = setup();
    f.on(ITEMS, () => json([{ key: "A" }], { "Total-Results": "57" }));
    const res = await client.getJson<unknown[]>("/users/1/items", { limit: 5, start: 0, q: undefined });
    expect(res.total).toBe(57);
    const call = f.calls[0]!;
    const headers = new Headers(call.init?.headers);
    expect(headers.get("Zotero-API-Version")).toBe("3");
    expect(headers.get("Authorization")).toBe(`Bearer ${API_KEY}`);
    expect(call.url.searchParams.get("format")).toBe("json");
    expect(call.url.searchParams.has("q")).toBe(false);
    // The key must never travel in the URL.
    expect(call.url.toString()).not.toContain(API_KEY);
  });

  it("retries a 429 after a short Retry-After", async () => {
    const { f, client, sleeps } = setup();
    let n = 0;
    f.on(ITEMS, () => (n++ === 0 ? new Response("slow down", { status: 429, headers: { "Retry-After": "2" } }) : json([])));
    await client.getJson("/users/1/items");
    expect(n).toBe(2);
    expect(sleeps).toContain(2000);
  });

  it("gives an actionable error when Retry-After is long", async () => {
    const { f, client } = setup();
    f.on(ITEMS, () => new Response("", { status: 429, headers: { "Retry-After": "120" } }));
    await expect(client.getJson("/users/1/items")).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 120,
      message: expect.stringContaining("120 seconds"),
    });
  });

  it("treats 503 + Retry-After as maintenance", async () => {
    const { f, client } = setup();
    f.on(ITEMS, () => new Response("", { status: 503, headers: { "Retry-After": "600" } }));
    await expect(client.getJson("/users/1/items")).rejects.toThrow(/temporarily unavailable/);
  });

  it("honours a Backoff header on later requests", async () => {
    const { f, client, sleeps, advance } = setup();
    f.on(ITEMS, () => json([], { Backoff: "60" }));
    await client.getJson("/users/1/items");
    await expect(client.getJson("/users/1/items")).rejects.toThrow(/pause \(Backoff\)/);
    expect(f.calls).toHaveLength(1); // the second request never reached Zotero
    advance(58_000); // 2 s left: short enough to wait inline
    await client.getJson("/users/1/items");
    expect(sleeps.at(-1)).toBe(2000);
  });

  it("maps 403 to a reconnect hint and 404 to not-found", async () => {
    const { f, client } = setup();
    f.on(ITEMS, () => new Response("Forbidden", { status: 403 }));
    await expect(client.getJson("/users/1/items")).rejects.toThrow(/zotero.org\/settings\/keys/);
    f.on(ITEMS, () => new Response("Not found", { status: 404 }));
    await expect(client.getJson("/users/1/items")).rejects.toThrow(/Not found in this Zotero library/);
  });

  it("never runs more than 4 requests at once", async () => {
    const { f, client } = setup();
    let active = 0;
    let peak = 0;
    f.on(ITEMS, async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return json([]);
    });
    await Promise.all(Array.from({ length: 10 }, () => client.getJson("/users/1/items")));
    expect(f.calls).toHaveLength(10);
    expect(peak).toBe(4);
  });
});

describe("User-Agent", () => {
  it("never contains a Zotero/<version> token (Zotero answers 500 on /children for those)", async () => {
    expect(USER_AGENT).not.toMatch(/zotero\/\d/i);
    expect(USER_AGENT).toMatch(/^ReaderForZotero \(\+https:\/\//);
    const f = fakeFetch();
    f.on("GET api.zotero.org/users/1/items/ABCD2345/children", () => json([]));
    const client = new ZoteroClient({ apiKey: API_KEY, fetch: f.fetch });
    await client.getJson("/users/1/items/ABCD2345/children");
    expect(new Headers(f.calls[0]!.init?.headers).get("User-Agent")).toBe(USER_AGENT);
  });
});

describe("failure diagnostics", () => {
  it("logs the masked route, status and Zotero's message, never ids, keys or values", async () => {
    const f = fakeFetch();
    f.on("GET api.zotero.org/users/12345/items/ABCD2345/children", () => new Response("An error occurred", { status: 500 }));
    const logs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      const client = new ZoteroClient({ apiKey: API_KEY, fetch: f.fetch, sleep: async () => {} });
      const err = await client.getJson("/users/12345/items/ABCD2345/children", { q: "secret search" }).catch((e) => e);
      expect(err).toMatchObject({ status: 500, message: "Zotero API error (HTTP 500): An error occurred" });
    } finally {
      console.error = orig;
    }
    expect(logs).toEqual(["zotero upstream 500 GET /users/:id/items/:key/children ?format,q | An error occurred"]);
    expect(logs.join()).not.toMatch(/12345|ABCD2345|secret search|TESTKEY/);
  });

  it("describeRequest keeps word segments like children/fulltext", () => {
    expect(describeRequest(new URL("https://api.zotero.org/groups/9/items/ABCD2345/fulltext?limit=1"))).toBe(
      "/groups/:id/items/:key/fulltext ?limit",
    );
  });
});

describe("parseLibrary", () => {
  it("defaults to the user's library and accepts group:<id>", () => {
    expect(parseLibrary(undefined, "9")).toEqual({ type: "user", id: "9" });
    expect(parseLibrary("group:777", "9")).toEqual({ type: "group", id: "777" });
  });
  it("rejects anything else", () => {
    expect(() => parseLibrary("groups/777/../../x", "9")).toThrow(ZoteroApiError);
  });
});
