import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { PiSearchBackend } from "../pi-search/searcher/contract/interface";

// New experimental runtime. The original finder and selection primitives stay frozen.
import { FIND_LIMITS as ORIGINAL_LIMITS, makeRegions, makeRequest, validateAnswers,
  type FindParams, type FindResponse, type Region } from "./jev_find_v1";
export { type FindParams } from "./jev_find_v1";
export const FIND_LIMITS = Object.freeze({ ...ORIGINAL_LIMITS, docs: 60, concurrency: 60 });

const digest = (s: string) => createHash("sha256").update(s).digest("hex");

async function mapLimit<T, R>(items: T[], concurrency: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; result[index] = await fn(items[index]); }
  }));
  return result;
}

type Options = { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; observe?: (r: Record<string, unknown>) => void; maxDocs?: number; concurrency?: number };

export function createBatchFinder(options: Options = {}) {
  const maxDocs = options.maxDocs ?? FIND_LIMITS.docs, concurrency = options.concurrency ?? FIND_LIMITS.concurrency;
  if (![maxDocs, concurrency].every(n => Number.isInteger(n) && n >= 1 && n <= 60)) throw new Error("Batch limits must be integers from 1 to 60");
  const env = options.env ?? process.env, send = options.fetchImpl ?? fetch;
  const observe = options.observe ?? ((record: Record<string, unknown>) => {
    if (env.JEV_FIND_LOG) appendFileSync(env.JEV_FIND_LOG, JSON.stringify(record) + "\n");
  });
  const sources = new Map<string, { text: string; totalLines: number; incomplete: boolean }>();
  const judgments = new Map<string, ReturnType<typeof validateAnswers>>();
  let sequence = 0;

  async function judge(docid: string, region: Region, queries: string[], batch: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const payload = makeRequest(docid, region, queries, env.JEV_MODEL ?? "jev-1.13.0");
    const hash = digest(JSON.stringify(payload)), cached = judgments.get(hash);
    if (cached) { observe({ type: "judge_cache", batch, request_sha256: hash }); return { ok: true as const, results: cached }; }
    const start = performance.now();
    const record: Record<string, unknown> = { type: "judge", batch, docid, request_sha256: hash,
      request: payload, attempt: 1, started_at: new Date().toISOString(), started_perf_ms: start };
    try {
      if (!env.TYPESAFE_API_KEY) throw new Error("missing_key");
      const timeout = AbortSignal.timeout(FIND_LIMITS.timeoutMs);
      const response = await send(env.JEV_URL ?? "https://api.typesafe.ai/v1/systemone", {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.TYPESAFE_API_KEY}` },
        body: JSON.stringify(payload), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      record.http_status = response.status;
      if (!response.ok) throw new Error(`http_${response.status}`);
      const body = await response.json() as FindResponse; record.response = body;
      const results = validateAnswers(body, region, queries);
      record.ok = true; judgments.set(hash, results); return { ok: true as const, results };
    } catch (error) {
      record.ok = false; record.error = error instanceof Error ? error.message : "unknown_error";
      if (signal?.aborted) throw signal.reason ?? error;
      return { ok: false as const, error: String(record.error) };
    } finally { record.ended_perf_ms = performance.now(); record.elapsed_ms = Number(record.ended_perf_ms) - start; observe(record); }
  }

  return async (params: FindParams, backend: PiSearchBackend, signal?: AbortSignal) => {
    const batch = ++sequence, started = performance.now(); signal?.throwIfAborted();
    const docids = [...new Set(params.docids)], queries = [...new Set(params.queries.map(q => q.trim()))];
    if (!docids.length || docids.length > maxDocs || !queries.length || queries.length > FIND_LIMITS.queries || queries.some(q => !q))
      throw new Error(`jev_find expects 1–${maxDocs} docids and 1–6 non-empty queries`);
    if (queries.length !== params.queries.length) throw new Error("Use distinct non-empty questions; query_ids follow input order");
    const prepared: { docid: string; source: NonNullable<ReturnType<typeof sources.get>>; split: ReturnType<typeof makeRegions> }[] = [];
    const documents: Record<string, unknown>[] = [];
    for (const docid of docids) {
      signal?.throwIfAborted(); let source = sources.get(docid);
      if (!source) {
        const start = performance.now();
        try {
          const response = await backend.readDocument({ docid, offset: 1, limit: FIND_LIMITS.readLines }, signal);
          observe({ type: "backend_read", batch, docid, found: response.found, elapsed_ms: performance.now() - start,
            total_lines: response.found ? response.totalUnits : null, truncated: response.found ? response.truncated : null });
          if (!response.found) { documents.push({ docid, error: "not_found" }); continue; }
          source = { text: response.text, totalLines: response.totalUnits ?? response.text.split(/\r?\n/).length,
            incomplete: Boolean(response.truncated) }; sources.set(docid, source);
        } catch (error) {
          if (signal?.aborted) throw error;
          documents.push({ docid, error: "backend_read_failed", fallback: "Use read_document directly." }); continue;
        }
      }
      const split = makeRegions(source.text);
      prepared.push({ docid, source, split });
    }
    const jobs = prepared.flatMap(d => d.split.regions.map(region => ({ docid: d.docid, region })));
    const answers = await mapLimit(jobs, concurrency, async job => ({ ...job, answer: await judge(job.docid, job.region, queries, batch, signal) }));
    for (const { docid, source, split } of prepared) {
      const rows = answers.filter(r => r.docid === docid);
      documents.push({ docid, total_lines: source.totalLines, source_chars: source.text.length,
        complete_scan: !source.incomplete && !split.skipped.length && rows.every(r => r.answer.ok),
        skipped_ranges: split.skipped, source_truncated: source.incomplete,
        regions: rows.map(({ region, answer }) => ({ start_line: region.start_line, end_line: region.end_line,
          ...(answer.ok ? { results: answer.results.map(result => ({ ...result,
            hits: result.hits.map(hit => ({ ...hit, suggested_read: { offset: Math.max(1, hit.start_line - 4),
              limit: Math.min(source.totalLines, hit.end_line + 8) - Math.max(1, hit.start_line - 4) + 1 } })) })) }
            : { error: answer.error, fallback: "Use read_document directly; unavailable is not absence of evidence." }) })) });
    }
    const output = { documents, note: "Locations only: call read_document to read and verify original evidence. Choice probabilities are relative within one region, not independent relevance probabilities; do not compare them across regions. Noul exists estimates whether that region addresses the query, not whether the final answer is correct. Low scores and failed/incomplete scans do not prove absence. You may read directly when uncertain. Batch independent reads for distinct ranges when appropriate." };
    observe({ type: "find", batch, params, output, elapsed_ms: performance.now() - started });
    return { content: [{ type: "text" as const, text: JSON.stringify(output) }],
      details: { jevFind: { batch, docids, queries, elapsed_ms: performance.now() - started } } };
  };
}
