// A tiny fake of the Zotero Web API and OAuth endpoints, used by every test via a stubbed fetch.
import type { ZoteroItem } from "../src/zotero/format";

export const USER_ID = "12345";
export const API_KEY = "TESTKEY0123456789abcdef";

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

export interface FakeFetch {
  fetch: typeof fetch;
  calls: Array<{ url: URL; init?: RequestInit }>;
  /** Route requests whose `METHOD host+path` matches (exact string or regex). Later routes win. */
  on(match: string | RegExp, handler: Handler): void;
}

export function fakeFetch(): FakeFetch {
  const routes: Array<[string | RegExp, Handler]> = [];
  const calls: FakeFetch["calls"] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // Real Zotero answers 500 on /children when the User-Agent looks like a Zotero client ("...Zotero/<version>").
    const ua = new Headers(init?.headers).get("User-Agent") ?? "";
    if (url.host === "api.zotero.org" && url.pathname.endsWith("/children") && /zotero\/\d/i.test(ua)) {
      return new Response("An error occurred", { status: 500 });
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    calls.push({ url, init });
    const key = `${method} ${url.host}${url.pathname}`;
    for (let i = routes.length - 1; i >= 0; i--) {
      const [m, h] = routes[i]!;
      if (typeof m === "string" ? m === key : m.test(key)) return h(url, init);
    }
    return new Response(`unmocked ${key}`, { status: 599 });
  }) as typeof fetch;
  return { fetch: fn, calls, on: (m, h) => routes.push([m, h]) };
}

export function json(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export function item(key: string, data: Partial<ZoteroItem["data"]> = {}, meta: ZoteroItem["meta"] = {}): ZoteroItem {
  return { key, meta, data: { key, itemType: "journalArticle", ...data } };
}

export const PAPER = item(
  "PAPER001",
  {
    title: "Attention Is All You Need",
    creators: [
      { creatorType: "author", firstName: "Ashish", lastName: "Vaswani" },
      { creatorType: "author", firstName: "Noam", lastName: "Shazeer" },
    ],
    abstractNote: "The dominant sequence transduction models are based on complex recurrent networks.",
    date: "2017-06-12",
    publicationTitle: "NeurIPS",
    DOI: "10.48550/arXiv.1706.03762",
    tags: [{ tag: "transformers" }],
    collections: ["COLL0001"],
  },
  { parsedDate: "2017-06-12", numChildren: 3 },
);

export const PDF = item("PDFATT01", {
  itemType: "attachment",
  parentItem: "PAPER001",
  title: "Full Text PDF",
  contentType: "application/pdf",
  linkMode: "imported_file",
  filename: "vaswani.pdf",
});

export const NOTE = item("NOTE0001", {
  itemType: "note",
  parentItem: "PAPER001",
  note: "<h1>Summary</h1><p>Self-attention &amp; no recurrence.</p><ul><li>Multi-head</li><li>Positional encodings</li></ul>",
});

export const SNAPSHOT = item("SNAP0001", {
  itemType: "attachment",
  parentItem: "PAPER001",
  title: "Snapshot",
  contentType: "text/html",
  linkMode: "imported_url",
});

export const ANNOTATION = item("ANNO0001", {
  itemType: "annotation",
  parentItem: "PDFATT01",
  annotationType: "highlight",
  annotationText: "Attention is all you need",
  annotationComment: "Key claim",
  annotationColor: "#ffd400",
  annotationPageLabel: "1",
});

/** Registers a realistic personal library + one group on the fake API. */
export function mockLibrary(f: FakeFetch, opts: { fulltext?: string | null } = {}): void {
  const api = "api.zotero.org";
  f.on(`GET ${api}/keys/current`, () =>
    json({ userID: Number(USER_ID), username: "alice", access: { user: { library: true, notes: true }, groups: { all: { library: true, write: false } } } }),
  );
  f.on(`GET ${api}/users/${USER_ID}/groups`, () =>
    json([{ id: 777, data: { id: 777, name: "Lab Group" }, meta: { numItems: 42 } }], { "Total-Results": "1" }),
  );
  f.on(new RegExp(`^GET ${api}/(users/${USER_ID}|groups/777)/items/top$`), () => json([PAPER], { "Total-Results": "31" }));
  f.on(`GET ${api}/users/${USER_ID}/collections/COLL0001/items/top`, () => json([PAPER], { "Total-Results": "1" }));
  f.on(`GET ${api}/users/${USER_ID}/collections/top`, () =>
    json([{ key: "COLL0001", data: { key: "COLL0001", name: "Deep Learning", parentCollection: false }, meta: { numCollections: 2, numItems: 10 } }], {
      "Total-Results": "1",
    }),
  );
  f.on(`GET ${api}/users/${USER_ID}/items/PAPER001`, () => json(PAPER));
  f.on(`GET ${api}/users/${USER_ID}/items/PDFATT01`, () => json(PDF));
  f.on(`GET ${api}/users/${USER_ID}/items/NOTE0001`, () => json(NOTE));
  f.on(`GET ${api}/users/${USER_ID}/items/PAPER001/children`, (url) => {
    const all = [SNAPSHOT, PDF, NOTE];
    const filtered = url.searchParams.get("itemType") ? all.filter((i) => i.data.itemType === url.searchParams.get("itemType")) : all;
    return json(filtered, { "Total-Results": String(filtered.length) });
  });
  f.on(`GET ${api}/users/${USER_ID}/items/PDFATT01/children`, () => json([ANNOTATION], { "Total-Results": "1" }));
  f.on(`GET ${api}/users/${USER_ID}/items/SNAP0001/children`, () => json([], { "Total-Results": "0" }));
  f.on(`GET ${api}/users/${USER_ID}/items/PDFATT01/fulltext`, () =>
    opts.fulltext === null
      ? new Response("Not found", { status: 404 })
      : json({ content: opts.fulltext ?? "0123456789".repeat(5000), indexedPages: 15, totalPages: 15 }),
  );
  f.on(`GET ${api}/users/${USER_ID}/items`, (url) => {
    const format = url.searchParams.get("format");
    if (format === "bibtex") return new Response("@article{vaswani_attention_2017,\n title = {Attention Is All You Need}\n}\n");
    if (format === "csljson") return json({ items: [{ id: "PAPER001", type: "article-journal", title: "Attention Is All You Need" }] });
    return json([PAPER]);
  });
}
