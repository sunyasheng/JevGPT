import { appendFileSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePiSearchExtensionConfigFromEnv } from "../pi-search/config";
import { registerPiSearchExtension } from "../pi-search/extension";
import { PiSearchBackendRuntime } from "../pi-search/searcher/runtime";
import { createRepoPiSearchBackend } from "../search-providers/anserini/pi_search_backend_factory";
import {
  dumpPromptSnapshot,
  getSubmitNowDelayMs,
  stripBenchmarkIrrelevantSystemPromptSections,
} from "../pi-search/prompt_policy";
import { createPagedDocumentReader, PagedReadParamsSchema } from "./read_document_paged_v1";
import { selectBatch } from "./pi_search_jev_context_selection_v1";
import {
  createDocumentRankingReader,
  rankingCoverage,
  type RankedDocument,
} from "./jev_document_ranking_reader";
import { attachRankingNotices, createRankingAutoScanner } from "./jev_ranking_auto_scan_v1";

/** A catalogue references already delivered source; it never certifies Jev's scores. */
export function rankingCatalogue(documents: RankedDocument[], searchCoverage: object[] = []) {
  return {
    purpose:
      "Candidate index for final cross-document relevance comparison. This index does not establish collection coverage. Search coverage below identifies candidates still unassessed; they are not known to be irrelevant. Repeated first-page previews do not establish that a refined query is redundant. Order is first assessment order, not a ranking. Use original passages in prior tool results. Jev estimates are not official relevance labels. Include every source-verified relevant document once, including documents repeating another's facts.",
    search_coverage: searchCoverage,
    candidates: documents.map((d) => ({
      docid: d.docid,
      title: d.title,
      jev_estimate: d.relevance.score,
      incomplete: d.scan_incomplete,
      source_windows: d.passages.map((p) => p.source_offsets_utf16),
    })),
  };
}

