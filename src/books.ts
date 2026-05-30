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
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { LruCache, renderWindow } from "./textwindow.js";

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

// ---------------------------------------------------------------------------
// SSRF guard — used by the arbitrary-URL fetch_text tool
// ---------------------------------------------------------------------------

/** Block an IPv4 literal that is loopback, private, link-local (incl. the
 *  169.254.169.254 cloud-metadata endpoint), CGNAT, or otherwise non-public. */
function isBlockedIp4(ip: string): boolean {
  const p = ip.split(".").map((n) => Number(n));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved
  return false;
}

/** Block an IPv6 literal that is loopback, ULA, link-local, or an embedded
 *  IPv4-mapped private address. */
function isBlockedIp6(ip: string): boolean {
  let s = ip.toLowerCase();
  const pct = s.indexOf("%"); // strip zone id, e.g. fe80::1%eth0
  if (pct !== -1) s = s.slice(0, pct);
  if (s === "::1" || s === "::") return true; // loopback / unspecified
  const mapped = s.match(/(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/); // ::ffff:1.2.3.4
  if (mapped) return isBlockedIp4(mapped[1]);
  const head = s.split(":")[0] ?? "";
  if (/^fe[89ab]/.test(head)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(head)) return true; // fc00::/7 unique-local
  return false;
}

function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedIp4(ip);
  if (v === 6) return isBlockedIp6(ip);
  return true; // not a parseable IP → block
}

/**
 * Reject anything that isn't a plain http(s) request to a public host, to reduce
 * SSRF risk in fetch_text (which takes an arbitrary client URL). Blocks non-http
 * schemes, localhost, and hosts that resolve to private/loopback/link-local/
 * metadata addresses. A DNS lookup could still rebind between this check and the
 * actual connection (a small TOCTOU window), but this closes the common direct
 * vectors, and bookRequest re-runs the guard on every redirect hop.
 */
