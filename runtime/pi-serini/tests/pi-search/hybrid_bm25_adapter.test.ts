import assert from "node:assert/strict";
import test from "node:test";

import {
  PassageBm25Backend,
  sliceLines,
  type PassageHelperTransport,
} from "../../src/pi-search/searcher/adapters/passage_bm25/adapter";
import {
  chooseUnit,
  HybridBm25Backend,
  rrfFuse,
} from "../../src/pi-search/searcher/adapters/passage_bm25/hybrid";
import type { PiSearchBackend } from "../../src/pi-search/searcher/contract/interface";

void test("rrfFuse reduces passages to documents (MaxP) and ranks by summed reciprocal ranks", () => {
  const docs = ["A", "B", "C"];
  const passages = [
    { docid: "X", index: 4 },
    { docid: "X", index: 2 },
    { docid: "C", index: 7 },
    { docid: "B", index: 1 },
  ];
  const fused = rrfFuse(docs, passages, 60);
  // Passage ranks over distinct documents: X=1 (best passage 4), C=2, B=3.
  const byId = Object.fromEntries(fused.map((e) => [e.docid, e]));
  assert.equal(byId.X.passageRank, 1);
  assert.equal(byId.X.bestPassage, 4);
  assert.equal(byId.C.passageRank, 2);
  assert.equal(byId.B.passageRank, 3);
  assert.equal(byId.A.passageRank, undefined);
  assert.ok(Math.abs(byId.C.score - (1 / 63 + 1 / 62)) < 1e-12);
  // C (3,2) and B (2,3) tie on score; tie broken by best single rank, then docid.
  assert.deepEqual(
    fused.map((e) => e.docid),
    ["B", "C", "A", "X"],
  );
});

void test("chooseUnit reads short documents whole and long documents through their best passage", () => {
  assert.equal(chooseUnit({ docid: "D", score: 1, bestPassage: 3 }, 3000, 8000), "D");
  assert.equal(chooseUnit({ docid: "D", score: 1, bestPassage: 3 }, 9000, 8000), "D#3");
  assert.equal(chooseUnit({ docid: "D", score: 1 }, 900000, 8000), "D");
  assert.equal(chooseUnit({ docid: "D", score: 1, bestPassage: 2 }, undefined, 8000), "D#2");
});

const DOCS: Record<string, string> = {
  short: "---\ntitle: Short Page\n---\nalpha beta gamma",
  long:
    "---\ntitle: Long Page\n---\n" +
    "filler ".repeat(2000) +
    "needle phrase here " +
    "filler ".repeat(10),
};
function documentsBackend(): PiSearchBackend {
  return {
    capabilities: {
      backendId: "docs",
      supportsScore: true,
      supportsSnippets: false,
      supportsExactTotalHits: false,
    },
    async search() {
      throw new Error("not used");
    },
    async readDocument(request) {
      const text = DOCS[request.docid];
      if (text === undefined) return { found: false, docid: request.docid };
      const w = sliceLines(text, request.offset ?? 1, request.limit ?? 200);
      return {
        found: true,
        docid: request.docid,
        text: w.text,
        offset: w.offset,
        limit: w.limit,
        totalUnits: w.totalUnits,
        truncated: w.truncated,
      };
    },
  };
}
function helper(
  results: { docid: string; score: number }[],
  passages: Record<string, string> = {},
): PassageHelperTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request(commandType, params) {
      calls.push(commandType);
      if (commandType === "search") return JSON.stringify({ mode: "search", results });
      if (commandType === "render_search_results")
        return JSON.stringify({
          mode: "render_search_results",
          results: (params.docids as string[]).map((docid) => ({
            docid,
            title: null,
            matched_terms: [],
            excerpt: `excerpt of ${docid}`,
            excerpt_truncated: false,
          })),
        });
      if (commandType === "read_document") {
        const text = passages[params.docid as string];
        return JSON.stringify(
          text === undefined
            ? { mode: "read_document", found: false }
            : { mode: "read_document", found: true, text, total_lines: 1, truncated: false },
        );
      }
      throw new Error(commandType);
    },
  };
}

