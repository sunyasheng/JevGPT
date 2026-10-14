import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceDoc } from "../src/extensions/jev_adaptive_overlap_v1";
import {
  mapLocalInterval,
  translateEvidenceDoc,
  translateFindOutput,
  parentDocidsOf,
  type UnitSource,
} from "../src/extensions/jev_passage_units_v1";

const docText = "---\ntitle: T\n---\n" + "line one of the body\nline two here\nline three ends\n";
// front matter = 17 chars; body span starts at 17 (contiguous) for unit A; unit B maps to "line three ends".
const front = 17;
const unitA: UnitSource = {
  unitId: "9#1",
  docid: "9",
  title: "T",
  aligned: true,
  docLength: docText.length,
  docText,
  text: docText.slice(0, front + 35),
  pieces: [{ local: [0, front + 35], doc: [0, front + 35] }],
};
const b0 = docText.indexOf("line three ends");
const unitB: UnitSource = {
  unitId: "9#2",
  docid: "9",
  title: "T",
  aligned: true,
  docLength: docText.length,
  docText,
  text: docText.slice(0, front) + "line three ends",
  pieces: [
    { local: [0, front], doc: [0, front] },
    { local: [front, front + 15], doc: [b0, b0 + 15] },
  ],
};
const resolve = (id: string) => ({ "9#1": unitA, "9#2": unitB })[id];

void test("mapLocalInterval splits across pieces and merges adjacent spans", () => {
  assert.deepEqual(mapLocalInterval(unitB.pieces, [10, front + 5]), [
    [10, front],
    [b0, b0 + 5],
  ]);
  assert.deepEqual(mapLocalInterval(unitA.pieces, [3, 9]), [[3, 9]]);
  assert.deepEqual(mapLocalInterval(unitB.pieces, [front + 20, front + 30]), []);
});

void test("translateEvidenceDoc rewrites pages, omissions and hits into parent coordinates", () => {
  const local = unitB.text.slice(front + 5, front + 15);
  const doc = {
    docid: "9#2",
    passages: [
      { text: local, lines: [4, 4], source_offsets_utf16: [front + 5, front + 15], query_ids: [1] },
    ],
    omitted_pages: [{ lines: [1, 2], source_offsets_utf16: [0, 12], query_ids: [2] }],
    selected_hits: [
      { query_id: 1, priority: 0, lines: [4, 4], source_offsets_utf16: [front, front + 15] },
    ],
    source_length_utf16: unitB.text.length,
    not_located_queries: [],
  };
  const out = translateEvidenceDoc(doc as never, resolve);
  assert.equal(out.docid, "9");
  assert.equal(out.passage_unit, "9#2");
  assert.equal(out.title, "T");
  assert.equal(out.source_length_utf16, docText.length);
  assert.equal(out.passages.length, 1);
  assert.deepEqual(out.passages[0].source_offsets_utf16, [b0 + 5, b0 + 15]);
  assert.equal(out.passages[0].text, docText.slice(b0 + 5, b0 + 15));
  assert.deepEqual(out.passages[0].lines, [6, 6]);
  assert.deepEqual(out.omitted_ranges_offsets_utf16, [[0, 12]]);
  assert.deepEqual(out.omitted_ranges, [[1, 2]]);
  assert.deepEqual(
    (out.selected_hits as { source_offsets_utf16: number[] }[])[0].source_offsets_utf16,
    [b0, b0 + 15],
  );
});

void test("pages spanning the front matter boundary become two verbatim pages", () => {
  const doc = {
    docid: "9#2",
    passages: [
      {
        text: unitB.text.slice(10, front + 4),
        lines: [2, 4],
        source_offsets_utf16: [10, front + 4],
        query_ids: [1],
      },
    ],
    not_located_queries: [],
  };
  const out = translateEvidenceDoc(doc as never, resolve);
  assert.equal(out.passages.length, 2);
  assert.equal(out.passages[0].text, docText.slice(10, front));
  assert.equal(out.passages[1].text, docText.slice(b0, b0 + 4));
  assert.deepEqual(out.passages[1].lines, [6, 6]);
});

void test("pages without offsets use unit line numbers; unknown and unaligned units stay put", () => {
  const byLines = translateEvidenceDoc(
    {
      docid: "9#1",
      passages: [{ text: "line one of the body", lines: [4, 4], query_ids: [1] }],
      not_located_queries: [],
    } as never,
    resolve,
  );
  assert.deepEqual(byLines.passages[0].source_offsets_utf16, [front, front + 20]);
  assert.deepEqual(byLines.passages[0].lines, [4, 4]);
  const untouched = translateEvidenceDoc(
    { docid: "9", passages: [], not_located_queries: [] } as never,
    resolve,
  );
  assert.equal(untouched.docid, "9");
  const unaligned = translateEvidenceDoc(
    {
      docid: "9#3",
      passages: [{ text: "x", lines: [1, 1], source_offsets_utf16: [0, 1], query_ids: [] }],
    } as never,
    (id) => (id === "9#3" ? { ...unitA, unitId: "9#3", aligned: false, pieces: [] } : undefined),
  );
  assert.equal(unaligned.docid, "9#3");
  assert.equal(unaligned.parent_docid, "9");
  assert.equal(unaligned.coordinates, "passage_unit_only");
  const bad = translateEvidenceDoc(
    {
      docid: "9#1",
      passages: [
        { text: "wrong", lines: [4, 4], source_offsets_utf16: [front, front + 5], query_ids: [] },
      ],
    } as never,
    resolve,
  );
  assert.equal(bad.passages[0].translation_error, "text_mismatch");
});

void test("translateFindOutput adds the unit map and keeps adaptive metadata", () => {
  const output = {
    documents: [
      { docid: "9#1", passages: [], not_located_queries: [] },
      { docid: "77", passages: [], not_located_queries: [] },
    ],
    adaptive: { scanned: 2 },
    note: "n",
  };
  const out = translateFindOutput(
    output as { documents: EvidenceDoc[]; adaptive: Record<string, unknown> },
    resolve,
  );
  assert.deepEqual(out.passage_units, { "9#1": "9" });
  assert.deepEqual(
    out.documents.map((d: { docid: string }) => d.docid),
    ["9", "77"],
  );
  assert.deepEqual(out.adaptive, { scanned: 2 });
  assert.deepEqual(parentDocidsOf(["9#1", "9#2", "77"], resolve), ["9"]);
});
