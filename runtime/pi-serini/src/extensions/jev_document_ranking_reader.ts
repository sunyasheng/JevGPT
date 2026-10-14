import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { PiSearchBackend } from "../pi-search/searcher/contract/interface";
import { FIND_LIMITS, type Region } from "./jev_find_v1";
import { createRegionJudge, type TokenRecoveryOptions } from "./jev_region_judge_v2";
import { OverlapWorker } from "./jev_overlap_reader_v1";
import { originalLineAt, originalLineStarts } from "./read_document_paged_v1";
import { gptSourceBudget } from "./jev_gpt_return_budget_v1";
import {
  relevancePolicy,
  expansionPolicy,
  progressRegion,
  type RelevanceJudgment,
} from "./jev_document_ranking_policy";

export type RankingPage = {
  id: string;
  text: string;
  lines: number[];
  source_offsets_utf16: number[];
  keep_probability: number | null;
};
export type RankedDocument = {
  docid: string;
  title: string;
  passages: RankingPage[];
  relevance: {
    score: number | null;
    probability: number | null;
    assessed_regions: number;
    source_scope: "full_document" | "partial_document";
  };
  scan_incomplete: boolean;
  source_length_utf16: number;
  error?: string;
};
type Source = {
  title: string;
  text: string;
  pages: RankingPage[];
  regions: Region[];
  incomplete: boolean;
};
type Options = TokenRecoveryOptions & {
  split?: (text: string) => Promise<{ start_utf16: number; end_utf16: number }[]>;
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const isCandidate = (d: RankedDocument) =>
  d.scan_incomplete || (d.relevance.probability ?? 0) >= 0.25;

export function rankingCoverage(ids: string[], assessed: Set<string>, limit = 60) {
  const window = ids.slice(0, limit);
  const unseen = window.flatMap((docid, i) => (assessed.has(docid) ? [] : [i + 1]));
  return {
    window: [1, window.length],
    total_cached: ids.length,
    assessed_documents: window.length - unseen.length,
    unassessed_documents: unseen.length,
    first_unassessed_ranks: unseen.slice(0, 10),
    next_unassessed_rank:
      ids.findIndex((id) => !assessed.has(id)) < 0
        ? null
        : ids.findIndex((id) => !assessed.has(id)) + 1,
  };
}

/** Fair, whole-page allocation. An omitted page remains explicitly recoverable. */
export function packRankingDocuments(docs: RankedDocument[], budget: number) {
  const candidates = docs.filter(isCandidate);
  const output = candidates.map((d) => ({
    ...d,
    passages: [] as RankingPage[],
    omitted_pages: [] as Omit<RankingPage, "text">[],
  }));
  let chars = 0;
  const maxPages = Math.max(0, ...candidates.map((d) => d.passages.length));
  for (let i = 0; i < maxPages; i++) {
    for (let j = 0; j < candidates.length; j++) {
      const p = candidates[j].passages[i];
      if (!p) continue;
      if (chars + p.text.length <= budget) {
        output[j].passages.push(p);
        chars += p.text.length;
      } else {
        const { text: _text, ...metadata } = p;
        output[j].omitted_pages.push(metadata);
      }
    }
  }
  return {
    documents: output,
    source_chars: chars,
    omitted_documents: docs.length - candidates.length,
  };
}

export function createDocumentRankingReader(options: Options = {}) {
  const env = options.env ?? process.env;
  const observe = options.observe ?? (() => {});
  const remaining = options.remainingTimeMs ?? (() => Infinity);
  const splitter = new OverlapWorker({ ...env, JEV_OVERLAP_SCRIPT: env.JEV_EVIDENCE_PAGE_SCRIPT });
  const split = options.split ?? ((s: string) => splitter.split(s));
  const judge = createRegionJudge<RelevanceJudgment>({
    ...options,
    policy: relevancePolicy,
    timeoutMs: options.timeoutMs ?? 20000,
  });
  const gate = createRegionJudge<number>({
    ...options,
    policy: expansionPolicy,
    timeoutMs: 15000,
    observe: (r) =>
      observe({
        ...r,
        type: r.type === "judge" ? "adaptive_gate" : r.type,
        policy: "rank_documents",
      }),
  });
  const sources = new Map<string, Source>();
  const documents = new Map<string, RankedDocument>();
  let topic = "",
    sequence = 0;
  let queue: Promise<unknown> = Promise.resolve();

  async function source(
    docid: string,
    backend: PiSearchBackend,
    batch: number,
    signal?: AbortSignal,
  ) {
    const cached = sources.get(docid);
    if (cached) return cached;
    const started = performance.now();
    const r = await backend.readDocument(
      { docid, offset: 1, limit: FIND_LIMITS.readLines },
      signal,
    );
    observe({
      type: "backend_read",
      docid,
      batch,
      found: r.found,
      elapsed_ms: performance.now() - started,
    });
    if (!r.found) throw new Error("not_found");
    const spans = await split(r.text),
      starts = originalLineStarts(r.text);
    let covered = 0;
    const pages = spans.map((s, i): RankingPage => {
      assert.ok(s.start_utf16 <= covered && s.end_utf16 > covered && s.end_utf16 <= r.text.length);
      assert.ok(s.start_utf16 >= 0 && s.end_utf16 - s.start_utf16 <= 4000);
      covered = s.end_utf16;
      return {
        id: "P" + (i + 1),
        text: r.text.slice(s.start_utf16, s.end_utf16),
        lines: [originalLineAt(starts, s.start_utf16), originalLineAt(starts, s.end_utf16 - 1)],
        source_offsets_utf16: [s.start_utf16, s.end_utf16],
        keep_probability: null,
      };
    });
    assert.equal(covered, r.text.length, "Source pages must cover the whole available document");
    const regions: Region[] = [];
    let blocks: Region["blocks"] = [],
      bytes = 0;
    const flush = () => {
      if (!blocks.length) return;
      regions.push({
        start_line: blocks[0].start_line,
        end_line: blocks.at(-1)!.end_line,
        blocks,
        state: blocks.map((b) => b.id + "| " + b.text).join("\n"),
      });
      blocks = [];
      bytes = 0;
    };
    for (const p of pages) {
      const size = Buffer.byteLength(p.text);
      if (blocks.length && bytes + size > 48000) flush();
      blocks.push({ id: p.id, text: p.text, start_line: p.lines[0], end_line: p.lines[1] });
      bytes += size;
    }
    flush();
    const value: Source = {
      title:
        r.text
          .split(/\r?\n/)
          .find((s) => s.trim())
          ?.slice(0, 350) ?? docid,
      text: r.text,
      pages,
      regions,
      incomplete: Boolean(r.truncated),
    };
    sources.set(docid, value);
    observe({
      type: "ranking_source",
      docid,
      source_sha256: sha(r.text),
      source_chars_utf16: r.text.length,
      pages: pages.length,
      regions: regions.length,
      source_truncated: value.incomplete,
    });
    return value;
  }

  async function inspect(
    docid: string,
    backend: PiSearchBackend,
    batch: number,
    signal?: AbortSignal,
  ) {
    const cached = documents.get(docid);
    if (cached && !cached.scan_incomplete) {
      observe({ type: "ranking_document_cache", docid, batch });
      return { doc: cached, cached: true };
    }
    try {
      const s = await source(docid, backend, batch, signal);
      const rows = [];
      for (const region of s.regions) {
        if (remaining() <= 1000) {
          rows.push({ region, ok: false as const, error: "research_budget_exhausted" });
          continue;
        }
        rows.push(...(await judge(docid, region, [topic], batch, signal)));
      }
      const ok = rows.filter((r) => r.ok);
      const best = ok.map((r) => r.results).sort((a, b) => b.score - a.score)[0];
      const scores = Object.assign({}, ...ok.map((r) => r.results.pages)) as Record<string, number>;
      const incomplete = s.incomplete || rows.some((r) => !r.ok) || !ok.length;
      let selected = s.pages
        .map((p) => ({ ...p, keep_probability: scores[p.id] ?? null }))
        .filter((p) => p.keep_probability === null || p.keep_probability >= 0.5);
      // A plausible document always supplies source for GPT's own relevance judgment.
      if (!selected.length && (best?.relevant ?? 0) >= 0.25 && s.pages.length) {
        const p = [...s.pages].sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0))[0];
        selected = [{ ...p, keep_probability: scores[p.id] ?? null }];
      }
      const doc: RankedDocument = {
        docid,
        title: s.title,
        passages: selected,
        relevance: {
          score: best?.score ?? null,
          probability: best?.relevant ?? null,
          assessed_regions: ok.length,
          source_scope: incomplete ? "partial_document" : "full_document",
        },
        scan_incomplete: incomplete,
        source_length_utf16: s.text.length,
        ...(rows.some((r) => !r.ok)
          ? {
              error: rows
                .filter((r) => !r.ok)
                .map((r) => r.error)
                .join("; "),
            }
          : {}),
      };
      documents.set(docid, doc);
      observe({
        type: "ranking_document",
        batch,
        docid,
        relevance: doc.relevance,
        scan_incomplete: incomplete,
        selected_pages: selected.map(({ text: _text, ...p }) => p),
      });
      return { doc, cached: false };
    } catch (e) {
      signal?.throwIfAborted();
      const doc: RankedDocument = {
        docid,
        title: docid,
        passages: [],
        scan_incomplete: true,
        source_length_utf16: 0,
        relevance: {
          score: null,
          probability: null,
          assessed_regions: 0,
          source_scope: "partial_document",
        },
        error: e instanceof Error ? e.message : String(e),
      };
      documents.set(docid, doc);
      observe({ type: "ranking_document", batch, docid, error: doc.error, scan_incomplete: true });
      return { doc, cached: false };
    }
  }

  async function run(
    input: { topic: string; docids: string[]; targeted?: boolean },
    backend: PiSearchBackend,
    signal?: AbortSignal,
  ) {
    assert.ok(input.topic.trim() && input.docids.length > 0 && input.docids.length <= 60);
    if (topic && topic !== input.topic) reset();
    topic = input.topic;
    const batch = ++sequence,
      ids = [...new Set(input.docids)];
    const processed = new Map<string, RankedDocument>();
    // A rewritten query often puts known documents first. Reuse them before
    // batching so a repeated prefix cannot masquerade as a low-yield new batch.
    for (const id of ids) {
      const cached = documents.get(id);
      if (cached && !cached.scan_incomplete) {
        processed.set(id, cached);
        observe({ type: "ranking_document_cache", docid: id, batch });
      }
    }
    const reused = processed.size;
    const pending = ids.filter((id) => !processed.has(id));
    const stages: any[] = [];
    let freshScanned = 0,
      stopReason = "candidate_interval_complete";
    try {
      while (freshScanned < pending.length) {
        signal?.throwIfAborted();
        if (remaining() <= 1000) {
          stopReason = "research_budget";
          break;
        }
        const chunk = pending.slice(freshScanned, freshScanned + 10);
        const rows = await Promise.all(chunk.map((id) => inspect(id, backend, batch, signal)));
        for (const r of rows) processed.set(r.doc.docid, r.doc);
        freshScanned += chunk.length;
        const stage = {
          from: freshScanned - chunk.length + 1,
          to: freshScanned,
          original_ranks: chunk.map((id) => ids.indexOf(id) + 1),
          newly_assessed: rows.filter((r) => !r.cached).length,
          new_relevant_documents: rows.filter(
            (r) => !r.cached && (r.doc.relevance.probability ?? 0) >= 0.5,
          ).length,
          uncertain_documents: rows.filter((r) => r.doc.scan_incomplete).length,
          documents: rows.map((r) => ({
            docid: r.doc.docid,
            score: r.doc.relevance.score,
            relevant_probability: r.doc.relevance.probability,
            cached: r.cached,
          })),
        };
        stages.push(stage);
        observe({ type: "ranking_stage", batch, ...stage });
        if (input.targeted || freshScanned === pending.length || freshScanned < 20) continue;
        const progress = {
          assessed: freshScanned,
          interval_size: pending.length,
          cached_documents_reused_separately: reused,
          remaining: pending.length - freshScanned,
          unseen_remaining: pending.length - freshScanned,
          recent_batches: stages.slice(-2),
        };
        if (remaining() <= 1500) {
          stopReason = "research_budget";
          break;
        }
        const verdict = await gate(
          "ranking:" + batch,
          progressRegion(progress),
          [topic],
          batch,
          signal,
        );
        const decision = verdict[0];
        if (!decision?.ok) {
          stopReason = "assessment_unavailable";
          break;
        }
        observe({
          type: "ranking_expansion",
          batch,
          scanned: processed.size,
          fresh_scanned: freshScanned,
          continue_probability: decision.results,
        });
        if (decision.results < 0.5) {
          stopReason = "low_expected_document_yield";
          break;
        }
      }
      const attemptedDocids = ids.filter((id) => processed.has(id));
      let scannedPrefix = 0;
      while (scannedPrefix < ids.length && processed.has(ids[scannedPrefix])) scannedPrefix++;
      const packed = packRankingDocuments(
        attemptedDocids.map((id) => processed.get(id)!),
        gptSourceBudget(env),
      );
      const output = {
        ...packed,
        note: "Original source grouped by document for topic relevance ranking. Jev scores are fallible estimates, not official labels or final ranks. Compare substantive topic coverage using the source. Each distinct relevant document can be returned even if its facts repeat another document. An omitted page or failed scan never proves irrelevance. Read omitted page offsets when needed. This call does not certify coverage of the collection.",
        adaptive: {
          policy: "rank_documents_v2",
          scanned: processed.size,
          scanned_prefix: scannedPrefix,
          newly_assessed: freshScanned,
          reused_documents: reused,
          available: ids.length,
          stop_reason: stopReason,
          unscanned_docids: ids.filter((id) => !processed.has(id)),
          stages,
        },
      };
      observe({ type: "ranking_public", batch, output });
      return { output, attemptedDocids, scannedPrefix };
    } finally {
      splitter.close();
    }
  }

  function reset() {
    sources.clear();
    documents.clear();
    judge.reset();
    gate.reset();
    splitter.close();
    topic = "";
  }
  return {
    read(input: Parameters<typeof run>[0], backend: PiSearchBackend, signal?: AbortSignal) {
      const result = queue.then(() => run(input, backend, signal));
      queue = result.catch(() => {});
      return result;
    },
    reset,
    catalogue: () => [...documents.values()].filter(isCandidate),
    assessedIds: () =>
      new Set([...documents.values()].filter((d) => !d.scan_incomplete).map((d) => d.docid)),
  };
}
