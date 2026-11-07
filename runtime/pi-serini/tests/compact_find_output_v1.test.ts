import assert from "node:assert/strict";
import test from "node:test";
import { compactFindOutput, COMPACT_FIND_NOTE } from "../src/extensions/compact_find_output_v1";

const page = { text: "α\r\nverbatim 😀 text", lines: [4, 6], source_offsets_utf16: [10, 30],
  query_ids: [1, 2], evidence_page: { priority: 0 }, context_read: false };
const doc = (docid: string, extra = {}) => ({ docid, passages: [], selected_hits: [],
  source_length_utf16: 1000, not_located_queries: [1], ...extra });
const full = (documents: unknown[], extra = {}) => ({ documents, note: "old note",
  adaptive: { scanned: documents.length, complete: false, unresolved_queries: null,
    stop_reason: "no_progress", assessment_status: "unavailable", unscanned_docids: ["later"],
    stages: [{ routing_steps: [] }], prior_evidence_refs: ["hash"], policy: "old" },
  passage_units: {}, ranking: { start: 1, end: 60, total_cached: 100, next_offset: 61 },
  auto_scan_notices: [{ text: "original notice" }], ...extra });

test("ordinary empty documents disappear, every anomalous empty document survives", () => {
  const keys = ["error", "scan_incomplete", "deferred_queries", "omitted_pages", "omitted_ranges",
    "omitted_ranges_offsets_utf16", "translation_error"];
  const result = compactFindOutput(full([doc("ordinary"), ...keys.map(k => doc(k, { [k]: true }))]));
  assert.deepEqual((result.documents as any[]).map(d => d.docid), keys);
  for (const d of result.documents as any[]) assert.deepEqual(d.passages, []);
});
test("covered hit spans disappear; partial, missing-coordinate and failed translations survive", () => {
  const hits = [{ source_offsets_utf16: [10, 30] }, { source_offsets_utf16: [29, 31] },
    { query_id: 3 }, { source_offsets_utf16: [11, 12], translation_error: "uncertain" }];
  const result = compactFindOutput(full([doc("one", { passages: [page], selected_hits: hits })]));
  assert.deepEqual((result.documents as any[])[0].selected_hits, hits.slice(1));
  assert.equal((compactFindOutput(full([doc("onlyhit", { selected_hits: [hits[1]] })])).documents as any[]).length, 1);
});
test("verbatim passage fields and coordinate exceptions survive; input stays deeply equal", () => {
  const input = full([doc("one", { title: "T", passages: [{ ...page, context_read: true }],
    parent_docid: "parent", passage_unit: "one#1", coordinates: "passage_unit_only", translation_error: "bad" })]);
  const before = structuredClone(input);
  const result = compactFindOutput(input);
  const d = (result.documents as any[])[0];
  assert.deepEqual(d.passages[0], { text: page.text, lines: page.lines,
    source_offsets_utf16: page.source_offsets_utf16, query_ids: page.query_ids, context_read: true });
  for (const k of ["parent_docid", "passage_unit", "coordinates", "translation_error"])
    assert.equal(d[k], (input.documents[0] as any)[k]);
  assert.ok(!("source_length_utf16" in d) && !("not_located_queries" in d));
  assert.deepEqual(input, before);
});
test("explicit targets retain deduplicated attempted no-excerpt IDs, excluding unscanned and fallback IDs", () => {
  const input = full([doc("empty"), doc("found", { passages: [page] }), doc("fallback")]);
  const result = compactFindOutput(input, { requestedDocids: ["empty", "empty", "found", "unscanned"],
    attemptedDocids: ["empty", "found", "fallback"] });
  assert.deepEqual((result.adaptive as any).attempted_without_excerpts, ["empty"]);
  assert.ok(!("attempted_without_excerpts" in (compactFindOutput(input).adaptive as any)));
});
test("null unknowns, scoped prior assessment, nonhash identifiers and unassessed context stay intact", () => {
  const assessment = { applies_to: "recorded_query_and_source_snapshot_only", queries: ["Q"],
    source_snapshot_sha256: "scope", verdict: { prior_ids: ["a".repeat(64), "docid"] } };
  const input = full([], { adaptive: { unresolved_queries: null, last_successful_assessment: assessment,
    unscanned_docids: ["a", "b"], context_selection: [{ id: "context" }], unassessed_context_pages: [{ id: "pending" }] } });
  const before = structuredClone(input);
  const a = compactFindOutput(input).adaptive as any;
  assert.equal(a.unresolved_queries, null);
  assert.equal(a.unscanned_count, 2);
  assert.deepEqual(a.last_successful_assessment, { ...assessment, verdict: { prior_ids: ["docid"] } });
  assert.deepEqual(a.context_selection, (input.adaptive as any).context_selection);
  assert.deepEqual(a.unassessed_context_pages, (input.adaptive as any).unassessed_context_pages);
  assert.deepEqual(input, before);
});
test("zero excerpts retain structure, ranking, notices and exact conditional note", () => {
  const input = full([doc("empty")]);
  const result = compactFindOutput(input);
  assert.deepEqual(result.documents, []);
  assert.deepEqual(result.ranking, input.ranking);
  assert.deepEqual(result.auto_scan_notices, input.auto_scan_notices);
  assert.ok(!("passage_units" in result));
  assert.equal(result.note, COMPACT_FIND_NOTE + " This ranking stopped adding located evidence."
    + " No judgment of the latest evidence is available; this is not a finding of insufficient evidence.");
  assert.equal((result.adaptive as any).unresolved_queries, null);
});
test("nonempty unit map and a passage's translation failure are preserved", () => {
  const input = full([doc("one", { passages: [{ ...page, translation_error: "text_mismatch" }] })],
    { passage_units: { "one#1": "one" } });
  const result = compactFindOutput(input);
  assert.deepEqual(result.passage_units, input.passage_units);
  assert.equal((result.documents as any[])[0].passages[0].translation_error, "text_mismatch");
});
