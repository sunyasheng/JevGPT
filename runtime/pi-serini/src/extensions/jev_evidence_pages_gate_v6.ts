/** Local retrieval decisions only; the outer agent owns whole-question research. */
import { createHash } from "node:crypto";
import { routingRequest as frozenRequest, decodeRouting as frozenDecode, type RoutingInput, type RoutingContext as FrozenContext } from "./jev_evidence_pages_routing_v1";
import type { EvidenceDoc } from "./jev_adaptive_overlap_v1";
import { batchingPolicy } from "./jev_evidence_pages_batching_v6";
export type RoutingContext = FrozenContext;

export type Verdict = {
  stop: boolean; decision: string; sufficient: number | null; action: string; target?: string;
  query_coverage?: number[]; all_queries_answered?: boolean; error?: string;
  assessment_status?: "assessed" | "unavailable" | "not_assessed"; [key: string]: unknown;
};
export type GateOptions = {
  env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; observe?: (row: Record<string, any>) => void;
  /** Remaining research time, excluding the harness's final-answer window. Unknown means no retry. */
  remainingTimeMs?: () => number;
  timeoutMs?: number; reserveMs?: number;
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** Bind the requested read and its target in one choice. ADVANCE also handles an exhausted ranking. */
export function localActions(ctx: RoutingContext): Record<string, string> {
  return {
    ADVANCE: ctx.canExpand
      ? "Inspect the next batch in this ranking if local evidence is insufficient; sufficient evidence returns immediately without another batch."
      : "Return the collected evidence from this exhausted ranking; this does not decide the original research question.",
    ...(ctx.noProgress >= 2 ? { YIELD_PARTIAL: "Return partial evidence after two successful later batches added no located evidence. This only ends this ranking." } : {}),
    ...Object.fromEntries((ctx.reads < 2 ? ctx.targets : []).map(t => [`READ_${t.id}`, t.description])),
  };
}

export function routingRequest(input: RoutingInput, docs: EvidenceDoc[], scanned: number, ctx: RoutingContext, model: string) {
  const base = frozenRequest(input, docs, scanned, ctx, model);
  const { next_action: _action, read_target: _target, ...questions } = base.questions;
  const { no_progress_batches_after_first11: _legacyCount, ...routing } = base.state.routing;
  return { ...base, state: { ...base.state, routing: { ...routing, no_progress_batches: ctx.noProgress }, assessment_scope: "current_queries_and_candidate_ranking_only" },
    questions: { ...questions, next_action: { type: "choice",
      instructions: "Choose a concrete next action WITHIN THIS retrieval call if its current verification questions are not sufficiently answered. A READ action includes one offered source-window ID; choose it only if that window can clarify a missing local fact. Otherwise ADVANCE through this ranking. YIELD_PARTIAL is offered only after two successful later batches added no located evidence. When local evidence already suffices, choose ADVANCE; the completeness rule returns it without scanning. Use the original question only to resolve entities and relationships. The outer researcher, using the full conversation, decides whether to answer the original question or start another search. Do not make that global decision here. Missing source is not negative evidence.",
      criteria: localActions(ctx) } } };
}

export function decodeRouting(body: any, scanned: number, queries: number, ctx: RoutingContext, minimumDiscoveryDocuments = 10): Verdict {
  const a = body?.answers?.next_action, labels = Object.keys(localActions(ctx));
  if (a?.type !== "choice" || !labels.includes(a.choice)
    || !labels.every(k => Number.isFinite(a.probabilities?.[k]) && a.probabilities[k] >= 0 && a.probabilities[k] <= 1)
    || Object.keys(a.probabilities ?? {}).some(k => !labels.includes(k))
    || Math.abs(labels.reduce((n, k) => n + a.probabilities[k], 0) - 1) > .03)
    throw new Error("Invalid local retrieval action");
  const target = a.choice.startsWith("READ_") ? a.choice.slice(5) : "NONE";
  const action = target !== "NONE" ? "READ_CONTEXT" : a.choice === "YIELD_PARTIAL" ? "YIELD_PARTIAL" : "EXPAND";
  const choose = (value: string, choices: string[]) => ({ type: "choice", choice: value,
    probabilities: Object.fromEntries(choices.map(k => [k, k === value ? 1 : 0])) });
  // Preserve frozen schema/coverage validation; adapt only the discovery warmup to this entry mode.
  const verdict = frozenDecode({ ...body, answers: { ...body.answers,
    next_action: choose(action, ["READ_CONTEXT", "EXPAND", "YIELD_PARTIAL"]),
    read_target: choose(target, ["NONE", ...ctx.targets.map(t => t.id)]),
  } }, scanned, queries, ctx);
  if (verdict.decision === "NEXT_STEP") {
    const eligible = Number(verdict.discovery) >= .5 && scanned >= minimumDiscoveryDocuments;
    verdict.stop = eligible && verdict.sufficient >= .5;
    verdict.minimum_discovery_batch_guard = !eligible;
  }
  return { ...verdict, requested_action: a.choice, assessment_scope: "current_queries_and_candidate_ranking_only" };
}

export const unavailable = (error: string, errorKind: string, attempts: number, extra = {}): Verdict => ({
  assessment_status: "unavailable", decision: "UNAVAILABLE", sufficient: null, stop: false,
  action: "RETURN_UNASSESSED", error, error_kind: errorKind, attempts, ...extra,
});

/** References identify precisely the text assessed; full source stays in the request audit, not duplicated in GPT context. */
export function assessmentSnapshot(request: ReturnType<typeof routingRequest>, ctx: RoutingContext) {
  const s = request.state;
  return {
    request_sha256: hash(JSON.stringify(request)), scanned: s.scanned_documents, context_reads: ctx.reads,
    original_question: s.original_question, objective: s.current_objective, queries: [...s.verification_questions],
    source_snapshot_sha256: hash(JSON.stringify([s.evidence, s.prior_evidence])),
    source_refs: structuredClone([
      ...s.evidence.flatMap(d => d.passages.map(p => ({ scope: "current", docid: d.docid,
        lines: p.lines, source_offsets_utf16: p.source_offsets_utf16, text_sha256: hash(p.text),
        query_ids: p.query_ids, context_read: p.context_read }))),
      ...s.prior_evidence.map(p => ({ scope: "prior", docid: p.docid, id: p.id, source_call: p.source_call,
        lines: p.lines, source_offsets_utf16: p.source_offsets_utf16, text_sha256: hash(p.text) })),
    ]),
  };
}

export function createRoutingGate(options: GateOptions = {}) {
  const env = options.env ?? process.env, send = options.fetchImpl ?? fetch, observe = options.observe ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 15000, reserveMs = options.reserveMs ?? 1000;
  const remaining = options.remainingTimeMs ?? (() => Infinity);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(reserveMs) || reserveMs < 0)
    throw new Error("Invalid gate timeout/reserve");
  return async (input: RoutingInput, docs: EvidenceDoc[], scanned: number, ctx: RoutingContext, signal?: AbortSignal): Promise<Verdict> => {
    signal?.throwIfAborted();
    if (!docs.some(d => d.passages.some(p => !p.fallback && (p.query_ids.length > 0 || p.context_read))) && !ctx.prior.length && ctx.noProgress < 2)
      return { assessment_status: "not_assessed", decision: "NOT_ASSESSED", sufficient: null,
        stop: false, action: "EXPAND", no_evidence: true };
    const minimumDiscoveryDocuments = batchingPolicy(input.primary_count).minimumDiscoveryDocuments;
    const request = routingRequest(input, docs, scanned, ctx, env.JEV_MODEL ?? "jev-1.13.0");
    const payload = JSON.stringify(request), requestHash = hash(payload);
    const sourceChars = request.state.evidence.flatMap(d => d.passages).reduce((n, p) => n + p.text.length, 0)
      + request.state.prior_evidence.reduce((n, p) => n + p.text.length, 0);
    for (let attempt = 1; attempt <= 2; attempt++) {
      signal?.throwIfAborted();
      const left = remaining();
      if (Number.isNaN(left) || left <= reserveMs) {
        const verdict = unavailable("Research time budget exhausted before judgment", "budget_exhausted", attempt - 1);
        observe({ type: "adaptive_gate_skipped", policy: "evidence_pages_v6", call_id: ctx.call_id, scanned, minimum_discovery_documents: minimumDiscoveryDocuments,
          request_sha256: requestHash, remaining_ms: Number.isFinite(left) ? left : null, ...verdict });
        return verdict;
      }
      const waitMs = Math.min(timeoutMs, Number.isFinite(left) ? left - reserveMs : timeoutMs);
      const controller = new AbortController(), start = performance.now();
      const record: Record<string, any> = { type: "adaptive_gate", policy: "evidence_pages_v6", call_id: ctx.call_id,
        scanned, minimum_discovery_documents: minimumDiscoveryDocuments, attempt, request, request_sha256: requestHash, request_bytes: Buffer.byteLength(payload),
        source_chars_utf16: sourceChars, started_at: new Date().toISOString(), started_perf_ms: start,
        timeout_ms: waitMs, remaining_ms: Number.isFinite(left) ? left : null, phase: "awaiting_headers", ok: false };
      const timer = setTimeout(() => controller.abort(new DOMException("Jev judgment timed out", "TimeoutError")), waitMs);
      try {
        if (!env.TYPESAFE_API_KEY) { record.error_kind = "missing_key"; throw new Error("missing_key"); }
        const response = await send(env.JEV_URL ?? "https://api.typesafe.ai/v1/systemone", {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.TYPESAFE_API_KEY}` },
          body: payload, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        });
        record.headers_ms = performance.now() - start; record.http_status = response.status; record.phase = "response_body";
        record.provider_request_id = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
        if (!response.ok) {
          record.error_kind = "http_error"; record.error_body = (await response.text()).slice(0, 1000);
          throw new Error(`http_${response.status}`);
        }
        const body = await response.json(); record.response = body; record.body_ms = performance.now() - start;
        record.phase = "decode";
        const verdict: Verdict = { ...decodeRouting(body, scanned, input.queries.length, ctx, minimumDiscoveryDocuments), assessment_status: "assessed" };
        record.verdict = verdict; record.ok = true; record.phase = "complete"; return verdict;
      } catch (e) {
        record.error = e instanceof Error ? e.message : String(e);
        if (signal?.aborted) { record.error_kind = "cancelled"; throw e; }
        const timedOut = controller.signal.aborted;
        record.error_kind ??= timedOut ? "timeout" : record.phase === "decode" ? "invalid_judgment" : "request_error";
        const retryBudget = remaining();
        const canRetry = timedOut && !record.http_status && attempt === 1
          && Number.isFinite(retryBudget) && retryBudget >= timeoutMs + reserveMs;
        // A response-body timeout can also be retried, but never turn a known HTTP error into a retry.
        const retryBody = timedOut && record.http_status === 200 && attempt === 1
          && Number.isFinite(retryBudget) && retryBudget >= timeoutMs + reserveMs;
        record.retry_scheduled = canRetry || retryBody;
        if (record.retry_scheduled) continue;
        record.retry_skipped = attempt === 2 ? "attempt_limit" : !timedOut || (record.http_status && record.http_status !== 200)
          ? "not_retryable" : !Number.isFinite(retryBudget) ? "unknown_budget" : "insufficient_budget";
        return unavailable(record.error, record.error_kind, attempt, { retry_skipped: record.retry_skipped });
      } finally {
        clearTimeout(timer); record.elapsed_ms = performance.now() - start; observe(record);
      }
    }
    throw new Error("Unreachable retry state");
  };
}
