import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/mcp/server";
import { resetBackoffForTests } from "../src/zotero/client";
import { API_KEY, fakeFetch, mockLibrary, USER_ID, type FakeFetch } from "./fixtures";

async function connect(f: FakeFetch) {
  const handler = createMcpHandler(() =>
    buildServer({ zoteroUserId: USER_ID, zoteroKey: API_KEY, zoteroUsername: "alice" }, { fetch: f.fetch, sleep: async () => {} }),
  );
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://rfz.test.example/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
  return { isError: res.isError === true, text, data: res.isError ? undefined : tryJson(text) };
}

function tryJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

describe("MCP tools", () => {
  let f: FakeFetch;
  let client: Client;
  beforeEach(async () => {
    resetBackoffForTests();
    f = fakeFetch();
    mockLibrary(f);
    client = await connect(f);
  });

  it("exposes nine read-only tools with titles and short names", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "export_items",
      "get_fulltext",
      "get_item",
      "get_item_annotations",
      "get_item_notes",
      "list_collection_items",
      "list_collections",
      "list_libraries",
      "search_items",
    ]);
    for (const t of tools) {
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.annotations?.title ?? t.title).toBeTruthy();
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.description!.length).toBeGreaterThan(40);
    }
  });

  it("list_libraries returns the personal library and readable groups, never the key", async () => {
    const r = await call(client, "list_libraries");
    expect(r.data.libraries).toEqual([
      { library: "user", name: "alice's library", type: "personal" },
      { library: "group:777", name: "Lab Group", type: "group", items: 42 },
    ]);
    expect(r.text).not.toContain(API_KEY);
  });

  it("search_items maps arguments to Zotero query params and paginates", async () => {
    const r = await call(client, "search_items", { query: "attention", search_mode: "everything", tag: "transformers", limit: 5, start: 10 });
    const url = f.calls.at(-1)!.url;
    expect(url.pathname).toBe(`/users/${USER_ID}/items/top`);
    expect(url.searchParams.get("q")).toBe("attention");
    expect(url.searchParams.get("qmode")).toBe("everything");
    expect(url.searchParams.get("tag")).toBe("transformers");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("start")).toBe("10");
    expect(r.data).toMatchObject({ total: 31, start: 10, returned: 1, next_start: 11 });
    expect(r.data.items[0]).toMatchObject({ key: "PAPER001", title: "Attention Is All You Need", year: "2017" });
  });

  it("search_items reads group libraries", async () => {
    await call(client, "search_items", { query: "x", library: "group:777" });
    expect(f.calls.at(-1)!.url.pathname).toBe("/groups/777/items/top");
  });

  it("rejects malformed keys and libraries with clear errors", async () => {
    const bad = await call(client, "get_item", { item_key: "../../x" });
    expect(bad.isError).toBe(true);
    const lib = await call(client, "search_items", { library: "groups/1" });
    expect(lib.isError).toBe(true);
    expect(lib.text).toMatch(/group:<id>/);
    expect(f.calls.every((c) => !c.url.pathname.includes(".."))).toBe(true);
  });

  it("list_collections and list_collection_items", async () => {
    const cols = await call(client, "list_collections");
    expect(cols.data.items).toEqual([{ key: "COLL0001", name: "Deep Learning", subcollections: 2, items: 10 }]);
    const items = await call(client, "list_collection_items", { collection_key: "coll0001" });
    expect(f.calls.at(-1)!.url.pathname).toBe(`/users/${USER_ID}/collections/COLL0001/items/top`);
    expect(items.data.items[0].key).toBe("PAPER001");
  });

  it("get_item returns metadata, abstract and attachments", async () => {
    const r = await call(client, "get_item", { item_key: "PAPER001" });
    expect(r.data).toMatchObject({
      key: "PAPER001",
      abstract: expect.stringContaining("sequence transduction"),
      fields: { DOI: "10.48550/arXiv.1706.03762", publicationTitle: "NeurIPS" },
      note_count: 1,
    });
    expect(r.data.attachments.map((a: { key: string }) => a.key)).toEqual(["SNAP0001", "PDFATT01"]);
  });

  it("get_item_notes returns plain text", async () => {
    const r = await call(client, "get_item_notes", { item_key: "PAPER001" });
    expect(r.data.items[0].text).toContain("Self-attention & no recurrence.");
    expect(f.calls.at(-1)!.url.searchParams.get("itemType")).toBe("note");
  });

  it("get_item_annotations collects annotations from the item's attachments", async () => {
    const r = await call(client, "get_item_annotations", { item_key: "PAPER001" });
    expect(r.data.items).toEqual([
      { key: "ANNO0001", attachment: "PDFATT01", type: "highlight", page: "1", text: "Attention is all you need", comment: "Key claim", color: "#ffd400" },
    ]);
  });

  it("get_fulltext prefers the PDF and pages through the text", async () => {
    const first = await call(client, "get_fulltext", { item_key: "PAPER001", max_chars: 20000 });
    expect(first.data).toMatchObject({ attachment_key: "PDFATT01", total_chars: 50000, offset: 0, returned_chars: 20000, next_offset: 20000 });
    expect(first.data.other_attachments[0].key).toBe("SNAP0001");
    const last = await call(client, "get_fulltext", { item_key: "PDFATT01", offset: 40000, max_chars: 20000 });
    expect(last.data).toMatchObject({ returned_chars: 10000, next_offset: null });
  });

  it("get_fulltext explains missing indexes", async () => {
    f = fakeFetch();
    mockLibrary(f, { fulltext: null });
    client = await connect(f);
    const r = await call(client, "get_fulltext", { item_key: "PDFATT01" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/index the file and sync/);
  });

  it("export_items returns BibTeX and CSL JSON from Zotero", async () => {
    const bib = await call(client, "export_items", { item_keys: ["PAPER001", "paper001"] });
    expect(bib.text).toContain("@article{vaswani_attention_2017");
    const url = f.calls.at(-1)!.url;
    expect(url.searchParams.get("itemKey")).toBe("PAPER001");
    expect(url.searchParams.get("format")).toBe("bibtex");
    const csl = await call(client, "export_items", { item_keys: ["PAPER001"], format: "csljson" });
    expect(JSON.parse(csl.text).items[0].title).toBe("Attention Is All You Need");
  });

  it("surfaces Zotero rate limits as a tool error, not a crash", async () => {
    f.on(`GET api.zotero.org/users/${USER_ID}/items/top`, () => new Response("", { status: 429, headers: { "Retry-After": "90" } }));
    const r = await call(client, "search_items", { query: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/wait about 90 seconds/);
  });
});