async function assertPublicUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Only http(s) URLs are allowed (got "${u.protocol}").`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new Error(`URL has no host: ${raw}`);
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error(`Refusing to fetch localhost.`);
  }
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`Refusing to fetch private/loopback address ${host}.`);
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error(`Could not resolve host "${host}".`);
  }
  for (const { address } of addrs) {
    if (isBlockedIp(address)) {
      throw new Error(`Refusing to fetch "${host}" — it resolves to non-public address ${address}.`);
    }
  }
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
  /**
   * Optional per-URL guard (e.g. an SSRF check). When set, redirects are followed
   * manually so the guard runs on every hop instead of trusting the platform to
   * follow a redirect into a private address.
   */
  guard?: (url: string) => Promise<void>;
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
  const guard = opts.guard;
  const MAX_HOPS = 5;
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // When guarded, follow redirects by hand so the guard runs on every hop.
      let current = url;
      let res: Response;
      for (let hop = 0; ; hop++) {
        if (guard) await guard(current);
        res = await fetch(current, {
          signal: ctrl.signal,
          redirect: guard ? "manual" : "follow",
          headers: { "User-Agent": BOOK_UA, "Accept-Language": "en,de,ko" },
        });
        const location = res.headers.get("location");
        if (guard && res.status >= 300 && res.status < 400 && location) {
          if (hop >= MAX_HOPS) throw new Error(`Too many redirects from ${url}`);
          current = new URL(location, current).toString();
          continue;
        }
        break;
      }
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

/**
 * Cache of fully-fetched/extracted bodies, keyed by source (e.g. "gut:1234",
 * "ia:<id>", a URL). Lets a tool page through a long book with offset= without
 * re-downloading it each call — the body is fetched once, then sliced.
 */
const bodyCache = new LruCache<string>(8);

/** Shared `offset` input field for the read tools — keeps paging consistent. */
const offsetField = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe(
    "Character offset to start from (default 0). For long texts, read a window then call " +
      "again with the offset reported in the footer to continue — avoids re-sending earlier text.",
  );

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
        "Returns one window of max_chars from offset; whole books are long, so read a window and " +
        "page on with the offset in the footer. The downloaded body is cached, so paging is cheap.",
      inputSchema: {
        book_id: z.number().int().describe("Gutenberg book id."),
        max_chars: z.number().int().min(500).max(200_000).default(15_000).describe("Characters to return (default 15000)."),
        offset: offsetField,
      },
    },
    async ({ book_id, max_chars, offset }) => {
      const bid = book_id;
      const key = `gut:${bid}`;
      let body = bodyCache.get(key) ?? "";
      if (!body) {
        const candidates = [
          `https://www.gutenberg.org/cache/epub/${bid}/pg${bid}.txt`,
          `https://www.gutenberg.org/files/${bid}/${bid}-0.txt`,
          `https://www.gutenberg.org/ebooks/${bid}.txt.utf-8`,
        ];
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
        if (!body.trim()) {
          // last resort: Gutendex metadata -> its own text/plain link
          try {
            const meta = await getJson(`https://gutendex.com/books/${bid}`, GUTENDEX_OPTS);
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
        bodyCache.set(key, body);
      }
      const m = body.slice(0, 400).match(/Project Gutenberg eBook of (.+)/);
      const title = m ? m[1].trim() : `Gutenberg ${bid}`;
      return ok(renderWindow(`# ${title} (Gutenberg ${bid})`, body, max_chars, offset));
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
        "search_internet_archive). Returns one window of max_chars from offset; scans are long, so " +
        "read a window and page on with the offset in the footer. The text is cached after first fetch.",
      inputSchema: {
        identifier: z.string().min(1).describe("IA item identifier."),
        max_chars: z.number().int().min(500).max(200_000).default(15_000).describe("Characters to return."),
        offset: offsetField,
      },
    },
    async ({ identifier, max_chars, offset }) => {
      const key = `ia:${identifier}`;
      let body = bodyCache.get(key) ?? "";
      if (!body) {
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
            if (t && t.trim()) {
              body = t;
              break;
            }
          } catch {
            /* try next candidate */
          }
        }
        if (!body.trim()) {
          return fail(
            `No OCR text file found for "${identifier}" (may be image-only or restricted). ` +
              `Browse it at https://archive.org/details/${identifier}`,
          );
        }
        bodyCache.set(key, body);
      }
      return ok(renderWindow(`# Internet Archive: ${identifier}`, body, max_chars, offset));
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
      description:
        "Fetch the plain text of a Wikisource page by title (from search_wikisource). Returns one " +
        "window of max_chars from offset; page on with the offset in the footer. Cached after first fetch.",
      inputSchema: {
        title: z.string().min(1).describe("Exact page title."),
        lang: z.string().default("en").describe("Wikisource language subdomain."),
        max_chars: z.number().int().min(500).max(200_000).default(15_000).describe("Characters to return."),
        offset: offsetField,
      },
    },
    async ({ title, lang, max_chars, offset }) => {
      const key = `ws:${lang}:${title}`;
      try {
        let cached = bodyCache.get(key);
        let pageTitle = title;
        if (cached === undefined) {
          const params = new URLSearchParams({
            action: "query", prop: "extracts", explaintext: "1",
            titles: title, format: "json", redirects: "1",
          });
          const data = await getJson(`https://${lang}.wikisource.org/w/api.php?${params.toString()}`);
          const pages: Record<string, any> = data?.query?.pages ?? {};
          for (const page of Object.values(pages)) {
            const extract = String(page?.extract ?? "");
            if (extract.trim()) {
              cached = extract;
              pageTitle = String(page?.title ?? title);
              bodyCache.set(key, extract);
              break;
            }
          }
          if (cached === undefined) {
            return fail(`No extractable text for "${title}" on ${lang}.wikisource. Verify the title via search_wikisource.`);
          }
        }
        return ok(renderWindow(`# ${pageTitle} (Wikisource ${lang})`, cached, max_chars, offset));
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
        "full URL. Returns one window of max_chars from offset; SEP entries are long, so read a " +
        "window and page on with the offset in the footer. Cached after first fetch.",
      inputSchema: {
        entry: z.string().min(1).describe("Entry slug, /entries/.. path, or full URL."),
        max_chars: z.number().int().min(500).max(200_000).default(15_000).describe("Characters to return."),
        offset: offsetField,
      },
    },
    async ({ entry, max_chars, offset }) => {
      let url = "";
      try {
        if (entry.startsWith("http")) {
          // A full URL must point at SEP itself — don't let this tool fetch
          // arbitrary hosts.
          const u = new URL(entry);
          if (u.protocol !== "https:" || u.hostname !== "plato.stanford.edu") {
            return fail(`get_sep_entry only accepts https://plato.stanford.edu/... URLs (got "${entry}").`);
          }
          url = u.toString();
        } else if (entry.startsWith("/")) {
          url = new URL(entry, "https://plato.stanford.edu").toString();
        } else {
          url = `https://plato.stanford.edu/entries/${entry.replace(/^\/|\/$/g, "")}/`;
        }
        const key = `sep:${url}`;
        let text = bodyCache.get(key);
        if (text === undefined) {
          text = htmlToText(await getText(url));
          bodyCache.set(key, text);
        }
        return ok(renderWindow(`# SEP entry: ${url}`, text, max_chars, offset));
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
        "(German Idealism to Frankfurt School translations), Standard Ebooks, a specific page, etc. " +
        "Returns one window of max_chars from offset; page on with the offset in the footer. Cached per URL.",
      inputSchema: {
        url: z.string().url().describe("The page or text-file URL."),
        max_chars: z.number().int().min(500).max(200_000).default(15_000).describe("Characters to return."),
        offset: offsetField,
      },
    },
    async ({ url, max_chars, offset }) => {
      try {
        const key = `url:${url}`;
        let text = bodyCache.get(key);
        if (text === undefined) {
          const { contentType, body } = await bookRequest(url, { guard: assertPublicUrl });
          text =
            contentType.includes("html") || body.trimStart().startsWith("<") ? htmlToText(body) : body;
          if (!text.trim()) return ok(`Fetched ${url} but found no readable text (binary or JS-only page?).`);
          bodyCache.set(key, text);
        }
        return ok(renderWindow(`# ${url}`, text, max_chars, offset));
      } catch (e: any) {
        return fail(`Fetch failed for ${url}: ${e?.message ?? e}`);
      }
    },
  );
}
