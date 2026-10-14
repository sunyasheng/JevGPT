import assert from "node:assert/strict";
import test from "node:test";

import {
  alignBody,
  buildUnitText,
  compactText,
  parseFrontmatter,
  parsePassageId,
  parseUnitId,
  PassageBm25Backend,
  sliceLines,
  stripTitlePrefix,
  unitIdFor,
} from "../../src/pi-search/searcher/adapters/passage_bm25/adapter";
import type { AnseriniBm25HelperTransport } from "../../src/pi-search/searcher/adapters/anserini_bm25/helper_transport";
import type { PiSearchBackend } from "../../src/pi-search/searcher/contract/interface";

const DOCS: Record<string, string> = {
  "6235":
    "---\ntitle: Elfen Lied\ndate: 2004-07-25\n---\nElfen Lied (エルフェンリート) is a Japanese manga series\ncreated by Lynn Okamoto.\nSecond paragraph  with   odd spacing.\n",
  "64576": "alpha beta gamma delta epsilon zeta eta theta",
  "77": '---\ntitle: "T"\n---\nx y z\nx y z\n',
};
const PASSAGES: Record<string, string> = {
  browsecomp_plus_6235_1:
    "Elfen Lied Elfen Lied (エルフェンリート) is a Japanese manga series created by Lynn Okamoto.",
  browsecomp_plus_6235_2: "Elfen Lied Second paragraph with odd spacing.",
  browsecomp_plus_64576_1: "gamma delta epsilon",
  browsecomp_plus_77_1: "T x y z",
  browsecomp_plus_77_2: "T x y z",
};

function fakeDocuments(): PiSearchBackend & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    capabilities: {
      backendId: "fake-docs",
      supportsScore: true,
      supportsSnippets: false,
      supportsExactTotalHits: false,
    },
    async search() {
      throw new Error("document search is not used by the passage backend");
    },
    async readDocument(request) {
      reads.push(request.docid);
      const text = DOCS[request.docid];
      if (text === undefined) return { found: false, docid: request.docid };
      const window = sliceLines(text, request.offset ?? 1, request.limit ?? 200);
      return {
        found: true,
        docid: request.docid,
        text: window.text,
        offset: window.offset,
        limit: window.limit,
        totalUnits: window.totalUnits,
        truncated: window.truncated,
        ...(window.nextOffset ? { nextOffset: window.nextOffset } : {}),
      };
    },
  };
}

function fakePassages(): AnseriniBm25HelperTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request(commandType, params) {
      calls.push(commandType);
      if (commandType === "search")
        return JSON.stringify({
          mode: "search",
          results: [
            { docid: "browsecomp_plus_6235_1", score: 28.9 },
            { docid: "browsecomp_plus_64576_1", score: 10.5 },
            { docid: "not_a_passage", score: 1 },
          ],
          timing_ms: { command: 4, init: 1, server_uptime: 9 },
        });
      if (commandType === "render_search_results")
        return JSON.stringify({
          mode: "render_search_results",
          results: (params.docids as string[]).map((docid) => ({
            docid,
            title: null,
            matched_terms: [],
            excerpt: PASSAGES[docid]?.slice(0, 40) ?? "",
            excerpt_truncated: true,
          })),
        });
      if (commandType === "read_document") {
        const text = PASSAGES[params.docid as string];
        if (text === undefined)
          return JSON.stringify({ mode: "read_document", docid: params.docid, found: false });
        return JSON.stringify({
          mode: "read_document",
          docid: params.docid,
          found: true,
          text,
          total_lines: 1,
          truncated: false,
        });
      }
      throw new Error(`unexpected ${commandType}`);
    },
  };
}

