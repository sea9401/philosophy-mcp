/**
 * Book & reference tools — public-domain classics plus modern research/translations.
 *
 * Self-contained (own HTTP / HTML helpers) so it composes onto the PhilPapers
 * server without touching its code. Registered via registerBookTools(server).
 *
 * Sources (all keyless):
 *   - Project Gutenberg  (Gutendex JSON, gutenberg.org OPDS fallback + direct text)
 *   - Internet Archive   (advancedsearch + OCR _djvu.txt)
 *   - Wikisource         (MediaWiki API, any language)
 *   - Open Library       (modern editions/translations metadata + read/borrow links)
 *   - DOAB               (open-access academic books)
 *   - Stanford Encyclopedia of Philosophy (static contents index + entry text)
 *   - fetch_text         (readable text from any URL — Zeno.org, marxists.org, ...)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

// ---------------------------------------------------------------------------
// HTTP + text helpers
// ---------------------------------------------------------------------------

// A browser-like UA maximises compatibility — several scholarly sites reject
// unfamiliar agents with 403.
const BOOK_UA = "Mozilla/5.0 (compatible; philosophy-mcp/0.3; +research/educational)";
const TIMEOUT_MS = 30_000;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

const atomXml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  trimValues: true,
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function asArr<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

interface FetchOpts {
  retries?: number;
  timeoutMs?: number;
}

interface FetchResult {
  contentType: string;
  body: string;
}

/**
 * GET with retry-and-backoff on transient errors (timeouts, 5xx, 429). The body
 * is read under the same abort timer as the request, so a server that sends
 * headers and then stalls the body cannot hang past timeoutMs.
 */
async function bookRequest(url: string, opts: FetchOpts = {}): Promise<FetchResult> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers: { "User-Agent": BOOK_UA, "Accept-Language": "en,de,ko" },
      });
      if (RETRY_STATUS.has(res.status) && i < retries) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(600 * (i + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
      const body = await res.text(); // read while the abort timer is still armed
      return { contentType: (res.headers.get("content-type") || "").toLowerCase(), body };
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        await sleep(600 * (i + 1));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function getText(url: string, opts: FetchOpts = {}): Promise<string> {
  return (await bookRequest(url, opts)).body;
}
async function getJson(url: string, opts: FetchOpts = {}): Promise<any> {
  return JSON.parse((await bookRequest(url, opts)).body);
}

// Gutendex (gutendex.com) is frequently overloaded; probe it fast and fall back
// to the reliable gutenberg.org host rather than hanging on its timeout.
const GUTENDEX_OPTS: FetchOpts = { retries: 0, timeoutMs: 8_000 };

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘",
    rdquo: "”", ldquo: "“",
  };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X"
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return named[ent.toLowerCase()] ?? m;
  });
}

/** Strip HTML to readable plain text (no DOM): drop scripts/chrome, block tags -> newlines. */
function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<\/?(p|div|section|article|li|tr|h[1-6]|blockquote|pre|ul|ol|table|br)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  const out: string[] = [];
  let blank = 0;
  for (const raw of s.split(/\n/)) {
    const line = raw.replace(/[ \t\f\v]+/g, " ").trim();
    if (line) {
      out.push(line);
      blank = 0;
    } else if (++blank <= 1) {
      out.push("");
    }
  }
  return out.join("\n").trim();
}

function clip(text: string, maxChars: number): string {
  const t = text.trim();
  const max = Math.max(500, Math.min(maxChars, 200_000));
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n\n[... truncated — ${t.length - max} more characters. Increase max_chars to read further.]`;
}

// ---------------------------------------------------------------------------
// Source-specific helpers
// ---------------------------------------------------------------------------

/** Fallback Gutenberg search via gutenberg.org's OPDS feed (when Gutendex is overloaded). */
async function gutenbergOpds(terms: string, limit: number): Promise<Array<{ id: number; title: string; author: string }>> {
  const body = await getText(`https://www.gutenberg.org/ebooks/search.opds/?query=${encodeURIComponent(terms)}`);
  const root: any = atomXml.parse(body);
  const items: Array<{ id: number; title: string; author: string }> = [];
  for (const entry of asArr<any>(root?.feed?.entry)) {
    const title = String(entry?.title ?? "").trim();
    const authorRaw = entry?.author?.name;
    const author = String(Array.isArray(authorRaw) ? authorRaw[0] : authorRaw ?? "").trim();
    let bid: number | null = null;
    for (const ln of asArr<any>(entry?.link)) {
      const m = String(ln?.["@_href"] ?? "").match(/\/(?:ebooks|epub|files|cache\/epub)\/(\d+)/);
      if (m) {
        bid = parseInt(m[1], 10);
        break;
      }
    }
    if (bid === null) {
      const m = String(entry?.id ?? "").match(/(\d+)/);
      bid = m ? parseInt(m[1], 10) : null;
    }
    if (bid === null) continue; // skip facet/navigation entries
    items.push({ id: bid, title, author });
    if (items.length >= limit) break;
  }
  return items;
}