void test("HybridBm25Backend emits one unit per document, with titles, and routes reads by unit kind", async () => {
  const documents = documentsBackend();
  const passageHelper = helper(
    [
      { docid: "browsecomp_plus_long_9", score: 9 },
      { docid: "browsecomp_plus_short_1", score: 8 },
    ],
    { browsecomp_plus_long_9: "Long Page needle phrase here" },
  );
  const docHelper = helper([
    { docid: "short", score: 5 },
    { docid: "other", score: 4 },
  ]);
  const units = new PassageBm25Backend({ passages: passageHelper, documents });
  const backend = new HybridBm25Backend({
    passages: passageHelper,
    documentHelper: docHelper,
    documents,
    units,
    docLengths: new Map([
      ["short", DOCS.short.length],
      ["long", DOCS.long.length],
      ["other", 100],
    ]),
    shortChars: 8000,
    fusion: "rrf",
    passagesPerDoc: 1,
  });
  const response = await backend.search({ query: "needle", limit: 1000 });
  assert.deepEqual(
    response.hits.map((h) => h.docid),
    ["short", "long#9", "other"],
  );
  assert.equal(response.hits[0].title, "Short Page");
  assert.equal(response.hits[1].title, "Long Page");
  assert.equal(response.hits[0].snippet, "excerpt of short");
  assert.equal(response.hits[1].snippet, "excerpt of browsecomp_plus_long_9");
  assert.deepEqual(response.hits[1].metadata, {
    parent_docid: "long",
    unit_kind: "passage",
    doc_rank: null,
    passage_rank: 1,
    doc_length_utf16: DOCS.long.length,
    fusion: "rrf",
  });
  const whole = await backend.readDocument({ docid: "short", offset: 1, limit: 1000000 });
  assert.ok(whole.found && whole.text === DOCS.short);
  const unit = await backend.readDocument({ docid: "long#9", offset: 1, limit: 1000000 });
  assert.ok(unit.found);
  assert.ok(
    unit.text.startsWith("---\ntitle: Long Page\n---\n") &&
      unit.text.endsWith("needle phrase here"),
  );
  assert.ok(backend.getUnitMapping("long#9")?.aligned);
});

import { convexFuse, minMax } from "../../src/pi-search/searcher/adapters/passage_bm25/hybrid";

void test("minMax maps the list's extremes to 0 and 1 and a constant list to 0", () => {
  const m = minMax([
    ["a", 10],
    ["b", 5],
    ["c", 7.5],
  ]);
  assert.equal(m.get("a"), 1);
  assert.equal(m.get("b"), 0);
  assert.equal(m.get("c"), 0.5);
  assert.equal(
    minMax([
      ["x", 3],
      ["y", 3],
    ]).get("x"),
    0,
  );
  assert.equal(minMax([]).size, 0);
});

void test("convexFuse combines normalised sides, keeps a one-sided winner near the top, and records top passages", () => {
  // Document side: A strongest. Passage side: X strongest (not in the document list), A weak.
  const fused = convexFuse(
    [
      ["A", 20],
      ["B", 15],
      ["C", 10],
    ],
    [
      { docid: "X", index: 7, score: 30 },
      { docid: "X", index: 2, score: 28 },
      { docid: "X", index: 9, score: 27 },
      { docid: "A", index: 1, score: 20 },
      { docid: "C", index: 4, score: 10 },
    ],
    0.5,
    2,
  );
  const byId = Object.fromEntries(fused.map((e) => [e.docid, e]));
  assert.equal(byId.A.normDoc, 1);
  assert.equal(byId.X.normPassage, 1);
  assert.equal(byId.X.normDoc, 0);
  assert.ok(Math.abs(byId.A.score - (0.5 * 1 + 0.5 * 0.5)) < 1e-12);
  assert.ok(Math.abs(byId.X.score - 0.5) < 1e-12);
  assert.deepEqual(fused.map((e) => e.docid).slice(0, 2), ["A", "X"]);
  assert.deepEqual(byId.X.topPassages, [7, 2]);
  assert.equal(byId.X.bestPassage, 7);
  assert.deepEqual(byId.B.topPassages, []);
});

void test("default convex fusion expands a long document into its top passages as consecutive units", async () => {
  const documents = documentsBackend();
  const passageHelper = helper(
    [
      { docid: "browsecomp_plus_long_9", score: 9 },
      { docid: "browsecomp_plus_long_3", score: 8.5 },
      { docid: "browsecomp_plus_long_5", score: 8 },
      { docid: "browsecomp_plus_short_1", score: 7 },
    ],
    {
      browsecomp_plus_long_9: "Long Page needle phrase here",
      browsecomp_plus_long_3: "Long Page filler filler",
    },
  );
  const docHelper = helper([{ docid: "short", score: 5 }]);
  const units = new PassageBm25Backend({ passages: passageHelper, documents });
  const backend = new HybridBm25Backend({
    passages: passageHelper,
    documentHelper: docHelper,
    documents,
    units,
    docLengths: new Map([
      ["short", DOCS.short.length],
      ["long", DOCS.long.length],
    ]),
    shortChars: 8000,
    lambda: 0.5,
    passagesPerDoc: 2,
  });
  const response = await backend.search({ query: "needle", limit: 1000 });
  assert.deepEqual(response.hits.map((h) => h.docid).sort(), ["long#3", "long#9", "short"].sort());
  assert.deepEqual(
    response.hits.filter((h) => h.docid.startsWith("long#")).map((h) => h.docid),
    ["long#9", "long#3"],
  );
  assert.equal(response.hits.find((h) => h.docid === "long#9")!.metadata!.fusion, "cc");
});
