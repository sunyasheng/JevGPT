// Hybrid v2 entry = the hybrid v1 entry (document + passage convex-combination ranking, one unit
// per short document, top passages of long documents, routing reader, gate, Jev requests and the
// parent-coordinate translation unchanged) plus the auto-scan patch: after every search, Jev
// scans the top ranked units that no earlier auto-scan covered, using clue statements derived
// from the question text, and located verbatim excerpts are attached as a notice to the model's
// next tool result. Scans run in the background and never block the model.
import { appendFileSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePiSearchExtensionConfigFromEnv } from "../pi-search/config";
import { registerPiSearchExtension } from "../pi-search/extension";
import {
  dumpPromptSnapshot,
  getSubmitNowDelayMs,
  stripBenchmarkIrrelevantSystemPromptSections,
} from "../pi-search/prompt_policy";
import { PiSearchBackendRuntime } from "../pi-search/searcher/runtime";
import type { HybridBm25Backend } from "../pi-search/searcher/adapters/passage_bm25/hybrid";
import { createHybridPiSearchBackend } from "../search-providers/anserini/hybrid_backend_factory";
import { createRoutingReader, gptSourceBudget } from "./jev_context_selection_reader_v1";
import { EvidenceStore } from "./jev_evidence_store_v2";
import { ResearchProgress } from "./jev_research_progress_v2";
import { createPagedDocumentReader, PagedReadParamsSchema } from "./read_document_paged_v1";
import { createBatchFindReader } from "./jev_evidence_pages_reader_v2";
import { selectBatch } from "./pi_search_jev_context_selection_v1";
import { parentDocidsOf, translateFindOutput, type ResolveUnit } from "./jev_passage_units_v1";
import { installHostOverride } from "./jev_host_override_v1";
import { updateHybridWorkflow } from "./pi_search_jev_hybrid_v1";
import {
  attachNoticesToText,
  clueQueriesFromQuestion,
  createAutoScanner,
  type Notice,
} from "./jev_auto_scan_v1";

