import { createHash } from "node:crypto";
import type { EvidenceDoc, AdaptiveInput } from "./jev_adaptive_overlap_v1";

type Span = [number, number];
type Source = { spans: Span[]; textHashes: Set<string> };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function merge(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) {
    const previous = out.at(-1);
    if (previous && a <= previous[1]) previous[1] = Math.max(b, previous[1]);
    else out.push([a, b]);
  }
  return out;
}
const size = (spans: Span[]) => spans.reduce((n, [a, b]) => n + b - a, 0);

/** Observed search/source history, not model conclusions and not a deterministic stopping rule. */
export class ResearchProgress {
  private sources = new Map<string, Source>();
  private searches: Record<string, unknown>[] = [];
  private steps: Record<string, unknown>[] = [];
  revision = 0;
  clear() { this.sources.clear(); this.searches = []; this.steps = []; this.revision++; }
  recordSearch(searchId: string, query: string, docids: string[]) {
    this.searches.push({ search_id: searchId, query: query.slice(0, 350), candidate_count: docids.length, top_docids: docids.slice(0, 5) });
    this.searches = this.searches.slice(-6); this.revision++;
  }
  private count(docs: EvidenceDoc[], commit: boolean) {
    const working = new Map<string, Source>();
    const changes: { docid: string; new_source_utf16: number }[] = [];
    for (const d of docs) {
      const previous = working.get(d.docid) ?? this.sources.get(d.docid);
      const s = working.get(d.docid) ?? { spans: previous?.spans.map(p => [...p] as Span) ?? [], textHashes: new Set(previous?.textHashes) };
      let added = 0;
      for (const p of d.passages) {
        if (p.fallback || (!p.query_ids.length && !p.context_read) || !p.text) continue;
        const textHash = hash(p.text), span = p.source_offsets_utf16 as Span | undefined;
        if (span && span.length === 2 && span.every(Number.isInteger) && span[0] >= 0 && span[1] - span[0] === p.text.length) {
          const joined = merge([...s.spans.map(p => [...p] as Span), [...span] as Span]);
          if (!s.textHashes.has(textHash)) added += size(joined) - size(s.spans);
          s.spans = joined;
        } else if (!s.textHashes.has(textHash)) added += p.text.length;
        s.textHashes.add(textHash);
      }
      working.set(d.docid, s);
      if (added) changes.push({ docid: d.docid, new_source_utf16: added });
    }
    if (commit) for (const [id, s] of working) this.sources.set(id, s);
    // Bounded history may forget older source. Novelty remains a hint, never proof or a stop condition.
    if (commit) {
      while (this.sources.size > 512) this.sources.delete(this.sources.keys().next().value!);
      for (const s of this.sources.values()) while (s.textHashes.size > 128) s.textHashes.delete(s.textHashes.values().next().value!);
    }
    return { new_source_utf16: changes.reduce((n, d) => n + d.new_source_utf16, 0), new_source_docs: changes.slice(0, 12) };
  }
  snapshot(docs: EvidenceDoc[]) {
    return structuredClone({
      recent_searches: this.searches, recent_evidence_steps: this.steps,
      current_source_novelty: this.count(docs, false),
      interpretation: "Counts describe previously unseen source characters, not relevance or factual support. New candidate IDs do not establish progress. Read original evidence to judge whether an important answer uncertainty can be reduced. History is bounded and may omit older activity.",
    });
  }
  recordEvidence(sourceCall: string, input: Pick<AdaptiveInput, "reason" | "queries">, docs: EvidenceDoc[], assessmentStatus: string) {
    const change = this.count(docs, true);
    this.steps.push({ source_call: sourceCall, objective: input.reason.slice(0, 250), queries: input.queries.map(q => q.slice(0, 150)),
      assessment_status: assessmentStatus, ...change });
    this.steps = this.steps.slice(-6); this.revision++;
    return change;
  }
}