/** Lazily-built, cached SEP entry index from the static contents page. */
let sepIndex: Array<[string, string]> | null = null;
async function getSepIndex(): Promise<Array<[string, string]>> {
  if (sepIndex === null) {
    const html = await getText("https://plato.stanford.edu/contents.html");
    const idx: Array<[string, string]> = [];
    const seen = new Set<string>();
    const re = /href="(?:https:\/\/plato\.stanford\.edu\/)?(entries\/[^"#]+\/?)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const title = htmlToText(m[2]).trim();
      const url = new URL(m[1], "https://plato.stanford.edu/contents.html").toString();
      if (!title || seen.has(url)) continue;
      seen.add(url);
      idx.push([title, url]);
    }
    sepIndex = idx;
  }
  return sepIndex;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerBookTools(server: McpServer): void {
  // --- Project Gutenberg ---------------------------------------------------
  server.registerTool(
    "search_gutenberg",
    {
      title: "Search Project Gutenberg (public-domain classics)",
      description:
        "Search Project Gutenberg for public-domain classics and out-of-copyright translations " +
        "(Kant, Hegel, Nietzsche, Schopenhauer, Marx, Fichte, ...). Returns title, author, " +
        "languages, a Gutenberg page link, and download URLs. Use the numeric id with get_gutenberg_text.",
      inputSchema: {
        query: z.string().default("").describe("Free-text search over title + author."),
        author: z.string().default("").describe("Author name to fold into the search."),
        topic: z.string().default("").describe("Subject/bookshelf filter, e.g. 'philosophy'."),
        languages: z.string().default("").describe("Comma-separated ISO codes, e.g. 'en,de'."),
        limit: z.number().int().min(1).max(32).default(10).describe("Max results (1–32)."),
      },
    },
    async ({ query, author, topic, languages, limit }) => {
      const terms = [query, author].filter(Boolean).join(" ").trim();
      // Primary: Gutendex (rich JSON + language/topic filters).
      try {
        const params = new URLSearchParams();
        if (terms) params.set("search", terms);
        if (topic) params.set("topic", topic);
        if (languages) params.set("languages", languages.replace(/\s/g, ""));
        const data = await getJson(`https://gutendex.com/books?${params.toString()}`, GUTENDEX_OPTS);
        const results: any[] = (data.results ?? []).slice(0, limit);
        if (results.length) {
          const lines = results.map((b) => {
            const fmts: Record<string, string> = b.formats ?? {};
            const epub = Object.entries(fmts).find(([k]) => k.includes("epub"))?.[1] ?? "";
            const txt = Object.entries(fmts).find(([k]) => k.startsWith("text/plain"))?.[1] ?? "";
            const authors = asArr<any>(b.authors).map((a) => a.name).join(", ") || "—";
            return [
              `• [${b.id}] ${b.title ?? "?"}`,
              `   author: ${authors} | lang: ${asArr<string>(b.languages).join(",")} | downloads: ${b.download_count ?? 0}`,
              `   gutenberg: https://www.gutenberg.org/ebooks/${b.id}`,
              epub ? `   epub: ${epub}` : "",
              txt ? `   text: ${txt}` : "",
            ].filter(Boolean).join("\n");
          });
          return ok([`Project Gutenberg — ${data.count ?? 0} total match(es), showing ${results.length}:`, "", ...lines].join("\n"));
        }
      } catch {
        // Gutendex is frequently overloaded — fall back to gutenberg.org OPDS.
      }
      const queryTerms = terms || topic;
      if (!queryTerms) return fail("Provide a query, author, or topic to search Project Gutenberg.");
      try {
        const items = await gutenbergOpds(queryTerms, limit);
        if (!items.length) return ok("No Project Gutenberg matches.");
        const lines = items.map((b) =>
          [
            `• [${b.id}] ${b.title || "?"}`,
            `   author: ${b.author || "—"}`,
            `   gutenberg: https://www.gutenberg.org/ebooks/${b.id}`,
          ].join("\n"),
        );
        return ok([`Project Gutenberg (via gutenberg.org) — showing ${items.length}:`, "", ...lines].join("\n"));
      } catch (e: any) {
        return fail(`Project Gutenberg unreachable (Gutendex down; gutenberg.org error: ${e?.message ?? e}).`);
      }
    },
  );

  server.registerTool(
    "get_gutenberg_text",
    {
      title: "Read a Project Gutenberg book",
      description:
        "Fetch the plain-text body of a Project Gutenberg book by numeric id (from search_gutenberg). " +
        "Truncated to max_chars.",
      inputSchema: {
        book_id: z.number().int().describe("Gutenberg book id."),
        max_chars: z.number().int().min(500).max(200_000).default(15_000).describe("Characters to return (default 15000)."),
      },
    },
    async ({ book_id, max_chars }) => {
      const bid = book_id;
      const candidates = [
        `https://www.gutenberg.org/cache/epub/${bid}/pg${bid}.txt`,
        `https://www.gutenberg.org/files/${bid}/${bid}-0.txt`,
        `https://www.gutenberg.org/ebooks/${bid}.txt.utf-8`,
      ];
      let body = "";
      for (const u of candidates) {
        try {
          const t = await getText(u, { retries: 1 });
          if (t && t.trim()) {
            body = t;
            break;
          }
        } catch {
          /* try next layout */
        }
      }
      let title = "";
      if (!body.trim()) {
        // last resort: Gutendex metadata -> its own text/plain link
        try {
          const meta = await getJson(`https://gutendex.com/books/${bid}`, GUTENDEX_OPTS);
          title = meta.title ?? "";
          const fmts: Record<string, string> = meta.formats ?? {};
          const url = Object.entries(fmts).find(([k, v]) => k.startsWith("text/plain") && !v.endsWith(".zip"))?.[1];
          if (url) body = await getText(url, { retries: 1 });
        } catch {
          /* ignore */
        }
      }
      if (!body.trim()) {
        return fail(
          `Could not download plain text for Gutenberg id ${bid}. ` +
            `Try the epub from search_gutenberg or https://www.gutenberg.org/ebooks/${bid}.`,
        );
      }
      if (!title) {
        const m = body.slice(0, 400).match(/Project Gutenberg eBook of (.+)/);
        title = m ? m[1].trim() : `Gutenberg ${bid}`;
      }
      return ok(`# ${title} (Gutenberg ${bid})\n\n` + clip(body, max_chars));
    },
  );

  // --- Internet Archive ----------------------------------------------------
  server.registerTool(
    "search_internet_archive",
    {
      title: "Search the Internet Archive",
      description:
        "Search the Internet Archive for scanned, out-of-print monographs, journals, and " +
        "translations. Use the returned identifier with get_archive_text.",
      inputSchema: {
        query: z.string().min(1).describe("Search terms."),
        limit: z.number().int().min(1).max(25).default(10).describe("Max results (1–25)."),
        mediatype: z.string().default("texts").describe("Usually 'texts'; pass '' for all media."),
      },
    },
    async ({ query, limit, mediatype }) => {
      try {
        const q = mediatype ? `(${query}) AND mediatype:${mediatype}` : `(${query})`;
        const params = new URLSearchParams({ q, rows: String(limit), output: "json" });
        for (const f of ["identifier", "title", "creator", "year", "mediatype"]) params.append("fl[]", f);
        const data = await getJson(`https://archive.org/advancedsearch.php?${params.toString()}`);
        const docs: any[] = data?.response?.docs ?? [];
        if (!docs.length) return ok("No Internet Archive matches.");
        const lines = docs.map((d) => {
          const creator = Array.isArray(d.creator) ? d.creator.join(", ") : d.creator ?? "—";
          return [
            `• [${d.identifier}] ${d.title ?? "?"}`,
            `   creator: ${creator || "—"} | year: ${d.year ?? "?"}`,
            `   details: https://archive.org/details/${d.identifier}`,
          ].join("\n");
        });
        return ok([`Internet Archive — showing ${docs.length}:`, "", ...lines].join("\n"));
      } catch (e: any) {
        return fail(`Internet Archive request failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "get_archive_text",
    {
      title: "Read Internet Archive OCR text",
      description:
        "Fetch the OCR full text of an Internet Archive item by identifier (from " +
        "search_internet_archive). Truncated to max_chars.",
      inputSchema: {
        identifier: z.string().min(1).describe("IA item identifier."),
        max_chars: z.number().int().min(500).max(200_000).default(15_000).describe("Characters to return."),
      },
    },
    async ({ identifier, max_chars }) => {
      const candidates = [`https://archive.org/download/${identifier}/${identifier}_djvu.txt`];
      try {
        const meta = await getJson(`https://archive.org/metadata/${identifier}`);
        for (const f of asArr<any>(meta.files)) {
          const name = String(f.name ?? "");
          const fmt = String(f.format ?? "").toLowerCase();
          if (name.endsWith("_djvu.txt") || (name.endsWith(".txt") && fmt.includes("text"))) {
            candidates.push(`https://archive.org/download/${identifier}/${encodeURIComponent(name)}`);
          }
        }
      } catch {
        /* ignore — fall back to the conventional name */
      }
      const seen = new Set<string>();
      for (const u of candidates) {
        if (seen.has(u)) continue;
        seen.add(u);
        try {
          const t = await getText(u, { retries: 1 });
          if (t && t.trim()) return ok(`# Internet Archive: ${identifier}\n\n` + clip(t, max_chars));
        } catch {
          /* try next candidate */
        }
      }
      return fail(
        `No OCR text file found for "${identifier}" (may be image-only or restricted). ` +
          `Browse it at https://archive.org/details/${identifier}`,
      );
    },
  );

  // --- Wikisource ----------------------------------------------------------
  server.registerTool(
    "search_wikisource",
    {
      title: "Search Wikisource",
      description:
        "Search Wikisource for primary texts and translations (en, de, ko, ...). " +
        "Use get_wikisource_text to read.",
      inputSchema: {
        query: z.string().min(1).describe("Search terms."),
        lang: z.string().default("en").describe("Wikisource language subdomain (en, de, ko...)."),
        limit: z.number().int().min(1).max(25).default(10).describe("Max results (1–25)."),
      },
    },
    async ({ query, lang, limit }) => {
      try {
        const params = new URLSearchParams({
          action: "query", list: "search", srsearch: query,
          srlimit: String(limit), format: "json", srprop: "snippet",
        });
        const data = await getJson(`https://${lang}.wikisource.org/w/api.php?${params.toString()}`);
        const hits: any[] = data?.query?.search ?? [];
        if (!hits.length) return ok(`No ${lang}.wikisource matches.`);
        const lines = hits.map((h) => {
          const title = String(h.title ?? "?");
          const snip = htmlToText(h.snippet ?? "").replace(/\n/g, " ");
          const link = `https://${lang}.wikisource.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
          return `• ${title}\n   ${snip}\n   ${link}`;
        });
        return ok([`Wikisource (${lang}) — showing ${hits.length}:`, "", ...lines].join("\n"));
      } catch (e: any) {
        return fail(`Wikisource request failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "get_wikisource_text",
    {
      title: "Read a Wikisource page",
      description: "Fetch the plain text of a Wikisource page by title (from search_wikisource). Truncated to max_chars.",
      inputSchema: {
        title: z.string().min(1).describe("Exact page title."),
        lang: z.string().default("en").describe("Wikisource language subdomain."),
        max_chars: z.number().int().min(500).max(200_000).default(15_000).describe("Characters to return."),
      },
    },
    async ({ title, lang, max_chars }) => {
      try {
        const params = new URLSearchParams({
          action: "query", prop: "extracts", explaintext: "1",
          titles: title, format: "json", redirects: "1",
        });
        const data = await getJson(`https://${lang}.wikisource.org/w/api.php?${params.toString()}`);
        const pages: Record<string, any> = data?.query?.pages ?? {};
        for (const page of Object.values(pages)) {
          const extract = String(page?.extract ?? "");
          if (extract.trim()) return ok(`# ${page?.title ?? title} (Wikisource ${lang})\n\n` + clip(extract, max_chars));
        }
        return fail(`No extractable text for "${title}" on ${lang}.wikisource. Verify the title via search_wikisource.`);
      } catch (e: any) {
        return fail(`Wikisource request failed: ${e?.message ?? e}`);
      }
    },
  );

  // --- Open Library --------------------------------------------------------
  server.registerTool(
    "search_openlibrary",
    {
      title: "Search Open Library",
      description:
        "Search Open Library for books — strong for modern editions and translations as metadata, " +
        "with read/borrow links wherever a scan exists.",
      inputSchema: {
        query: z.string().min(1).describe("Title or keywords, e.g. 'Being and Time Heidegger'."),
        author: z.string().default("").describe("Optional author filter."),
        limit: z.number().int().min(1).max(25).default(10).describe("Max results (1–25)."),
      },
    },
    async ({ query, author, limit }) => {
      try {
        const params = new URLSearchParams({
          q: query, limit: String(limit),
          fields: "title,author_name,first_publish_year,key,ia,ebook_access,edition_count",
        });
        if (author) params.set("author", author);
        const data = await getJson(`https://openlibrary.org/search.json?${params.toString()}`);
        const docs: any[] = (data.docs ?? []).slice(0, limit);
        if (!docs.length) return ok("No Open Library matches.");
        const lines = docs.map((d) => {
          const authors = asArr<string>(d.author_name).join(", ") || "—";
          const ia = asArr<string>(d.ia);
          const read = ia.length ? `https://archive.org/details/${ia[0]}` : "";
          return [
            `• ${d.title ?? "?"} (${d.first_publish_year ?? "?"})`,
            `   author: ${authors} | editions: ${d.edition_count ?? "?"} | ebook: ${d.ebook_access ?? "no ebook"}`,
            `   openlibrary: https://openlibrary.org${d.key ?? ""}`,
            read ? `   read/borrow: ${read}` : "",
          ].filter(Boolean).join("\n");
        });
        return ok([`Open Library — ${data.numFound ?? 0} total, showing ${docs.length}:`, "", ...lines].join("\n"));
      } catch (e: any) {
        return fail(`Open Library request failed: ${e?.message ?? e}`);
      }
    },
  );

  // --- DOAB ----------------------------------------------------------------
  server.registerTool(
    "search_doab",
    {
      title: "Search DOAB (open-access books)",
      description:
        "Search the Directory of Open Access Books — peer-reviewed, fully open-access academic " +
        "books, including many modern philosophy monographs readable in full.",
      inputSchema: {
        query: z.string().min(1).describe("Search terms (title/author/keyword)."),
        limit: z.number().int().min(1).max(25).default(10).describe("Max results (1–25)."),
      },
    },
    async ({ query, limit }) => {
      const manual = `https://directory.doabooks.org/discover?query=${encodeURIComponent(query)}`;
      try {
        const params = new URLSearchParams({ query, expand: "metadata", limit: String(limit) });
        const data = await getJson(`https://directory.doabooks.org/rest/search?${params.toString()}`);
        if (!Array.isArray(data) || !data.length) return ok(`No DOAB matches. Browse: ${manual}`);
        const lines = data.slice(0, limit).map((item: any) => {
          const mds = asArr<any>(item.metadata).filter((m) => m && typeof m === "object");
          const vals = (...keys: string[]) =>
            mds.filter((m) => keys.includes(m.key) && m.value).map((m) => String(m.value));
          const title = vals("dc.title")[0] ?? item.name ?? "?";
          let people = vals("dc.contributor.author", "dc.creator");
          let role = "author";
          if (!people.length) {
            people = vals("dc.contributor.editor");
            role = "editor";
          }
          const who = [...new Set(people)].join(", ") || "—";
          const handle = item.handle ?? "";
          const link = handle
            ? `https://directory.doabooks.org/handle/${handle}`
            : vals("dc.identifier.uri")[0] ?? "";
          return [`• ${title}`, `   ${role}: ${who}`, link ? `   ${link}` : ""].filter(Boolean).join("\n");
        });
        return ok([`DOAB (open-access books) — showing ${Math.min(data.length, limit)}:`, "", ...lines].join("\n"));
      } catch (e: any) {
        return fail(`DOAB request failed: ${e?.message ?? e}\nSearch manually: ${manual}`);
      }
    },
  );

  // --- Stanford Encyclopedia of Philosophy ---------------------------------
  server.registerTool(
    "search_sep",
    {
      title: "Search the Stanford Encyclopedia of Philosophy",
      description:
        "Search SEP (the standard scholarly reference) by matching its full entry index. " +
        "Read an entry with get_sep_entry.",
      inputSchema: {
        query: z.string().min(1).describe("Topic or philosopher, e.g. 'Hegel', 'phenomenology'."),
        limit: z.number().int().min(1).max(20).default(10).describe("Max results (1–20)."),
      },
    },
    async ({ query, limit }) => {
      try {
        const idx = await getSepIndex();
        const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
        if (!words.length) return fail("Provide a search term.");
        let matches = idx.filter(([t]) => words.every((w) => t.toLowerCase().includes(w)));
        if (!matches.length) matches = idx.filter(([t]) => words.some((w) => t.toLowerCase().includes(w)));
        if (!matches.length) return ok(`No SEP entries matched "${query}". Browse https://plato.stanford.edu/contents.html`);
        matches = matches.slice(0, limit);
        const lines = matches.map(([t, u]) => {
          const slug = u.replace(/\/$/, "").split("/").pop();
          return `• ${t}  (slug: ${slug})\n   ${u}`;
        });
        return ok([`Stanford Encyclopedia of Philosophy — ${matches.length} entr(ies) for "${query}":`, "", ...lines].join("\n"));
      } catch (e: any) {
        return fail(`SEP index fetch failed: ${e?.message ?? e}\nBrowse https://plato.stanford.edu/contents.html`);
      }
    },
  );

  server.registerTool(
    "get_sep_entry",
    {
      title: "Read a Stanford Encyclopedia entry",
      description:
        "Fetch the text of a SEP entry. Accepts a slug (e.g. 'hegel'), a /entries/.. path, or a " +
        "full URL. Truncated to max_chars.",
      inputSchema: {
        entry: z.string().min(1).describe("Entry slug, /entries/.. path, or full URL."),
        max_chars: z.number().int().min(500).max(200_000).default(18_000).describe("Characters to return."),
      },
    },
    async ({ entry, max_chars }) => {
      let url = "";
      try {
        if (entry.startsWith("http")) url = entry;
        else if (entry.startsWith("/")) url = new URL(entry, "https://plato.stanford.edu").toString();
        else url = `https://plato.stanford.edu/entries/${entry.replace(/^\/|\/$/g, "")}/`;
        const html = await getText(url);
        return ok(`# SEP entry: ${url}\n\n` + clip(htmlToText(html), max_chars));
      } catch (e: any) {
        return fail(`Could not fetch SEP entry at ${url || entry}: ${e?.message ?? e}`);
      }
    },
  );

  // --- Catch-all -----------------------------------------------------------
  server.registerTool(
    "fetch_text",
    {
      title: "Fetch readable text from any URL",
      description:
        "Fetch any URL and return its readable text — the catch-all for sources without a " +
        "dedicated tool: Zeno.org and projekt-gutenberg.org (German originals), marxists.org " +
        "(German Idealism to Frankfurt School translations), Standard Ebooks, a specific page, etc.",
      inputSchema: {
        url: z.string().url().describe("The page or text-file URL."),
        max_chars: z.number().int().min(500).max(200_000).default(15_000).describe("Characters to return."),
      },
    },
    async ({ url, max_chars }) => {
      try {
        const { contentType, body } = await bookRequest(url);
        const text =
          contentType.includes("html") || body.trimStart().startsWith("<") ? htmlToText(body) : body;
        if (!text.trim()) return ok(`Fetched ${url} but found no readable text (binary or JS-only page?).`);
        return ok(`# ${url}\n\n` + clip(text, max_chars));
      } catch (e: any) {
        return fail(`Fetch failed for ${url}: ${e?.message ?? e}`);
      }
    },
  );
}
