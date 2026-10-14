import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import {
  createDocumentRankingReader,
  packRankingDocuments,
  rankingCoverage,
} from "../src/extensions/jev_document_ranking_reader";
import { taskModeForBenchmark, resolveTaskMode } from "../src/pi-search/task_profile";
import { getBenchmarkDefinition } from "../src/benchmarks/registry";
import { formatPiSearchPrompt } from "../src/pi-search/agent_prompt";
import type { PiSearchBackend } from "../src/pi-search/searcher/contract/interface";

const topic = "Information about a seed vault";
const env = { TYPESAFE_API_KEY: "offline-only" };
function parseRequest(init?: RequestInit) {
  assert.ok(typeof init?.body === "string");
  return JSON.parse(init.body);
}
function answer(request: any, pageProbability = 0.9, continueProbability = 0.9) {
  const answers = Object.fromEntries(
    Object.entries(request.questions).map(([id, q]: [string, any]) => [
      id,
      q.type === "score"
        ? { type: "score", score: 3, probabilities: { "0": 0, "1": 0, "2": 0, "3": 1 } }
        : { type: "noul", noul: id === "continue_scan" ? continueProbability : pageProbability },
    ]),
  );
  return Response.json({ answers, usage: { input_tokens: 10 } });
}
const split = async (s: string) => {
  const middle = s.indexOf("\n") + 1;
  return [
    { start_utf16: 0, end_utf16: middle },
    { start_utf16: middle, end_utf16: s.length },
  ];
};
const text = "Seed vault storage conditions.\nSeed sources and depositing institutions.";
function backend(counter = { reads: 0 }): PiSearchBackend {
  return {
    capabilities: {} as any,
    search: async () => {
      throw new Error("Unexpected search");
    },
    readDocument: async () => {
      counter.reads++;
      return { found: true, text, totalUnits: 2, truncated: false } as any;
    },
  };
}

void test("benchmark selection changes task semantics while BrowseComp keeps the answer prompt", () => {
  assert.equal(taskModeForBenchmark("neuclir"), "rank_documents");
  assert.equal(taskModeForBenchmark("browsecomp-plus"), "answer_question");
  assert.equal(resolveTaskMode({}), "answer_question");
  assert.throws(() => resolveTaskMode({ PI_SEARCH_TASK_MODE: "typo" }));
  assert.equal(getBenchmarkDefinition("neuclir").piSearchPromptVariant, "rank_documents");
  assert.match(formatPiSearchPrompt("QUESTION"), /Exact Answer: \{your succinct, final answer\}/);
  assert.match(formatPiSearchPrompt("TOPIC", "rank_documents"), /JSON array of full docid strings/);
});

void test("all useful pages survive, and distinct documents repeating facts remain separate candidates", async () => {
  const requests: any[] = [];
  const reader = createDocumentRankingReader({
    env,
    split,
    fetchImpl: (async (_url, init) => {
      const r = parseRequest(init);
      requests.push(r);
      return answer(r);
    }) as typeof fetch,
  });
  const result = await reader.read({ topic, docids: ["A", "B"] }, backend());
  assert.deepEqual(
    result.output.documents.map((d) => d.docid),
    ["A", "B"],
  );
  for (const d of result.output.documents) {
    assert.equal(d.passages.map((p) => p.text).join(""), text);
    for (const p of d.passages)
      assert.equal(text.slice(...(p.source_offsets_utf16 as [number, number])), p.text);
  }
  assert.equal(requests.length, 2);
  assert.ok(requests.every((r) => r.state.original_topic === topic));
});

void test("repeated rankings reuse document judgments, but changing the original topic invalidates them", async () => {
  let requests = 0;
  const counts = { reads: 0 };
  const reader = createDocumentRankingReader({
    env,
    split,
    fetchImpl: (async (_u, init) => {
      requests++;
      return answer(parseRequest(init));
    }) as typeof fetch,
  });
  const b = backend(counts);
  await reader.read({ topic, docids: ["A", "B"] }, b);
  await reader.read({ topic, docids: ["B", "A"] }, b);
  assert.equal(requests, 2);
  assert.equal(counts.reads, 2);
  await reader.read({ topic: "Different topic", docids: ["A"] }, b);
  assert.equal(requests, 3);
});

void test("relevant documents keep expansion open; task completion is never inferred from an answered fact", async () => {
  const reader = createDocumentRankingReader({
    env,
    split,
    fetchImpl: (async (_u, init) => answer(parseRequest(init))) as typeof fetch,
  });
  const ids = Array.from({ length: 30 }, (_, i) => "d" + i);
  const r = await reader.read({ topic, docids: ids }, backend());
  assert.equal(r.output.adaptive.scanned, 30);
  assert.equal(r.output.documents.length, 30);
  assert.equal(r.output.adaptive.stop_reason, "candidate_interval_complete");
});

void test("low expected document yield yields only this interval with an exact unscanned suffix", async () => {
  const reader = createDocumentRankingReader({
    env,
    split,
    fetchImpl: (async (_u, init) => answer(parseRequest(init), 0.9, 0.1)) as typeof fetch,
  });
  const ids = Array.from({ length: 40 }, (_, i) => "d" + i);
  const r = await reader.read({ topic, docids: ids }, backend());
  assert.equal(r.output.adaptive.scanned, 20);
  assert.deepEqual(r.output.adaptive.unscanned_docids, ids.slice(20));
  assert.equal(r.output.adaptive.stop_reason, "low_expected_document_yield");
});

