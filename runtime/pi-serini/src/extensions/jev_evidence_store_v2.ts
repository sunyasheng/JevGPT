/** Bounded source memory with short, traceable views and separate research scopes. */
import type { EvidenceDoc } from "./jev_adaptive_overlap_v1";
import { covered, type HitAnchor } from "./jev_evidence_pages_v1";
import { sourceKey, type StoredEvidence } from "./jev_evidence_store_v1";
import { originalLineAt, originalLineStarts, pageOriginalSource } from "./read_document_paged_v1";

type SourceHit = { source_call: string; query?: string; source_offsets_utf16: number[] };
export type MemoryEntry = StoredEvidence & { source_hits: SourceHit[] };
export type MemoryWindow = StoredEvidence & { parent_id: string };
export { sourceKey };
export const HISTORY_WINDOW_CAP = 1000;
const words = (text: string) => text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]{3,}/gu) ?? [];
const stopWords = new Set("the and with what which where when does source document from that this were was for are has have how who its into about say says state states first name title".split(" "));
const queryWords = (text: string) => [...new Set(words(text))].filter(w => !stopWords.has(w));
// Native ICU boundaries keep source text intact; the existing pager protects UTF-16 and CRLF.
const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });
const lexical = new Intl.Segmenter(undefined, { granularity: "word" });

function sourceWindows(entry: MemoryEntry, cap: number): MemoryWindow[] {
  const base = entry.source_offsets_utf16;
  if (!base) {
    const { source_hits, ...source } = structuredClone(entry);
    return [{ ...source, parent_id: entry.id }];
  }
  const starts = originalLineStarts(entry.text), ranges: number[][] = [];
  for (const h of entry.source_hits) {
    const [a, b] = h.source_offsets_utf16;
    if (a >= base[0] && b <= base[1] && b - a <= cap && b - a >= 2) ranges.push([a - base[0], b - base[0]]);
  }
  const breaks = [...new Set([
    ...[...sentences.segment(entry.text)].map(s => s.index + s.segment.length),
    ...starts.slice(1), entry.text.length,
  ])].sort((a, b) => a - b);
  const wordBreaks = [...lexical.segment(entry.text)].map(s => s.index + s.segment.length);
  let cursor = 0;
  while (cursor < entry.text.length) {
    const page = pageOriginalSource(entry.text, { docid: entry.docid, reason: "Historical source window", start_index: cursor, max_length: cap }, starts);
    const hardEnd = page.source_offsets_utf16[1], floor = cursor + Math.floor(cap / 2);
    let end = breaks.filter(b => b > cursor && b <= hardEnd && (b >= floor || b === entry.text.length)).at(-1);
    end ??= wordBreaks.filter(b => b > cursor && b <= hardEnd && b >= floor).at(-1);
    end ??= hardEnd;
    // A word boundary can fall inside CRLF; validate it through the same source pager.
    const safe = pageOriginalSource(entry.text, { docid: entry.docid, reason: "Historical source boundary", start_index: cursor, max_length: Math.max(2, end - cursor) }, starts);
    end = Math.min(end, safe.source_offsets_utf16[1]);
    if (end <= cursor) throw new Error("Historical source window made no progress");
    ranges.push([cursor, end]); cursor = end;
  }
  const result = new Map<string, MemoryWindow>();
  for (const [a, b] of ranges) {
    // Located ranges come from the validated source mapper; reject unsafe external metadata.
    try {
      const safe = pageOriginalSource(entry.text, { docid: entry.docid, reason: "Validate historical window", start_index: a, max_length: Math.max(2, b - a) }, starts);
      if (safe.source_offsets_utf16[1] < b) continue;
    } catch { continue; }
    const text = entry.text.slice(a, b), offsets = [base[0] + a, base[0] + b];
    if (!text) continue;
    const p = { text, source_offsets_utf16: offsets,
      lines: [entry.lines[0] + originalLineAt(starts, a) - 1, entry.lines[0] + originalLineAt(starts, Math.max(a, b - 1)) - 1] };
    const id = sourceKey(entry.docid, p);
    result.set(id, { ...p, id, docid: entry.docid, source_call: entry.source_call, parent_id: entry.id });
  }
  return [...result.values()];
}

