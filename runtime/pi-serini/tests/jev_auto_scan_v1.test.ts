import assert from "node:assert/strict";
import test from "node:test";

import {
  attachNoticesToText,
  buildNotice,
  clueQueriesFromQuestion,
  createAutoScanner,
  NOTICE_MARKER,
} from "../src/extensions/jev_auto_scan_v1";
import type { PiSearchBackend } from "../src/pi-search/searcher/contract/interface";

void test("clueQueriesFromQuestion keeps declarative sentences, drops the ask, merges to the cap", () => {
  const q =
    "A bridge was designed by 3 engineers in 1998. Its construction brought two city councils into a joint project. The bridge has 7 spans of different lengths. A plaque on the first span reads “built for all”. Which bridge is it?";
  const clues = clueQueriesFromQuestion(q);
  assert.equal(clues.length, 4);
  assert.ok(clues.every((c) => !c.endsWith("?")));
  assert.equal(clues[0], "A bridge was designed by 3 engineers in 1998.");
  const many = clueQueriesFromQuestion(
    Array.from({ length: 9 }, (_, i) => `Clue number ${i + 1} is here.`).join(" "),
  );
  assert.equal(many.length, 6);
  assert.ok(many.some((c) => c.includes("Clue number 1 is here. Clue number 2 is here.")));
  const listed = clueQueriesFromQuestion(
    "Please identify a museum in which:  - One of its wings was designed by an architect who also designed a train station. - Another wing opened between 1950 and 1975 (exclusive). - One of its curators, who wrote two catalogues, was born after 1980. Which museum is it?",
  );
  assert.deepEqual(listed, [
    "One of its wings was designed by an architect who also designed a train station.",
    "Another wing opened between 1950 and 1975 (exclusive).",
    "One of its curators, who wrote two catalogues, was born after 1980.",
  ]);
  assert.deepEqual(
    clueQueriesFromQuestion("Facts: 1) The bakery opened in 1962. 2) It sold rye bread six days a week. Name it."),
    ["The bakery opened in 1962.", "It sold rye bread six days a week."],
  );
  const traits = clueQueriesFromQuestion(
    "Who is the person with these traits as of June 2022: Opened a regional newspaper between 1920 and 1960, served on a city council between 1940 and 1965, was born in the late 19th century, studied at the same college as the winner of a televised cooking contest in the early 21st century.",
  );
  assert.ok(traits.length >= 3 && traits.length <= 6, JSON.stringify(traits));
  assert.ok(traits[0].startsWith("Opened a regional newspaper"));
  assert.ok(traits.every((t) => t.length <= 200));
  assert.ok(traits.some((t) => t.includes("city council")));
  assert.deepEqual(clueQueriesFromQuestion("Who is it?"), ["Who is it?"]);
  assert.deepEqual(clueQueriesFromQuestion("   "), []);
  const long = clueQueriesFromQuestion("x".repeat(400) + ".");
  assert.ok(long[0].length <= 350);
});

const DOCS = [
  {
    docid: "A",
    passage_unit: "A#3",
    passages: [
      { text: "alpha ".repeat(100), query_ids: [1, 2], lines: [4, 9], source_offsets_utf16: [10, 610] },
      { text: "context only", query_ids: [], context_read: true },
    ],
  },
  { docid: "B", passages: [{ text: "beta", query_ids: [2], lines: [1, 1], source_offsets_utf16: [0, 4] }] },
  { docid: "C", passages: [{ text: "gamma", query_ids: [], fallback: true }] },
  { docid: "D", passages: [] },
];

void test("buildNotice keeps located documents only, orders by clue coverage then rank, bounds excerpts", () => {
  const units = [
    { unit: "D", rank: 1 },
    { unit: "B", rank: 2 },
    { unit: "A#3", rank: 7 },
    { unit: "C", rank: 8 },
  ];
  const notice = buildNotice("s1", units, DOCS as never, new Map([["A", "Alpha Page"]]), ["c1", "c2"], {
    excerptChars: 50,
  });
  assert.ok(notice);
  assert.deepEqual(notice.ranks, [1, 8]);
  assert.equal(notice.units_scanned, 4);
  assert.deepEqual(
    notice.located.map((d) => d.docid),
    ["A", "B"],
  );
  assert.equal(notice.located[0].rank, 7);
  assert.equal(notice.located[0].passage_unit, "A#3");
  assert.equal(notice.located[0].title, "Alpha Page");
  assert.deepEqual(notice.located[0].clue_ids, [1, 2]);
  assert.equal(notice.located[0].excerpt.length, 50);
  assert.equal(notice.located[0].excerpt_truncated, true);
  assert.deepEqual(notice.located[0].lines, [4, 9]);
  assert.equal(notice.located[1].title, null);
  assert.equal(notice.located[1].excerpt_truncated, false);
  assert.equal(buildNotice("s2", units, [DOCS[2], DOCS[3]] as never, new Map(), ["c1"]), null);
  const capped = buildNotice("s3", units, DOCS as never, new Map(), ["c1"], { maxDocs: 1 });
  assert.equal(capped!.located.length, 1);
});

