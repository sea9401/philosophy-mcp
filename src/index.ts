#!/usr/bin/env node
/**
 * PhilPapers / PhilArchive MCP server.
 *
 * Backends (all keyless):
 *   - Keyword search  -> OpenAlex, filtered to the PhilPapers/PhilArchive source.
 *   - Record metadata -> PhilArchive OAI-PMH (GetRecord).
 *   - Recent papers   -> PhilArchive OAI-PMH (ListRecords, by date).
 *   - Full text        -> https://philpapers.org/archive/<ID>.pdf
 *
 * PhilArchive is the open-access archive built on the PhilPapers database, so a
 * PhilPapers record id (e.g. "BROTNO-9") resolves on both hosts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const USER_AGENT = `philpapers-mcp/0.1 (+${MAILTO})`;
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

async function httpGet(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { "User-Agent": USER_AGENT, ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
    return res;
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
  if (recId && !pdfUrl) {
    // OpenAlex didn't surface a PDF; leave undefined rather than guess an OA copy exists.
  }
  return { recId, landing, pdfUrl };
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

// ---------------------------------------------------------------------------
// OAI-PMH helpers
// ---------------------------------------------------------------------------

async function oaiRequest(params: Record<string, string>): Promise<any> {
  const url = new URL(OAI_BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await httpGet(url.toString());
  const body = await res.text();
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

// ---------------------------------------------------------------------------
// Server + tools
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "philpapers", version: "0.1.0" });

server.registerTool(
  "search_papers",
  {
    title: "Search philosophy papers",
    description:
      "Keyword search across PhilPapers / PhilArchive (philosophy preprints and published " +
      "papers indexed by the PhilPapers Foundation), powered by OpenAlex full-text search. " +
      "Returns title, authors, year, abstract, the PhilArchive record id + URL, and an " +
      "open-access PDF URL when one exists. Use the returned `id` with get_paper or fetch_pdf.",
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
      const filters = [`locations.source.id:${OPENALEX_SOURCES.join("|")}`];
      if (year_from) filters.push(`from_publication_date:${year_from}-01-01`);
      if (year_to) filters.push(`to_publication_date:${year_to}-12-31`);
      if (open_access_only) filters.push("open_access.is_oa:true");

      // Over-fetch a little when filtering to PDFs so we can still fill `limit`.
      const perPage = Math.min(50, open_access_only ? limit * 3 : limit);
      const url = new URL(OPENALEX_WORKS);
      url.searchParams.set("search", query);
      url.searchParams.set("filter", filters.join(","));
      url.searchParams.set("per-page", String(perPage));
      url.searchParams.set(
        "select",
        "id,title,publication_year,authorships,doi,locations,abstract_inverted_index",
      );
      url.searchParams.set("mailto", MAILTO);

      const res = await httpGet(url.toString());
      const data: any = await res.json();
      const total: number = data?.meta?.count ?? 0;

      let items = asArray<any>(data.results).map((w) => {
        const links = philLinks(w);
        const authors = asArray<any>(w.authorships)
          .map((a) => a?.author?.display_name)
          .filter(Boolean);
        return {
          id: links.recId,
          title: w.title ?? "(untitled)",
          year: w.publication_year,
          authors,
          doi: w.doi as string | undefined,
          philarchive: links.landing,
          pdf: links.pdfUrl,
          abstract: reconstructAbstract(w.abstract_inverted_index),
        };
      });

      if (open_access_only) items = items.filter((it) => it.pdf);
      items = items.slice(0, limit);

      if (items.length === 0) {
        return ok(`No PhilPapers/PhilArchive results for "${query}".`);
      }

      const lines = items.map((it, i) => {
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
        `showing ${items.length}${open_access_only ? " (open-access only)" : ""}.`;
      return ok([header, "", ...lines].join("\n"));
    } catch (e: any) {
      return fail(`search_papers failed: ${e?.message ?? e}`);
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
      const recId = normalizeRecId(id);
      const oai = await oaiRequest({
        verb: "GetRecord",
        metadataPrefix: "oai_dc",
        identifier: `oai:philarchive.org/rec/${recId}`,
      });
      const record = oai?.GetRecord?.record;
      if (!record) return fail(`No record found for id "${recId}".`);
      const meta = parseOaiRecord(record);
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
      const records = asArray<any>(oai?.ListRecords?.record)
        .map(parseOaiRecord)
        .filter((r) => !r.deleted)
        .slice(0, limit);

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

      const more = asArray<any>(oai?.ListRecords?.record).length > records.length ? " (more available)" : "";
      return ok(
        [`PhilArchive records since ${fromDate}${until ? ` until ${until}` : ""} — ${records.length}${more}:`, "", ...lines].join(
          "\n",
        ),
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
      "Download the open-access PDF of a PhilArchive record and save it locally, returning " +
      "the file path so it can be read. Accepts a record id or URL. Fails clearly if the " +
      "paper has no open-access PDF.",
    inputSchema: {
      id: z.string().min(1).describe("PhilArchive record id or URL, e.g. 'BROTNO-9'."),
      dest_dir: z
        .string()
        .optional()
        .describe(`Directory to save into. Default: ${DOWNLOAD_DIR}`),
    },
  },
  async ({ id, dest_dir }) => {
    try {
      const recId = normalizeRecId(id);
      const pdfUrl = `${PDF_BASE}/${recId}.pdf`;
      const res = await httpGet(pdfUrl);
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("pdf")) {
        return fail(
          `No open-access PDF for "${recId}" (server returned content-type "${ct}"). ` +
            `The paper may not be open access on PhilArchive.`,
        );
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const dir = dest_dir || DOWNLOAD_DIR;
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${recId}.pdf`);
      await writeFile(file, buf);
      return ok(
        [
          `Saved PhilArchive PDF for "${recId}".`,
          `Path: ${file}`,
          `Size: ${(buf.length / 1024).toFixed(1)} KiB`,
          `Source: ${pdfUrl}`,
        ].join("\n"),
      );
    } catch (e: any) {
      return fail(`fetch_pdf failed: ${e?.message ?? e}`);
    }
  },
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel — log only to stderr.
  console.error("philpapers-mcp running on stdio");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
