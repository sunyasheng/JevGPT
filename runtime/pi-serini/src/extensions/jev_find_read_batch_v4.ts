import { appendFileSync } from "node:fs";
import type { PiSearchBackend } from "../pi-search/searcher/contract/interface";
import { createBatchFinder, type FindParams } from "./jev_find_batch_v4";

import { AUTO_READ_POLICY, planSourceReads, type DeliveredDoc } from "./jev_find_read_v1";
type FindDoc = Parameters<typeof planSourceReads>[0];

type Options = { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; observe?: (record: Record<string, unknown>) => void; maxDocs?: number; concurrency?: number };
export function createBatchFindReader(options: Options = {}) {
  const env = options.env ?? process.env;
  const observe = options.observe ?? ((record: Record<string, unknown>) => {
    if (env.JEV_FIND_LOG) appendFileSync(env.JEV_FIND_LOG, JSON.stringify(record) + "\n");
  });
  const finder = createBatchFinder({ ...options, env, observe });
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
