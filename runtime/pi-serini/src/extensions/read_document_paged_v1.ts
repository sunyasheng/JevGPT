// Local-corpus adaptation of the MCP Fetch start_index/max_length pagination pattern.
// Coordinates are explicitly UTF-16, matching Jev source_offsets_utf16 (not Python indices).
import { Type, type Static } from "typebox";
import type { PiSearchBackend } from "../pi-search/searcher/contract/interface";

export const PAGE_CAP = 5000;
export const PagedReadParamsSchema = Type.Object({
  reason: Type.String({ description: "Brief reason for missing context, under 100 words." }),
  docid: Type.String({ minLength: 1 }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "Original 1-based line to start at; default 1. Do not combine with start_index." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Original lines requested; default 200. The 5000 UTF-16-unit page cap still applies. Do not combine with start_index." })),
  start_index: Type.Optional(Type.Integer({ minimum: 0, description: "Absolute 0-based UTF-16 position in original source, as in source_offsets_utf16. Use returned next_start_index to continue within a long line; do not combine with offset/limit." })),
  max_length: Type.Optional(Type.Integer({ minimum: 2, description: "Maximum source UTF-16 units per page, default and hard cap 5000. Larger requests are clamped. Unicode surrogate pairs and CRLF are kept intact." })),
});
export type PagedReadParams = Static<typeof PagedReadParamsSchema>;

export function originalLineStarts(text: string): number[] {
  const starts = [0];
  for (const match of text.matchAll(/\r?\n/g)) starts.push(match.index! + match[0].length);
  return starts;
}
export function originalLineAt(starts: number[], index: number): number {
  let lo = 0, hi = starts.length;
  while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (starts[mid] <= index) lo = mid; else hi = mid; }
  return lo + 1;
}
function bisectsPair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const a = text.charCodeAt(index - 1), b = text.charCodeAt(index);
  return (a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff) || (a === 13 && b === 10);
}
function integer(name: string, value: number, minimum: number) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a safe integer >= ${minimum}.`);
  return value;
}
export function pageOriginalSource(text: string, params: PagedReadParams, starts = originalLineStarts(text)) {
  const cap = Math.min(PAGE_CAP, integer("max_length", params.max_length ?? PAGE_CAP, 2));
  let start: number, requestedEnd = text.length;
  if (params.start_index !== undefined) {
    if (params.offset !== undefined || params.limit !== undefined) throw new Error("Use start_index OR offset/limit, not both.");
    start = integer("start_index", params.start_index, 0);
    if (start > text.length) throw new Error(`start_index exceeds source length ${text.length}.`);
    if (bisectsPair(text, start)) throw new Error(`start_index bisects a Unicode surrogate pair or CRLF; use ${start - 1}.`);
  } else {
    const offset = integer("offset", params.offset ?? 1, 1), limit = integer("limit", params.limit ?? 200, 1);
    if (offset > starts.length) throw new Error(`offset exceeds total original lines ${starts.length}.`);
    start = starts[offset - 1];
    requestedEnd = starts[Math.min(starts.length, offset - 1 + limit)] ?? text.length;
  }
  let end = Math.min(requestedEnd, start + cap);
  if (bisectsPair(text, end)) end--;
  const more = end < text.length;
  return {
    docid: params.docid,
    index_unit: "utf16" as const,
    source_offsets_utf16: [start, end] as [number, number],
    original_lines: [originalLineAt(starts, start), originalLineAt(starts, Math.max(start, end - 1))] as [number, number],
    total_lines: starts.length,
    total_length_utf16: text.length,
    max_length: cap,
    text: text.slice(start, end),
    has_more: more,
    ...(more ? { next_start_index: end,
      continuation: `For more original context call read_document with docid=${JSON.stringify(params.docid)}, start_index=${end}, max_length=${cap}, and reason. This can continue within the same original line; omit offset/limit.` } : {}),
  };
}

export function createPagedDocumentReader(observe?: (record: object) => void) {
  // Per-session bounded LRU. Source cache never changes the evidence or the public page.
  const cache = new Map<string, { text: string; starts: number[] }>();
  let cachedUnits = 0;
  return async (params: PagedReadParams, backend: PiSearchBackend, signal?: AbortSignal, toolCallId?: string) => {
    signal?.throwIfAborted();
    let source = cache.get(params.docid);
    if (!source) {
      const raw = await backend.readDocument({ docid: params.docid, offset: 1, limit: 1000000 }, signal);
      signal?.throwIfAborted();
      if (!raw.found) throw new Error(`Document ${params.docid} was not found.`);
      if (raw.truncated) throw new Error("Backend did not return complete source; cannot provide reliable absolute character cursors.");
      source = { text: raw.text, starts: originalLineStarts(raw.text) };
      if (source.text.length <= 10000000) {
        while (cache.size >= 8 || cachedUnits + source.text.length > 10000000) {
          const key = cache.keys().next().value!;
          cachedUnits -= cache.get(key)!.text.length; cache.delete(key);
        }
        cache.set(params.docid, source); cachedUnits += source.text.length;
      }
    } else { cache.delete(params.docid); cache.set(params.docid, source); }
    const output = pageOriginalSource(source.text, params, source.starts);
    observe?.({ type: "paged_read", tool_call_id: toolCallId, params, output });
    return { content: [{ type: "text" as const, text: JSON.stringify(output) }], details: output };
  };
}
