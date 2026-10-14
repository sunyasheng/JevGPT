import { createHash } from "node:crypto";
import type { EvidenceDoc } from "./jev_adaptive_overlap_v1";

export type StoredEvidence = { id: string; docid: string; text: string; lines: number[];
  source_offsets_utf16?: number[]; source_call: string };
const words = (text: string) => new Set(text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]{3,}/gu) ?? []);
const stopWords = new Set("the and with what which where when does source document from that this were was for are has have how who its into about say says state states first name title".split(" "));
export const sourceKey = (docid: string, p: { text: string; lines?: unknown; source_offsets_utf16?: unknown }) =>
  createHash("sha256").update(JSON.stringify([docid, p.source_offsets_utf16 ?? p.lines, p.text])).digest("hex");

/** Contains only source already delivered to the researcher, never model conclusions. */
export class EvidenceStore {
  private entries = new Map<string, StoredEvidence>();
  private units = 0;
  revision = 0;
  constructor(private maxUnits = 60000, private maxEntries = 128) {}
  clear() { this.entries.clear(); this.units = 0; this.revision++; }
  add(docs: EvidenceDoc[], sourceCall: string): StoredEvidence[] {
    const added: StoredEvidence[] = [];
    for (const d of docs) for (const p of d.passages) {
      if (p.fallback || (!p.query_ids.length && !p.context_read) || !p.text || p.text.length > this.maxUnits) continue;
      const id = sourceKey(d.docid, p);
      if (this.entries.has(id)) continue;
      const e: StoredEvidence = { id, docid: d.docid, text: p.text, lines: [...p.lines as number[]],
        ...(p.source_offsets_utf16 ? { source_offsets_utf16: [...p.source_offsets_utf16 as number[]] } : {}), source_call: sourceCall };
      while (this.entries.size >= this.maxEntries || this.units + e.text.length > this.maxUnits) {
        const first = this.entries.keys().next().value!;
        this.units -= this.entries.get(first)!.text.length; this.entries.delete(first);
      }
      this.entries.set(id, e); this.units += e.text.length; this.revision++; added.push(structuredClone(e));
    }
    return added;
  }
  addPage(page: { docid: string; text: string; original_lines: number[]; source_offsets_utf16: number[] }, sourceCall: string) {
    return this.add([{ docid: page.docid, passages: [{ text: page.text, lines: page.original_lines,
      source_offsets_utf16: page.source_offsets_utf16, query_ids: [], context_read: true }] }], sourceCall);
  }
  select(queries: string[], maxUnits = 8000, exclude: EvidenceDoc[] = []): StoredEvidence[] {
    const query = [...words(queries.join(" "))].filter(w => !stopWords.has(w));
    const candidates = [...this.entries.values()].filter(e => !exclude.some(d => d.docid === e.docid && d.passages.some(p => p.text.includes(e.text))));
    const tokens = candidates.map(e => words(e.text));
    const scored = candidates.map((e, i) => ({ e, i, score: query.reduce((score, w) => score + (tokens[i].has(w)
      ? Math.log(1 + candidates.length / (1 + tokens.filter(t => t.has(w)).length)) : 0), 0) }));
    scored.sort((a, b) => b.score - a.score || b.i - a.i);
    const result: StoredEvidence[] = []; let used = 0;
    for (const { e, score } of scored) {
      if (score <= 0 || used + e.text.length > maxUnits || result.length >= 24) continue;
      if (result.some(p => p.docid === e.docid && p.text.includes(e.text))) continue;
      result.push(structuredClone(e)); used += e.text.length;
    }
    return result;
  }
}
