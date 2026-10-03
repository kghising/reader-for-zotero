import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fbfaf7;--fg:#1d1d1b;--muted:#5f5e5a;--card:#fff;--line:#e3e1db;--accent:#a02c2c;--warn:#8a5a00}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe7;--muted:#a9a8a2;--card:#20201e;--line:#353531;--accent:#e07a6e;--warn:#e0b35a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:640px;margin:0 auto;padding:40px 16px}h1{font-size:1.6rem;margin:0 0 .5rem}h2{font-size:1.15rem;margin:1.8rem 0 .4rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin:1rem 0}
.muted{color:var(--muted)}.warn{color:var(--warn)}code{font-size:.92em}a{color:var(--accent)}
ul{padding-left:1.2rem}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:1.2rem}
button{font:inherit;padding:10px 18px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}footer{margin-top:2.5rem;font-size:.9rem}
`;

export function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}
<footer class="muted">Reader for Zotero is an independent project, not affiliated with or endorsed by Zotero or the Corporation for Digital Scholarship.
<a href="/privacy">Privacy</a></footer></main></body></html>`;
}

const SECURITY_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export function htmlResponse(html: string, status = 200, extra?: Headers): Response {
  const headers = new Headers(SECURITY_HEADERS);
  extra?.forEach((v, k) => headers.append(k, v));
  return new Response(html, { status, headers });
}

export function consentPage(c: ConsentDescription, handle: string, wantsRefresh: boolean): string {
  const who = c.clientDomain
    ? `<strong>${escapeHtml(c.clientName)}</strong> <span class="muted">(verified domain: ${escapeHtml(c.clientDomain)})</span>`
    : `<strong>${escapeHtml(c.clientName)}</strong> <span class="muted">(name provided by the app, not verified)</span>`;
  const loopback = c.redirectIsLoopback
    ? `<p class="warn">This app receives access on your own computer (<code>${escapeHtml(c.redirectHost)}</code>). Only continue if you just started this connection yourself, for example from Claude Code.</p>`
    : "";
  return layout(
    "Connect Zotero",
    `<h1>Connect your Zotero library</h1>
<div class="card">
<p>${who} wants read-only access to your Zotero library through Reader for Zotero.</p>
<p>Access will be sent to <strong>${escapeHtml(c.redirectHost)}</strong>.</p>
${loopback}
<p>It will be able to:</p>
<ul><li>search and list your items, collections and tags</li><li>read metadata, abstracts, notes and annotations</li>
<li>read the indexed full text of your attachments</li><li>read group libraries you allow on the next page</li></ul>
<p>It cannot change or delete anything. Next you'll sign in at <strong>zotero.org</strong> and approve a read-only API key.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">${wantsRefresh ? '<input type="hidden" name="offline" value="1">' : ""}
<div class="actions"><button class="primary" type="submit" name="action" value="approve">Continue to Zotero</button>
<button type="submit" name="action" value="deny">Cancel</button></div>
</form></div>`,
  );
}

export function errorPage(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><div class="card"><p>${escapeHtml(message)}</p></div>`);
}

export function landingPage(publicUrl: string, supportEmail: string): string {
  const mcpUrl = `${publicUrl}/mcp`;
  return layout(
    "Reader for Zotero",
    `<h1>Reader for Zotero</h1>
<p>A read-only connector that lets Claude search and read your own Zotero library: items, collections, notes, PDF annotations, indexed full text, and BibTeX/CSL JSON export.</p>
<div class="card"><h2>Add it to Claude</h2>
<p>In Claude, open <em>Settings → Connectors → Add custom connector</em> and enter:</p><p><code>${escapeHtml(mcpUrl)}</code></p>
<p>In Claude Code: <code>claude mcp add --transport http zotero ${escapeHtml(mcpUrl)}</code></p>
<p class="muted">You'll sign in with your own Zotero account. Revoke access any time at zotero.org → Settings → Security / API keys.</p></div>
<p>Support: <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a></p>`,
  );
}

/** Tiny Markdown renderer for our own PRIVACY.md (headings, paragraphs, lists, bold, links, code). */
export function renderMarkdown(md: string): string {
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+|\/[^)\s]*)\)/g, '<a href="$2">$1</a>');
  const out: string[] = [];
  let list: string[] | null = null;
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
    if (list) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join("")}</ul>`);
    list = null;
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = h[1]!.length;
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
    } else if (li) {
      if (para.length) flush();
      (list ??= []).push(li[1]!);
    } else if (line.trim() === "") {
      flush();
    } else if (list) {
      list[list.length - 1] += " " + line.trim();
    } else {
      para.push(line.trim());
    }
  }
  flush();
  return out.join("\n");
}
