/** Minimal budget fix: distinguish unreturned locations from no location.
 * The frozen v4 source selection, budget, requests and excerpts are unchanged.
 * Automatic core-only recovery remains a separate experimental v1 policy. */
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import type { PiSearchBackend } from "../pi-search/searcher/contract/interface";
import type { FindParams } from "./jev_find_batch_v4";
import { createBatchFindReader as createLegacyReader } from "./jev_find_read_batch_v4";
import { planSourceReads, type DeliveredDoc } from "./jev_find_read_v1";

type LocatedDoc = Parameters<typeof planSourceReads>[0];
type CoverageDoc = DeliveredDoc & { deferred_queries?: number[] };
export type CoverageOutput = { documents: CoverageDoc[]; note: string };
type Options = { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch;
  observe?: (record: Record<string, unknown>) => void; maxDocs?: number; concurrency?: number };

export function correctBudgetCoverage(previous: CoverageOutput, located: LocatedDoc[], queries: string[]) {
  const output = structuredClone(previous);
  const byId = new Map(located.map(d => [d.docid, d]));
  let deferredPairs = 0, correctedDocuments = 0;
  for (let i = 0; i < output.documents.length; i++) {
    const doc = output.documents[i], location = byId.get(doc.docid);
    assert.ok(location, `Missing recorded location for ${doc.docid}`);
    const plan = planSourceReads(location, queries);
    const deliveredIds = new Set(doc.passages.flatMap(p => p.query_ids));
    const deferred = queries.map((_, q) => q + 1)
      .filter(q => !plan.not_located_queries.includes(q) && !deliveredIds.has(q));
    doc.not_located_queries = plan.not_located_queries;
    if (deferred.length) {
      doc.deferred_queries = deferred;
      deferredPairs += deferred.length;
      correctedDocuments++;
    } else delete doc.deferred_queries;
    assert.deepEqual(doc.passages, previous.documents[i].passages);
    assert.deepEqual(doc.omitted_ranges, previous.documents[i].omitted_ranges);
    assert.deepEqual(doc.read_errors, previous.documents[i].read_errors);
  }
  // Explain the extra field only when it is present; unaffected tool results
  // remain byte-for-byte identical to the original JSON payload.
  if (deferredPairs) output.note += " deferred_queries: Jev located a candidate, but its original source was not returned. This is not a negative finding; use read_document at omitted_ranges for budget-withheld source, or retry read_errors.";
  return { output, stats: { corrected_document_calls: correctedDocuments,
    deferred_query_document_pairs: deferredPairs, source_passages_changed: 0, extra_source_reads: 0, extra_model_calls: 0 } };
}

export function createBatchFindReader(options: Options = {}) {
  const env = options.env ?? process.env;
  const observe = options.observe ?? ((record: Record<string, unknown>) => {
    if (env.JEV_FIND_LOG) appendFileSync(env.JEV_FIND_LOG, JSON.stringify(record) + "\n");
  });
  const found = new Map<number, LocatedDoc[]>();
  const reads = new Map<number, Record<string, unknown>>();
  const legacy = createLegacyReader({ ...options, env, observe(record) {
    if (record.type === "find") found.set(Number(record.batch), (record.output as { documents: LocatedDoc[] }).documents);
    if (record.type === "find_read") {
      reads.set(Number(record.batch), record);
      observe({ ...record, type: "legacy_find_read" });
    } else observe(record);
  } });
  let sequence = 0;
  return async (params: FindParams, backend: PiSearchBackend, signal?: AbortSignal) => {
    const batch = ++sequence, started = performance.now();
    try {
      const result = await legacy(params, backend, signal);
      assert.equal(result.details.jevFindRead.batch, batch);
      const locations = found.get(batch), record = reads.get(batch);
      assert.ok(locations && record);
      const fixed = correctBudgetCoverage(JSON.parse(result.content[0].text), locations, params.queries.map(q => q.trim()));
      const elapsed = performance.now() - started;
      observe({ ...record, output: fixed.output, elapsed_ms: elapsed,
        budget_policy: "coverage_metadata_only_v2", budget_fix: fixed.stats });
      return { content: [{ type: "text" as const, text: JSON.stringify(fixed.output) }],
        details: { jevFindRead: { ...result.details.jevFindRead, elapsedMs: elapsed, budgetFix: fixed.stats } } };
    } finally {
      found.delete(batch); reads.delete(batch);
    }
  };
}
