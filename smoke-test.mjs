/**
 * Network-free smoke test.
 *
 * Starts the MCP server over stdio, performs the protocol handshake, and lists
 * its tools — no external API is called. This is the regression guard for the
 * "server exits right after connecting / MCP error -32000: Connection closed"
 * bug, and verifies every expected tool is registered. Safe to run in CI.
 *
 * Run after `npm run build`. Exits non-zero on any failure.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED = [
  // PhilPapers / PhilArchive (src/index.ts)
  "search_papers",
  "research",
  "get_paper",
  "list_recent",
  "fetch_pdf",
  "get_fulltext",
  // Books & reference (src/books.ts)
  "search_gutenberg",
  "get_gutenberg_text",
  "search_internet_archive",
  "get_archive_text",
  "search_wikisource",
  "get_wikisource_text",
  "search_openlibrary",
  "search_doab",
  "search_sep",
  "get_sep_entry",
  "fetch_text",
];

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env },
});
const client = new Client({ name: "smoke-test", version: "0.0.0" });

let failed = false;
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  console.log(`Connected over stdio. Server exposes ${names.size} tool(s).`);

  const missing = EXPECTED.filter((n) => !names.has(n));
  if (missing.length) {
    console.error(`Missing expected tool(s): ${missing.join(", ")}`);
    failed = true;
  } else {
    console.log(`All ${EXPECTED.length} expected tools are registered.`);
  }
} catch (e) {
  console.error(`Smoke test error: ${e?.stack ?? e?.message ?? e}`);
  failed = true;
} finally {
  await client.close().catch(() => {});
}

if (failed) {
  console.error("SMOKE TEST: FAIL");
  process.exit(1);
}
console.log("SMOKE TEST: PASS");
