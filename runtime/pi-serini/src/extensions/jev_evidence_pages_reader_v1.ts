/** Independent output-paging experiment; input presentation and locator requests are frozen. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { PiSearchBackend } from "../pi-search/searcher/contract/interface";
import { FIND_LIMITS, makeRequest, validateAnswers, type Region, type FindParams, type FindResponse } from "./jev_find_v1";
import { SplitWorker } from "./jev_find_read_batch_splitter_v1";
import { OverlapWorker, presentation } from "./jev_overlap_reader_v1";
import { pageLocatedSource, mergeEvidence } from "./jev_evidence_pages_v1";
type Presentation = Awaited<ReturnType<typeof presentation>>;
type Observe = (row: Record<string, any>) => void;
type Options = { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; observe?: Observe; maxDocs?: number; concurrency?: number };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export function createBatchFindReader(options: Options = {}) {
  const env = options.env ?? process.env, send = options.fetchImpl ?? fetch;
  const observe: Observe = options.observe ?? (r => { if (env.JEV_FIND_LOG) appendFileSync(env.JEV_FIND_LOG, JSON.stringify(r) + "\n"); });
  const longLines = new SplitWorker(env), overlap = new OverlapWorker(env);
  const pages = new OverlapWorker({ ...env, JEV_OVERLAP_SCRIPT: env.JEV_EVIDENCE_PAGE_SCRIPT });
  const sources = new Map<string, { p: Presentation; incomplete: boolean }>();
  const judgments = new Map<string, ReturnType<typeof validateAnswers>>(); let sequence = 0;
  return async (params: FindParams, backend: PiSearchBackend, signal?: AbortSignal) => {
    const batch = ++sequence, started = performance.now(), queries = params.queries.map(q => q.trim());
    const docids = [...new Set(params.docids)];
    assert.ok(docids.length >= 1 && docids.length <= (options.maxDocs ?? 60));
    assert.ok(queries.length >= 1 && queries.length <= 6 && queries.every(Boolean) && new Set(queries).size === queries.length);
    const documents: any[] = [], prepared: { docid: string; p: Presentation; incomplete: boolean }[] = [];
    try {
      for (const docid of docids) {
        signal?.throwIfAborted(); let source = sources.get(docid);
        if (!source) {
          const t = performance.now();
          const r = await backend.readDocument({ docid, offset: 1, limit: FIND_LIMITS.readLines }, signal);
          observe({ type: "backend_read", batch, docid, found: r.found, elapsed_ms: performance.now() - t, total_lines: r.found ? r.totalUnits : null, truncated: r.found ? r.truncated : null });
          if (!r.found) { documents.push({ docid, error: "not_found", complete_scan: false }); continue; }
          const p = await presentation(r.text, longLines, overlap); source = { p, incomplete: Boolean(r.truncated) }; sources.set(docid, source);
          observe({ type: "overlap_source_map", docid, source_sha256: sha(r.text), source_chars_utf16: r.text.length,
            base_segments: p.base_segments, segments: p.segments, split_lines: p.split_lines, skipped: p.skipped,
            regions: p.regions.map(r => ({ start_line: r.start_line, end_line: r.end_line, blocks: r.blocks.map(({ text, ...b }) => b) })),
            capacity_bytes: 60000, overlap_bytes: 1024, package: "semantic-text-splitter==0.33.0" });
        }
        prepared.push({ docid, ...source });
      }
      const jobs = prepared.flatMap(d => d.p.regions.map(region => ({ docid: d.docid, region })));
      const answers: { docid: string; region: Region; ok: boolean; results?: ReturnType<typeof validateAnswers>; error?: string }[] = new Array(jobs.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 60, jobs.length) }, async () => {
        while (next < jobs.length) {
          const i = next++, job = jobs[i], request = makeRequest(job.docid, job.region, queries, env.JEV_MODEL ?? "jev-1.13.0"), hash = sha(JSON.stringify(request));
          const cached = judgments.get(hash);
          if (cached) { observe({ type: "judge_cache", batch, docid: job.docid, request_sha256: hash }); answers[i] = { ...job, ok: true, results: cached }; continue; }
          const t = performance.now(); const record: any = { type: "judge", batch, docid: job.docid, request, request_sha256: hash, attempt: 1, started_at: new Date().toISOString(), started_perf_ms: t };
          try {
            signal?.throwIfAborted(); assert.ok(env.TYPESAFE_API_KEY);
            const timeout = AbortSignal.timeout(FIND_LIMITS.timeoutMs);
            const response = await send(env.JEV_URL ?? "https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.TYPESAFE_API_KEY}` },
              body: JSON.stringify(request), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
            record.http_status = response.status; if (!response.ok) throw new Error(`http_${response.status}`);
            record.response = await response.json() as FindResponse;
            const results = validateAnswers(record.response, job.region, queries); judgments.set(hash, results);
            record.ok = true; answers[i] = { ...job, ok: true, results };
          } catch (e) { record.ok = false; record.error = e instanceof Error ? e.message : String(e); answers[i] = { ...job, ok: false, error: record.error }; }
          finally { record.ended_perf_ms = performance.now(); record.elapsed_ms = record.ended_perf_ms - t; observe(record); }
        }
      }));
      signal?.throwIfAborted();
      for (const d of prepared) {
        const rows = answers.filter(a => a.docid === d.docid);
        documents.push({ docid: d.docid, total_lines: d.p.segments.length, source_chars: d.p.original.length,
          complete_scan: !d.incomplete && !d.p.skipped.length && rows.every(r => r.ok), source_truncated: d.incomplete, skipped_ranges: d.p.skipped,
          regions: rows.map(({ region, ...r }) => ({ start_line: region.start_line, end_line: region.end_line, ...(r.ok ? { results: r.results!.map(result => ({ ...result,
            hits: result.hits.map(hit => ({ ...hit, suggested_read: { offset: Math.max(1, hit.start_line - 4), limit: Math.min(d.p.segments.length, hit.end_line + 8) - Math.max(1, hit.start_line - 4) + 1 } })) })) } : { error: r.error }) })) });
      }
      documents.sort((a, b) => docids.indexOf(a.docid) - docids.indexOf(b.docid));
      observe({ type: "find", batch, params, output: { documents }, elapsed_ms: performance.now() - started });
      const plans = [];
      for (const doc of documents) {
        const source = sources.get(doc.docid);
        if (!source) { plans.push({ doc: { docid: doc.docid, passages: [], error: doc.error, scan_incomplete: true }, plan: {}, oversize_ranges: 0 }); continue; }
        plans.push(await pageLocatedSource(doc, queries, source.p, text => pages.split(text)));
      }
      const delivered = mergeEvidence(plans.map(p => p.doc));
      const used = delivered.reduce((n, d) => n + d.passages.reduce((v, p) => v + p.text.length, 0), 0);
      const output = { documents: delivered, note: "Verbatim source pages, at most 4000 UTF-16 units each and 20000 total. Original lines and half-open source_offsets_utf16 are preserved; a page can contain only part of a line. Hit pages precede surrounding context. query_ids and selected_hits are retrieval associations, not verified answers. deferred_queries means some selected hit source is missing; omitted_pages lists bounded source windows withheld by the budget, in priority order. Read a missing page with read_document(docid, start_index=source_offsets_utf16[0], max_length=end-start), or continue from its end. Omission, not_located and failed scans never prove absence." };
      observe({ type: "evidence_paging", batch, page_cap_utf16: 4000, overlap_cap_utf16: 128,
        documents: plans.map(p => ({ docid: p.doc.docid, oversize_ranges: p.oversize_ranges,
          candidates: p.doc.passages.map(({ text, ...metadata }) => ({ ...metadata, chars: text.length })) })) });
      observe({ type: "find_read", batch, params, plans: plans.map(p => ({ docid: p.doc.docid, ...p.plan })), output, source_chars: used, elapsed_ms: performance.now() - started });
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], details: { jevFindRead: { batch, sourceChars: used, elapsedMs: performance.now() - started } } };
    } finally { longLines.close(); overlap.close(); pages.close(); }
  };
}
