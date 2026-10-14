import { appendFileSync } from "node:fs";
import type { PiSearchBackend } from "../pi-search/searcher/contract/interface";
import { createFinder, type FindParams } from "./jev_find_v1";

export const AUTO_READ_POLICY = Object.freeze({ minExists: 0.5, secondaryMinProbability: 0.15,
  secondaryWhenTopBelow: 0.8, maxSourceChars: 20000, fallbackLines: 40 });
type Hit = { start_line: number; end_line: number; choice_probability: number; suggested_read: { offset: number; limit: number } };
type Located = { query: string; exists: number; hits: Hit[] };
type FindDoc = { docid: string; total_lines?: number; error?: string; complete_scan?: boolean;
  regions?: { error?: string; results?: Located[] }[] };
export type SourceRange = { start: number; end: number; query_ids: number[]; fallback?: boolean };
export type Passage = { lines: [number, number]; query_ids: number[]; text: string; fallback?: boolean };
export type DeliveredDoc = { docid: string; passages: Passage[]; not_located_queries: number[];
  scan_incomplete?: boolean; omitted_ranges?: [number, number][]; read_errors?: [number, number][]; error?: string };

/** Union overlapping/adjacent source ranges, preserving their query associations. */
export function mergeSourceRanges(ranges: SourceRange[]): SourceRange[] {
  const merged: SourceRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
      previous.query_ids = [...new Set([...previous.query_ids, ...range.query_ids])].sort((a, b) => a - b);
      if (range.fallback) previous.fallback = true;
    } else merged.push({ ...range, query_ids: [...range.query_ids] });
  }
  return merged;
}

/** Fixed before evaluation; no gold labels, lexical reranker, or generated facts. */
export function planSourceReads(doc: FindDoc, queries: string[]) {
  const ranges: SourceRange[] = [], selected = new Set<number>();
  for (const region of doc.regions ?? []) for (const result of region.results ?? []) {
    const qid = queries.indexOf(result.query) + 1;
    if (!qid || result.exists < AUTO_READ_POLICY.minExists) continue;
    const positive = result.hits.filter(h => h.choice_probability > 0);
    const primary = positive[0]; if (!primary) continue;
    const chosen = [primary];
    if (primary.choice_probability < AUTO_READ_POLICY.secondaryWhenTopBelow &&
      positive[1]?.choice_probability >= AUTO_READ_POLICY.secondaryMinProbability) chosen.push(positive[1]);
    for (const hit of chosen) ranges.push({ start: hit.suggested_read.offset,
      end: hit.suggested_read.offset + hit.suggested_read.limit - 1, query_ids: [qid] });
    selected.add(qid);
  }
  const scanFailed = !doc.complete_scan || Boolean(doc.error);
  if (scanFailed) ranges.push({ start: 1, end: Math.min(doc.total_lines ?? AUTO_READ_POLICY.fallbackLines,
    AUTO_READ_POLICY.fallbackLines), query_ids: [], fallback: true });
  return { ranges: mergeSourceRanges(ranges), not_located_queries: queries.map((_, i) => i + 1).filter(i => !selected.has(i)) };
}

type Options = { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; observe?: (record: Record<string, unknown>) => void };
export function createFindReader(options: Options = {}) {
  const env = options.env ?? process.env;
  const observe = options.observe ?? ((record: Record<string, unknown>) => {
    if (env.JEV_FIND_LOG) appendFileSync(env.JEV_FIND_LOG, JSON.stringify(record) + "\n");
  });
  const finder = createFinder({ ...options, env, observe });
  let sequence = 0;
  return async (params: FindParams, backend: PiSearchBackend, signal?: AbortSignal) => {
    const batch = ++sequence, start = performance.now();
    const found = await finder(params, backend, signal);
    const located = JSON.parse(found.content[0].text) as { documents: FindDoc[] };
    const queries = [...new Set(params.queries.map(q => q.trim()))];
    const plans = located.documents.map(doc => ({ doc, plan: planSourceReads(doc, queries), delivered: {
      docid: doc.docid, passages: [], not_located_queries: [] as number[],
      ...(!doc.complete_scan ? { scan_incomplete: true } : {}), ...(doc.error ? { error: doc.error } : {}),
    } as DeliveredDoc }));
    const maxGroups = Math.max(0, ...plans.map(p => p.plan.ranges.length));
    let usedChars = 0;
    // Round-robin documents so an early document cannot consume every passage slot.
    for (let i = 0; i < maxGroups; i++) for (const p of plans) {
      const range = p.plan.ranges[i]; if (!range) continue;
      signal?.throwIfAborted();
      try {
        const t = performance.now();
        const result = await backend.readDocument({ docid: p.doc.docid, offset: range.start, limit: range.end - range.start + 1 }, signal);
        observe({ type: "auto_backend_read", batch, docid: p.doc.docid, range, found: result.found, elapsed_ms: performance.now() - t });
        if (!result.found) { (p.delivered.read_errors ??= []).push([range.start, range.end]); continue; }
        if (usedChars + result.text.length > AUTO_READ_POLICY.maxSourceChars) {
          (p.delivered.omitted_ranges ??= []).push([range.start, range.end]); continue;
        }
        const lines = result.text.split(/\r?\n/).length;
        const end = Math.min(range.end, result.totalUnits ?? range.start + lines - 1);
        if (end < range.start) { (p.delivered.read_errors ??= []).push([range.start, range.end]); continue; }
        p.delivered.passages.push({ lines: [range.start, end], query_ids: range.query_ids, text: result.text,
          ...(range.fallback ? { fallback: true } : {}) });
        usedChars += result.text.length;
      } catch (error) {
        if (signal?.aborted) throw error;
        (p.delivered.read_errors ??= []).push([range.start, range.end]);
        observe({ type: "auto_read_error", batch, docid: p.doc.docid, range, error: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const p of plans) {
      const deliveredIds = new Set(p.delivered.passages.flatMap(s => s.query_ids));
      p.delivered.not_located_queries = queries.map((_, i) => i + 1).filter(i => !deliveredIds.has(i));
    }
    const output = { documents: plans.map(p => p.delivered), note: "Verbatim source excerpts; lines are 1-indexed. query_ids refer to your input queries, not verified answers. Not located or omitted is not proof of absence. Use read_document for missing facts or surrounding context; otherwise continue research from this evidence." };
    observe({ type: "find_read", batch, params, plans: plans.map(p => ({ docid: p.doc.docid, ...p.plan })),
      output, source_chars: usedChars, elapsed_ms: performance.now() - start });
    return { content: [{ type: "text" as const, text: JSON.stringify(output) }], details: {
      jevFindRead: { batch, autoDeliveredDocids: plans.filter(p => p.delivered.passages.length).map(p => p.doc.docid),
        sourceChars: usedChars, elapsedMs: performance.now() - start } } };
  };
}
