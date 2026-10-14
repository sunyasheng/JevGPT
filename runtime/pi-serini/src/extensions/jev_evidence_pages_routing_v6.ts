// v6 starts ranked discovery with ten documents; explicit targets keep the frozen v5 schedule.
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { PiSearchBackend } from "../pi-search/searcher/contract/interface";
import { createBatchFindReader } from "./jev_evidence_pages_reader_v1";
import type { EvidenceDoc } from "./jev_adaptive_overlap_v1";
import { createPagedDocumentReader } from "./read_document_paged_v1";
import { mergeEvidence } from "./jev_evidence_pages_v1";
import { EvidenceStore, sourceKey, type MemoryWindow as StoredEvidence } from "./jev_evidence_store_v2";
import { readTargets, type RoutingInput } from "./jev_evidence_pages_routing_v1";
import { createRoutingGate, routingRequest, assessmentSnapshot, type Verdict, type GateOptions } from "./jev_evidence_pages_gate_v6";
import { ResearchProgress } from "./jev_research_progress_v2";
import { batchingPolicy } from "./jev_evidence_pages_batching_v6";
export { readTargets, type RoutingInput } from "./jev_evidence_pages_routing_v1";
export { createRoutingGate, routingRequest, decodeRouting, type RoutingContext, type Verdict } from "./jev_evidence_pages_gate_v6";

type Observe = (row: Record<string, any>) => void;
type Options = GateOptions & { store?: EvidenceStore; progress?: ResearchProgress; scan?: ReturnType<typeof createBatchFindReader>;
  judge?: ReturnType<typeof createRoutingGate>; page?: ReturnType<typeof createPagedDocumentReader> };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const useful = (d: EvidenceDoc) => ({ ...d, passages: d.passages.filter(p => !p.fallback && (p.query_ids.length > 0 || p.context_read)) });
const keys = (docs: EvidenceDoc[]) => new Set(docs.flatMap(d => useful(d).passages.map(p => sourceKey(d.docid, p))));
const hasCoverage = (v: Verdict, count: number) => !v.error && v.query_coverage?.length === count
  && v.query_coverage.every(n => Number.isFinite(n) && n >= 0 && n <= 1);

export function selectResearchPrior(store: EvidenceStore, input: RoutingInput, evidence: EvidenceDoc[]) {
  return store.selectResearch(input.queries, input.original_question, 8000, evidence.map(useful));
}