function redundant(a: MemoryWindow, selected: MemoryWindow[]): boolean {
  return selected.some(b => {
    if (a.docid !== b.docid) return false;
    if (!a.source_offsets_utf16 || !b.source_offsets_utf16) return a.text.includes(b.text) || b.text.includes(a.text);
    const [x, y] = a.source_offsets_utf16, [u, v] = b.source_offsets_utf16;
    return Math.max(0, Math.min(y, v) - Math.max(x, u)) / Math.min(y - x, v - u) >= .7;
  });
}

/** Same raw-source lifetime/bounds as v1. Derived views never add unseen source. */
export class EvidenceStore {
  private entries = new Map<string, MemoryEntry>();
  private units = 0;
  private windows = new Map<string, MemoryWindow[]>();
  revision = 0;
  constructor(private maxUnits = 60000, private maxEntries = 128) {}
  clear() { this.entries.clear(); this.windows.clear(); this.units = 0; this.revision++; }
  snapshot() { return structuredClone([...this.entries.values()]); }
  add(docs: EvidenceDoc[], sourceCall: string, queries: string[] = []): MemoryEntry[] {
    const added: MemoryEntry[] = [];
    for (const d of docs) for (const p of d.passages) {
      if (p.fallback || (!p.query_ids.length && !p.context_read) || !p.text || p.text.length > this.maxUnits) continue;
      const span = p.source_offsets_utf16 as number[] | undefined;
      if (span && (!Array.isArray(span) || span.length !== 2 || !span.every(Number.isSafeInteger) || span[0] < 0 || span[1] - span[0] !== p.text.length))
        throw new Error("Historical source offsets do not match delivered text");
      const id = sourceKey(d.docid, p);
      const hits: SourceHit[] = (d.selected_hits as HitAnchor[] ?? []).filter(h => span && h.source_offsets_utf16[0] >= span[0]
        && h.source_offsets_utf16[1] <= span[1] && h.source_offsets_utf16[1] > h.source_offsets_utf16[0])
        .map(h => ({ source_call: sourceCall, ...(queries[h.query_id - 1] ? { query: queries[h.query_id - 1] } : {}),
          source_offsets_utf16: [...h.source_offsets_utf16] }));
      const old = this.entries.get(id);
      if (old) {
        const fresh = hits.filter(h => !old.source_hits.some(o => o.query === h.query && o.source_offsets_utf16.every((n, i) => n === h.source_offsets_utf16[i])));
        if (fresh.length) { old.source_hits.push(...fresh); this.windows.clear(); this.revision++; added.push(structuredClone(old)); }
        continue;
      }
      const e: MemoryEntry = { id, docid: d.docid, text: p.text, lines: [...p.lines as number[]], source_call: sourceCall,
        ...(span ? { source_offsets_utf16: [...span] } : {}), source_hits: hits };
      while (this.entries.size >= this.maxEntries || this.units + e.text.length > this.maxUnits) {
        const first = this.entries.keys().next().value!;
        this.units -= this.entries.get(first)!.text.length; this.entries.delete(first); this.windows.clear();
      }
      this.entries.set(id, e); this.units += e.text.length; this.revision++; added.push(structuredClone(e));
    }
    return added;
  }
  addPage(page: { docid: string; text: string; original_lines: number[]; source_offsets_utf16: number[] }, sourceCall: string) {
    return this.add([{ docid: page.docid, passages: [{ text: page.text, lines: page.original_lines,
      source_offsets_utf16: page.source_offsets_utf16, query_ids: [], context_read: true }] }], sourceCall);
  }
  select(queries: string[], maxUnits = 8000, exclude: EvidenceDoc[] = []) {
    return this.selectResearch(queries, undefined, maxUnits, exclude);
  }
  selectResearch(queries: string[], originalQuestion?: string, maxUnits = 8000, exclude: EvidenceDoc[] = []): MemoryWindow[] {
    if (!Number.isSafeInteger(maxUnits) || maxUnits < 2) return [];
    const local = queries.filter(q => queryWords(q).length), original = originalQuestion?.trim();
    const localBudget = original && local.length ? Math.floor(maxUnits * .6) : maxUnits;
    const cap = Math.max(2, Math.min(HISTORY_WINDOW_CAP, Math.floor(localBudget / Math.max(1, local.length))));
    const all = [...this.entries.values()].flatMap(e => {
      const key = `${e.id}:${cap}`;
      let views = this.windows.get(key);
      if (!views) { views = sourceWindows(e, cap); this.windows.set(key, views); }
      return views;
    });
    const unique = new Map(all.map(e => [e.id, e]));
    const candidates = [...unique.values()].filter(e => !exclude.some(d => d.docid === e.docid && (
      (e.source_offsets_utf16 && covered(e.source_offsets_utf16, d.passages.flatMap(p => p.source_offsets_utf16 ? [p.source_offsets_utf16 as number[]] : [])))
      || d.passages.some(p => p.text.includes(e.text)))));
    if (!candidates.length) return [];
    // BM25 uses per-window length normalization, unlike the old unnormalized word sum.
    const frequencies = candidates.map(e => {
      const tf = new Map<string, number>(); for (const w of words(e.text)) tf.set(w, (tf.get(w) ?? 0) + 1); return tf;
    });
    const lengths = frequencies.map(tf => [...tf.values()].reduce((n, k) => n + k, 0));
    const mean = lengths.reduce((n, k) => n + k, 0) / candidates.length || 1;
    const df = new Map<string, number>(); for (const tf of frequencies) for (const w of tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
    const termScores = (query: string) => {
      const terms = queryWords(query);
      return frequencies.map((tf, i) => new Map(terms.filter(w => tf.has(w)).map(w => {
        const n = tf.get(w)!, idf = Math.log(1 + (candidates.length - (df.get(w) ?? 0) + .5) / ((df.get(w) ?? 0) + .5));
        return [w, idf * n * 2.2 / (n + 1.2 * (.25 + .75 * lengths[i] / mean))];
      })));
    };
    const scores = new Map([...local, ...(original ? [original] : [])].map(q => [q, termScores(q)]));
    const result: MemoryWindow[] = []; let used = 0;
    const coveredTerms = new Map<string, Set<string>>();
    const choose = (query: string, remaining: number) => {
      const seen = coveredTerms.get(query) ?? new Set<string>();
      let best = -1, bestScore = 0;
      candidates.forEach((e, i) => {
        if (e.text.length > remaining || redundant(e, result)) return;
        const ts = scores.get(query)![i];
        // Novel query terms and different documents reduce repeated background selection.
        const score = [...ts].reduce((n, [w, s]) => n + s * (seen.has(w) ? .25 : 1), 0)
          / (1 + result.filter(p => p.docid === e.docid).length * .5);
        if (score > bestScore || (score > 0 && score === bestScore && i > best)) { best = i; bestScore = score; }
      });
      if (best < 0) return false;
      const e = candidates[best]; result.push(e); used += e.text.length;
      for (const q of scores.keys()) {
        const terms = coveredTerms.get(q) ?? new Set<string>();
        for (const w of scores.get(q)![best].keys()) terms.add(w);
        coveredTerms.set(q, terms);
      }
      return true;
    };
    const fill = (qs: string[], allowance: number) => {
      const limit = Math.min(maxUnits, used + allowance);
      while (used < limit && result.length < 24) {
        let progress = false;
        for (const q of qs) {
          if (result.length >= 24) break;
          progress = choose(q, limit - used) || progress;
        }
        if (!progress) break;
      }
    };
    fill(local, localBudget);
    if (original) fill([original], maxUnits - localBudget);
    // A scope that has no matching source releases its unused capacity.
    fill([...local, ...(original ? [original] : [])], maxUnits - used);
    return structuredClone(result);
  }
}
