// v6 routing and configurable GPT return, with bounded recovery of Jev token overflows.
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
import { createRepoPiSearchBackend } from "../search-providers/anserini/pi_search_backend_factory";
import { createRoutingReader, gptSourceBudget } from "./jev_context_selection_reader_v1";
import { EvidenceStore } from "./jev_evidence_store_v2";
import { ResearchProgress } from "./jev_research_progress_v2";
import { createPagedDocumentReader, PagedReadParamsSchema } from "./read_document_paged_v1";
import { updateFusedWorkflow } from "./pi_search_jev_find_read_v1";

export type SelectionParams = {
  docids?: string[];
  search_id?: string;
  offset?: number;
  limit?: number;
};
export function selectBatch(
  params: SelectionParams,
  rankings: Map<string, string[]>,
  seen: Set<string>,
  batchSize: number,
) {
  if (Boolean(params.search_id) === Boolean(params.docids))
    throw new Error("Supply either search_id or docids, exclusively.");
  if (params.docids) {
    if (params.offset !== undefined || params.limit !== undefined)
      throw new Error("offset/limit apply only to search_id.");
    const docids = [...new Set(params.docids)];
    if (!docids.length || docids.length > batchSize || docids.some((id) => !seen.has(id)))
      throw new Error(
        `Supply 1–${batchSize} known docids, or use a cached search_id for ranked candidates.`,
      );
    return { docids, ranking: undefined };
  }
  const ranking = rankings.get(params.search_id!);
  if (!ranking)
    throw new Error("Unknown or expired search_id. Use a search_id returned by search.");
  const offset = params.offset ?? 1,
    limit = params.limit ?? batchSize;
  if (
    !Number.isInteger(offset) ||
    offset < 1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > batchSize
  )
    throw new Error(`offset must be positive; limit must be 1–${batchSize}.`);
  const docids = ranking.slice(offset - 1, offset - 1 + limit);
  if (!docids.length) throw new Error("No cached candidates remain in this rank interval.");
  const end = offset + docids.length - 1;
  return {
    docids,
    ranking: {
      search_id: params.search_id,
      start: offset,
      end,
      total_cached: ranking.length,
      ...(end < ranking.length ? { next_offset: end + 1 } : {}),
    },
  };
}

export function updateBatchWorkflow(text: string, batchSize: number) {
  return updateFusedWorkflow(text)
    .replace(
      "3. Browse the current ranking with read_search_results before repeatedly rewriting the query.",
      `3. Before repeatedly rewriting a query, use jev_find with search_id to inspect batches of ${batchSize} ranked documents. You do not need to preview their docids first; the tool accesses the cached ranking.`,
    )
    .replace(
      "4. If promising candidate documents appear, call jev_find with their docids and all currently unresolved independent questions. It runs Choice location and Noul existence judgments together and immediately reads the selected source ranges.",
      `4. For candidate discovery, prefer jev_find(search_id, offset, queries); it defaults to ${batchSize} documents. Ask the currently unresolved independent questions together. The tool runs Choice+Noul in parallel and returns selected original source. Explicit docids are for targeted follow-up after a candidate is identified.`,
    );
}