export function createRoutingReader(options: Options = {}) {
  const env = options.env ?? process.env;
  const observe: Observe = options.observe ?? (r => { if (env.JEV_FIND_LOG) appendFileSync(env.JEV_FIND_LOG, JSON.stringify(r) + "\n"); });
  const store = options.store ?? new EvidenceStore();
  const progress = options.progress ?? new ResearchProgress();
  const scan = options.scan ?? createBatchFindReader({ ...options, env, observe, maxDocs: 60, concurrency: 60 });
  const gate = options.judge ?? createRoutingGate({ ...options, env, observe });
  const page = options.page ?? createPagedDocumentReader(r => observe({ ...r, type: "routing_context_page" }));
  let callSeq = 0, queue: Promise<unknown> = Promise.resolve();
  const partialCache = new Map<string, { revision: number; progressRevision: number; output: any }>();
  const run = async (input: RoutingInput, backend: PiSearchBackend, signal?: AbortSignal) => {
    const callId = `jev_find:${++callSeq}`, docids = [...new Set(input.docids)];
    if (!docids.length || docids.length > 60) throw new Error("Expected 1–60 candidates");
    const fingerprint = hash(JSON.stringify([input.reason, input.queries, docids, input.primary_count]));
    const cached = partialCache.get(fingerprint);
    if (cached?.revision === store.revision && cached.progressRevision === progress.revision) {
      const output = structuredClone(cached.output); output.adaptive.reused_from = output.adaptive.call_id; output.adaptive.call_id = callId;
      observe({ type: "routing_cached", call_id: callId }); observe({ type: "adaptive_public", output });
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], details: { adaptive: output.adaptive, attemptedDocids: output.documents.map((d: EvidenceDoc) => d.docid) } };
    }
    const all: EvidenceDoc[] = [], stages: any[] = [], tried = new Set<string>();
    let scanned = 0, noProgress = 0, reads = 0, stopReason = "candidate_limit", note = "", last: Verdict | undefined;
    let lastPrior: StoredEvidence[] = [];
    let lastSuccessful: (ReturnType<typeof assessmentSnapshot> & { verdict: Verdict; unresolved_queries: { query_id: number; query: string }[] }) | undefined;
    const batching = batchingPolicy(input.primary_count);
    const initial = Math.min(docids.length, batching.initial);
    while (scanned < docids.length) {
      signal?.throwIfAborted();
      const from = scanned, end = Math.min(docids.length, scanned === 0 ? initial : scanned + batching.step), before = keys(all);
      const response = await scan({ reason: input.reason, queries: input.queries, docids: docids.slice(from, end) }, backend, signal);
      const result = JSON.parse(response.content[0].text); all.push(...result.documents); note = result.note; scanned = end;
      const added = [...keys(all)].filter(k => !before.has(k)).length;
      const success = result.documents.every((d: EvidenceDoc) => !d.error && !d.scan_incomplete && !d.omitted_ranges?.length && !d.deferred_queries?.length);
      if (from >= batching.minimumDiscoveryDocuments) noProgress = success && added === 0 ? noProgress + 1 : 0;
      else noProgress = 0;
      const stage: any = { from: from + 1, to: end, added_docids: docids.slice(from, end), new_located_passages: added, successful_scan: success, no_progress_batches: noProgress, routing_steps: [] };
      while (true) {
        const evidence = mergeEvidence(all);
        const prior = selectResearchPrior(store, input, evidence); lastPrior = prior;
        const targets = reads < 2 ? readTargets(evidence, tried, prior) : [];
        const ctx = { prior, targets, noProgress, reads, canExpand: scanned < docids.length, call_id: callId };
        const snapshot = assessmentSnapshot(routingRequest({ ...input, docids }, evidence, scanned, ctx, env.JEV_MODEL ?? "jev-1.13.0"), ctx);
        last = await gate({ ...input, docids }, evidence, scanned, ctx, signal);
        stage.routing_steps.push({ ...last, context_reads: reads, prior_ids: prior.map(p => p.id) });
        if (last.error || last.assessment_status === "unavailable") {
          stopReason = "assessment_unavailable";
          break; // A transport failure is not a request to scan more candidates.
        }
        if (hasCoverage(last, input.queries.length)) lastSuccessful = structuredClone({
          ...snapshot, verdict: last,
          unresolved_queries: input.queries.flatMap((q, i) => last!.query_coverage![i] < .5 ? [{ query_id: i + 1, query: q }] : []),
        });
        if (last.stop) { stopReason = "jev_sufficient"; break; }
        const target = targets.find(t => t.id === last!.target);
        if (last.action === "READ_CONTEXT" && target && reads < 2) {
          tried.add(target.id); reads++;
          observe({ type: "routing_context_request", call_id: callId, target, scanned_docids: docids.slice(0, scanned), ordinal: reads });
          try {
            const response = await page(target.params, backend, signal, `${callId}:context:${reads}`), p = response.details;
            const doc = all.find(d => d.docid === p.docid)!;
            const passage = { lines: p.original_lines, source_offsets_utf16: p.source_offsets_utf16, text: p.text, query_ids: [] as number[], context_read: true };
            const fresh = !useful(doc).passages.some(old => old.text.includes(p.text));
            if (fresh && p.text) doc.passages.unshift(passage);
            observe({ type: "routing_context_result", call_id: callId, target_id: target.id, new_source: fresh, source_offsets_utf16: p.source_offsets_utf16 });
          } catch (e) {
            if (signal?.aborted) throw e;
            observe({ type: "routing_context_error", call_id: callId, target_id: target.id, error: e instanceof Error ? e.message : String(e) });
          }
          continue;
        }
        if (last.action === "YIELD_PARTIAL" && noProgress >= 2) stopReason = "no_progress";
        break;
      }
      Object.assign(stage, { decision: last!.decision, stop: stopReason !== "candidate_limit", sufficient: last!.sufficient,
        query_coverage: last!.query_coverage, action: last!.action });
      stages.push(stage); observe({ type: "adaptive_stage", call_id: callId, reason: input.reason, ...stage });
      if (stopReason !== "candidate_limit") break;
    }
    const docs = mergeEvidence(all);
    const assessmentStatus = stopReason === "assessment_unavailable" ? "unavailable"
      : last && hasCoverage(last, input.queries.length) ? "assessed" : "not_assessed";
    const complete = assessmentStatus === "assessed" && Boolean(last?.stop && last.decision === "ANSWERED" && last.all_queries_answered);
    const unresolved = assessmentStatus === "assessed"
      ? input.queries.flatMap((q, i) => last!.query_coverage![i] < .5 ? [{ query_id: i + 1, query: q }] : []) : null;
    const unavailableFields = assessmentStatus === "assessed" ? {} : {
      unassessed_queries: input.queries.map((query, i) => ({ query_id: i + 1, query })),
      assessment_error: last?.error ? { message: last.error, kind: last.error_kind, attempts: last.attempts, retry_skipped: last.retry_skipped } : null,
      last_successful_assessment: lastSuccessful ? { ...lastSuccessful, applies_to: "recorded_query_and_source_snapshot_only" } : null,
    };
    if (assessmentStatus === "unavailable") note += " The latest Jev assessment was unavailable. This is not a finding of insufficient evidence. Review the returned source and the explicitly scoped last successful assessment; no judgment of the latest evidence is available. Do not restart research solely because complete=false.";
    const output = { documents: docs, note: note + (stopReason === "no_progress" ? " This ranking stopped adding located evidence. It does not establish absence or require another search." : "")
        + " Jev assessed only this call's verification questions and candidate ranking. The outer researcher decides whether to continue the original question using all evidence already returned in the conversation. An unresolved local question alone is not a command to search again.",
      adaptive: { call_id: callId, policy: "evidence_pages_v6", scanned, available: docids.length, stop_reason: stopReason, complete,
        completion_scope: "current_queries_only", research_decision_owner: "outer_agent",
        assessment_status: assessmentStatus, ...unavailableFields,
        unresolved_queries: unresolved, suggested_action: complete ? "use_evidence" : "review_available_evidence",
        stages, context_reads: reads, prior_evidence_refs: lastPrior.map(({ text, ...p }) => p), unscanned_docids: docids.slice(scanned) } };
    const committed = store.add(docs, callId, input.queries); observe({ type: "evidence_commit", source_call: callId, entries: committed });
    observe({ type: "research_progress", source_call: callId, ...progress.recordEvidence(callId, input, docs, assessmentStatus) });
    if (stopReason === "no_progress") {
      if (partialCache.size >= 16) partialCache.delete(partialCache.keys().next().value!);
      partialCache.set(fingerprint, { revision: store.revision, progressRevision: progress.revision, output: structuredClone(output) });
    }
    observe({ type: "adaptive_public", output });
    return { content: [{ type: "text" as const, text: JSON.stringify(output) }], details: { adaptive: output.adaptive, attemptedDocids: docids.slice(0, scanned) } };
  };
  const read = (input: RoutingInput, backend: PiSearchBackend, signal?: AbortSignal) => {
    const result = queue.then(() => run(input, backend, signal)); queue = result.catch(() => {}); return result;
  };
  read.reset = () => { partialCache.clear(); store.clear(); progress.clear(); };
  return read;
}