void test("specificity rule downweights clues that many documents match and keeps a fallback lead", () => {
  const units = Array.from({ length: 6 }, (_, i) => ({ unit: `D${i}`, rank: i + 1 }));
  const docs = [
    { docid: "D0", passages: [{ text: "generic", query_ids: [1], lines: [1, 1], source_offsets_utf16: [0, 7] }] },
    { docid: "D1", passages: [{ text: "generic", query_ids: [1], lines: [1, 1], source_offsets_utf16: [0, 7] }] },
    { docid: "D2", passages: [{ text: "generic", query_ids: [1], lines: [1, 1], source_offsets_utf16: [0, 7] }] },
    { docid: "D3", passages: [{ text: "generic", query_ids: [1], lines: [1, 1], source_offsets_utf16: [0, 7] }] },
    { docid: "D4", passages: [{ text: "specific", query_ids: [2], lines: [1, 1], source_offsets_utf16: [0, 8] }] },
    { docid: "D5", passages: [{ text: "both", query_ids: [1, 3], lines: [1, 1], source_offsets_utf16: [0, 4] }] },
  ];
  const n = buildNotice("s1", units, docs as never, new Map(), ["c1", "c2", "c3"], { rule: "specificity", maxDocs: 3 });
  // Clue 1 matches five documents (weight 0.2); clue 2 and clue 3 match one each (weight 1).
  assert.deepEqual(n!.located.map((d) => [d.docid, d.score]), [
    ["D5", 1.2],
    ["D4", 1],
  ]);
  const onlyGeneric = buildNotice("s2", units.slice(0, 4), docs.slice(0, 4) as never, new Map(), ["c1"], { rule: "specificity" });
  assert.equal(onlyGeneric!.located.length, 1);
  assert.equal(onlyGeneric!.located[0].docid, "D0");
  const coverage = buildNotice("s3", units, docs as never, new Map(), ["c1", "c2", "c3"], { maxDocs: 6 });
  assert.equal(coverage!.located.length, 6);
});

void test("attachNoticesToText appends a parsable marker block only when there are notices", () => {
  assert.equal(attachNoticesToText("hello", []), "hello");
  const text = attachNoticesToText("hello", [{ search_id: "s1" } as never]);
  const k = text.indexOf(NOTICE_MARKER);
  assert.ok(k > 0);
  assert.deepEqual(JSON.parse(text.slice(k + NOTICE_MARKER.length)), [{ search_id: "s1" }]);
});

function fakeScan(located: Record<string, number[]>, calls: string[][], delayMs = 0) {
  return async (params: { docids: string[]; queries: string[] }, _b: PiSearchBackend, signal?: AbortSignal) => {
    calls.push(params.docids);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    signal?.throwIfAborted();
    const documents = params.docids.map((docid) => ({
      docid,
      passages: located[docid]
        ? [{ text: `text of ${docid}`, query_ids: located[docid], lines: [1, 1], source_offsets_utf16: [0, 8] }]
        : [],
    }));
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ documents }) }],
      details: { jevFindRead: { batch: calls.length } },
    };
  };
}

void test("createAutoScanner scans each unit once, delivers notices once, and records attempts", async () => {
  const calls: string[][] = [];
  const rows: Record<string, unknown>[] = [];
  const attempted: string[][] = [];
  const scanner = createAutoScanner({
    scan: fakeScan({ B: [1], C: [1, 2] }, calls),
    resolveUnit: (id) => (id.includes("#") ? ({ unitId: id, docid: id.split("#")[0] } as never) : undefined),
    audit: (r) => rows.push(r),
    top: 3,
    onScanned: (units, parents) => attempted.push([...units, ...parents]),
  });
  assert.equal(scanner.onSearch("s1", ["A", "B", "C", "D"], {} as PiSearchBackend, ["clue one", "clue two"]), 3);
  assert.equal(scanner.onSearch("s2", ["B", "C", "E#1", "F"], {} as PiSearchBackend, ["clue one", "clue two"]), 1);
  assert.equal(scanner.onSearch("s3", ["A", "B"], {} as PiSearchBackend, ["clue one"]), 0);
  await scanner.idle();
  assert.deepEqual(calls, [["A", "B", "C"], ["E#1"]]);
  const notices = scanner.drain();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].search_id, "s1");
  assert.deepEqual(
    notices[0].located.map((d) => [d.docid, d.rank, d.clue_ids]),
    [
      ["C", 3, [1, 2]],
      ["B", 2, [1]],
    ],
  );
  assert.deepEqual(scanner.drain(), []);
  assert.deepEqual(attempted, [["A", "B", "C"], ["E#1", "E"]]);
  const publicRows = rows.filter((r) => r.type === "auto_scan_public");
  assert.equal(publicRows.length, 2);
  assert.deepEqual(publicRows[0].batches, [1]);
  assert.equal(publicRows[1].notice, null);
  assert.equal(scanner.stats.scans, 2);
  assert.equal(scanner.stats.notices, 1);
  assert.ok(scanner.has("E#1") && !scanner.has("F"));
});

void test("createAutoScanner skips when stopped or when the time budget is nearly spent, and aborts in-flight work", async () => {
  const calls: string[][] = [];
  const rows: Record<string, unknown>[] = [];
  let remaining = 10_000;
  const scanner = createAutoScanner({
    scan: fakeScan({ A: [1] }, calls, 30),
    resolveUnit: () => undefined,
    audit: (r) => rows.push(r),
    remainingTimeMs: () => remaining,
    minRemainingMs: 45_000,
  });
  scanner.onSearch("s1", ["A"], {} as PiSearchBackend, ["clue"]);
  await scanner.idle();
  assert.deepEqual(calls, []);
  assert.equal(rows.filter((r) => r.type === "auto_scan_skip" && r.reason === "time_budget").length, 1);
  remaining = 100_000;
  scanner.onSearch("s2", ["B"], {} as PiSearchBackend, ["clue"]);
  scanner.stop();
  await scanner.idle();
  assert.ok(rows.some((r) => r.type === "auto_scan_skip" && r.reason === "stopped") || rows.some((r) => r.type === "auto_scan_error"));
  assert.deepEqual(scanner.drain(), []);
  scanner.reset();
  scanner.onSearch("s3", ["A"], {} as PiSearchBackend, ["clue"]);
  await scanner.idle();
  assert.equal(scanner.drain().length, 1);
});
