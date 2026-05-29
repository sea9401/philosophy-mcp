# philosophy-mcp

[![CI](https://github.com/sea9401/philosophy-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sea9401/philosophy-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An MCP server for **philosophy texts** — both current scholarship and the canon.
It folds two things into one keyless server:

- **PhilPapers / PhilArchive** — the philosophy preprint archive (the field's closest
  analog to arXiv): search papers, read abstracts, browse recent submissions, pull full text.
- **Books, classics & reference** — public-domain originals and translations (Project
  Gutenberg, Internet Archive, Wikisource), open-access academic books (DOAB), modern
  editions (Open Library), and the Stanford Encyclopedia of Philosophy — plus a generic
  `fetch_text` for any other source (Zeno.org, marxists.org, Standard Ebooks, …).

**No API key required.** Everything runs against keyless public endpoints.

> Renamed and expanded from **philpapers-mcp** (which covered only the PhilPapers tools).
> The `philpapers-mcp` binary name still works as an alias.

## Tools

### Philosophy scholarship (PhilPapers / PhilArchive)

| Tool | What it does | Backend |
| --- | --- | --- |
| `search_papers` | Keyword search (title/abstract/full text), returns metadata + PhilArchive links + PDF URL | OpenAlex, filtered to the PhilPapers Foundation source |
| `research` | One-shot scan: search **and** pull each hit's verbatim full abstract + subjects in a single call | OpenAlex + OAI-PMH `GetRecord` |
| `get_paper` | Canonical metadata + full abstract for one record id | PhilArchive OAI-PMH `GetRecord` |
| `list_recent` | Records added/updated in a date window | PhilArchive OAI-PMH `ListRecords` |
| `fetch_pdf` | Download a record's open-access PDF to disk, return the path | `philpapers.org/archive/<ID>.pdf` |
| `get_fulltext` | Download the open-access PDF and return its **extracted full text** | PDF + `unpdf` text extraction |

PhilArchive is the open-access archive built on the PhilPapers database, so a record id
such as `BROTNO-9` resolves on both `philarchive.org` and `philpapers.org`.

### Books, classics & reference

| Tool | What it does | Source |
| --- | --- | --- |
| `search_gutenberg` / `get_gutenberg_text` | Find and read public-domain classics + out-of-copyright translations | Project Gutenberg (Gutendex, with a gutenberg.org fallback) |
| `search_internet_archive` / `get_archive_text` | Find scanned, out-of-print works and read their OCR text | Internet Archive |
| `search_wikisource` / `get_wikisource_text` | Find and read primary texts/translations in any language (en, de, ko, …) | Wikisource |
| `search_openlibrary` | Modern editions & translations as metadata, with read/borrow links | Open Library |
| `search_doab` | Peer-reviewed, fully open-access academic books (readable in full) | DOAB |
| `search_sep` / `get_sep_entry` | Search and read the standard scholarly reference | Stanford Encyclopedia of Philosophy |
| `fetch_text` | Readable plain text from **any** URL — the catch-all for sources without a dedicated tool | any site |

All text-returning tools take `max_chars` (default 15000–18000) and truncate with a note —
raise it to read further into a work.

## Example

`search_papers` with `{ "query": "phenomenal consciousness higher-order", "open_access_only": true, "limit": 2 }`:

```
Found 1,806 match(es) in PhilPapers/PhilArchive; showing 2 (open-access only).

1. The HOROR theory of phenomenal consciousness (2014)
   id: BROTNO-9
   authors: Richard Brown
   philarchive: https://philarchive.org/rec/BROTNO-9
   pdf: https://philpapers.org/archive/BROTNO-9.pdf
```

Then `get_fulltext` with `{ "id": "BROTNO-9" }` returns the paper's extracted full text.

For the canon: `search_gutenberg` with `{ "query": "kant critique", "languages": "en" }` returns book
ids, and `get_gutenberg_text` with `{ "book_id": 4280 }` reads *The Critique of Pure Reason* directly;
`search_sep` → `get_sep_entry` reads an encyclopedia entry; `fetch_text` pulls readable text from
German originals on Zeno.org or translations on marxists.org.

> 20th-century authors still in copyright (Heidegger, Adorno, Gadamer, Habermas) won't have free
> full texts here — you'll get metadata, SEP coverage, and read/borrow links.

## Setup

Run straight with `npx` (no clone, once published):

```bash
npx -y philosophy-mcp
```

Or from source:

```bash
git clone https://github.com/sea9401/philosophy-mcp
cd philosophy-mcp
npm install   # the `prepare` hook builds dist/ automatically
```

## Register with Claude Code

```bash
# via npx (no clone)
claude mcp add philosophy -- npx -y philosophy-mcp

# from a local build
claude mcp add philosophy -- node /absolute/path/to/dist/index.js

# optional: identify yourself to OpenAlex's "polite pool" for better rate limits
claude mcp add philosophy -e OPENALEX_MAILTO=you@example.com -- npx -y philosophy-mcp
```

Then `/mcp` inside Claude Code lists `philosophy` with its tools.

## Register with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "philosophy": {
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

Spawns the server over stdio and exercises the PhilPapers tools.

## Notes & limits

- The book/reference tools are keyless and read-only. Search tools return compact lists; the
  `get_*` / `fetch_text` tools return text truncated to `max_chars`.
- **Gutendex** (the Project Gutenberg API host) is frequently overloaded; `search_gutenberg`
  probes it briefly and falls back to gutenberg.org's OPDS feed. `get_gutenberg_text` reads the
  text directly from gutenberg.org, so it works even when Gutendex is down.
- **SEP** has no keyword API (its on-site search is JavaScript-driven), so `search_sep` matches
  against the published entry index (`contents.html`) — i.e. title/topic matching.
- `list_recent` filters on the OAI **datestamp**, returns only the first OAI page, and not every
  record has an open-access PDF — `get_paper` reports availability; `fetch_pdf` fails clearly.

## Publishing (maintainers)

CI (`.github/workflows/ci.yml`) builds on Node 18/20/22 for every push and PR.

To publish a new version to npm:

1. Add a repo secret `NPM_TOKEN` (an npm **Automation** access token) under
   *Settings → Secrets and variables → Actions*.
2. Bump the version and tag: `npm version patch && git push --follow-tags`.
3. Cut a GitHub Release — `.github/workflows/publish.yml` runs `npm publish` automatically.

Or publish manually: `npm login` then `npm publish --access public`.

## License

MIT
