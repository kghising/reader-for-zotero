import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { GrantProps } from "../env";
import { ZoteroApiError, ZoteroClient, libraryPrefix, parseLibrary, type LibraryRef } from "../zotero/client";
import {
  annotationSummary,
  attachmentSummary,
  collectionSummary,
  compact,
  isReadableAttachment,
  itemDetail,
  itemSummary,
  noteSummary,
  truncate,
  type ZoteroCollection,
  type ZoteroItem,
} from "../zotero/format";

export const SERVER_NAME = "reader-for-zotero";
export const SERVER_VERSION = "0.1.0";

// Every tool only reads. None changes the library, and all stay within the user's Zotero data.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const ITEM_KEY = z
  .string()
  .regex(/^[A-Za-z0-9]{8}$/, "Zotero keys are 8 letters/digits, e.g. ABCD2345")
  .transform((k) => k.toUpperCase());
const LIBRARY = z
  .string()
  .optional()
  .describe('Which library: "user" (default, your personal library) or "group:<id>" from list_libraries.');
const START = z.number().int().min(0).default(0).describe("Offset for pagination; use next_start from the previous page.");

const SEARCH_SORTS = ["dateModified", "dateAdded", "title", "creator", "date"] as const;

export interface ServerDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function buildServer(props: GrantProps, deps: ServerDeps = {}): McpServer {
  const zotero = new ZoteroClient({ apiKey: props.zoteroKey, fetch: deps.fetch, sleep: deps.sleep });
  const lib = (library: string | undefined): LibraryRef => parseLibrary(library, props.zoteroUserId);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "Reader for Zotero" },
    {
      instructions:
        "Read-only access to the user's Zotero libraries (personal and groups). Items, collections and " +
        "attachments are identified by 8-character keys. Full text is available only for attachments that " +
        "Zotero desktop has indexed and synced.",
    },
  );

  // ---------------------------------------------------------------------------------------------
  server.registerTool(
    "list_libraries",
    {
      title: "List Zotero libraries",
      description:
        "List the Zotero libraries this connection can read: the personal library and any group libraries, " +
        'with the value to pass as `library` to the other tools (e.g. "group:12345").',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () =>
      run(async () => {
        const { data: key } = await zotero.getJson<KeyInfo>("/keys/current");
        const libraries: Array<Record<string, unknown>> = [
          { library: "user", name: props.zoteroUsername ? `${props.zoteroUsername}'s library` : "My Library", type: "personal" },
        ];
        const groupAccess = key.access?.groups ?? {};
        if (Object.keys(groupAccess).length > 0) {
          for (let start = 0; start < 500; start += 100) {
            const { data: groups, total } = await zotero.getJson<ZoteroGroup[]>(`/users/${props.zoteroUserId}/groups`, {
              limit: 100,
              start,
            });
            for (const g of groups) {
              if (!groupAccess.all && !groupAccess[String(g.id)]) continue;
              libraries.push({ library: `group:${g.id}`, name: g.data.name, type: "group", items: g.meta?.numItems });
            }
            if (groups.length < 100 || (total !== undefined && start + 100 >= total)) break;
          }
        }
        return {
          libraries,
          ...(Object.keys(groupAccess).length === 0 && {
            note: "This connection has no group access. Reconnect and allow group access to read group libraries.",
          }),
        };
      }),
  );

  // ---------------------------------------------------------------------------------------------
  const listItems = async (args: {
    library?: string;
    query?: string;
    search_mode?: "title_creator_year" | "everything";
    tag?: string;
    item_type?: string;
    collection_key?: string;
    sort?: (typeof SEARCH_SORTS)[number];
    limit: number;
    start: number;
  }) => {
    const prefix = libraryPrefix(lib(args.library));
    const path = args.collection_key ? `${prefix}/collections/${args.collection_key}/items/top` : `${prefix}/items/top`;
    const { data, total } = await zotero.getJson<ZoteroItem[]>(path, {
      q: args.query,
      qmode: args.query ? (args.search_mode === "everything" ? "everything" : "titleCreatorYear") : undefined,
      tag: args.tag,
      itemType: args.item_type,
      sort: args.sort,
      direction: args.sort === "title" || args.sort === "creator" ? "asc" : "desc",
      limit: args.limit,
      start: args.start,
    });
    return page(data.map(itemSummary), total, args.start);
  };

  server.registerTool(
    "search_items",
    {
      title: "Search Zotero items",
      description:
        "Search top-level items (papers, books, etc.) in a Zotero library. Matches title, creators and year by " +
        'default; search_mode "everything" also matches all fields, notes and indexed full text. Can filter by tag, ' +
        "item type or collection. Returns short summaries with item keys; use get_item for details.",
      inputSchema: z.object({
        query: z.string().max(500).optional().describe("Quick-search text. Omit to list items matching only the filters."),
        search_mode: z.enum(["title_creator_year", "everything"]).default("title_creator_year"),
        tag: z
          .string()
          .max(200)
          .optional()
          .describe('Tag filter in Zotero syntax: "tag", "-tag" to exclude, "a || b" for either.'),
        item_type: z.string().max(50).optional().describe('Zotero item type, e.g. "journalArticle", "book", or "-attachment" to exclude.'),
        collection_key: ITEM_KEY.optional().describe("Only search inside this collection."),
        sort: z.enum(SEARCH_SORTS).default("dateModified"),
        limit: z.number().int().min(1).max(25).default(10),
        start: START,
        library: LIBRARY,
      }),
      annotations: READ_ONLY,
    },
    async (args) => run(() => listItems(args)),
  );

  // ---------------------------------------------------------------------------------------------
  server.registerTool(
    "list_collections",
    {
      title: "List Zotero collections",
      description:
        "List collections (folders) in a Zotero library: top-level ones by default, or the subcollections of parent_key. " +
        "Shows item and subcollection counts.",
      inputSchema: z.object({
        parent_key: ITEM_KEY.optional().describe("List subcollections of this collection instead of top-level ones."),
        limit: z.number().int().min(1).max(50).default(25),
        start: START,
        library: LIBRARY,
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const prefix = libraryPrefix(lib(args.library));
        const path = args.parent_key ? `${prefix}/collections/${args.parent_key}/collections` : `${prefix}/collections/top`;
        const { data, total } = await zotero.getJson<ZoteroCollection[]>(path, {
          sort: "title",
          direction: "asc",
          limit: args.limit,
          start: args.start,
        });
        return page(data.map(collectionSummary), total, args.start);
      }),
  );

  server.registerTool(
    "list_collection_items",
    {
      title: "List items in a Zotero collection",
      description: "List the top-level items in one collection (not its subcollections). Returns short summaries with item keys.",
      inputSchema: z.object({
        collection_key: ITEM_KEY,
        sort: z.enum(SEARCH_SORTS).default("title"),
        limit: z.number().int().min(1).max(25).default(10),
        start: START,
        library: LIBRARY,
      }),
      annotations: READ_ONLY,
    },
    async (args) => run(() => listItems(args)),
  );

  // ---------------------------------------------------------------------------------------------
  server.registerTool(
    "get_item",
    {
      title: "Get Zotero item details",
      description:
        "Get one item's full metadata and abstract, plus its attachments (with keys for get_fulltext) and how many notes it has.",
      inputSchema: z.object({ item_key: ITEM_KEY, library: LIBRARY }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const prefix = libraryPrefix(lib(args.library));
        const { data: item } = await zotero.getJson<ZoteroItem>(`${prefix}/items/${args.item_key}`);
        if (item.data.itemType === "note") return { ...noteSummary(item, 20_000), type: "note" };
        if (item.data.itemType === "attachment") return { ...itemDetail(item), parent: item.data.parentItem };
        const children = await allChildren(prefix, args.item_key);
        const attachments = children.filter((c) => c.data.itemType === "attachment");
        const notes = children.filter((c) => c.data.itemType === "note");
        return {
          ...itemDetail(item),
          attachments: attachments.map(attachmentSummary),
          note_count: notes.length,
        };
      }),
  );

  server.registerTool(
    "get_item_notes",
    {
      title: "Get notes for a Zotero item",
      description: "Get the notes attached to an item, converted from HTML to plain text. Long notes are truncated.",
      inputSchema: z.object({
        item_key: ITEM_KEY.describe("The parent item's key (or a note's own key)."),
        max_chars_per_note: z.number().int().min(200).max(20_000).default(4000),
        limit: z.number().int().min(1).max(20).default(10),
        start: START,
        library: LIBRARY,
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const prefix = libraryPrefix(lib(args.library));
        const { data: item } = await zotero.getJson<ZoteroItem>(`${prefix}/items/${args.item_key}`);
        if (item.data.itemType === "note") return page([noteSummary(item, args.max_chars_per_note)], 1, 0);
        const { data, total } = await zotero.getJson<ZoteroItem[]>(`${prefix}/items/${args.item_key}/children`, {
          itemType: "note",
          limit: args.limit,
          start: args.start,
        });
        return page(data.map((n) => noteSummary(n, args.max_chars_per_note)), total, args.start);
      }),
  );

  server.registerTool(
    "get_item_annotations",
    {
      title: "Get PDF annotations for a Zotero item",
      description:
        "Get highlights, notes and other annotations made in Zotero's PDF/EPUB reader, with page labels and comments. " +
        "Accepts a parent item key (reads all its attachments) or an attachment key. Annotations embedded in the PDF " +
        "file by other apps aren't included unless imported into Zotero.",
      inputSchema: z.object({
        item_key: ITEM_KEY,
        limit: z.number().int().min(1).max(100).default(50),
        start: START,
        library: LIBRARY,
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const prefix = libraryPrefix(lib(args.library));
        const { data: item } = await zotero.getJson<ZoteroItem>(`${prefix}/items/${args.item_key}`);
        const attachmentKeys =
          item.data.itemType === "attachment"
            ? [item.data.key]
            : (await allChildren(prefix, args.item_key)).filter(isReadableAttachment).slice(0, 5).map((a) => a.data.key);
        const annotations: ZoteroItem[] = [];
        for (const key of attachmentKeys) {
          annotations.push(...(await allChildren(prefix, key, "annotation", 500 - annotations.length)));
          if (annotations.length >= 500) break;
        }
        return page(
          annotations.slice(args.start, args.start + args.limit).map(annotationSummary),
          annotations.length,
          args.start,
        );
      }),
  );

  // ---------------------------------------------------------------------------------------------
  server.registerTool(
    "get_fulltext",
    {
      title: "Get full text of a Zotero attachment",
      description:
        "Get the extracted text of a PDF, EPUB or web snapshot, in pages of characters. Pass an attachment key, or a " +
        "parent item key to use its first PDF. Use next_offset to read further. Only works for files Zotero desktop " +
        "has indexed and synced.",
      inputSchema: z.object({
        item_key: ITEM_KEY,
        offset: z.number().int().min(0).default(0).describe("Character offset to start from."),
        max_chars: z.number().int().min(1000).max(50_000).default(20_000),
        library: LIBRARY,
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const prefix = libraryPrefix(lib(args.library));
        const { data: item } = await zotero.getJson<ZoteroItem>(`${prefix}/items/${args.item_key}`);
        let attachment = item;
        let others: ZoteroItem[] = [];
        if (item.data.itemType !== "attachment") {
          const readable = (await allChildren(prefix, args.item_key)).filter(isReadableAttachment);
          readable.sort((a, b) => Number(b.data.contentType === "application/pdf") - Number(a.data.contentType === "application/pdf"));
          if (readable.length === 0) {
            throw new ZoteroApiError("This item has no PDF, EPUB or text attachment to read.", 404);
          }
          [attachment, ...others] = readable as [ZoteroItem, ...ZoteroItem[]];
        }
        let ft: FullText;
        try {
          ft = (await zotero.getJson<FullText>(`${prefix}/items/${attachment.data.key}/fulltext`)).data;
        } catch (e) {
          if (e instanceof ZoteroApiError && e.status === 404) {
            throw new ZoteroApiError(
              "No indexed full text for this attachment. Zotero desktop must index the file and sync it " +
                "(full-text syncing is on by default in Zotero's Sync settings). Metadata and annotations are still available.",
              404,
            );
          }
          throw e;
        }
        const content = ft.content ?? "";
        const text = content.slice(args.offset, args.offset + args.max_chars);
        const end = args.offset + text.length;
        return compact({
          attachment_key: attachment.data.key,
          attachment_title: attachment.data.title,
          total_chars: content.length,
          offset: args.offset,
          returned_chars: text.length,
          next_offset: end < content.length ? end : null,
          indexed_pages: ft.indexedPages,
          total_pages: ft.totalPages,
          other_attachments: others.length ? others.map(attachmentSummary) : undefined,
          text,
        });
      }),
  );

  // ---------------------------------------------------------------------------------------------
  server.registerTool(
    "export_items",
    {
      title: "Export Zotero items as citations",
      description: "Export up to 50 items as BibTeX, BibLaTeX, RIS or CSL JSON, generated by Zotero.",
      inputSchema: z.object({
        item_keys: z.array(ITEM_KEY).min(1).max(50),
        format: z.enum(["bibtex", "biblatex", "ris", "csljson"]).default("bibtex"),
        library: LIBRARY,
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const prefix = libraryPrefix(lib(args.library));
        const keys = [...new Set(args.item_keys)];
        const text = await zotero.getText(`${prefix}/items`, { itemKey: keys.join(","), format: args.format });
        return { content: [{ type: "text", text: truncate(text, 200_000) }] };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  return server;

  async function allChildren(prefix: string, key: string, itemType?: string, max = 300): Promise<ZoteroItem[]> {
    const out: ZoteroItem[] = [];
    for (let start = 0; out.length < max; start += 100) {
      const { data, total } = await zotero.getJson<ZoteroItem[]>(`${prefix}/items/${key}/children`, {
        itemType,
        limit: 100,
        start,
      });
      out.push(...data);
      if (data.length < 100 || (total !== undefined && start + 100 >= total)) break;
    }
    return out.slice(0, max);
  }
}

interface KeyInfo {
  userID: number;
  username?: string;
  access?: {
    user?: { library?: boolean; notes?: boolean; write?: boolean; files?: boolean };
    groups?: Record<string, { library?: boolean; write?: boolean }>;
  };
}

interface ZoteroGroup {
  id: number;
  data: { id: number; name: string };
  meta?: { numItems?: number };
}

interface FullText {
  content?: string;
  indexedPages?: number;
  totalPages?: number;
  indexedChars?: number;
  totalChars?: number;
}

function page<T>(items: T[], total: number | undefined, start: number) {
  const end = start + items.length;
  const known = total ?? end;
  return { total: known, start, returned: items.length, next_start: end < known ? end : null, items };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await fn()) }] };
  } catch (e) {
    return errorResult(e);
  }
}

function errorResult(e: unknown): CallToolResult {
  const message =
    e instanceof ZoteroApiError
      ? e.message
      : "Unexpected error while reading from Zotero. Please try again; if it persists, reconnect the connector.";
  if (!(e instanceof ZoteroApiError)) console.error("tool error", e instanceof Error ? e.name : typeof e);
  return { isError: true, content: [{ type: "text", text: message }] };
}
