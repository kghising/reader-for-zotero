// Shapes Zotero JSON into small objects for Claude. Long fields are truncated with a marker so
// responses stay proportionate; the full-text tool pages through large text instead.

export interface ZoteroCreator {
  creatorType?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

export interface ZoteroItemData {
  key: string;
  itemType: string;
  title?: string;
  creators?: ZoteroCreator[];
  abstractNote?: string;
  date?: string;
  publicationTitle?: string;
  bookTitle?: string;
  publisher?: string;
  DOI?: string;
  ISBN?: string;
  url?: string;
  tags?: Array<{ tag: string; type?: number }>;
  collections?: string[];
  parentItem?: string;
  contentType?: string;
  linkMode?: string;
  filename?: string;
  note?: string;
  annotationType?: string;
  annotationText?: string;
  annotationComment?: string;
  annotationColor?: string;
  annotationPageLabel?: string;
  dateAdded?: string;
  dateModified?: string;
  [field: string]: unknown;
}

export interface ZoteroItem {
  key: string;
  library?: { type: string; id: number; name?: string };
  meta?: { creatorSummary?: string; parsedDate?: string; numChildren?: number };
  data: ZoteroItemData;
}

export interface ZoteroCollection {
  key: string;
  data: { key: string; name: string; parentCollection: string | false };
  meta?: { numCollections?: number; numItems?: number };
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}… [truncated, ${text.length - max} more characters]`;
}

export function formatCreator(c: ZoteroCreator): string {
  if (c.name) return c.name;
  const first = c.firstName?.trim();
  return first ? `${c.lastName ?? ""}, ${first}` : (c.lastName ?? "");
}

function creatorList(creators: ZoteroCreator[] | undefined, max: number): string[] | undefined {
  if (!creators?.length) return undefined;
  const names = creators.slice(0, max).map(formatCreator).filter(Boolean);
  if (creators.length > max) names.push(`et al. (${creators.length - max} more)`);
  return names;
}

function year(item: ZoteroItem): string | undefined {
  return item.meta?.parsedDate?.slice(0, 4) || item.data.date?.match(/\d{4}/)?.[0];
}

/** One line per item in search and list results. */
export function itemSummary(item: ZoteroItem) {
  const d = item.data;
  return compact({
    key: d.key,
    type: d.itemType,
    title: d.title ? truncate(d.title, 300) : undefined,
    creators: creatorList(d.creators, 4),
    year: year(item),
    publication: d.publicationTitle || d.bookTitle || d.publisher || undefined,
    doi: d.DOI || undefined,
    tags: d.tags?.length ? d.tags.slice(0, 10).map((t) => t.tag) : undefined,
    children: item.meta?.numChildren || undefined,
  });
}

// Fields shown separately or not useful to a reader.
const OMIT_FIELDS = new Set([
  "key", "version", "itemType", "title", "creators", "abstractNote", "tags", "collections",
  "relations", "dateAdded", "dateModified", "accessDate", "note", "parentItem",
]);

/** Full metadata for get_item. */
export function itemDetail(item: ZoteroItem) {
  const d = item.data;
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) {
    if (OMIT_FIELDS.has(k) || typeof v !== "string" || v === "") continue;
    fields[k] = truncate(v, 1000);
  }
  return compact({
    key: d.key,
    type: d.itemType,
    title: d.title,
    creators: d.creators?.length
      ? d.creators.slice(0, 50).map((c) => `${formatCreator(c)}${c.creatorType && c.creatorType !== "author" ? ` (${c.creatorType})` : ""}`)
      : undefined,
    year: year(item),
    abstract: d.abstractNote ? truncate(d.abstractNote, 5000) : undefined,
    fields,
    tags: d.tags?.length ? d.tags.slice(0, 50).map((t) => t.tag) : undefined,
    collections: d.collections?.length ? d.collections : undefined,
    date_added: d.dateAdded,
    date_modified: d.dateModified,
  });
}

export function attachmentSummary(item: ZoteroItem) {
  const d = item.data;
  return compact({
    key: d.key,
    title: d.title,
    content_type: d.contentType || undefined,
    link_mode: d.linkMode,
    filename: d.filename,
  });
}

export function isReadableAttachment(item: ZoteroItem): boolean {
  const t = item.data.contentType ?? "";
  return item.data.itemType === "attachment" && (t === "application/pdf" || t === "application/epub+zip" || t.startsWith("text/"));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Zotero notes are HTML. Convert to readable plain text without a DOM. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n• ")
    .replace(/<\s*\/\s*(p|div|h[1-6]|ul|ol|blockquote|tr|pre)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function noteSummary(item: ZoteroItem, maxChars: number) {
  const d = item.data;
  return compact({
    key: d.key,
    parent: d.parentItem,
    text: truncate(htmlToText(d.note ?? ""), maxChars),
    tags: d.tags?.length ? d.tags.map((t) => t.tag) : undefined,
    date_modified: d.dateModified,
  });
}

export function annotationSummary(item: ZoteroItem) {
  const d = item.data;
  return compact({
    key: d.key,
    attachment: d.parentItem,
    type: d.annotationType,
    page: d.annotationPageLabel || undefined,
    text: d.annotationText ? truncate(d.annotationText, 2000) : undefined,
    comment: d.annotationComment ? truncate(htmlToText(d.annotationComment), 2000) : undefined,
    color: d.annotationColor,
    tags: d.tags?.length ? d.tags.map((t) => t.tag) : undefined,
  });
}

export function collectionSummary(c: ZoteroCollection) {
  return compact({
    key: c.data.key,
    name: c.data.name,
    parent: c.data.parentCollection || undefined,
    subcollections: c.meta?.numCollections || undefined,
    items: c.meta?.numItems,
  });
}

/** Drop undefined fields so the JSON stays small. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
