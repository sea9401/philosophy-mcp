/**
 * Local document tools — read large local files (a 700-page PDF, a long .txt)
 * without pulling the whole thing into the model's context.
 *
 * The motivation is token economy: feeding an entire long document into an
 * agent and then re-sending it every turn is what burns through usage. These
 * tools let the model work the way a person skims a thick book — get an outline,
 * jump to the relevant pages by searching, and read a bounded chunk at a time —
 * so only the parts that matter ever reach the context.
 *
 * Self-contained (own helpers) so it composes onto the server without touching
 * its code. Registered via registerLocalTools(server).
 *
 * Tools:
 *   - local_doc_info    overview: pages, chars, ~tokens, heuristic outline
 *   - local_doc_search  find passages by keyword/regex → snippets + page numbers
 *   - local_doc_read    read a page range / chunk, capped so it can't flood context
 *
 * Security: only files under the user's home directory are readable by default;
 * extra roots can be allowed via the PHILOSOPHY_DOC_ROOTS env var (delimiter-
 * separated absolute paths). Paths are real-path resolved, so symlinks can't
 * escape the allowed roots.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { extractText, getDocumentProxy } from "unpdf";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, extname, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Small helpers (kept local so this module stays self-contained)
// ---------------------------------------------------------------------------

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/** Same whitespace tidy-up the PDF path in index.ts uses. */
function cleanText(s: string): string {
  return String(s ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rough token estimate — ~4 chars per token is close enough for a heads-up. */
function estTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

// ---------------------------------------------------------------------------
// Path allowlist
// ---------------------------------------------------------------------------

let ROOTS: string[] | null = null;

/** Real-path-resolved allowed roots: $HOME plus any PHILOSOPHY_DOC_ROOTS entries. */
async function allowedRoots(): Promise<string[]> {
  if (ROOTS) return ROOTS;
  const raw = [homedir(), ...(process.env.PHILOSOPHY_DOC_ROOTS?.split(delimiter) ?? [])]
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const r of raw) {
    try {
      out.push(await realpath(resolve(r)));
    } catch {
      out.push(resolve(r)); // root may not exist yet; keep the literal form
    }
  }
  ROOTS = out.length ? out : [resolve(homedir())];
  return ROOTS;
}

/**
 * Resolve a client-supplied path to a real absolute path and verify it sits
 * under an allowed root. realpath() follows symlinks before the check, so a link
 * inside an allowed root that points outside it is rejected.
 */
async function resolveAllowed(input: string): Promise<string> {
  if (!input || !input.trim()) throw new Error("No file path given.");
  const resolved = resolve(input.trim());
  let real: string;
  try {
    real = await realpath(resolved);
  } catch {
    throw new Error(`File not found or unreadable: ${resolved}`);
  }
  const roots = await allowedRoots();
  const allowed = roots.some((root) => real === root || real.startsWith(root + sep));
  if (!allowed) {
    throw new Error(
      `Path "${real}" is outside the allowed roots (${roots.join(", ")}). ` +
        `Add its folder to the PHILOSOPHY_DOC_ROOTS env var to allow it.`,
    );
  }
  return real;
}

// ---------------------------------------------------------------------------
// Loading + paginating documents (with an mtime-keyed cache)
// ---------------------------------------------------------------------------

interface Doc {
  /** Per-page text. For PDFs these are real pages; for text, virtual pages. */
  pages: string[];
  kind: "pdf" | "text";
  /** true when text was split into fixed-size virtual pages (no real page breaks). */
  synthetic: boolean;
  mtimeMs: number;
  bytes: number;
}

const CACHE = new Map<string, Doc>();
const TEXT_EXTS = new Set([".txt", ".md", ".markdown", ".text", ".org", ".rst", ".tex", ".log", ""]);

/** Split plain text into virtual pages: on form-feeds if present, else ~4 KB blocks. */
function paginateText(s: string): { pages: string[]; synthetic: boolean } {
  if (s.includes("\f")) {
    return { pages: s.split("\f").map(cleanText), synthetic: false };
  }
  const TARGET = 4000;
  const pages: string[] = [];
  let buf = "";
  for (const line of s.split("\n")) {
    if (buf.length > 0 && buf.length + line.length + 1 > TARGET) {
      pages.push(buf);
      buf = "";
    }
    buf += (buf ? "\n" : "") + line;
  }
  if (buf) pages.push(buf);
  return { pages: pages.length ? pages.map(cleanText) : [""], synthetic: true };
}

/** Load + paginate a document, reusing the cache when the file is unchanged. */
async function loadDoc(real: string): Promise<Doc> {
  const st = await stat(real);
  const cached = CACHE.get(real);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached;

  const ext = extname(real).toLowerCase();
  let doc: Doc;
  if (ext === ".pdf") {
    const buf = await readFile(real);
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    // mergePages:false keeps page boundaries so search/read can cite page numbers.
    const extracted: any = await extractText(pdf, { mergePages: false });
    const raw = extracted?.text;
    const pages = (Array.isArray(raw) ? raw : [String(raw ?? "")]).map(cleanText);
    doc = { pages, kind: "pdf", synthetic: false, mtimeMs: st.mtimeMs, bytes: st.size };
  } else if (TEXT_EXTS.has(ext)) {
    const s = await readFile(real, "utf8");
    const { pages, synthetic } = paginateText(s);
    doc = { pages, kind: "text", synthetic, mtimeMs: st.mtimeMs, bytes: st.size };
  } else {
    throw new Error(
      `Unsupported file type "${ext || "(none)"}" — this tool reads .pdf and plain-text files.`,
    );
  }
  CACHE.set(real, doc);
  return doc;
}

function docChars(doc: Doc): number {
  return doc.pages.reduce((n, p) => n + p.length, 0);
}

// ---------------------------------------------------------------------------
// Outline detection
// ---------------------------------------------------------------------------

const HEADING_RES = [
  /^#{1,6}\s+\S/, // markdown heading
  /^(chapter|section|part|appendix|book|preface|introduction|conclusion|bibliography|references|abstract)\b/i,
  /^\s*\d+(\.\d+)*\.?\s+\p{L}/u, // numbered: "1. Title", "2.3 Title"
];

function looksLikeHeading(line: string): boolean {
  const t = line.trim();
  if (t.length < 2 || t.length > 90) return false;
  if (/[.,;:]$/.test(t)) return false; // sentence-like → not a heading
  if (HEADING_RES.some((re) => re.test(t))) return true;
  // Short ALL-CAPS line (e.g. "PHENOMENAL CONSCIOUSNESS").
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (
    letters.length >= 3 &&
    letters === letters.toUpperCase() &&
    t.split(/\s+/).length <= 12
  ) {
    return true;
  }
  return false;
}

function buildOutline(doc: Doc, max: number): Array<{ page: number; text: string }> {
  const out: Array<{ page: number; text: string }> = [];
  let last = "";
  for (let p = 0; p < doc.pages.length && out.length < max; p++) {
    for (const line of doc.pages[p].split("\n")) {
      const t = line.trim();
      if (t && t !== last && looksLikeHeading(t)) {
        out.push({ page: p + 1, text: t.replace(/^#{1,6}\s+/, "") });
        last = t;
        if (out.length >= max) break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerLocalTools(server: McpServer): void {
  server.registerTool(
    "local_doc_info",
    {
      title: "Local document overview",
      description:
        "Open a local PDF or plain-text file and return a cheap overview — page count, " +
        "character count, an estimated token count, and a heuristic outline (detected " +
        "headings with their page numbers) — WITHOUT dumping the whole document into context. " +
        "Use this first on a long file, then local_doc_search to jump to relevant pages and " +
        "local_doc_read to read a chunk. Only files under the allowed roots (home directory by " +
        "default) can be opened.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute (or ~-relative) path to a local .pdf or text file."),
        max_headings: z
          .number()
          .int()
          .min(1)
          .max(300)
          .default(60)
          .describe("Max outline headings to return (default 60)."),
      },
    },
    async ({ path, max_headings }) => {
      try {
        const real = await resolveAllowed(path);
        const doc = await loadDoc(real);
        const chars = docChars(doc);
        const outline = buildOutline(doc, max_headings);

        const kindLabel =
          doc.kind === "pdf"
            ? `PDF, ${doc.pages.length} page(s)`
            : `Text, ${doc.pages.length} ${doc.synthetic ? "virtual " : ""}page(s)` +
              (doc.synthetic ? " (~4 KB each — no real page breaks)" : "");

        const head = [
          `File: ${real}`,
          `Type: ${kindLabel}`,
          `Size: ${(doc.bytes / 1024).toFixed(1)} KiB on disk · ${chars.toLocaleString()} text chars · ~${estTokens(chars).toLocaleString()} tokens`,
        ];
        const body =
          outline.length > 0
            ? [
                "",
                `Outline (${outline.length} heading(s)):`,
                ...outline.map((h) => `  [p.${h.page}] ${h.text}`),
              ]
            : ["", "Outline: (no headings detected)"];
        const hint = [
          "",
          `Next: local_doc_search("${real}", "<keyword>") to find relevant pages, ` +
            `then local_doc_read("${real}", page_from=N) to read a chunk.`,
        ];
        if (chars === 0) {
          body.push("", "(no extractable text — the PDF may be image-only / scanned)");
        }
        return ok([...head, ...body, ...hint].join("\n"));
      } catch (e: any) {
        return fail(`local_doc_info failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "local_doc_search",
    {
      title: "Search inside a local document",
      description:
        "Search a local PDF or text file for a keyword or regular expression and return only the " +
        "matching passages — each as a short snippet with surrounding context and its page number — " +
        "instead of the whole document. This is the token-efficient way to answer a question about " +
        "a long file: find the handful of relevant pages, then local_doc_read just those. Only files " +
        "under the allowed roots can be opened.",
      inputSchema: {
        path: z.string().min(1).describe("Path to a local .pdf or text file."),
        query: z.string().min(1).max(1000).describe("Keyword/phrase to find (or a regex if is_regex=true)."),
        is_regex: z.boolean().default(false).describe("Treat query as a JavaScript regular expression."),
        ignore_case: z.boolean().default(true).describe("Case-insensitive matching (default true)."),
        context_chars: z
          .number()
          .int()
          .min(0)
          .max(2000)
          .default(160)
          .describe("Characters of context to show on each side of a match (default 160)."),
        max_matches: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(20)
          .describe("Max matching snippets to return (default 20)."),
        max_chars: z
          .number()
          .int()
          .min(500)
          .max(50_000)
          .default(8000)
          .describe("Overall cap on returned text so results can't flood context (default 8000)."),
      },
    },
    async ({ path, query, is_regex, ignore_case, context_chars, max_matches, max_chars }) => {
      try {
        const real = await resolveAllowed(path);
        const doc = await loadDoc(real);

        const flags = ignore_case ? "gi" : "g";
        let re: RegExp;
        try {
          re = new RegExp(is_regex ? query : escapeRegex(query), flags);
        } catch (e: any) {
          return fail(`Invalid regular expression: ${e?.message ?? e}`);
        }

        // Collect a bit beyond the display cap so we can tell the user there's more.
        const hardCap = max_matches * 3;
        const hits: Array<{ page: number; snippet: string }> = [];
        let truncatedCollection = false;

        outer: for (let p = 0; p < doc.pages.length; p++) {
          const text = doc.pages[p];
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          let perPage = 0;
          while ((m = re.exec(text)) !== null) {
            const len = m[0].length || 1;
            const start = Math.max(0, m.index - context_chars);
            const end = Math.min(text.length, m.index + len + context_chars);
            const snippet =
              (start > 0 ? "…" : "") +
              text.slice(start, end).replace(/\s+/g, " ").trim() +
              (end < text.length ? "…" : "");
            hits.push({ page: p + 1, snippet });

            if (m[0].length === 0) re.lastIndex++; // guard against zero-width loops
            if (++perPage >= 50) break; // don't let one page dominate
            if (hits.length >= hardCap) {
              truncatedCollection = true;
              break outer;
            }
          }
        }

        if (hits.length === 0) {
          return ok(`No matches for ${is_regex ? `/${query}/` : `"${query}"`} in ${basename(real)}.`);
        }

        const shown: string[] = [];
        let budget = max_chars;
        let cutByChars = false;
        for (const h of hits.slice(0, max_matches)) {
          const line = `[p.${h.page}] ${h.snippet}`;
          if (line.length > budget && shown.length > 0) {
            cutByChars = true;
            break;
          }
          shown.push(line);
          budget -= line.length + 1;
        }

        const more =
          truncatedCollection || hits.length > shown.length || cutByChars
            ? " (more matches exist — refine the query or read the cited pages)"
            : "";
        const header = `${hits.length}${truncatedCollection ? "+" : ""} match(es) for ${
          is_regex ? `/${query}/` : `"${query}"`
        } in ${basename(real)}; showing ${shown.length}${more}.`;
        return ok([header, "", ...shown].join("\n"));
      } catch (e: any) {
        return fail(`local_doc_search failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "local_doc_read",
    {
      title: "Read a page range of a local document",
      description:
        "Read a bounded slice of a local PDF or text file — a page range starting at page_from — and " +
        "return it with page markers, capped at max_chars so it can't flood context. Omitting page_to " +
        "reads forward from page_from until the cap is hit and reports the next page to continue from, " +
        "which makes it easy to walk a long document chunk-by-chunk (e.g. to summarize it section by " +
        "section). Only files under the allowed roots can be opened.",
      inputSchema: {
        path: z.string().min(1).describe("Path to a local .pdf or text file."),
        page_from: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe("First page to read (1-based, default 1)."),
        page_to: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Last page to read (1-based, inclusive). Omit to read forward until max_chars."),
        max_chars: z
          .number()
          .int()
          .min(500)
          .max(100_000)
          .default(12_000)
          .describe("Cap on returned text (default 12000). Reading stops at this many chars."),
      },
    },
    async ({ path, page_from, page_to, max_chars }) => {
      try {
        const real = await resolveAllowed(path);
        const doc = await loadDoc(real);
        const total = doc.pages.length;
        if (page_from > total) {
          return fail(`page_from ${page_from} is past the end (document has ${total} page(s)).`);
        }
        const start = Math.min(Math.max(1, page_from), total);
        const end = page_to ? Math.min(Math.max(start, page_to), total) : total;

        const parts: string[] = [];
        let used = 0;
        let lastRead = start - 1;
        let cutByChars = false;
        for (let p = start; p <= end; p++) {
          const marker = `\n=== p.${p} ===\n`;
          const pageText = doc.pages[p - 1] || "(blank page)";
          if (used > 0 && used + marker.length + pageText.length > max_chars) {
            cutByChars = true;
            break;
          }
          let chunk = pageText;
          if (used + marker.length + chunk.length > max_chars) {
            chunk = chunk.slice(0, Math.max(0, max_chars - used - marker.length)).trimEnd() + "…";
            cutByChars = true;
          }
          parts.push(marker + chunk);
          used += marker.length + chunk.length;
          lastRead = p;
          if (cutByChars) break;
        }

        const next =
          lastRead < total
            ? ` Continue with page_from=${lastRead + 1}.`
            : " (end of document).";
        const header =
          `${basename(real)} — pages ${start}–${lastRead} of ${total}` +
          `${cutByChars ? ` (stopped at max_chars=${max_chars.toLocaleString()})` : ""}.${next}`;
        return ok([header, ...parts].join("\n"));
      } catch (e: any) {
        return fail(`local_doc_read failed: ${e?.message ?? e}`);
      }
    },
  );
}