export default function registerBatchFind(pi: ExtensionAPI) {
  const gptBudget = gptSourceBudget();
  const batchSize = Number(process.env.JEV_BATCH_SIZE ?? 30);
  if (![30, 40, 60].includes(batchSize)) throw new Error("JEV_BATCH_SIZE must be 30, 40, or 60.");
  const runtime = new PiSearchBackendRuntime(resolvePiSearchExtensionConfigFromEnv(process.env), {
    createBackend: createRepoPiSearchBackend,
  });
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
  const audit = (record: object) => {
    if (process.env.JEV_FIND_LOG)
      appendFileSync(process.env.JEV_FIND_LOG, JSON.stringify(record) + "\n");
  };
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
                `Use jev_find with search_id to inspect up to ${batchSize} cached candidates, starting with 10 documents in parallel. No need to page through previews or list every docid first. Ask questions that can reveal useful evidence or the next entity; one document need not satisfy every clue.`,
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
                            `Use jev_find with search_id=${JSON.stringify(details.searchId)} and your independent evidence questions to inspect up to ${batchSize} cached documents, including ranks not previewed here. offset defaults to 1; limit defaults to ${batchSize}. Original passages are returned directly. Use read_document for missing context after a find attempt.`,
                          )
                          .replaceAll(
                            "No snippet available from this backend. Use read_document(docid) to inspect the document.",
                            "No snippet available. jev_find can inspect this cached candidate.",
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
              "Read missing original source context after a jev_find attempt. Returns at most 5000 UTF-16 units, preserving original line numbers. offset/limit select original lines; start_index selects an absolute UTF-16 character position. Continue with next_start_index even within a long line. Always provide reason first.",
            promptSnippet:
              "Read a bounded source page after jev_find. Use original offset/limit OR start_index; max_length defaults to 5000 and cannot exceed 5000. Follow next_start_index without offset/limit to continue.",
            parameters: PagedReadParamsSchema,
            promptGuidelines: [
              "Use read_document for missing facts or context after jev_find inspected this docid. Avoid rereading evidence already provided.",
              "For truncated pages, next_start_index points to the first unread UTF-16 source position. Keep the original line numbers for citations. source_offsets_utf16 from Jev uses the same coordinates.",
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
    description: `Read up to ${batchSize} ranked documents in one call. Jev starts with explicit targets or up to 10 ranked documents, can add 10 documents at a time, read up to two bounded source pages, or yield partial evidence when this ranking stops adding located evidence. Supply search_id for cached BM25 ranks, OR explicit docids with their cached ranking as fallback. Returns up to ${gptBudget} UTF-16 characters of verbatim source, any remaining omissions, and coverage of your current verification questions. Additional original excerpts may extend beyond the source used for Jev's local assessment; review them yourself. complete and unresolved_queries apply only to this call; neither decides whether the original question needs more research. You own that decision using the full conversation. Before another search, check evidence already returned and identify the specific uncertainty and promising lead it could resolve. Use a supported answer with explicit qualifications when further verification is unlikely to change the identification; never claim an unresolved clue is proven. assessment_status=unavailable means the latest local judgment failed, not that evidence is insufficient. Review returned source and any last_successful_assessment within its recorded scope. Raw source memory is automatic; no evidence-state editing is required.`,
    promptSnippet: `For discovery, give search_id and independent questions; defaults to at most ${batchSize} candidates, starting with 10 documents in parallel. Use offset for the next rank batch.`,
    promptGuidelines: [
      `Prefer the default ${batchSize}-document ranking batch during candidate discovery instead of asking about single documents. Stop when evidence is sufficient; no need to fill a batch for a small targeted follow-up.`,
      "Ask for unknown values and relationships without guessing names. A document can supply one clue or a next entity without satisfying every condition. After evidence establishes an entity, formulate the next search or targeted questions.",
      "The returned excerpts are original source. Not located and omitted do not prove absence; use native read_document for missing context. Inspect another rank batch when needed before repeatedly paraphrasing the same search.",
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
          description: `Maximum ranked documents; defaults to ${batchSize}. Jev may stop earlier.`,
        }),
      ),
      docids: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          minItems: 1,
          maxItems: batchSize,
          uniqueItems: true,
          description: "Alternative to search_id for targeted follow-up on known source documents.",
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
      const parsed = JSON.parse(result.content[0].text);
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
      const output = { ...parsed, ...(ranking ? { ranking } : {}) };
      audit({ type: "batch_public", output });
      return { ...result, content: [{ type: "text" as const, text: JSON.stringify(output) }] };
    },
  });
  pi.on("session_start", async () => {
    reset();
    audit({ type: "navigation_start", active_tools: pi.getActiveTools(), batch_size: batchSize });
  });
  pi.on("input", async (event) => {
    if (event.text.includes("\nQuestion: ") || !originalQuestion) {
      const question = event.text.split("\nQuestion: ").at(-1) ?? event.text;
      if (question !== originalQuestion) {
        reset();
        originalQuestion = question;
      }
    }
    const text = updateBatchWorkflow(event.text, batchSize);
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
      `\nDocument navigation: use jev_find with a cached search_id and independent evidence questions to inspect up to ${batchSize} ranked documents. You need not preview all docids or manage intermediate batches. Ranked discovery starts with up to 10 documents and expands by 10. Explicit docids start with those sources and may expand through their cached ranking. Jev controls this call's progressive expansion and up to two bounded context reads; it assesses only the current verification questions. You are responsible for deciding whether the original research question needs another search or can be answered, using the full conversation and previously returned source. Before continuing, identify what evidence is still missing, whether it could change the candidate identification, and which concrete new source or search lead could resolve it. Do not restart verification solely because complete=false, a local clue is unresolved, or a fact is absent from Jev's selected history. Avoid repeating searches that only reconfirm already supported clues. Keep entities and relations linked; contradictory source or a material identification gap warrants further investigation. When the answer is supported but a remaining clue cannot be verified with promising available leads, answer with an explicit qualification instead of inventing support. complete and unresolved_queries apply only to the current tool call. stop_reason=no_progress describes this ranking, not absence of a fact. assessment_status=unavailable or not_assessed means no current judgment; it does not create new evidence gaps. Review any last_successful_assessment only within its recorded query/source scope. Evidence memory is maintained automatically. Native read_document remains available after one Jev attempt per docid; use its bounded pages for missing context. Missing or omitted source never proves absence.`;
    dumpPromptSnapshot(systemPrompt, event.prompt);
    return { systemPrompt };
  });
}