void test("ranking requests use the existing bounded token recovery without dropping either child page", async () => {
  const requests: any[] = [],
    events: any[] = [];
  const reader = createDocumentRankingReader({
    env,
    split,
    observe: (r) => events.push(r),
    fetchImpl: (async (_u, init) => {
      const r = parseRequest(init);
      requests.push(r);
      return Object.keys(r.questions).length > 2
        ? Response.json({ detail: { error_type: "max_tokens_exceeded" } }, { status: 400 })
        : answer(r);
    }) as typeof fetch,
  });
  const r = await reader.read({ topic, docids: ["A"] }, backend());
  assert.equal(requests.length, 3);
  assert.equal(r.output.documents[0].passages.map((p) => p.text).join(""), text);
  assert.equal(r.output.documents[0].scan_incomplete, false);
  assert.equal(events.filter((r) => r.type === "judge_region_split").length, 1);
});

void test("transport failures remain uncertain with original source rather than being filtered as unrelated", async () => {
  const reader = createDocumentRankingReader({
    env,
    split,
    fetchImpl: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
  });
  const r = await reader.read({ topic, docids: ["A"] }, backend());
  assert.equal(r.output.documents.length, 1);
  assert.equal(r.output.documents[0].scan_incomplete, true);
  assert.equal(r.output.documents[0].relevance.score, null);
  assert.equal(r.output.documents[0].passages.map((p) => p.text).join(""), text);
});

void test("source budget allocates first pages across documents and records every omitted window", async () => {
  const reader = createDocumentRankingReader({
    env,
    split,
    fetchImpl: (async (_u, init) => answer(parseRequest(init))) as typeof fetch,
  });
  await reader.read({ topic, docids: ["A", "B"] }, backend());
  const packed = packRankingDocuments(reader.catalogue(), text.indexOf("\n") * 2 + 2);
  assert.equal(packed.documents.length, 2);
  assert.ok(packed.documents.every((d) => d.passages.length === 1 && d.omitted_pages.length === 1));
  assert.ok(packed.source_chars <= text.indexOf("\n") * 2 + 2);
});

void test("the pinned semantic splitter covers long Unicode lines with exact source coordinates", async () => {
  const long = "😀种子来源é ".repeat(1800) + "\r\n" + "Storage conditions. ".repeat(350);
  const reader = createDocumentRankingReader({
    env: {
      ...env,
      JEV_SPLITTER_PYTHON: process.env.JEV_SPLITTER_PYTHON ?? "python3",
      JEV_EVIDENCE_PAGE_SCRIPT: resolve("../../scripts/jev_evidence_page_chunker_v1.py"),
    },
    fetchImpl: (async (_u, init) => answer(parseRequest(init))) as typeof fetch,
  });
  const b = backend();
  b.readDocument = async () =>
    ({ found: true, text: long, truncated: false, totalUnits: 2 }) as any;
  const r = await reader.read({ topic, docids: ["A"] }, b);
  let covered = 0;
  for (const p of r.output.documents[0].passages) {
    const [a, z] = p.source_offsets_utf16;
    assert.equal(long.slice(a, z), p.text);
    assert.ok(a <= covered && z > covered && p.text.length <= 4000);
    assert.ok(!/^[\uDC00-\uDFFF]/.test(p.text) && !/[\uD800-\uDBFF]$/.test(p.text));
    covered = z;
  }
  assert.equal(covered, long.length);
});

void test("search coverage exposes fresh documents behind a repeated preview and gives the next rank", () => {
  const ids = Array.from({ length: 80 }, (_, i) => "d" + i);
  const progress = rankingCoverage(ids, new Set(ids.slice(0, 5)));
  assert.equal(progress.unassessed_documents, 55);
  assert.equal(progress.next_unassessed_rank, 6);
  assert.deepEqual(progress.first_unassessed_ranks, [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal(rankingCoverage(ids, new Set(ids.slice(0, 60))).next_unassessed_rank, 61);
});

void test("a cached prefix cannot stop a new ranking before its unseen candidates are assessed", async () => {
  const ids = Array.from({ length: 40 }, (_, i) => "d" + i);
  const requests: any[] = [];
  const reader = createDocumentRankingReader({
    env,
    split,
    fetchImpl: (async (_u, init) => {
      const r = parseRequest(init);
      requests.push(r);
      const recent = r.state.candidate_progress?.recent_batches ?? [];
      const fresh = recent.some((b: any) => b.newly_assessed > 0);
      return answer(r, 0.9, fresh ? 0.9 : 0.1);
    }) as typeof fetch,
  });
  const b = backend();
  await reader.read({ topic, docids: ids.slice(0, 20) }, b);
  const r = await reader.read({ topic, docids: ids }, b);
  assert.equal(r.output.adaptive.reused_documents, 20);
  assert.equal(r.output.adaptive.newly_assessed, 20);
  assert.equal(r.output.documents.length, 40);
  assert.equal(requests.filter((r) => r.questions.relevance).length, 40);
});

void test("cached documents beyond a stop do not advance the resume cursor over an unassessed gap", async () => {
  const ids = Array.from({ length: 40 }, (_, i) => "d" + i);
  const reader = createDocumentRankingReader({
    env,
    split,
    fetchImpl: (async (_u, init) => answer(parseRequest(init), 0.9, 0.1)) as typeof fetch,
  });
  const b = backend();
  await reader.read({ topic, docids: ids.slice(25, 30), targeted: true }, b);
  const r = await reader.read({ topic, docids: ids }, b);
  assert.equal(r.output.adaptive.scanned, 25);
  assert.equal(r.scannedPrefix, 20);
  assert.deepEqual(r.output.adaptive.unscanned_docids, [...ids.slice(20, 25), ...ids.slice(30)]);
  assert.equal(r.attemptedDocids.length, 25);
});
