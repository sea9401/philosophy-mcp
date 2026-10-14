/**
 * Network-free unit tests for the Gutenberg mirror/catalog helpers.
 * Run after `npm run build` (imports the compiled dist/ module).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GUTENBERG_CATALOG_URLS,
  GUTENBERG_MIRRORS,
  gutenbergTextUrls,
  isGutenbergSite,
  parseCsv,
  catalogFromCsv,
  searchCatalog,
} from "../dist/gutenberg.js";

test("text URLs only point at official mirrors, never www.gutenberg.org", () => {
  const urls = gutenbergTextUrls(4280);
  assert.ok(urls.length > 0);
  for (const u of urls) {
    const host = new URL(u).hostname;
    assert.notEqual(host, "www.gutenberg.org");
    assert.notEqual(host, "gutenberg.org");
    assert.ok(GUTENBERG_MIRRORS.some((m) => u.startsWith(m)), `${u} is not on a listed mirror`);
  }
});

test("text URLs use the mirror directory layout", () => {
  assert.ok(gutenbergTextUrls(4280).some((u) => u.endsWith("/4/2/8/4280/4280-0.txt")));
  assert.ok(gutenbergTextUrls(12).some((u) => u.endsWith("/1/12/12-0.txt")));
  assert.ok(gutenbergTextUrls(5).some((u) => u.endsWith("/0/5/5-0.txt")));
  assert.ok(gutenbergTextUrls(4280).some((u) => u.endsWith("/cache/epub/4280/pg4280.txt")));
});

test("generated UTF-8 text from the fast ODU mirror is tried first, slow PGLAF last", () => {
  const urls = gutenbergTextUrls(4280);
  assert.equal(urls[0], "https://mirror.cs.odu.edu/gutenberg-epub/4280/pg4280.txt");
  assert.ok(urls.at(-1).startsWith("https://gutenberg.pglaf.org/"));
});

test("catalog URLs are mirror-hosted, fast mirror first", () => {
  assert.equal(GUTENBERG_CATALOG_URLS[0], "https://mirror.cs.odu.edu/gutenberg-epub/feeds/pg_catalog.csv.gz");
  for (const u of GUTENBERG_CATALOG_URLS) assert.ok(GUTENBERG_MIRRORS.some((m) => u.startsWith(m)));
});

test("parseCsv handles quoted commas, escaped quotes and embedded newlines", () => {
  const rows = parseCsv('a,b,c\n1,"x, y","he said ""hi"""\n2,"line1\nline2",z\n');
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["1", "x, y", 'he said "hi"'],
    ["2", "line1\nline2", "z"],
  ]);
});

const CSV = [
  "Text#,Type,Issued,Title,Language,Authors,Subjects,LoCC,Bookshelves",
  '4280,Text,2003-07-01,The Critique of Pure Reason,en,"Kant, Immanuel, 1724-1804",Knowledge; Reason,B,Category: Philosophy & Ethics',
  '6342,Text,2004-08-01,Kritik der reinen Vernunft,de,"Kant, Immanuel, 1724-1804",Knowledge,B,',
  '1,Text,1971-12-01,The Declaration of Independence,en,"Jefferson, Thomas",United States -- History,E201,Politics',
  '99999,Sound,2010-01-01,Kant audio,en,"Kant, Immanuel",,,',
].join("\n");

test("catalogFromCsv keeps text entries only", () => {
  const cat = catalogFromCsv(CSV);
  assert.deepEqual(cat.map((b) => b.id), [4280, 6342, 1]);
  assert.equal(cat[0].authors, "Kant, Immanuel, 1724-1804");
});

test("searchCatalog matches all terms across title + authors", () => {
  const cat = catalogFromCsv(CSV);
  const hits = searchCatalog(cat, { terms: "kant critique", limit: 10 });
  assert.deepEqual(hits.map((b) => b.id), [4280]);
});

test("searchCatalog filters by language and topic", () => {
  const cat = catalogFromCsv(CSV);
  assert.deepEqual(searchCatalog(cat, { terms: "kant", languages: "de", limit: 10 }).map((b) => b.id), [6342]);
  assert.deepEqual(searchCatalog(cat, { topic: "philosophy", limit: 10 }).map((b) => b.id), [4280]);
  assert.equal(searchCatalog(cat, { terms: "kant", limit: 1 }).length, 1);
});

test("isGutenbergSite flags gutenberg.org but not mirrors or projekt-gutenberg.org", () => {
  assert.equal(isGutenbergSite("https://www.gutenberg.org/ebooks/4280.txt.utf-8"), true);
  assert.equal(isGutenbergSite("https://gutenberg.org/files/4280/4280-0.txt"), true);
  assert.equal(isGutenbergSite("https://WWW.Gutenberg.org/"), true);
  assert.equal(isGutenbergSite("https://gutenberg.pglaf.org/4/2/8/4280/4280-0.txt"), false);
  assert.equal(isGutenbergSite("https://www.projekt-gutenberg.org/kant/"), false);
  assert.equal(isGutenbergSite("not a url"), false);
});
