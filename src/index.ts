#!/usr/bin/env node
/**
 * Philosophy MCP server.
 *
 * PhilPapers / PhilArchive scholarship (all keyless):
 *   - Keyword search  -> OpenAlex, filtered to the PhilPapers/PhilArchive source.
 *   - Record metadata -> PhilArchive OAI-PMH (GetRecord).
 *   - Recent papers   -> PhilArchive OAI-PMH (ListRecords, by date).
 *   - Full text        -> https://philpapers.org/archive/<ID>.pdf (downloaded + text-extracted)
 *
 * PhilArchive is the open-access archive built on the PhilPapers database, so a
 * PhilPapers record id (e.g. "BROTNO-9") resolves on both hosts.
 *
 * Book & reference tools (Gutenberg, Internet Archive, Wikisource, Open Library,
 * DOAB, Stanford Encyclopedia, and a generic fetch_text) live in ./books.ts and
 * are attached below via registerBookTools().
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { XMLParser } from "fast-xml-parser";
import { extractText, getDocumentProxy } from "unpdf";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerBookTools } from "./books.js";
import { registerLocalTools } from "./local.js";
import { LruCache, windowText, windowNote, pastEndNote } from "./textwindow.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** OpenAlex source ids for the PhilPapers Foundation repository (covers PhilArchive). */
const OPENALEX_SOURCES = ["S4306402130", "S4306402131"];
const OPENALEX_WORKS = "https://api.openalex.org/works";
const OAI_BASE = "https://philarchive.org/oai.pl";
const PDF_BASE = "https://philpapers.org/archive";

/** OpenAlex "polite pool" contact. Set OPENALEX_MAILTO to your own email. */
const MAILTO = process.env.OPENALEX_MAILTO || "mcp@example.com";
/** Where fetch_pdf saves files when no dest_dir is given. */
const DOWNLOAD_DIR = process.env.PHILPAPERS_DOWNLOAD_DIR || join(tmpdir(), "philpapers-mcp");
const USER_AGENT = `philpapers-mcp/0.2 (+${MAILTO})`;
const HTTP_TIMEOUT_MS = 30_000;

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  trimValues: true,
});

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * GET `url` and consume its body within a single abort timer. The `read`
 * callback reads the Response (json/text/arrayBuffer) while the timer is still
 * armed, so a server that sends headers and then stalls the body can't hang past
 * HTTP_TIMEOUT_MS — the old version cleared the timer as soon as headers arrived.
 */
async function httpRequest<T>(
  url: string,
  read: (res: Response) => Promise<T>,
  init: RequestInit = {},
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { "User-Agent": USER_AGENT, ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
    return await read(res); // body read happens inside the timeout window
  } finally {
    clearTimeout(timer);
  }
}

