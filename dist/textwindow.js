/**
 * Token-aware text windowing + extraction cache.
 *
 * Long bodies (PDFs, OCR scans, whole books) are the main driver of token use:
 * every character returned lands in the model's context and is re-sent on every
 * later turn. These helpers let the fetch tools page through a body in fixed
 * windows — returning only the slice the caller asked for and telling it the
 * exact `offset` to continue from — while caching the fully-extracted text so
 * paging never re-downloads or re-parses the source.
 */
const MAX_WINDOW = 200_000;
const MIN_WINDOW = 500;
/** Slice `text` to a single window starting at `offset`, clamped to sane bounds. */
export function windowText(text, maxChars, offset = 0) {
    const total = text.length;
    const max = Math.max(MIN_WINDOW, Math.min(maxChars, MAX_WINDOW));
    const off = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
    const start = Math.min(off, total);
    const end = Math.min(start + max, total);
    return {
        slice: text.slice(start, end),
        total,
        start,
        end,
        truncated: end < total,
        nextOffset: end < total ? end : null,
    };
}
/** One-line position/continuation note appended after a windowed slice. */
export function windowNote(w) {
    const span = `chars ${w.start.toLocaleString()}–${w.end.toLocaleString()} of ${w.total.toLocaleString()}`;
    if (w.truncated) {
        return `\n\n[${span}. More text remains — call again with offset=${w.nextOffset} to read the next part.]`;
    }
    return `\n\n[${span} — end of text.]`;
}
/** Note for an offset that lands at or past the end of the body. */
export function pastEndNote(total, offset) {
    return (`Offset ${offset.toLocaleString()} is at/past the end of the text ` +
        `(total ${total.toLocaleString()} chars). Nothing more to return.`);
}
/** Assemble a header + windowed body + continuation note in one shot. */
export function renderWindow(header, fullText, maxChars, offset = 0) {
    const w = windowText(fullText, maxChars, offset);
    if (w.total === 0)
        return `${header}\n\n(no readable text.)`;
    if (w.slice === "")
        return `${header}\n\n${pastEndNote(w.total, w.start)}`;
    return `${header}\n\n${w.slice}${windowNote(w)}`;
}
/**
 * Tiny bounded LRU cache for fully-extracted bodies, keyed by source id/URL.
 * Count-bounded (not byte-bounded) — a handful of books is plenty for paging
 * through one work at a time, and keeps the footprint of a local server small.
 */
export class LruCache {
    max;
    map = new Map();
    constructor(max = 8) {
        this.max = max;
    }
    get(key) {
        const v = this.map.get(key);
        if (v !== undefined) {
            // Refresh recency.
            this.map.delete(key);
            this.map.set(key, v);
        }
        return v;
    }
    set(key, val) {
        if (this.map.has(key))
            this.map.delete(key);
        this.map.set(key, val);
        while (this.map.size > this.max) {
            const oldest = this.map.keys().next().value;
            if (oldest === undefined)
                break;
            this.map.delete(oldest);
        }
    }
}
