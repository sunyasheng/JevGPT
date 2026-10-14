import assert from "node:assert/strict";
import test from "node:test";

import {
  attachRankingNotices,
  buildRankingNotice,
  createRankingAutoScanner,
  RANKING_NOTICE_MARKER,
  type RankingReaderLike,
} from "../src/extensions/jev_ranking_auto_scan_v1";
import type { RankedDocument } from "../src/extensions/jev_document_ranking_reader";
import type { PiSearchBackend } from "../src/pi-search/searcher/contract/interface";

const backend = {} as PiSearchBackend;

function doc(docid: string, probability: number | null, options: { incomplete?: boolean; text?: string } = {}): RankedDocument {
  return {
    docid,
    title: "Title " + docid,
    passages: options.text === undefined ? [] : [{ id: "P1", text: options.text, lines: [1, 2], source_offsets_utf16: [0, options.text.length], keep_probability: 0.9 }],
    relevance: { score: probability === null ? null : probability * 3, probability, assessed_regions: 1, source_scope: "full_document" },
    scan_incomplete: Boolean(options.incomplete),
    source_length_utf16: 100,
  };
}

void test("buildRankingNotice keeps likely relevant complete undelivered documents, best first", () => {
  const units = ["a", "b", "c", "d", "e"].map((docid, i) => ({ docid, rank: i + 1 }));
  const docs = [doc("a", 0.4, { text: "low" }), doc("b", 0.9, { text: "x".repeat(300) }), doc("c", 0.9, { text: "tie" }),
    doc("d", 0.8, { incomplete: true, text: "partial" }), doc("e", 0.95, { text: "delivered" })];
  const notice = buildRankingNotice("s1", units, docs, { exclude: new Set(["e"]), excerptChars: 240 });
  assert.ok(notice);
  assert.deepEqual(notice.located.map((d) => d.docid), ["b", "c"]);
  assert.equal(notice.located[0].excerpt.length, 240);
  assert.equal(notice.located[0].excerpt_truncated, true);
  assert.deepEqual(notice.ranks, [1, 5]);
  assert.equal(notice.assessed_not_listed, 3);
  assert.equal(buildRankingNotice("s1", units, [doc("a", 0.2)]), null);
  assert.equal(buildRankingNotice("s1", units, docs, { maxDocs: 1 })!.located.length, 1);
});

void test("attachRankingNotices appends a single marker only when notices exist", () => {
  assert.equal(attachRankingNotices("text", []), "text");
  const notice = buildRankingNotice("s1", [{ docid: "a", rank: 1 }], [doc("a", 0.7, { text: "t" })])!;
  const out = attachRankingNotices("text", [notice]);
  assert.ok(out.startsWith("text\n\n" + RANKING_NOTICE_MARKER + " "));
  assert.equal(JSON.parse(out.split(RANKING_NOTICE_MARKER + " ")[1])[0].search_id, "s1");
});

function fakeReader(probabilities: Record<string, number>) {
  const assessed = new Set<string>();
  const calls: string[][] = [];
  const reader: RankingReaderLike = {
    async read(input) {
      calls.push(input.docids);
      assert.equal(input.targeted, true);
      for (const id of input.docids) assessed.add(id);
      return { output: { documents: input.docids.map((id) => doc(id, probabilities[id] ?? 0, { text: "source " + id })) }, attemptedDocids: input.docids };
    },
    assessedIds: () => new Set(assessed),
  };
  return { reader, calls, assessed };
}

void test("scanner assesses only unassessed top units and delivers each notice once", async () => {
  const { reader, calls, assessed } = fakeReader({ b: 0.9, d: 0.6 });
  assessed.add("a");
  const audit: any[] = [];
  const attempted: string[] = [];
  const scanner = createRankingAutoScanner({ reader, audit: (r) => audit.push(r), top: 4, onAttempted: (ids) => attempted.push(...ids) });
  scanner.schedule("s1", ["a", "b", "c", "d", "e"], backend, "topic");
  await scanner.flush();
  assert.deepEqual(calls, [["b", "c", "d"]]);
  assert.deepEqual(attempted, ["b", "c", "d"]);
  const notices = scanner.take("search");
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].located.map((d) => d.docid), ["b", "d"]);
  assert.deepEqual(scanner.take("jev_find"), []);
  scanner.schedule("s2", ["b", "c", "d", "a"], backend, "topic");
  await scanner.flush();
  assert.equal(calls.length, 1);
  assert.ok(audit.some((r) => r.type === "auto_scan_skip" && r.reason === "no_unassessed_units"));
  scanner.stop();
  assert.equal(audit.at(-1).type, "auto_scan_summary");
  assert.equal(audit.at(-1).scans, 1);
});

void test("scanner skips when little time remains and excludes delivered documents", async () => {
  const { reader, calls } = fakeReader({ x: 0.9, y: 0.9 });
  const audit: any[] = [];
  const late = createRankingAutoScanner({ reader, audit: (r) => audit.push(r), remainingTimeMs: () => 10_000 });
  late.schedule("s1", ["x"], backend, "topic");
  await late.flush();
  assert.equal(calls.length, 0);
  assert.ok(audit.some((r) => r.reason === "low_remaining_time"));
  const scanner = createRankingAutoScanner({ reader, audit: () => {}, isDelivered: (d) => d === "x" });
  scanner.schedule("s1", ["x", "y"], backend, "topic");
  await scanner.flush();
  assert.deepEqual(scanner.take("search")[0].located.map((d) => d.docid), ["y"]);
  scanner.reset();
  assert.deepEqual(scanner.take("search"), []);
});
