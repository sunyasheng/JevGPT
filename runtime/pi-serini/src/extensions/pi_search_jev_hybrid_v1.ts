// Hybrid variant of the passage entry (pi_search_jev_passage_v1). Search fuses the whole-document
// ranking (document daemon, k1=25/b=1 as in the control) with the passage ranking (MaxP over the
// passage daemon) by reciprocal rank fusion. The cached ranking holds one unit per document: short
// documents as plain docids read whole, long documents as their best passage unit (docid#n).
// Routing reader, gate, Jev requests and the parent-coordinate translation are unchanged.
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
import { updateFusedWorkflow } from "./pi_search_jev_find_read_v1";
import { selectBatch } from "./pi_search_jev_context_selection_v1";
import { parentDocidsOf, translateFindOutput, type ResolveUnit } from "./jev_passage_units_v1";
import { installHostOverride } from "./jev_host_override_v1";

export function updateHybridWorkflow(text: string, batchSize: number) {
  return updateFusedWorkflow(text)
    .replace(
      "3. Browse the current ranking with read_search_results before repeatedly rewriting the query.",
      `3. Before repeatedly rewriting a query, use jev_find with search_id to inspect batches of ${batchSize} ranked results. You do not need to preview their ids first; the tool accesses the cached ranking.`,
    )
    .replace(
      "4. If promising candidate documents appear, call jev_find with their docids and all currently unresolved independent questions. It runs Choice location and Noul existence judgments together and immediately reads the selected source ranges.",
      `4. For candidate discovery, prefer jev_find(search_id, offset, queries); it defaults to ${batchSize} results. Ask the currently unresolved independent questions together. The tool runs Choice+Noul in parallel and returns selected original source with the parent docid. Explicit docids are for targeted follow-up after a candidate is identified.`,
    );
}

export default function registerHybridFind(pi: ExtensionAPI) {
  const hostOverride = installHostOverride(process.env);
  const gptBudget = gptSourceBudget();
  const batchSize = Number(process.env.JEV_BATCH_SIZE ?? 30);
  if (![30, 40, 60].includes(batchSize)) throw new Error("JEV_BATCH_SIZE must be 30, 40, or 60.");
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
  const rankings = new Map<string, string[]>(),
    seen = new Set<string>(),
    attempted = new Set<string>();
  let readPage = createPagedDocumentReader(audit);
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
              }
              for (const id of details.previewedDocids ?? []) seen.add(String(id));
              return {
                ...result,
                content: result.content.map((block) =>
                  block.type !== "text"
                    ? block
                    : {
                        ...block,
                        text: block.text
                          .replace(
                            "Use read_document(docid) to inspect a specific document in paginated chunks.",
                            `Use jev_find with search_id=${JSON.stringify(details.searchId)} and your independent evidence questions to inspect up to ${batchSize} cached results, including ranks not previewed here. offset defaults to 1; limit defaults to ${batchSize}. Original source is returned with the parent docid and original offsets. Use read_document(parent docid) for missing context after a find attempt.`,
                          )
                          .replaceAll(
                            "No snippet available from this backend. Use read_document(docid) to inspect the document.",
                            "No snippet available. jev_find can inspect this cached result.",
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
              "Read missing original source context after a jev_find attempt. Use the parent docid (without #n) to read the full original document; a passage id reads only that passage. Returns at most 5000 UTF-16 units, preserving original line numbers. offset/limit select original lines; start_index selects an absolute UTF-16 character position. Continue with next_start_index even within a long line. Always provide reason first.",
            promptSnippet:
              "Read a bounded source page after jev_find. Use the parent docid with original offset/limit OR start_index; max_length defaults to 5000 and cannot exceed 5000. Follow next_start_index without offset/limit to continue.",
            parameters: PagedReadParamsSchema,
            promptGuidelines: [
              "Use read_document for missing facts or context after jev_find inspected this document or its ranking. Avoid rereading evidence already provided.",
              "For truncated pages, next_start_index points to the first unread UTF-16 source position. Keep the original line numbers for citations. source_offsets_utf16 from jev_find use the same parent-document coordinates.",
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
      const output = { ...translated, ...(ranking ? { ranking } : {}) };
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
      }
    }
    const text = updateHybridWorkflow(event.text, batchSize);
    if (text !== event.text) return { action: "transform" as const, text };
  });
  pi.on("agent_start", async () => {
    const delay = getSubmitNowDelayMs();
    deadline = delay === null ? Infinity : performance.now() + delay;
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
      `\nDocument navigation: search combines a whole-document ranking and a passage ranking into one result per document, shown with the document title; short documents appear as docid and long documents as their best-matching section docid#n. Use jev_find with a cached search_id and independent evidence questions to inspect up to ${batchSize} ranked results. You need not preview all ids or manage intermediate batches. Ranked discovery starts with up to 10 results and expands by 10. Explicit ids start with those sources and may expand through their cached ranking. Jev controls this call's progressive expansion and up to two bounded context reads; it assesses only the current verification questions. Returned evidence carries the parent docid, original line numbers and source_offsets_utf16 in the full document; read_document(parent docid, start_index) reads surrounding original context. You are responsible for deciding whether the original research question needs another search or can be answered, using the full conversation and previously returned source. Before continuing, identify what evidence is still missing, whether it could change the candidate identification, and which concrete new source or search lead could resolve it. Do not restart verification solely because complete=false, a local clue is unresolved, or a fact is absent from Jev's selected history. Avoid repeating searches that only reconfirm already supported clues. Keep entities and relations linked; contradictory source or a material identification gap warrants further investigation. When the answer is supported but a remaining clue cannot be verified with promising available leads, answer with an explicit qualification instead of inventing support. complete and unresolved_queries apply only to the current tool call. stop_reason=no_progress describes this ranking, not absence of a fact. assessment_status=unavailable or not_assessed means no current judgment; it does not create new evidence gaps. Review any last_successful_assessment only within its recorded query/source scope. Evidence memory is maintained automatically. Native read_document remains available after one Jev attempt per document or ranking; use its bounded pages for missing context. Missing or omitted source never proves absence.`;
    dumpPromptSnapshot(systemPrompt, event.prompt);
    return { systemPrompt };
  });
}