void test("unit and passage id round trips", () => {
  assert.deepEqual(parseUnitId("6235#14"), { docid: "6235", index: 14 });
  assert.equal(parseUnitId("6235"), undefined);
  assert.equal(parseUnitId("6235#"), undefined);
  assert.equal(parseUnitId("#3"), undefined);
  assert.equal(unitIdFor("6235", 14), "6235#14");
  assert.deepEqual(parsePassageId("browsecomp_plus_", "browsecomp_plus_64576_14"), {
    docid: "64576",
    index: 14,
  });
  assert.equal(parsePassageId("browsecomp_plus_", "other_1_2"), undefined);
});

void test("front matter and title stripping tolerate whitespace and quotes", () => {
  assert.deepEqual(parseFrontmatter(DOCS["6235"]), { end: 43, title: "Elfen Lied" });
  assert.deepEqual(parseFrontmatter(DOCS["77"]), { end: 19, title: "T" });
  assert.deepEqual(parseFrontmatter(DOCS["64576"]), { end: 0 });
  assert.equal(
    parseFrontmatter(
      '---\ntitle: "Stranger Things" was influenced by "Akira"\ndate: 2017-02-17\n---\nbody',
    ).title,
    '"Stranger Things" was influenced by "Akira"',
  );
  assert.equal(parseFrontmatter("---\ntitle: 'Quoted'\n---\nbody").title, "Quoted");
  assert.equal(stripTitlePrefix("Elfen Lied Elfen Lied ( x", "Elfen Lied"), "Elfen Lied ( x");
  assert.equal(stripTitlePrefix("gamma delta", undefined), "gamma delta");
  assert.equal(stripTitlePrefix("Other start", "Elfen Lied"), "Other start");
});

void test("whitespace-insensitive alignment maps a normalised body to the original span", () => {
  const doc = { text: DOCS["6235"], compact: compactText(DOCS["6235"]) };
  const span = alignBody(doc, "Second paragraph with odd spacing.");
  assert.ok(span);
  assert.equal(DOCS["6235"].slice(span[0], span[1]), "Second paragraph  with   odd spacing.");
  const exact = alignBody(
    { text: DOCS["64576"], compact: compactText(DOCS["64576"]) },
    "gamma delta epsilon",
  );
  assert.deepEqual(exact, [11, 30]);
  assert.equal(alignBody(doc, "not present anywhere"), undefined);
  const repeated = { text: DOCS["77"], compact: compactText(DOCS["77"]) };
  assert.deepEqual(alignBody(repeated, "x y z"), [19, 24]);
  assert.deepEqual(alignBody(repeated, "x y z", 24), [25, 30]);
  const built = buildUnitText(DOCS["6235"], parseFrontmatter(DOCS["6235"]), span);
  assert.equal(built.text, DOCS["6235"].slice(0, 43) + "Second paragraph  with   odd spacing.");
  assert.deepEqual(built.pieces, [
    { local: [0, 43], doc: [0, 43] },
    { local: [43, 43 + 37], doc: [span[0], span[1]] },
  ]);
});

void test("sliceLines mirrors the Java line window", () => {
  const text = "a\nb\nc";
  assert.deepEqual(sliceLines(text, 1, 10), {
    offset: 1,
    limit: 10,
    totalUnits: 3,
    returnedOffsetStart: 1,
    returnedOffsetEnd: 3,
    truncated: false,
    nextOffset: undefined,
    text,
  });
  assert.deepEqual(sliceLines(text, 2, 1), {
    offset: 2,
    limit: 1,
    totalUnits: 3,
    returnedOffsetStart: 2,
    returnedOffsetEnd: 2,
    truncated: true,
    nextOffset: 3,
    text: "b",
  });
  assert.equal(sliceLines(text, 9, 1).returnedOffsetStart, 0);
});

