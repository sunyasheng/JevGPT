/** Exact output pages, after the unchanged Jev locator. No generated source. */
import assert from "node:assert/strict";
import { AUTO_READ_POLICY, planSourceReads } from "./jev_find_read_v1";
import { originalSpan, presentation } from "./jev_overlap_reader_v1";
import { originalLineAt, originalLineStarts } from "./read_document_paged_v1";
import type { EvidenceDoc } from "./jev_adaptive_overlap_v1";

type Presentation = Awaited<ReturnType<typeof presentation>>;
type Interval = [number, number];
export type HitAnchor = { query_id: number; priority: number; lines: number[]; source_offsets_utf16: Interval };
type Page = EvidenceDoc["passages"][number];
type Split = (text: string) => Promise<{ start_utf16: number; end_utf16: number }[]>;
export const EVIDENCE_PAGE_CAP = 4000;
export function covered(range: number[], spans: number[][]): boolean {
  let cursor = range[0];
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (a > cursor) break;
    cursor = Math.max(cursor, b);
    if (cursor >= range[1]) return true;
  }
  return cursor >= range[1];
}
export function selectedHits(doc: any, queries: string[], p: Presentation): HitAnchor[] {
  const hits: HitAnchor[] = [];
  for (const r of doc.regions ?? []) for (const q of r.results ?? []) {
    const id = queries.indexOf(q.query) + 1;
    if (!id || q.exists < AUTO_READ_POLICY.minExists) continue;
    const positive = q.hits.filter((h: any) => h.choice_probability > 0);
    const chosen = positive.slice(0, 1);
    if (chosen[0]?.choice_probability < AUTO_READ_POLICY.secondaryWhenTopBelow &&
        positive[1]?.choice_probability >= AUTO_READ_POLICY.secondaryMinProbability) chosen.push(positive[1]);
    for (const [priority, h] of chosen.entries()) {
      const s = originalSpan(p, h.start_line, h.end_line);
      const anchor = { query_id: id, priority, lines: s.lines, source_offsets_utf16: s.source_offsets_utf16 as Interval };
      if (!hits.some(a => JSON.stringify(a) === JSON.stringify(anchor))) hits.push(anchor);
    }
  }
  return hits.sort((a, b) => a.priority - b.priority || a.query_id - b.query_id || a.source_offsets_utf16[0] - b.source_offsets_utf16[0]);
}
export async function pageLocatedSource(doc: any, queries: string[], p: Presentation, split: Split) {
  const plan = planSourceReads(doc, queries), anchors = selectedHits(doc, queries, p);
  const starts = originalLineStarts(p.original), pages: Page[] = [];
  for (const range of plan.ranges) {
    const span = originalSpan(p, range.start, range.end), base = span.source_offsets_utf16[0];
    const pieces = span.text.length <= EVIDENCE_PAGE_CAP
      ? (span.text ? [{ start_utf16: 0, end_utf16: span.text.length }] : []) : await split(span.text);
    let cursor = 0;
    for (const s of pieces) {
      assert.ok(s.start_utf16 <= cursor && s.end_utf16 > cursor && s.end_utf16 <= span.text.length);
      assert.ok(s.end_utf16 - s.start_utf16 <= EVIDENCE_PAGE_CAP); cursor = s.end_utf16;
      const a = base + s.start_utf16, b = base + s.end_utf16;
      for (const pos of [a, b]) if (pos > 0 && pos < p.original.length) {
        const x = p.original.charCodeAt(pos - 1), y = p.original.charCodeAt(pos);
        assert.ok(!(x >= 0xd800 && x <= 0xdbff && y >= 0xdc00 && y <= 0xdfff) && !(x === 13 && y === 10));
      }
      const matching = anchors.filter(h => h.source_offsets_utf16[0] < b && h.source_offsets_utf16[1] > a);
      const priority = matching.length ? Math.min(...matching.map(h => h.priority)) : range.fallback ? 3 : 2;
      pages.push({ text: p.original.slice(a, b), lines: [originalLineAt(starts, a), originalLineAt(starts, b - 1)],
        source_offsets_utf16: [a, b], query_ids: range.query_ids, ...(range.fallback ? { fallback: true } : {}),
        evidence_page: { priority, hit_query_ids: [...new Set(matching.map(h => h.query_id))],
          first_hit_query: matching.length ? Math.min(...matching.filter(h => h.priority === priority).map(h => h.query_id)) : 0 } });
    }
    assert.equal(cursor, span.text.length);
  }
  const result: EvidenceDoc = { docid: doc.docid, passages: pages, selected_hits: anchors,
    source_length_utf16: p.original.length, not_located_queries: plan.not_located_queries,
    ...(!doc.complete_scan ? { scan_incomplete: true } : {}), ...(doc.error ? { error: doc.error } : {}) };
  return { doc: result, plan, oversize_ranges: plan.ranges.filter(r => originalSpan(p, r.start, r.end).text.length > 20000).length };
}
const priority = (p: Page) => p.context_read ? -1 : (p.evidence_page as any)?.priority ?? (p.fallback ? 3 : 0);
function metadata(p: Page) {
  const { text, ...rest } = p; return rest;
}
/** Round-robin documents within each hit priority; keep honest omissions after every repack. */
export function mergeEvidence(docs: EvidenceDoc[], maxChars = 20000): EvidenceDoc[] {
  const copy = structuredClone(docs), original = copy.map(d => d.passages);
  let used = 0;
  for (const d of copy) d.passages = [];
  for (const tier of [-1, 0, 1, 2, 3]) {
    const candidates = original.map(ps => ps.filter(p => priority(p) === tier).sort((a, b) =>
      ((a.evidence_page as any)?.first_hit_query ?? 0) - ((b.evidence_page as any)?.first_hit_query ?? 0)));
    for (let i = 0; i < Math.max(0, ...candidates.map(ps => ps.length)); i++) for (let j = 0; j < copy.length; j++) {
      const d = copy[j], p = candidates[j][i]; if (!p) continue;
      const offsets = p.source_offsets_utf16 as number[] | undefined;
      if (offsets && covered(offsets, d.passages.flatMap(x => x.source_offsets_utf16 ? [x.source_offsets_utf16 as number[]] : []))) continue;
      if (used + p.text.length <= maxChars) { d.passages.push(p); used += p.text.length; }
      else {
        ((d.omitted_pages ??= []) as any[]).push(metadata(p));
        d.deferred_queries = [...new Set([...(d.deferred_queries ?? []), ...p.query_ids])];
      }
    }
  }
  for (const d of copy) {
    const spans = d.passages.flatMap(p => p.source_offsets_utf16 ? [p.source_offsets_utf16 as number[]] : []);
    const omitted: any[] = [];
    for (const p of d.omitted_pages as any[] ?? []) {
      if (p.source_offsets_utf16 && covered(p.source_offsets_utf16, spans)) continue;
      if (!omitted.some(x => JSON.stringify(x.source_offsets_utf16 ?? x.lines) === JSON.stringify(p.source_offsets_utf16 ?? p.lines))) omitted.push(p);
    }
    omitted.sort((a, b) => priority(a) - priority(b));
    if (d.selected_hits) {
      delete d.omitted_ranges; delete d.omitted_ranges_offsets_utf16; delete d.deferred_queries; delete d.omitted_pages;
      const missing = (d.selected_hits as HitAnchor[]).filter(h => !covered(h.source_offsets_utf16, spans));
      if (missing.length) d.deferred_queries = [...new Set(missing.map(h => h.query_id))];
    }
    if (omitted.length) {
      d.omitted_pages = omitted;
      d.omitted_ranges = omitted.map(p => p.lines);
      d.omitted_ranges_offsets_utf16 = omitted.filter(p => p.source_offsets_utf16).map(p => p.source_offsets_utf16);
    }
  }
  return copy;
}
