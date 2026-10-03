// Zotero Web API v3 client: https://www.zotero.org/support/dev/web_api/v3/basics
// Honours Backoff / Retry-After, caps concurrency at 4 (Zotero's guidance), and maps errors to
// messages Claude can act on. Nothing is cached.

export const ZOTERO_API_BASE = "https://api.zotero.org";
const MAX_CONCURRENCY = 4;
/** Longest wait we absorb inside a tool call before telling the user to retry later. */
const MAX_INLINE_WAIT_MS = 3000;
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 10_000;

// Backoff is about Zotero's server load, not one user, so share it across requests in this isolate.
let backoffUntil = 0;
export function resetBackoffForTests(): void {
  backoffUntil = 0;
}

export type LibraryRef = { type: "user" | "group"; id: string };

export class ZoteroApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ZoteroApiError";
  }
}

/** Parse the tools' `library` argument: "user" (default) or "group:<numeric id>". */
export function parseLibrary(library: string | undefined, userId: string): LibraryRef {
  if (!library || library === "user") return { type: "user", id: userId };
  const m = /^group:(\d+)$/.exec(library);
  if (!m) {
    throw new ZoteroApiError(
      `Invalid library "${library}". Use "user" for your personal library or "group:<id>" (see list_libraries).`,
      400,
    );
  }
  return { type: "group", id: m[1]! };
}

export function libraryPrefix(lib: LibraryRef): string {
  return lib.type === "user" ? `/users/${lib.id}` : `/groups/${lib.id}`;
}

export interface ZoteroResponse<T> {
  data: T;
  /** Total-Results header, present on multi-object requests. */
  total?: number;
}

export interface ZoteroClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  baseUrl?: string;
}

type Params = Record<string, string | number | undefined>;

export class ZoteroClient {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #baseUrl: string;
  #active = 0;
  readonly #queue: Array<() => void> = [];

  constructor(opts: ZoteroClientOptions) {
    this.#apiKey = opts.apiKey;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#now = opts.now ?? Date.now;
    this.#baseUrl = opts.baseUrl ?? ZOTERO_API_BASE;
  }

  async getJson<T>(path: string, params: Params = {}): Promise<ZoteroResponse<T>> {
    const res = await this.request(path, { ...params, format: params.format ?? "json" });
    const total = res.headers.get("Total-Results");
    return { data: (await res.json()) as T, total: total === null ? undefined : Number(total) };
  }

  async getText(path: string, params: Params = {}): Promise<string> {
    const res = await this.request(path, params);
    return res.text();
  }

  async request(path: string, params: Params = {}): Promise<Response> {
    const url = new URL(this.#baseUrl + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    await this.#acquire();
    try {
      return await this.#requestWithRetry(url);
    } finally {
      this.#release();
    }
  }

  async #requestWithRetry(url: URL): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      await this.#waitForBackoff();
      let res: Response;
      try {
        res = await this.#fetch(url.toString(), {
          headers: {
            "Zotero-API-Version": "3",
            Authorization: `Bearer ${this.#apiKey}`,
            "User-Agent": "ReaderForZotero/0.1 (+https://github.com/kghising/reader-for-zotero)",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        if (attempt < 1) continue;
        throw new ZoteroApiError("Could not reach the Zotero API. Please try again shortly.", 502);
      }

      const backoff = parseSeconds(res.headers.get("Backoff"));
      if (backoff !== undefined) backoffUntil = Math.max(backoffUntil, this.#now() + backoff * 1000);

      if (res.ok) return res;

      if (res.status === 429 || res.status === 503) {
        const retryAfter = parseSeconds(res.headers.get("Retry-After"));
        const waitMs = retryAfter !== undefined ? retryAfter * 1000 : 1000 * 2 ** attempt;
        if (retryAfter !== undefined) backoffUntil = Math.max(backoffUntil, this.#now() + waitMs);
        if (attempt < MAX_RETRIES && waitMs <= MAX_INLINE_WAIT_MS) {
          await res.body?.cancel();
          await this.#sleep(waitMs);
          continue;
        }
        const secs = Math.ceil(waitMs / 1000);
        throw new ZoteroApiError(
          res.status === 429
            ? `Zotero is rate-limiting requests. Please wait about ${secs} seconds and try again.`
            : `Zotero is temporarily unavailable (maintenance or overload). Please try again in about ${secs} seconds.`,
          res.status,
          secs,
        );
      }

      if (res.status >= 500 && attempt < 1) {
        await res.body?.cancel();
        await this.#sleep(500);
        continue;
      }
      throw await toApiError(res);
    }
  }

  async #waitForBackoff(): Promise<void> {
    const wait = backoffUntil - this.#now();
    if (wait <= 0) return;
    if (wait <= MAX_INLINE_WAIT_MS) return this.#sleep(wait);
    const secs = Math.ceil(wait / 1000);
    throw new ZoteroApiError(
      `Zotero asked clients to pause (Backoff). Please try again in about ${secs} seconds.`,
      503,
      secs,
    );
  }

  #acquire(): Promise<void> {
    if (this.#active < MAX_CONCURRENCY) {
      this.#active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#queue.push(resolve));
  }

  #release(): void {
    const next = this.#queue.shift();
    if (next) next();
    else this.#active--;
  }
}

function parseSeconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value.trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

async function toApiError(res: Response): Promise<ZoteroApiError> {
  // Zotero's 4xx bodies are short plain-text explanations ("Invalid 'itemType' value"); keep them, bounded.
  const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 300);
  switch (res.status) {
    case 400:
      return new ZoteroApiError(`Zotero rejected the request: ${detail || "bad request"}`, 400);
    case 403:
      return new ZoteroApiError(
        "Zotero refused access. The library may not be shared with this connection (group libraries need group access " +
          "when connecting), or the key was revoked at zotero.org/settings/keys. Reconnecting the connector issues a new key.",
        403,
      );
    case 404:
      return new ZoteroApiError("Not found in this Zotero library. Check the key and the library argument.", 404);
    default:
      return new ZoteroApiError(`Zotero API error (HTTP ${res.status})${detail ? `: ${detail}` : ""}`, res.status);
  }
}
