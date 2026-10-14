/** Isolated overlapping regions. Reuses the pinned splitter and frozen Jev/read decisions. */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { PiSearchBackend } from "../pi-search/searcher/contract/interface";
import { FIND_LIMITS, makeRequest, validateAnswers, type Region, type FindParams, type FindResponse } from "./jev_find_v1";
import { AUTO_READ_POLICY, planSourceReads } from "./jev_find_read_v1";
import { SplitWorker, makeChunkView, type SourceSegment } from "./jev_find_read_batch_splitter_v1";

type Span = { start_utf16: number; end_utf16: number };
type Cell = SourceSegment & { virtual_start: number; virtual_end: number };
type Observe = (row: Record<string, any>) => void;
type Options = { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; observe?: Observe; maxDocs?: number; concurrency?: number };
type Presentation = { original: string; virtual: string; base_segments: SourceSegment[]; segments: Cell[];
  regions: Region[]; skipped: { start_line: number; end_line: number; reason: string }[]; split_lines: number[] };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export class OverlapWorker {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, { child: ChildProcessWithoutNullStreams; resolve: (v: Span[]) => void; reject: (e: Error) => void }>();
  constructor(private env: NodeJS.ProcessEnv) {}
  async split(text: string): Promise<Span[]> {
    if (!this.child) {
      assert.ok(this.env.JEV_SPLITTER_PYTHON && this.env.JEV_OVERLAP_SCRIPT);
      const child = spawn(this.env.JEV_SPLITTER_PYTHON, [this.env.JEV_OVERLAP_SCRIPT], { env: this.env, stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      let stderr = "";
      child.stderr.on("data", b => { stderr = (stderr + String(b)).slice(-1000); });
      const fail = (error: Error) => { for (const [id, p] of this.pending) if (p.child === child) { p.reject(error); this.pending.delete(id); } };
      child.on("error", fail);
      child.on("exit", code => { if (this.child === child) this.child = undefined; if (this.pending.size) fail(new Error(`overlap splitter exit ${code}: ${stderr}`)); });
      createInterface({ input: child.stdout }).on("line", line => {
        try { const r = JSON.parse(line), p = this.pending.get(r.id); if (!p) return;
          this.pending.delete(r.id); if (r.ok) p.resolve(r.chunks); else p.reject(new Error(r.error));
        } catch (error) { fail(error as Error); }
      });
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => { this.pending.set(id, { child: this.child!, resolve, reject }); this.child!.stdin.write(JSON.stringify({ id, text }) + "\n"); });
  }
  close() { const child = this.child; this.child = undefined; child?.stdin.end(); }
}

export async function presentation(original: string, longLines: SplitWorker, overlap: OverlapWorker): Promise<Presentation> {
  const old = await makeChunkView(original, t => longLines.split(t));
  let offset = 0;
  const base = old?.segments ?? original.split(/\r?\n/).map((line, i) => {
    const s = { start_utf16: offset, end_utf16: offset + line.length, source_line: i + 1 };
    offset += line.length;
    if (offset < original.length) offset += original.startsWith("\r\n", offset) ? 2 : 1;
    return s;
  });
  const virtual = base.map(s => original.slice(s.start_utf16, s.end_utf16)).join("\n");
  const chunks = Buffer.byteLength(virtual) + 1 <= 60000 ? [{ start_utf16: 0, end_utf16: virtual.length }] : await overlap.split(virtual);
  const boundaries = [...new Set(chunks.flatMap(s => [s.start_utf16, s.end_utf16]))].sort((a, b) => a - b);
  const cells: Cell[] = []; let v = 0;
  for (const s of base) {
    const end = v + s.end_utf16 - s.start_utf16;
    const cuts = [v, ...boundaries.filter(p => p > v && p < end), end];
    for (let i = 1; i < cuts.length; i++) cells.push({ source_line: s.source_line,
      start_utf16: s.start_utf16 + cuts[i - 1] - v, end_utf16: s.start_utf16 + cuts[i] - v,
      virtual_start: cuts[i - 1], virtual_end: cuts[i] });
    v = end + 1;
  }
  const regions: Region[] = [], skipped: Presentation["skipped"] = [];
  let covered = 0;
  for (const chunk of chunks) {
    assert.ok(chunk.start_utf16 <= covered && chunk.end_utf16 >= covered);
    assert.ok(Buffer.byteLength(virtual.slice(chunk.start_utf16, chunk.end_utf16)) <= 60000);
    covered = chunk.end_utf16;
    const ids = cells.flatMap((s, i) => s.virtual_start >= chunk.start_utf16 && s.virtual_end <= chunk.end_utf16 &&
      (s.virtual_start < chunk.end_utf16 || chunk.end_utf16 === virtual.length) ? [i] : []);
    if (!ids.length) continue;
    const first = ids[0], last = ids.at(-1)!;
    assert.equal(ids.length, last - first + 1);
    if (regions.length >= FIND_LIMITS.regions) { skipped.push({ start_line: first + 1, end_line: last + 1, reason: "region_count_budget" }); continue; }
    const step = Math.ceil(ids.length / FIND_LIMITS.choices), blocks: Region["blocks"] = [];
    for (let i = first; i <= last; i += step) {
      const j = Math.min(last, i + step - 1), start_line = i + 1, end_line = j + 1;
      blocks.push({ id: i === j ? `L${start_line}` : `L${start_line}-${end_line}`, start_line, end_line,
        text: virtual.slice(cells[i].virtual_start, cells[j].virtual_end) });
    }
    regions.push({ start_line: first + 1, end_line: last + 1, blocks, state: blocks.map(b => `${b.id}| ${b.text}`).join("\n") });
  }
  assert.equal(covered, virtual.length);
  return { original, virtual, base_segments: base, segments: cells, regions, skipped, split_lines: old?.splitLines ?? [] };
}

export function originalSpan(p: Presentation, start: number, end: number) {
  assert.ok(start >= 1 && end >= start && end <= p.segments.length);
  const a = p.segments[start - 1], b = p.segments[end - 1];
  return { lines: [a.source_line, b.source_line], source_offsets_utf16: [a.start_utf16, b.end_utf16],
    text: p.original.slice(a.start_utf16, b.end_utf16) };
}

export function createBatchFindReader(options: Options = {}) {
  const env = options.env ?? process.env, send = options.fetchImpl ?? fetch;
  const observe: Observe = options.observe ?? (r => { if (env.JEV_FIND_LOG) appendFileSync(env.JEV_FIND_LOG, JSON.stringify(r) + "\n"); });
  const longLines = new SplitWorker(env), overlap = new OverlapWorker(env);
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
      const plans = documents.map(doc => ({ doc, plan: planSourceReads(doc, queries), delivered: { docid: doc.docid, passages: [], not_located_queries: [] as number[],
        ...(!doc.complete_scan ? { scan_incomplete: true } : {}), ...(doc.error ? { error: doc.error } : {}) } as any }));
      let used = 0;
      for (let i = 0; i < Math.max(0, ...plans.map(p => p.plan.ranges.length)); i++) for (const p of plans) {
        const range = p.plan.ranges[i], source = sources.get(p.doc.docid); if (!range || !source) continue;
        const span = originalSpan(source.p, range.start, range.end);
        if (used + span.text.length > AUTO_READ_POLICY.maxSourceChars) {
          (p.delivered.omitted_ranges ??= []).push(span.lines); (p.delivered.omitted_ranges_offsets_utf16 ??= []).push(span.source_offsets_utf16); continue;
        }
        const mapped = source.p.segments.some((s, i) => s.source_line !== i + 1);
        p.delivered.passages.push({ lines: span.lines, text: span.text, ...(mapped ? { source_offsets_utf16: span.source_offsets_utf16 } : {}),
          query_ids: range.query_ids, ...(range.fallback ? { fallback: true } : {}) }); used += span.text.length;
      }
      for (const p of plans) {
        p.delivered.not_located_queries = p.plan.not_located_queries;
        const got = new Set(p.delivered.passages.flatMap((v: any) => v.query_ids));
        const deferred = queries.map((_, i) => i + 1).filter(i => !p.plan.not_located_queries.includes(i) && !got.has(i));
        if (deferred.length) p.delivered.deferred_queries = deferred;
      }
      let note = "Verbatim source excerpts; lines are 1-indexed. query_ids refer to your input queries, not verified answers. Not located or omitted is not proof of absence. Use read_document for missing facts or surrounding context; otherwise continue research from this evidence.";
      if (plans.some(p => p.delivered.deferred_queries?.length)) note += " deferred_queries: Jev located a candidate, but its original source was not returned. This is not a negative finding; use read_document at omitted_ranges for budget-withheld source, or retry read_errors.";
      if (prepared.some(d => d.p.segments.some((s, i) => s.source_line !== i + 1))) note += " Long source lines were divided into chunks. Public lines refer to original lines; source_offsets_utf16 are exact half-open character ranges in the original document. Text is verbatim; a partial line is not the entire original line.";
      const output = { documents: plans.map(p => p.delivered), note };
      observe({ type: "find_read", batch, params, plans: plans.map(p => ({ docid: p.doc.docid, ...p.plan })), output, source_chars: used, elapsed_ms: performance.now() - started });
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], details: { jevFindRead: { batch, sourceChars: used, elapsedMs: performance.now() - started } } };
    } finally { longLines.close(); overlap.close(); }
  };
}