export default function registerHybridFindV2(pi: ExtensionAPI) {
  const hostOverride = installHostOverride(process.env);
  const gptBudget = gptSourceBudget();
  const batchSize = Number(process.env.JEV_BATCH_SIZE ?? 30);
  if (![30, 40, 60].includes(batchSize)) throw new Error("JEV_BATCH_SIZE must be 30, 40, or 60.");
  const autoScanEnabled = process.env.JEV_AUTOSCAN !== "0";
  const autoScanTop = Number(process.env.JEV_AUTOSCAN_TOP ?? 60);
  const autoScanConcurrency = Number(process.env.JEV_AUTOSCAN_CONCURRENCY ?? 12);
  const autoScanMaxDocs = Number(process.env.JEV_AUTOSCAN_MAX_DOCS ?? 6);
  const autoScanExcerpt = Number(process.env.JEV_AUTOSCAN_EXCERPT_CHARS ?? 240);
  const autoScanMinRemainingMs = Number(process.env.JEV_AUTOSCAN_MIN_REMAINING_MS ?? 45_000);
  const autoScanRule = (process.env.JEV_AUTOSCAN_RULE ?? "coverage") as "coverage" | "specificity";
  const autoScanMinScore = Number(process.env.JEV_AUTOSCAN_MIN_SCORE ?? 0.5);
  if (!["coverage", "specificity"].includes(autoScanRule))
    throw new Error("JEV_AUTOSCAN_RULE must be coverage or specificity.");
  if (!(autoScanTop >= 1 && autoScanTop <= 120)) throw new Error("JEV_AUTOSCAN_TOP must be 1–120.");
  const audit = (record: object) => {
    if (process.env.JEV_FIND_LOG)
      appendFileSync(process.env.JEV_FIND_LOG, JSON.stringify(record) + "\n");
  };
  let backend: HybridBm25Backend | undefined;
  const runtime = new PiSearchBackendRuntime(resolvePiSearchExtensionConfigFromEnv(process.env), {
    createBackend: (cwd, config) =>
      (backend = createHybridPiSearchBackend(cwd, config, process.env, audit)),
  });
  const resolveUnit: ResolveUnit = (id) => backend?.getUnitMapping(id);
  const store = new EvidenceStore();
  const progress = new ResearchProgress();
  let deadline = Infinity;
  let find = createRoutingReader({
    store,
    progress,
    remainingTimeMs: () => deadline - performance.now(),
  });
  let originalQuestion = "";
  let clues: string[] = [];
  const rankings = new Map<string, string[]>(),
    seen = new Set<string>(),
    attempted = new Set<string>();
  let readPage = createPagedDocumentReader(audit);
  const scanner = createAutoScanner({
    scan: createBatchFindReader({
      env: process.env,
      observe: (r) => audit({ ...r, scanner: "auto_scan" }),
      maxDocs: 60,
      concurrency: autoScanConcurrency,
    }),
    resolveUnit,
    audit,
    store,
    top: autoScanTop,
    maxDocs: autoScanMaxDocs,
    excerptChars: autoScanExcerpt,
    rule: autoScanRule,
    minScore: autoScanMinScore,
    minRemainingMs: autoScanMinRemainingMs,
    titleOf: (docid, signal) => backend?.titleOf(docid, signal) ?? Promise.resolve(null),
    remainingTimeMs: () => deadline - performance.now(),
    onScanned: (units, parents) => {
      for (const id of units) {
        seen.add(id);
        attempted.add(id);
      }
      for (const id of parents) {
        seen.add(id);
        attempted.add(id);
      }
    },
  });
  const deliver = (tool: string): Notice[] => {
    const notices = scanner.drain();
    if (notices.length)
      audit({
        type: "auto_scan_delivery",
        tool,
        notices: notices.map((n) => ({
          search_id: n.search_id,
          ranks: n.ranks,
          located: n.located.length,
        })),
      });
    return notices;
  };
  const reset = () => {
    find.reset();
    find = createRoutingReader({
      store,
      progress,
      remainingTimeMs: () => deadline - performance.now(),
    });
    readPage = createPagedDocumentReader(audit);
    rankings.clear();
    seen.clear();
    attempted.clear();
    originalQuestion = "";
    clues = [];
    scanner.reset();
    audit({ type: "evidence_reset" });
  };
  const facade = new Proxy(pi, {
    get(target, property, receiver) {
      if (property !== "registerTool") return Reflect.get(target, property, receiver);
      return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
        if (tool.name === "search" || tool.name === "read_search_results")
          return pi.registerTool({
            ...tool,
            promptGuidelines: (tool.promptGuidelines ?? [])
              .filter((s) => !s.includes("read_document"))
              .concat(
                `Results combine whole-document and passage rankings, one result per document, each shown with the document title. Short documents appear as docid; long documents appear as their best-matching section docid#n. Use jev_find with search_id to inspect up to ${batchSize} cached results, starting with 10 in parallel. No need to page through previews or list every id first. Ask questions that can reveal useful evidence or the next entity; one result need not satisfy every clue.`,
              ),
            async execute(...args) {
              const result = await tool.execute(...args);
              const details = result.details as {
                searchId?: string;
                retrievedDocids?: string[];
                previewedDocids?: string[];
              };
              if (tool.name === "search" && details.searchId && details.retrievedDocids) {
                rankings.set(details.searchId, [...details.retrievedDocids]);
                progress.recordSearch(
                  details.searchId,
                  String((args[1] as { query?: string }).query ?? ""),
                  details.retrievedDocids,
                );
                while (rankings.size > 32) rankings.delete(rankings.keys().next().value!);
                if (autoScanEnabled) {
                  const ctx = args[4] as { cwd: string };
                  scanner.onSearch(
                    details.searchId,
                    details.retrievedDocids,
                    runtime.getBackend(ctx.cwd),
                    clues,
                  );
                }
              }
              for (const id of details.previewedDocids ?? []) seen.add(String(id));
              const notices = deliver(tool.name);
              return {
                ...result,
                content: result.content.map((block, index) =>
                  block.type !== "text"
                    ? block
                    : {
                        ...block,
                        text: attachNoticesToText(
                          block.text
                            .replace(
                              "Use read_document(docid) to inspect a specific document in paginated chunks.",
                              `Use jev_find with search_id=${JSON.stringify(details.searchId)} and your independent evidence questions to inspect up to ${batchSize} cached results, including ranks not previewed here. offset defaults to 1; limit defaults to ${batchSize}. Original source is returned with the parent docid and original offsets. Use read_document(parent docid) for missing context after a find attempt.`,
                            )
                            .replaceAll(
                              "No snippet available from this backend. Use read_document(docid) to inspect the document.",
                              "No snippet available. jev_find can inspect this cached result.",
                            ),
                          index === 0 ? notices : [],
                        ),
                      },
                ),
              };
            },
          });
        if (tool.name === "read_document")
          return pi.registerTool({
            name: tool.name,
            label: tool.label,
            description:
              "Read missing original source context after a jev_find attempt or an auto-scan notice. Use the parent docid (without #n) to read the full original document; a passage id reads only that passage. Returns at most 5000 UTF-16 units, preserving original line numbers. offset/limit select original lines; start_index selects an absolute UTF-16 character position. Continue with next_start_index even within a long line. Always provide reason first.",
            promptSnippet:
              "Read a bounded source page after jev_find or an auto-scan notice. Use the parent docid with original offset/limit OR start_index; max_length defaults to 5000 and cannot exceed 5000. Follow next_start_index without offset/limit to continue.",
            parameters: PagedReadParamsSchema,
            promptGuidelines: [
              "Use read_document for missing facts or context after jev_find or an auto-scan inspected this document or its ranking. Avoid rereading evidence already provided.",
              "For truncated pages, next_start_index points to the first unread UTF-16 source position. Keep the original line numbers for citations. source_offsets_utf16 from jev_find and auto-scan notices use the same parent-document coordinates.",
            ],
            async execute(id, params, signal, _update, ctx) {
              if (!attempted.has(params.docid))
                throw new Error(
                  "First use jev_find for this document or its search ranking; then read_document may supply missing context.",
                );
              const result = await readPage(params, runtime.getBackend(ctx.cwd), signal, id);
              const source_call = `read_document:${id}`;
              audit({
                type: "evidence_commit",
                source_call,
                entries: store.addPage(result.details, source_call),
              });
              const p = result.details;
              audit({
                type: "research_progress",
                source_call,
                ...progress.recordEvidence(
                  source_call,
                  { reason: params.reason, queries: [] },
                  [
                    {
                      docid: p.docid,
                      passages: [
                        {
                          text: p.text,
                          lines: p.original_lines,
                          source_offsets_utf16: p.source_offsets_utf16,
                          query_ids: [],
                          context_read: true,
                        },
                      ],
                    },
                  ],
                  "not_assessed",
                ),
              });
              // Notices are not attached here: the page JSON must stay byte-identical to the
              // logged paged_read row. They reach the model with the next search or jev_find.
              return result;
            },
          });
        return pi.registerTool(tool);
      };
    },
  });
  registerPiSearchExtension(facade, { backendRuntime: runtime });
  pi.registerTool({
    name: "jev_find",
    label: "Jev Batch Find and Read",
    description: `Read up to ${batchSize} ranked results (short documents or sections of long documents) in one call. Jev starts with explicit targets or up to 10 ranked results, can add 10 at a time, read up to two bounded source pages, or yield partial evidence when this ranking stops adding located evidence. Supply search_id for cached BM25 ranks, OR explicit ids (passage ids docid#n, or parent docids for a full-document scan) with their cached ranking as fallback. Returns up to ${gptBudget} UTF-16 characters of verbatim source in parent-document coordinates (docid, original lines, source_offsets_utf16), any remaining omissions, and coverage of your current verification questions. Additional original excerpts may extend beyond the source used for Jev's local assessment; review them yourself. complete and unresolved_queries apply only to this call; neither decides whether the original question needs more research. You own that decision using the full conversation. Before another search, check evidence already returned and identify the specific uncertainty and promising lead it could resolve. Use a supported answer with explicit qualifications when further verification is unlikely to change the identification; never claim an unresolved clue is proven. assessment_status=unavailable means the latest local judgment failed, not that evidence is insufficient. Review returned source and any last_successful_assessment within its recorded scope. Raw source memory is automatic; no evidence-state editing is required.`,
    promptSnippet: `For discovery, give search_id and independent questions; defaults to at most ${batchSize} results, starting with 10 in parallel. Use offset for the next rank batch.`,
    promptGuidelines: [
      `Prefer the default ${batchSize}-result ranking batch during candidate discovery instead of asking about single results. Stop when evidence is sufficient; no need to fill a batch for a small targeted follow-up.`,
      "Ask for unknown values and relationships without guessing names. A result can supply one clue or a next entity without satisfying every condition. After evidence establishes an entity, formulate the next search or targeted questions.",
      "The returned excerpts are original source with parent docids. Not located and omitted do not prove absence; use native read_document on the parent docid for missing context. Inspect another rank batch when needed before repeatedly paraphrasing the same search.",
    ],
    parameters: Type.Object({
      reason: Type.String({
        maxLength: 800,
        description: "Brief current evidence gap, under 100 words.",
      }),
      search_id: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Cached ranking to inspect. Use this for candidate discovery; do not also supply docids.",
        }),
      ),
      offset: Type.Optional(
        Type.Integer({ minimum: 1, description: "First rank to inspect; defaults to 1." }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: batchSize,
          description: `Maximum ranked results; defaults to ${batchSize}. Jev may stop earlier.`,
        }),
      ),
      docids: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          minItems: 1,
          maxItems: batchSize,
          uniqueItems: true,
          description:
            "Alternative to search_id for targeted follow-up: passage ids (docid#n) or parent docids already returned.",
        }),
      ),
      queries: Type.Array(Type.String({ minLength: 1, maxLength: 350 }), {
        minItems: 1,
        maxItems: 6,
        uniqueItems: true,
        description:
          "Independent evidence questions, one fact or relationship each. Every question gets both Choice location and Noul existence judgments.",
      }),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const selected = selectBatch(params, rankings, seen, batchSize);
      // For a known source, reuse its most recent already-cached ranking as fallback.
      if (params.docids) {
        const fallback = [...rankings.entries()]
          .reverse()
          .find(([, ids]) => ids.includes(params.docids![0]));
        if (fallback)
          selected.docids = [...new Set([...selected.docids, ...fallback[1]])].slice(0, batchSize);
      }
      audit({
        type: "batch_selection",
        params,
        resolved_docids: selected.docids,
        ranking: selected.ranking,
        batch_size: batchSize,
        unit: "hybrid",
      });
      const result = await find(
        {
          reason: params.reason,
          docids: selected.docids,
          queries: params.queries,
          original_question: originalQuestion,
          primary_count: params.docids?.length,
        },
        runtime.getBackend(ctx.cwd),
        signal,
      );
      for (const id of result.details.attemptedDocids) {
        seen.add(id);
        attempted.add(id);
      }
      for (const id of parentDocidsOf(result.details.attemptedDocids, resolveUnit)) {
        seen.add(id);
        attempted.add(id);
      }
      const parsed = JSON.parse(result.content[0].text);
      const translated = translateFindOutput(parsed, resolveUnit);
      const ranking:
        | {
            start: number;
            end: number;
            total_cached: number;
            next_offset?: number;
            search_id?: string;
          }
        | undefined = selected.ranking
        ? {
            ...selected.ranking,
            end: selected.ranking.start + result.details.attemptedDocids.length - 1,
            next_offset: selected.ranking.start + result.details.attemptedDocids.length,
          }
        : undefined;
      if (ranking && ranking.end >= ranking.total_cached) delete ranking.next_offset;
      const notices = deliver("jev_find");
      const output = {
        ...translated,
        ...(ranking ? { ranking } : {}),
        ...(notices.length ? { auto_scan_notices: notices } : {}),
      };
      audit({ type: "batch_public", output });
      audit({
        type: "passage_public",
        units: translated.passage_units,
        documents: output.documents.map((d: Record<string, unknown>) => ({
          docid: d.docid,
          passage_unit: d.passage_unit,
          coordinates: d.coordinates ?? "parent_document",
          pages: Array.isArray(d.passages) ? d.passages.length : 0,
          translation_errors: Array.isArray(d.passages)
            ? d.passages.filter((p: Record<string, unknown>) => p.translation_error).length
            : 0,
        })),
      });
      return { ...result, content: [{ type: "text" as const, text: JSON.stringify(output) }] };
    },
  });
  pi.on("session_start", async () => {
    reset();
    audit({
      type: "navigation_start",
      active_tools: pi.getActiveTools(),
      batch_size: batchSize,
      retrieval_unit: "hybrid",
      auto_scan: autoScanEnabled
        ? {
            top: autoScanTop,
            concurrency: autoScanConcurrency,
            max_docs: autoScanMaxDocs,
            excerpt_chars: autoScanExcerpt,
            rule: autoScanRule,
            min_score: autoScanMinScore,
            min_remaining_ms: autoScanMinRemainingMs,
          }
        : null,
      jev_url: process.env.JEV_URL ?? null,
      jev_host_override: Object.fromEntries(hostOverride),
    });
  });
  pi.on("input", async (event) => {
    if (event.text.includes("\nQuestion: ") || !originalQuestion) {
      const question = event.text.split("\nQuestion: ").at(-1) ?? event.text;
      if (question !== originalQuestion) {
        reset();
        originalQuestion = question;
        clues = clueQueriesFromQuestion(question);
        audit({ type: "auto_scan_clues", clues });
      }
    }
    const text = updateHybridWorkflow(event.text, batchSize);
    if (text !== event.text) return { action: "transform" as const, text };
  });
  pi.on("agent_start", async () => {
    const delay = getSubmitNowDelayMs();
    deadline = delay === null ? Infinity : performance.now() + delay;
  });
  pi.on("agent_end", async () => {
    scanner.stop();
    audit({ type: "auto_scan_summary", ...scanner.stats });
  });
  pi.on("tool_call", async (event) => {
    if (event.toolName === "jev_find" && performance.now() >= deadline)
      return {
        block: true,
        reason: "Time budget is nearly exhausted. Submit your final answer now.",
      };
  });
  pi.on("before_agent_start", async (event) => {
    const systemPrompt =
      stripBenchmarkIrrelevantSystemPromptSections(event.systemPrompt) +
      `\nDocument navigation: search combines a whole-document ranking and a passage ranking into one result per document, shown with the document title; short documents appear as docid and long documents as their best-matching section docid#n. Use jev_find with a cached search_id and independent evidence questions to inspect up to ${batchSize} ranked results. You need not preview all ids or manage intermediate batches. Ranked discovery starts with up to 10 results and expands by 10. Explicit ids start with those sources and may expand through their cached ranking. Jev controls this call's progressive expansion and up to two bounded context reads; it assesses only the current verification questions. Returned evidence carries the parent docid, original line numbers and source_offsets_utf16 in the full document; read_document(parent docid, start_index) reads surrounding original context. You are responsible for deciding whether the original research question needs another search or can be answered, using the full conversation and previously returned source. Before continuing, identify what evidence is still missing, whether it could change the candidate identification, and which concrete new source or search lead could resolve it. Do not restart verification solely because complete=false, a local clue is unresolved, or a fact is absent from Jev's selected history. Avoid repeating searches that only reconfirm already supported clues. Keep entities and relations linked; contradictory source or a material identification gap warrants further investigation. When the answer is supported but a remaining clue cannot be verified with promising available leads, answer with an explicit qualification instead of inventing support. complete and unresolved_queries apply only to the current tool call. stop_reason=no_progress describes this ranking, not absence of a fact. assessment_status=unavailable or not_assessed means no current judgment; it does not create new evidence gaps. Review any last_successful_assessment only within its recorded query/source scope. Evidence memory is maintained automatically. Native read_document remains available after one Jev attempt per document or ranking; use its bounded pages for missing context. Missing or omitted source never proves absence.` +
      (autoScanEnabled
        ? `\nAuto-scan: after each search, Jev scans in the background the top ${autoScanTop} ranked results that were not scanned before, against clue statements taken from the question. When it locates clue text, a notice (AUTO_SCAN_NOTICES, or auto_scan_notices inside a jev_find result) is attached to your next tool result with verbatim excerpts, parent docids, original lines and offsets. Treat located results as leads: inspect a promising one with jev_find(docids=[...]) or read_document(parent docid), and reconsider your current candidate when a notice points elsewhere. A notice never proves an answer, and the absence of a notice never proves absence.`
        : "");
    dumpPromptSnapshot(systemPrompt, event.prompt);
    return { systemPrompt };
  });
}