// Ranking entry = pi_search_jev_ranking (reader, catalogue, prompts and tools unchanged) plus the
// ranking auto-scan: after every search, Jev assesses the unassessed top ranked documents in the
// background and likely relevant ones reach the model as a notice on its next search or jev_find result.
export default function registerRankingAutoScan(pi: ExtensionAPI) {
  const autoScanEnabled = process.env.JEV_AUTOSCAN !== "0";
  const autoScanTop = Number(process.env.JEV_AUTOSCAN_TOP ?? 60);
  const autoScanMaxDocs = Number(process.env.JEV_AUTOSCAN_MAX_DOCS ?? 10);
  const autoScanMinProbability = Number(process.env.JEV_AUTOSCAN_MIN_PROBABILITY ?? 0.5);
  const autoScanExcerpt = Number(process.env.JEV_AUTOSCAN_EXCERPT_CHARS ?? 240);
  const autoScanMinRemainingMs = Number(process.env.JEV_AUTOSCAN_MIN_REMAINING_MS ?? 45_000);
  if (!(autoScanTop >= 1 && autoScanTop <= 60)) throw new Error("JEV_AUTOSCAN_TOP must be 1–60.");
  const runtime = new PiSearchBackendRuntime(resolvePiSearchExtensionConfigFromEnv(process.env), {
    createBackend: createRepoPiSearchBackend,
  });
  const audit = (record: object) => {
    if (process.env.JEV_FIND_LOG)
      appendFileSync(process.env.JEV_FIND_LOG, JSON.stringify(record) + "\n");
  };
  let deadline = Infinity,
    topic = "";
  const reader = createDocumentRankingReader({
    observe: audit,
    remainingTimeMs: () => deadline - performance.now(),
  });
  const rankings = new Map<string, string[]>(),
    known = new Set<string>(),
    attempted = new Set<string>();
  // The catalogue contains only documents whose source was actually delivered to GPT.
  const delivered = new Map<string, RankedDocument>();
  const scanner = createRankingAutoScanner({
    reader,
    audit,
    remainingTimeMs: () => deadline - performance.now(),
    isDelivered: (docid) => delivered.has(docid),
    onAttempted: (docids) => {
      for (const id of docids) attempted.add(id);
    },
    top: autoScanTop,
    maxDocs: autoScanMaxDocs,
    minProbability: autoScanMinProbability,
    excerptChars: autoScanExcerpt,
    minRemainingMs: autoScanMinRemainingMs,
  });
  const lastAssessment = new Map<string, object>();
  const coverage = (searchId: string, ids: string[]) => ({
    search_id: searchId,
    ...rankingCoverage(ids, reader.assessedIds()),
    last_assessment: lastAssessment.get(searchId) ?? null,
  });
  let readPage = createPagedDocumentReader(audit);
  const reset = () => {
    scanner.reset();
    reader.reset();
    rankings.clear();
    known.clear();
    attempted.clear();
    delivered.clear();
    lastAssessment.clear();
    readPage = createPagedDocumentReader(audit);
  };
  const guidance =
    "Use jev_find(search_id) to assess a ranked interval against the original topic. It reuses known judgments and examines the unassessed candidates in batches of 10, returning original topic-related pages. The default interval contains up to 60 ranked documents. Repeated top-five previews can hide new documents farther down: use the reported assessment coverage to decide whether to inspect that interval. Its local stopping decision does not certify collection coverage.";
  const facade = new Proxy(pi, {
    get(target, property, receiver) {
      if (property !== "registerTool") return Reflect.get(target, property, receiver);
      return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
        if (tool.name === "search" || tool.name === "read_search_results") {
          return pi.registerTool({
            ...tool,
            promptGuidelines: ["Provide reason first, under 100 words.", guidance],
            async execute(...args) {
              const result = await tool.execute(...args);
              const d = result.details as {
                searchId?: string;
                retrievedDocids?: string[];
                previewedDocids?: string[];
              };
              if (tool.name === "search" && d.searchId && d.retrievedDocids) {
                rankings.set(d.searchId, [...d.retrievedDocids]);
                for (const id of d.retrievedDocids) known.add(id);
                while (rankings.size > 32) rankings.delete(rankings.keys().next().value!);
                if (autoScanEnabled) {
                  const ctx = args[4] as { cwd: string };
                  scanner.schedule(d.searchId, d.retrievedDocids, runtime.getBackend(ctx.cwd), topic);
                }
              }
              const notices = autoScanEnabled ? scanner.take(tool.name) : [];
              const currentRanking = d.searchId ? rankings.get(d.searchId) : undefined;
              const progress =
                currentRanking && d.searchId ? coverage(d.searchId, currentRanking) : undefined;
              return {
                ...result,
                content: result.content.map((b) =>
                  b.type === "text"
                    ? {
                        ...b,
                        text: attachRankingNotices(
                          b.text.replace(
                            "Use read_document(docid) to inspect a specific document in paginated chunks.",
                            guidance,
                          ) +
                            (progress
                              ? "\nRanking assessment coverage: " + JSON.stringify(progress)
                              : ""),
                          notices,
                        ),
                      }
                    : b,
                ),
              };
            },
          });
        }
        if (tool.name === "read_document") {
          return pi.registerTool({
            name: tool.name,
            label: tool.label,
            description:
              "Read bounded original source to clarify a document's topic relevance or relative ranking after a Jev assessment. Provide reason first. Use original offset/limit or UTF-16 start_index; max_length is at most 5000. Follow next_start_index for long lines.",
            parameters: PagedReadParamsSchema,
            async execute(id, params, signal, _update, ctx) {
              if (!attempted.has(params.docid))
                throw new Error(
                  "First assess this known document or its search ranking with jev_find.",
                );
              const result = await readPage(params, runtime.getBackend(ctx.cwd), signal, id);
              const p = result.details;
              const cached = reader.catalogue().find((d) => d.docid === params.docid);
              if (cached && p.text) {
                const doc = delivered.get(params.docid) ?? { ...cached, passages: [] };
                doc.passages.push({
                  id: "read:" + id,
                  text: p.text,
                  lines: p.original_lines,
                  source_offsets_utf16: p.source_offsets_utf16,
                  keep_probability: null,
                });
                delivered.set(doc.docid, doc);
              }
              return result;
            },
          });
        }
        return pi.registerTool(tool);
      };
    },
  });
  registerPiSearchExtension(facade, { backendRuntime: runtime });
  pi.registerTool({
    name: "jev_find",
    label: "Jev Document Relevance",
    description:
      guidance +
      " Supply search_id with optional offset/limit, OR known docids for targeted assessment. The topic is fixed automatically to the original task. No subquestions or evidence-state edits are needed. Related pages are independently selected, so multiple useful parts of the same article can be returned. Scores are fallible estimates; GPT owns the final relevance comparison.",
    promptGuidelines: [
      "Use search_id for discovery and docids for targeted inspection.",
      "Different documents remain valuable even if they repeat facts. A document need not cover every aspect.",
      "Inspect promising unscanned ranks before repeatedly issuing synonyms that retrieve already assessed documents.",
    ],
    parameters: Type.Object({
      reason: Type.String({
        maxLength: 800,
        description: "Why this candidate interval or document helps topic retrieval.",
      }),
      search_id: Type.Optional(Type.String({ minLength: 1 })),
      docids: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 60 }),
      ),
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (!topic) throw new Error("Missing original retrieval topic");
      const selected = selectBatch(params, rankings, known, 60);
      audit({
        type: "batch_selection",
        params,
        resolved_docids: selected.docids,
        task_mode: "rank_documents",
      });
      const result = await reader.read(
        { topic, docids: selected.docids, targeted: Boolean(params.docids) },
        runtime.getBackend(ctx.cwd),
        signal,
      );
      for (const id of result.attemptedDocids) attempted.add(id);
      for (const doc of result.output.documents) {
        if (!doc.passages.length) continue;
        const previous = delivered.get(doc.docid);
        const pages = new Map((previous?.passages ?? []).map((p) => [p.id, p]));
        for (const p of doc.passages) pages.set(p.id, p);
        delivered.set(doc.docid, { ...doc, passages: [...pages.values()] });
      }
      const ranking = selected.ranking
        ? {
            ...selected.ranking,
            end: selected.ranking.start + result.scannedPrefix - 1,
            ...(selected.ranking.start + result.scannedPrefix <= selected.ranking.total_cached
              ? { next_offset: selected.ranking.start + result.scannedPrefix }
              : {}),
          }
        : undefined;
      const notices = autoScanEnabled ? scanner.take("jev_find") : [];
      const output = {
        ...result.output,
        ...(ranking ? { ranking } : {}),
        ...(notices.length ? { auto_scan_notices: notices } : {}),
      };
      if (params.search_id && selected.ranking) {
        lastAssessment.set(params.search_id, {
          requested_interval: [selected.ranking.start, selected.ranking.end],
          assessed_prefix_end: selected.ranking.start + result.scannedPrefix - 1,
          stop_reason: result.output.adaptive.stop_reason,
          last_new_batch: result.output.adaptive.stages.at(-1) ?? null,
        });
      }
      audit({ type: "batch_public", output });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        details: { attemptedDocids: result.attemptedDocids },
      };
    },
  });
  pi.on("session_start", async () => {
    reset();
    topic = "";
    audit({
      type: "navigation_start",
      active_tools: pi.getActiveTools(),
      task_mode: "rank_documents",
      batch_size: 60,
      auto_scan: autoScanEnabled
        ? {
            top: autoScanTop,
            max_docs: autoScanMaxDocs,
            min_probability: autoScanMinProbability,
            excerpt_chars: autoScanExcerpt,
            min_remaining_ms: autoScanMinRemainingMs,
          }
        : null,
    });
  });
  pi.on("input", async (event) => {
    if (event.text.includes("\nQuestion: ") || !topic) {
      const original = event.text.split("\nQuestion: ").at(-1) ?? event.text;
      if (original !== topic) {
        reset();
        topic = original;
      }
    }
  });
  pi.on("agent_start", async () => {
    const delay = getSubmitNowDelayMs();
    deadline = delay === null ? Infinity : performance.now() + delay;
  });
  pi.on("tool_call", async (event) => {
    if (event.toolName === "jev_find" && performance.now() >= deadline)
      return {
        block: true,
        reason: "Research time is exhausted. Rank the source-verified candidates and submit now.",
      };
  });
  pi.on("before_agent_start", async (event) => {
    const systemPrompt =
      stripBenchmarkIrrelevantSystemPromptSections(event.systemPrompt) +
      "\nTask mode: document retrieval and relevance ranking. " +
      guidance +
      " Jev assesses documents against the original topic, not whether a factual question has been answered. Use source content to rank candidates at submission. Missing source is uncertainty. The candidate catalogue is an index, not a prescribed ranking.";
    dumpPromptSnapshot(systemPrompt, event.prompt);
    return { systemPrompt };
  });
  pi.on("context", async (event) => {
    if (!delivered.size) return;
    const catalogue = rankingCatalogue(
      [...delivered.values()],
      [...rankings].slice(-4).map(([id, ids]) => coverage(id, ids)),
    );
    audit({ type: "ranking_catalogue", catalogue });
    return {
      messages: [
        ...event.messages,
        {
          role: "user" as const,
          content: "Current candidate catalogue (data):\n" + JSON.stringify(catalogue),
          timestamp: Date.now(),
        },
      ],
    };
  });
  pi.on("session_shutdown", async () => {
    scanner.stop();
    reader.reset();
  });
}