/** Accept "BROTNO-9", a /rec/ URL, an oai: identifier, or "<ID>.pdf" and return the bare id. */
function normalizeRecId(input: string): string {
  let s = input.trim();
  const m = s.match(/rec\/([^/?#\s]+)/i);
  if (m) s = m[1];
  s = s.replace(/^oai:philarchive\.org\/rec\//i, "");
  s = s.replace(/\.pdf$/i, "");
  return s;
}

/**
 * PhilArchive record ids are short alphanumeric-plus-hyphen codes (e.g.
 * "BROTNO-9"). Validate a client-supplied id against an allowlist before using
 * it in a filesystem path or an upstream URL, so it can't carry "../" path
 * traversal or other surprises into fetch_pdf / downloadPdf.
 */
const REC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
function assertSafeRecId(recId: string): string {
  if (!REC_ID_RE.test(recId)) {
    throw new Error(
      `Invalid PhilArchive record id "${recId}" — expected letters, digits, and ` +
        `hyphens only (e.g. "BROTNO-9").`,
    );
  }
  return recId;
}

/** OpenAlex stores abstracts as an inverted index; rebuild the running text. */
function reconstructAbstract(inv?: Record<string, number[]>): string {
  if (!inv) return "";
  const slots: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const p of positions) slots.push([p, word]);
  }
  slots.sort((a, b) => a[0] - b[0]);
  return slots.map(([, w]) => w).join(" ");
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n).trimEnd() + "…" : t;
}

/** Pull the PhilArchive id / links out of an OpenAlex work's locations. */
function philLinks(work: any): { recId?: string; landing?: string; pdfUrl?: string } {
  let recId: string | undefined;
  let landing: string | undefined;
  let pdfUrl: string | undefined;
  for (const loc of asArray<any>(work.locations)) {
    const lp: string = loc?.landing_page_url ?? "";
    const pu: string = loc?.pdf_url ?? "";
    const m = lp.match(/phil(?:archive|papers)\.org\/rec\/([^/?#]+)/i);
    if (m && !recId) recId = m[1];
    if (/philarchive\.org\/rec\//i.test(lp) && !landing) landing = lp;
    if (/philpapers\.org\/archive\//i.test(pu) && !pdfUrl) pdfUrl = pu;
  }
  if (recId && !landing) landing = `https://philarchive.org/rec/${recId}`;
  return { recId, landing, pdfUrl };
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

// ---------------------------------------------------------------------------
// OpenAlex search
// ---------------------------------------------------------------------------

interface Hit {
  id?: string;
  title: string;
  year?: number;
  authors: string[];
  doi?: string;
  philarchive?: string;
  pdf?: string;
  abstract: string;
}

async function openAlexSearch(
  query: string,
  opts: { limit: number; yearFrom?: number; yearTo?: number; openAccessOnly?: boolean },
): Promise<{ total: number; hits: Hit[] }> {
  const filters = [`locations.source.id:${OPENALEX_SOURCES.join("|")}`];
  if (opts.yearFrom) filters.push(`from_publication_date:${opts.yearFrom}-01-01`);
  if (opts.yearTo) filters.push(`to_publication_date:${opts.yearTo}-12-31`);
  if (opts.openAccessOnly) filters.push("open_access.is_oa:true");

  // Over-fetch a little when filtering to PDFs so we can still fill `limit`.
  const perPage = Math.min(50, opts.openAccessOnly ? opts.limit * 3 : opts.limit);
  const url = new URL(OPENALEX_WORKS);
  url.searchParams.set("search", query);
  url.searchParams.set("filter", filters.join(","));
  url.searchParams.set("per-page", String(perPage));
  url.searchParams.set(
    "select",
    "id,title,publication_year,authorships,doi,locations,abstract_inverted_index",
  );
  url.searchParams.set("mailto", MAILTO);

  const data: any = await httpRequest(url.toString(), (r) => r.json());
  const total: number = data?.meta?.count ?? 0;

  let hits: Hit[] = asArray<any>(data.results).map((w) => {
    const links = philLinks(w);
    return {
      id: links.recId,
      title: w.title ?? "(untitled)",
      year: w.publication_year,
      authors: asArray<any>(w.authorships)
        .map((a) => a?.author?.display_name)
        .filter(Boolean),
      doi: w.doi as string | undefined,
      philarchive: links.landing,
      pdf: links.pdfUrl,
      abstract: reconstructAbstract(w.abstract_inverted_index),
    };
  });

  if (opts.openAccessOnly) hits = hits.filter((h) => h.pdf);
  hits = hits.slice(0, opts.limit);
  return { total, hits };
}

// ---------------------------------------------------------------------------
// OAI-PMH helpers
// ---------------------------------------------------------------------------

async function oaiRequest(params: Record<string, string>): Promise<any> {
  const url = new URL(OAI_BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const body = await httpRequest(url.toString(), (r) => r.text());
  const root = xml.parse(body);
  const oai = root["OAI-PMH"];
  if (!oai) throw new Error("Malformed OAI-PMH response (no OAI-PMH root).");
  if (oai.error) {
    const err = oai.error;
    const code = (Array.isArray(err) ? err[0] : err)?.["@_code"] ?? "unknown";
    const msg =
      typeof err === "string" ? err : (Array.isArray(err) ? err[0] : err)?.["#text"] ?? "";
    throw new Error(`OAI-PMH error [${code}] ${msg}`.trim());
  }
  return oai;
}

interface PaperMeta {
  id?: string;
  title: string;
  authors: string[];
  date: string;
  subjects: string[];
  language: string;
  abstract: string;
  url?: string;
}

function parseOaiRecord(record: any): PaperMeta & { deleted: boolean } {
  const deleted = record?.header?.["@_status"] === "deleted";
  const dc = record?.metadata?.dc ?? {};
  const identifiers = asArray(dc.identifier).map(String);
  const landing =
    identifiers.find((s) => /philarchive\.org\/rec\//i.test(s)) ?? identifiers[0];
  return {
    deleted,
    id: landing ? normalizeRecId(landing) : undefined,
    title: asArray(dc.title).map(String).join(" ").trim(),
    authors: asArray(dc.creator).map(String),
    date: asArray(dc.date).map(String).join(", "),
    subjects: asArray(dc.subject).map(String),
    language: asArray(dc.language).map(String).join(", "),
    abstract: asArray(dc.description).map(String).join("\n\n").trim(),
    url: landing,
  };
}

/** GetRecord by record id; returns null on any error or if not found. */
async function fetchOaiMeta(recId: string): Promise<(PaperMeta & { deleted: boolean }) | null> {
  try {
    const oai = await oaiRequest({
      verb: "GetRecord",
      metadataPrefix: "oai_dc",
      identifier: `oai:philarchive.org/rec/${recId}`,
    });
    const record = oai?.GetRecord?.record;
    return record ? parseOaiRecord(record) : null;
  } catch {
    return null;
  }
}

async function headPdfExists(recId: string): Promise<boolean> {
  const url = `${PDF_BASE}/${recId}.pdf`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const res = await fetch(url, {
        method: "HEAD",
        signal: ctrl.signal,
        headers: { "User-Agent": USER_AGENT },
      });
      return res.ok && (res.headers.get("content-type") || "").includes("pdf");
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** Download a record's open-access PDF; throws clearly when there isn't one. */
async function downloadPdf(recId: string): Promise<Buffer> {
  const pdfUrl = `${PDF_BASE}/${recId}.pdf`;
  return httpRequest(pdfUrl, async (res) => {
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("pdf")) {
      throw new Error(
        `No open-access PDF for "${recId}" (server returned content-type "${ct}"). ` +
          `The paper may not be open access on PhilArchive.`,
      );
    }
    return Buffer.from(await res.arrayBuffer());
  });
}

// ---------------------------------------------------------------------------
// Server + tools
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "philosophy", version: "0.4.0" });

server.registerTool(
  "search_papers",
  {
    title: "Search philosophy papers",
    description:
      "Keyword search across PhilPapers / PhilArchive (philosophy preprints and published " +
      "papers indexed by the PhilPapers Foundation), powered by OpenAlex full-text search. " +
      "Returns title, authors, year, a short abstract, the PhilArchive record id + URL, and an " +
      "open-access PDF URL when one exists. Use the returned `id` with get_paper, research, or " +
      "fetch_pdf. For a richer one-shot digest with full abstracts, use `research` instead.",
    inputSchema: {
      query: z.string().min(1).describe("Search terms, e.g. 'phenomenal consciousness higher-order'."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Max results to return (1–50, default 10)."),
      year_from: z.number().int().optional().describe("Only papers published in or after this year."),
      year_to: z.number().int().optional().describe("Only papers published in or before this year."),
      open_access_only: z
        .boolean()
        .default(false)
        .describe("Only return papers that have a downloadable open-access PDF on PhilArchive."),
    },
  },
  async ({ query, limit, year_from, year_to, open_access_only }) => {
    try {
      const { total, hits } = await openAlexSearch(query, {
        limit,
        yearFrom: year_from,
        yearTo: year_to,
        openAccessOnly: open_access_only,
      });
      if (hits.length === 0) return ok(`No PhilPapers/PhilArchive results for "${query}".`);

      const lines = hits.map((it, i) => {
        const authors = it.authors.length
          ? it.authors.slice(0, 6).join(", ") + (it.authors.length > 6 ? ", et al." : "")
          : "(authors unknown)";
        const parts = [
          `${i + 1}. ${it.title}${it.year ? ` (${it.year})` : ""}`,
          `   id: ${it.id ?? "—"}`,
          `   authors: ${authors}`,
          `   philarchive: ${it.philarchive ?? "—"}`,
          `   pdf: ${it.pdf ?? "— (not open access)"}`,
        ];
        if (it.doi) parts.push(`   doi: ${it.doi}`);
        if (it.abstract) parts.push(`   abstract: ${truncate(it.abstract, 400)}`);
        return parts.join("\n");
      });

      const header =
        `Found ${total.toLocaleString()} match(es) in PhilPapers/PhilArchive; ` +
        `showing ${hits.length}${open_access_only ? " (open-access only)" : ""}.`;
      return ok([header, "", ...lines].join("\n"));
    } catch (e: any) {
      return fail(`search_papers failed: ${e?.message ?? e}`);
    }
  },
);

server.registerTool(
  "research",
  {
    title: "Research a topic (search + full abstracts)",
    description:
      "One-shot literature scan: runs a keyword search across PhilPapers/PhilArchive and, for " +
      "each hit, fetches the archive's canonical metadata (verbatim full abstract, subjects, " +
      "language) via OAI-PMH — so you get a ready-to-read digest in a single call instead of " +
      "search_papers + get_paper per result. Returns fewer results than search_papers by default " +
      "because it does more work per item.",
    inputSchema: {
      query: z.string().min(1).describe("Topic or search terms to research."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe("How many papers to include with full abstracts (1–20, default 5)."),
      year_from: z.number().int().optional().describe("Only papers published in or after this year."),
      year_to: z.number().int().optional().describe("Only papers published in or before this year."),
      open_access_only: z
        .boolean()
        .default(false)
        .describe("Only include papers with a downloadable open-access PDF."),
    },
  },
  async ({ query, limit, year_from, year_to, open_access_only }) => {
    try {
      const { total, hits } = await openAlexSearch(query, {
        limit,
        yearFrom: year_from,
        yearTo: year_to,
        openAccessOnly: open_access_only,
      });
      if (hits.length === 0) return ok(`No PhilPapers/PhilArchive results for "${query}".`);

      // Enrich every hit with canonical OAI metadata in parallel.
      const enriched = await Promise.all(
        hits.map(async (h) => {
          const meta = h.id ? await fetchOaiMeta(h.id) : null;
          const usable = meta && !meta.deleted ? meta : null;
          const oaiAbstract = usable?.abstract ?? "";
          return {
            ...h,
            // Prefer the archive's verbatim abstract when it's at least as complete.
            abstract: oaiAbstract.length >= h.abstract.length ? oaiAbstract : h.abstract,
            subjects: usable?.subjects ?? [],
          };
        }),
      );

      const blocks = enriched.map((it, i) => {
        const authors = it.authors.length ? it.authors.join(", ") : "(authors unknown)";
        return [
          `### ${i + 1}. ${it.title}${it.year ? ` (${it.year})` : ""}`,
          `- id: ${it.id ?? "—"}`,
          `- authors: ${authors}`,
          it.subjects.length ? `- subjects: ${it.subjects.join(", ")}` : "",
          `- philarchive: ${it.philarchive ?? "—"}`,
          `- pdf: ${it.pdf ?? "— (not open access)"}`,
          it.doi ? `- doi: ${it.doi}` : "",
          "",
          it.abstract || "(no abstract available)",
        ]
          .filter(Boolean)
          .join("\n");
      });

      const header =
        `# Research: "${query}"\n${total.toLocaleString()} total match(es) in ` +
        `PhilPapers/PhilArchive; showing ${enriched.length}` +
        `${open_access_only ? " (open-access only)" : ""} with full abstracts.`;
      return ok([header, ...blocks].join("\n\n"));
    } catch (e: any) {
      return fail(`research failed: ${e?.message ?? e}`);
    }
  },
);

server.registerTool(
  "get_paper",
  {
    title: "Get paper metadata",
    description:
      "Fetch canonical metadata for one PhilArchive/PhilPapers record via OAI-PMH. " +
      "Accepts a record id (e.g. 'BROTNO-9'), a philarchive.org/philpapers.org /rec/ URL, " +
      "or an oai: identifier. Returns title, authors, date, subjects, language, full abstract, " +
      "the landing-page URL, and whether an open-access PDF is available.",
    inputSchema: {
      id: z.string().min(1).describe("PhilArchive record id or URL, e.g. 'BROTNO-9'."),
    },
  },
  async ({ id }) => {
    try {
      const recId = assertSafeRecId(normalizeRecId(id));
      const meta = await fetchOaiMeta(recId);
      if (!meta) return fail(`No record found for id "${recId}".`);
      if (meta.deleted) return fail(`Record "${recId}" is marked deleted in PhilArchive.`);

      const pdfAvailable = meta.id ? await headPdfExists(meta.id) : false;
      const lines = [
        `Title: ${meta.title || "(untitled)"}`,
        `Authors: ${meta.authors.join("; ") || "(unknown)"}`,
        `Date: ${meta.date || "(unknown)"}`,
        `Language: ${meta.language || "(unspecified)"}`,
        `Subjects: ${meta.subjects.join(", ") || "(none)"}`,
        `URL: ${meta.url ?? `https://philarchive.org/rec/${recId}`}`,
        `Open-access PDF: ${pdfAvailable ? `${PDF_BASE}/${meta.id}.pdf` : "not available"}`,
        "",
        "Abstract:",
        meta.abstract || "(no abstract provided)",
      ];
      return ok(lines.join("\n"));
    } catch (e: any) {
      return fail(`get_paper failed: ${e?.message ?? e}`);
    }
  },
);

server.registerTool(
  "list_recent",
  {
    title: "List recent submissions",
    description:
      "List recently added/updated PhilArchive records in a date window, via OAI-PMH " +
      "(harvesting, not keyword search). Returns the first page of results (~up to `limit`). " +
      "Dates are UTC YYYY-MM-DD; defaults to the last 7 days.",
    inputSchema: {
      from: z.string().optional().describe("Start date (YYYY-MM-DD, UTC). Default: 7 days ago."),
      until: z.string().optional().describe("End date (YYYY-MM-DD, UTC). Default: now."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max records from the first page (1–100, default 20)."),
    },
  },
  async ({ from, until, limit }) => {
    try {
      const dayMs = 86_400_000;
      const fromDate = (from ?? new Date(Date.now() - 7 * dayMs).toISOString().slice(0, 10)).slice(0, 10);
      const params: Record<string, string> = {
        verb: "ListRecords",
        metadataPrefix: "oai_dc",
        from: `${fromDate}T00:00:00Z`,
      };
      if (until) params.until = `${until.slice(0, 10)}T23:59:59Z`;

      const oai = await oaiRequest(params);
      const all = asArray<any>(oai?.ListRecords?.record).map(parseOaiRecord).filter((r) => !r.deleted);
      const records = all.slice(0, limit);

      if (records.length === 0) {
        return ok(`No PhilArchive records found from ${fromDate}${until ? ` to ${until}` : ""}.`);
      }

      const lines = records.map((r, i) => {
        const authors = r.authors.slice(0, 5).join(", ") + (r.authors.length > 5 ? ", et al." : "");
        return [
          `${i + 1}. ${r.title || "(untitled)"}${r.date ? ` [${r.date}]` : ""}`,
          `   id: ${r.id ?? "—"}  |  ${r.url ?? ""}`,
          `   authors: ${authors || "(unknown)"}`,
          r.abstract ? `   abstract: ${truncate(r.abstract, 240)}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      });

      const more = all.length > records.length ? " (more available)" : "";
      return ok(
        [
          `PhilArchive records since ${fromDate}${until ? ` until ${until}` : ""} — ${records.length}${more}:`,
          "",
          ...lines,
        ].join("\n"),
      );
    } catch (e: any) {
      return fail(`list_recent failed: ${e?.message ?? e}`);
    }
  },
);

server.registerTool(
  "fetch_pdf",
  {
    title: "Download paper PDF",
    description:
      "Download the open-access PDF of a PhilArchive record and save it into the server's " +
      "download directory (set via the PHILPAPERS_DOWNLOAD_DIR env var), returning the file " +
      "path so it can be read. Accepts a record id or URL. Fails clearly if the paper has no " +
      "open-access PDF. To get the text directly instead of a file, use get_fulltext.",
    inputSchema: {
      id: z.string().min(1).describe("PhilArchive record id or URL, e.g. 'BROTNO-9'."),
    },
  },
  async ({ id }) => {
    try {
      const recId = assertSafeRecId(normalizeRecId(id));
      const buf = await downloadPdf(recId);
      // Always save inside the server-configured download dir — the client can't
      // choose an arbitrary destination path.
      await mkdir(DOWNLOAD_DIR, { recursive: true });
      const file = join(DOWNLOAD_DIR, `${recId}.pdf`);
      await writeFile(file, buf);
      return ok(
        [
          `Saved PhilArchive PDF for "${recId}".`,
          `Path: ${file}`,
          `Size: ${(buf.length / 1024).toFixed(1)} KiB`,
          `Source: ${PDF_BASE}/${recId}.pdf`,
        ].join("\n"),
      );
    } catch (e: any) {
      return fail(`fetch_pdf failed: ${e?.message ?? e}`);
    }
  },
);

/**
 * Cache of extracted PDF bodies, keyed by record id. Extraction (download +
 * unpdf parse) is the expensive part, so paging through a paper with offset=
 * reuses the parse instead of re-downloading the whole PDF each call.
 */
const fulltextCache = new LruCache<{ text: string; totalPages: number }>(8);

server.registerTool(
  "get_fulltext",
  {
    title: "Get paper full text",
    description:
      "Download a PhilArchive record's open-access PDF and extract its full text. Accepts a record " +
      "id or URL. Returns one window of max_chars starting at offset (default the first 15000 chars); " +
      "for a long paper, read a window and continue with the offset reported in the footer instead of " +
      "pulling the whole thing at once. The extracted text is cached, so paging doesn't re-download. " +
      "Fails clearly if the paper has no open-access PDF.",
    inputSchema: {
      id: z.string().min(1).describe("PhilArchive record id or URL, e.g. 'BROTNO-9'."),
      max_chars: z
        .number()
        .int()
        .min(500)
        .max(200_000)
        .default(15_000)
        .describe("Max characters of extracted text to return in this window (default 15000)."),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe(
          "Character offset to start from (default 0). Continue a long paper with the offset " +
            "reported in the previous call's footer — avoids re-sending earlier text.",
        ),
    },
  },
  async ({ id, max_chars, offset }) => {
    try {
      const recId = assertSafeRecId(normalizeRecId(id));
      let entry = fulltextCache.get(recId);
      if (!entry) {
        const buf = await downloadPdf(recId);
        const pdf = await getDocumentProxy(new Uint8Array(buf));
        const extracted = await extractText(pdf, { mergePages: true });
        const totalPages: number = (extracted as any).totalPages ?? 0;
        const raw = (extracted as any).text;
        const text = (Array.isArray(raw) ? raw.join("\n\n") : String(raw ?? ""))
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        entry = { text, totalPages };
        fulltextCache.set(recId, entry);
      }

      const source = `Source: ${PDF_BASE}/${recId}.pdf`;
      if (entry.text.length === 0) {
        return ok(
          `Full text of "${recId}" — ${entry.totalPages} page(s).\n${source}\n\n` +
            "(no extractable text — the PDF may be image-only)",
        );
      }
      const w = windowText(entry.text, max_chars, offset);
      if (w.slice === "") {
        return ok(`Full text of "${recId}".\n${source}\n\n${pastEndNote(w.total, w.start)}`);
      }
      const header =
        `Full text of "${recId}" — ${entry.totalPages} page(s), ${w.total.toLocaleString()} chars total.\n` +
        source;
      return ok(`${header}\n\n${w.slice}${windowNote(w)}`);
    } catch (e: any) {
      return fail(`get_fulltext failed: ${e?.message ?? e}`);
    }
  },
);

// Book & reference tools (Gutenberg, Internet Archive, Wikisource, Open Library,
// DOAB, Stanford Encyclopedia, fetch_text).
registerBookTools(server);

// Local document tools (info / search / read for large local PDFs & text files)
// — work a long local file without loading it whole into context.
registerLocalTools(server);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep the event loop alive on the stdio transport so the process doesn't exit
  // right after connecting (which surfaces to clients as "Connection closed"),
  // and shut down cleanly when the client disconnects (stdin EOF/close).
  process.stdin.resume();
  process.stdin.on("close", () => process.exit(0));
  // stdout is the protocol channel — log only to stderr.
  console.error("philosophy-mcp running on stdio");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
