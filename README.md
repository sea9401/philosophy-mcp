# philpapers-mcp

[![CI](https://github.com/sea9401/philpapers-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sea9401/philpapers-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/philpapers-mcp.svg)](https://www.npmjs.com/package/philpapers-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

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

## Example

`search_papers` with `{ "query": "phenomenal consciousness higher-order", "open_access_only": true, "limit": 3 }`:

```
Found 1,806 match(es) in PhilPapers/PhilArchive; showing 3 (open-access only).

1. What Is Wrong with the No-Report Paradigm and How to Fix It (2019)
   id: BLOWIW-2
   authors: Ned Block
   philarchive: https://philarchive.org/rec/BLOWIW-2
   pdf: https://philpapers.org/archive/BLOWIW-2.pdf
   doi: https://doi.org/10.1016/j.tics.2019.10.001
2. The HOROR theory of phenomenal consciousness (2014)
   id: BROTNO-9
   authors: Richard Brown
   philarchive: https://philarchive.org/rec/BROTNO-9
   pdf: https://philpapers.org/archive/BROTNO-9.pdf
   doi: https://doi.org/10.1007/s11098-014-0388-7
...
```

Then `fetch_pdf` with `{ "id": "BROTNO-9" }` downloads the PDF locally so the client can read it.

## Setup

Once published to npm, no clone or build is needed — run it straight with `npx`:

```bash
npx -y philpapers-mcp
```

Or from source:

```bash
git clone https://github.com/sea9401/philpapers-mcp
cd philpapers-mcp
npm install   # the `prepare` hook builds dist/ automatically
```

## Register with Claude Code

```bash
# via npx (no clone)
claude mcp add philpapers -- npx -y philpapers-mcp

# from a local build
claude mcp add philpapers -- node /absolute/path/to/philpapers-mcp/dist/index.js

# optional: identify yourself to OpenAlex's "polite pool" for better rate limits
claude mcp add philpapers -e OPENALEX_MAILTO=you@example.com -- npx -y philpapers-mcp
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

## Publishing (maintainers)

CI (`.github/workflows/ci.yml`) builds on Node 18/20/22 for every push and PR.

To publish a new version to npm:

1. Add a repo secret `NPM_TOKEN` (an npm **Automation** access token) under
   *Settings → Secrets and variables → Actions*.
2. Bump the version and tag: `npm version patch && git push --follow-tags`.
3. Cut a GitHub Release — `.github/workflows/publish.yml` runs `npm publish`
   (with provenance) automatically.

Or publish manually: `npm login` then `npm publish --access public`.

## License

MIT