void test("search exposes passage units with parent titles and excerpts", async () => {
  const passages = fakePassages(),
    documents = fakeDocuments();
  const backend = new PassageBm25Backend({ passages, documents });
  const response = await backend.search({ query: "Elfen Lied manga", limit: 1000 });
  assert.equal(response.hits.length, 2);
  assert.equal(response.hits[0].docid, "6235#1");
  assert.equal(response.hits[0].title, "Elfen Lied");
  assert.equal(
    response.hits[0].snippet,
    PASSAGES.browsecomp_plus_6235_1.slice("Elfen Lied ".length, 40),
  );
  assert.deepEqual(response.hits[0].metadata, { parent_docid: "6235", passage_index: 1 });
  assert.equal(response.hits[1].docid, "64576#1");
  assert.equal(response.hits[1].title, undefined);
  assert.equal(response.hasMore, false);
  assert.equal(response.timingMs?.request, 4);
  assert.deepEqual(passages.calls, ["search", "render_search_results"]);
  assert.deepEqual(documents.reads, ["6235", "64576"]);
  // Titles are cached across searches.
  await backend.search({ query: "again", limit: 1000 });
  assert.deepEqual(documents.reads, ["6235", "64576"]);
});

void test("readDocument serves verbatim pseudo-documents and delegates parent docids", async () => {
  const backend = new PassageBm25Backend({ passages: fakePassages(), documents: fakeDocuments() });
  const first = await backend.readDocument({ docid: "6235#1", offset: 1, limit: 1000000 });
  assert.ok(first.found);
  const doc = DOCS["6235"];
  const bodyEnd = doc.indexOf("Okamoto.") + "Okamoto.".length;
  assert.equal(first.text, doc.slice(0, bodyEnd));
  assert.equal(first.title, "Elfen Lied");
  assert.equal(first.totalUnits, 6);
  assert.equal(first.truncated, false);
  assert.deepEqual(first.metadata?.pieces, [{ local: [0, bodyEnd], doc: [0, bodyEnd] }]);
  const second = await backend.readDocument({ docid: "6235#2", offset: 1, limit: 1000000 });
  assert.ok(second.found);
  assert.equal(second.text, doc.slice(0, 43) + "Second paragraph  with   odd spacing.");
  const mapping = backend.getUnitMapping("6235#2");
  assert.ok(mapping?.aligned);
  assert.equal(mapping.docLength, doc.length);
  assert.equal(mapping.pieces.length, 2);
  for (const piece of mapping.pieces)
    assert.equal(
      mapping.text.slice(piece.local[0], piece.local[1]),
      doc.slice(piece.doc[0], piece.doc[1]),
    );
  const ocr = await backend.readDocument({ docid: "64576#1", offset: 1, limit: 1000000 });
  assert.ok(ocr.found);
  assert.equal(ocr.text, "gamma delta epsilon");
  assert.deepEqual(ocr.metadata?.pieces, [{ local: [0, 19], doc: [11, 30] }]);
  const parent = await backend.readDocument({ docid: "6235", offset: 1, limit: 1000000 });
  assert.ok(parent.found);
  assert.equal(parent.text, doc);
  const missing = await backend.readDocument({ docid: "6235#9", offset: 1, limit: 1000000 });
  assert.equal(missing.found, false);
  const paged = await backend.readDocument({ docid: "6235#1", offset: 2, limit: 1 });
  assert.ok(paged.found);
  assert.equal(paged.text, "title: Elfen Lied");
  assert.equal(paged.truncated, true);
});

void test("repeated passage bodies anchor on the preceding passage", async () => {
  const backend = new PassageBm25Backend({ passages: fakePassages(), documents: fakeDocuments() });
  const first = await backend.readDocument({ docid: "77#1", offset: 1, limit: 1000000 });
  const second = await backend.readDocument({ docid: "77#2", offset: 1, limit: 1000000 });
  assert.ok(first.found && second.found);
  assert.deepEqual(backend.getUnitMapping("77#1")!.pieces, [{ local: [0, 24], doc: [0, 24] }]);
  assert.deepEqual(backend.getUnitMapping("77#2")!.pieces, [
    { local: [0, 19], doc: [0, 19] },
    { local: [19, 24], doc: [25, 30] },
  ]);
});
