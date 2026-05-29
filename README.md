# philpapers-mcp

An MCP server wired to **PhilPapers / PhilArchive** — the philosophy preprint archive
(the field's closest analog to arXiv). It lets an MCP client search philosophy papers,
read their metadata and abstracts, browse recent submissions, and download open-access PDFs.

**No API key required.** Everything runs against keyless public endpoints.

## How it works

| Tool | What it does | Backend |
| --- | --- | --- |
| `search_papers` | Keyword search (title/abstract/full text), returns metadata + PhilArchive links + PDF URL | OpenAlex, filtered to the PhilPapers Foundation source |
| `get_paper` | Canonical metadata + full abstract for one record id | PhilArchive OAI-PMH `GetRecord` |
| `list_recent` | Records added/updated in a date window | PhilArchive OAI-PMH `ListRecords` |
| `fetch_pdf` | Download a record's open-access PDF to disk, return the path | `philpapers.org/archive/<ID>.pdf` |

PhilArchive is the open-access archive built on the PhilPapers database, so a record id
such as `BROTNO-9` resolves on both `philarchive.org` and `philpapers.org`.

Why OpenAlex for search? PhilPapers' own JSON search API needs a (free) key and sits behind
Cloudflare, and OAI-PMH is harvest-only (no keyword search). OpenAlex indexes ~80k PhilPapers
works with full-text search, abstracts, and links straight back to the PhilArchive record and PDF.

## Setup

```bash
cd philpapers-mcp
npm install
npm run build
```

## Register with Claude Code

```bash
claude mcp add philpapers -- node /home/sea9401/philpapers-mcp/dist/index.js
# optional: identify yourself to OpenAlex's "polite pool" for better rate limits
claude mcp add philpapers -e OPENALEX_MAILTO=you@example.com -- node /home/sea9401/philpapers-mcp/dist/index.js
```

Then `/mcp` inside Claude Code should list `philpapers` with its four tools.

## Register with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "philpapers": {
      "command": "node",
      "args": ["/home/sea9401/philpapers-mcp/dist/index.js"],
      "env": { "OPENALEX_MAILTO": "you@example.com" }
    }
  }
}
```

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `OPENALEX_MAILTO` | `mcp@example.com` | Your email — joins OpenAlex's polite pool (recommended). |
| `PHILPAPERS_DOWNLOAD_DIR` | `<tmp>/philpapers-mcp` | Where `fetch_pdf` saves files. |

## Smoke test

```bash
node test-client.mjs
```

Spawns the server over stdio and exercises all four tools.

## Notes & limits

- `search_papers` reaches both preprints and published papers that have a PhilPapers/PhilArchive
  record. `open_access_only: true` keeps only those with a downloadable PhilArchive PDF.
- `list_recent` filters on the OAI **datestamp** (when the record was added/updated), which can
  differ from the paper's publication date shown in the listing. It returns only the first OAI
  page (no resumption-token paging).
- Not every record has an open-access PDF — many entries are metadata-only links to the published
  version. `get_paper` reports PDF availability; `fetch_pdf` fails clearly when there isn't one.
- Abstracts from `search_papers` are reconstructed from OpenAlex's inverted index; `get_paper`
  returns the archive's verbatim abstract.

## License

MIT
