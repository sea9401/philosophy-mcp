/**
 * Project Gutenberg access via official mirrors only.
 *
 * gutenberg.org is "intended for human users only" and blocks automated access
 * (https://www.gutenberg.org/policy/robot_access.html); the policy points
 * programs at mirrors and the public-domain offline catalog instead. Mirrors
 * come from https://www.gutenberg.org/MIRRORS.ALL. Pure helpers live here so
 * they can be tested without the network.
 */
// HTTPS mirrors from MIRRORS.ALL. ODU and XMission are fast; PGLAF also carries
// the generated cache/ tree but is very slow (~40 KB/s), so it is the last resort.
const ODU_GENERATED = "https://mirror.cs.odu.edu/gutenberg-epub/"; // cache/epub tree: <id>/pg<id>.txt, feeds/
const ODU = "https://mirror.cs.odu.edu/gutenberg/";
const XMISSION = "https://mirrors.xmission.com/gutenberg/";
const PGLAF = "https://gutenberg.pglaf.org/";
export const GUTENBERG_MIRRORS = [ODU_GENERATED, ODU, XMISSION, PGLAF];
/** Offline catalog (public domain), fast mirror first. */
export const GUTENBERG_CATALOG_URLS = [
    `${ODU_GENERATED}feeds/pg_catalog.csv.gz`,
    `${PGLAF}cache/epub/feeds/pg_catalog.csv.gz`,
];
/** True for gutenberg.org itself (human-only site), not its mirrors or projekt-gutenberg.org. */
export function isGutenbergSite(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host === "gutenberg.org" || host === "www.gutenberg.org";
    }
    catch {
        return false;
    }
}
/** Mirror directory for a book id: 4280 -> "4/2/8/4280", 12 -> "1/12", 5 -> "0/5". */
function mirrorDir(id) {
    const s = String(id);
    const parents = s.length === 1 ? ["0"] : s.slice(0, -1).split("");
    return [...parents, s].join("/");
}
/** Candidate plain-text URLs for a book, most reliable first. */
export function gutenbergTextUrls(id) {
    const dir = mirrorDir(id);
    return [
        `${ODU_GENERATED}${id}/pg${id}.txt`, // generated UTF-8 text exists for every book
        `${ODU}${dir}/${id}-0.txt`,
        `${XMISSION}${dir}/${id}-0.txt`,
        `${ODU}${dir}/${id}.txt`, // older ASCII-only uploads
        `${PGLAF}cache/epub/${id}/pg${id}.txt`,
    ];
}
/** Minimal RFC 4180 CSV parser (quoted fields, "" escapes, embedded newlines). */
export function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                }
                else {
                    quoted = false;
                }
            }
            else {
                field += ch;
            }
        }
        else if (ch === '"') {
            quoted = true;
        }
        else if (ch === ",") {
            row.push(field);
            field = "";
        }
        else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && text[i + 1] === "\n")
                i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        }
        else {
            field += ch;
        }
    }
    if (field || row.length) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}
/** Build a searchable catalog from pg_catalog.csv, keeping text entries only. */
export function catalogFromCsv(csv) {
    const [header, ...rows] = parseCsv(csv);
    const col = (name) => header.indexOf(name);
    const [iId, iType, iTitle, iLang, iAuthors, iSubjects, iShelves] = [
        "Text#", "Type", "Title", "Language", "Authors", "Subjects", "Bookshelves",
    ].map(col);
    const books = [];
    for (const r of rows) {
        const id = parseInt(r[iId] ?? "", 10);
        if (!Number.isFinite(id) || r[iType] !== "Text")
            continue;
        const title = (r[iTitle] ?? "").replace(/\s+/g, " ").trim();
        const authors = (r[iAuthors] ?? "").trim();
        books.push({
            id,
            title,
            authors,
            languages: (r[iLang] ?? "").split(/[;,\s]+/).filter(Boolean),
            topics: `${r[iSubjects] ?? ""} ${r[iShelves] ?? ""}`.toLowerCase(),
            haystack: `${title} ${authors}`.toLowerCase(),
        });
    }
    return books;
}
/** All terms must appear in title/authors; topic and languages narrow further. */
export function searchCatalog(books, q) {
    const words = (q.terms ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const topic = (q.topic ?? "").toLowerCase().trim();
    const langs = (q.languages ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean);
    const out = [];
    for (const b of books) {
        if (words.some((w) => !b.haystack.includes(w)))
            continue;
        if (topic && !b.topics.includes(topic))
            continue;
        if (langs.length && !b.languages.some((l) => langs.includes(l)))
            continue;
        out.push(b);
        if (out.length >= q.limit)
            break;
    }
    return out;
}
