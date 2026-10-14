// Auto-scan (patch for the "gold in the top 60 but never scanned" misses). After every search,
// Jev scans the top ranked units that no earlier auto-scan inspected, using clue statements
// derived from the question text only. Located verbatim excerpts reach the model as a notice
// attached to its next tool result. The research process still receives nothing but the
// question: no qrels, gold labels or answers are involved anywhere in this module.
import type { PiSearchBackend } from "../pi-search/searcher/contract/interface";
import type { EvidenceDoc } from "./jev_adaptive_overlap_v1";
import type { EvidenceStore } from "./jev_evidence_store_v2";
import { parentDocidsOf, translateFindOutput, type ResolveUnit } from "./jev_passage_units_v1";

export const NOTICE_MARKER = "AUTO_SCAN_NOTICES:";
const ASK =
  /^(what|which|who|whom|whose|where|when|how|why|identify|name|give|provide|tell|find|determine|list|state|please|i am looking|i'm looking|looking for|can you|could you)\b/i;
// Inline list items ("in which: - One episode …  - Another …", "1) …", "(2) …", "• …").
const ITEM = /\s+(?:[-–—•*]|\(?\d{1,2}[.)])\s+(?=\S)/;

/** Clue statements from the question text: declarative sentences or list items, merged to `max`. */
export function clueQueriesFromQuestion(question: string, max = 6, maxChars = 350): string[] {
  const text = question.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const parts = text
    .split(ITEM)
    .flatMap((piece) => piece.split(/(?<=[.!?;])\s+(?=["'(\[]?[A-Z0-9])/))
    .map((s) => s.trim().replace(/[:;,]$/, ""))
    .filter(Boolean);
  let clues = parts.filter((s) => s.length >= 12 && !ASK.test(s) && !s.endsWith("?"));
  if (!clues.length) clues = parts.filter((s) => s.length >= 12);
  if (!clues.length) clues = [text];
  // One long sentence of comma-separated clauses ("… traits: founded …, was elected …, was born …"):
  // drop an ask lead-in up to its colon, then chunk at commas into statements of about 100 chars.
  clues = clues.flatMap((c) => (c.length <= 200 ? [c] : chunkClauses(c)));
  while (clues.length > max) {
    let best = 0;
    for (let i = 0; i + 1 < clues.length; i++)
      if (clues[i].length + clues[i + 1].length < clues[best].length + clues[best + 1].length)
        best = i;
    clues.splice(best, 2, `${clues[best]} ${clues[best + 1]}`);
  }
  return [
    ...new Set(
      clues.map((c) => (c.length > maxChars ? c.slice(0, maxChars - 1).trimEnd() + "…" : c)),
    ),
  ];
}

function chunkClauses(sentence: string, target = 100): string[] {
  let body = sentence;
  const colon = body.indexOf(":");
  if (colon > 0 && colon < 160 && ASK.test(body)) body = body.slice(colon + 1).trim();
  const pieces = body.split(/,\s+/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const piece of pieces) {
    const last = out[out.length - 1];
    if (last !== undefined && last.length + piece.length + 2 <= target) out[out.length - 1] = `${last}, ${piece}`;
    else out.push(piece);
  }
  return out.map((p) => p.replace(/^(and|or|then)\s+/i, "")).filter((p) => p.length >= 12);
}

export type NoticeDoc = {
  rank: number;
  docid: string;
  passage_unit?: string;
  title: string | null;
  clue_ids: number[];
  lines: unknown;
  source_offsets_utf16: unknown;
  excerpt: string;
  excerpt_truncated: boolean;
  score?: number;
};
export type NoticeRule = "coverage" | "specificity";
export type Notice = {
  search_id: string;
  ranks: [number, number];
  units_scanned: number;
  clues: string[];
  located: NoticeDoc[];
  note: string;
};
export type ScannedUnit = { unit: string; rank: number };

const NOTE =
  "Jev auto-scanned these ranked results against the question's clue statements (clue_ids index the clues list, 1-based). Excerpts are verbatim source prefixes of located pages in parent-document coordinates; they are retrieval associations, not verified answers. Use jev_find(docids=[...]) with your current questions or read_document(parent docid) to inspect a lead. Reconsider your current candidate if a located result contradicts it.";

function cut(text: string, n: number) {
  if (text.length <= n) return text;
  let end = n;
  const c = text.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return text.slice(0, end);
}

export function buildNotice(
  searchId: string,
  units: ScannedUnit[],
  documents: EvidenceDoc[],
  titles: Map<string, string | null | undefined>,
  clues: string[],
  options: { maxDocs?: number; excerptChars?: number; rule?: NoticeRule; minScore?: number } = {},
): Notice | null {
  const maxDocs = options.maxDocs ?? 6,
    excerptChars = options.excerptChars ?? 240;
  const rankOf = new Map(units.map((u) => [u.unit, u.rank]));
  const located: NoticeDoc[] = [];
  for (const doc of documents) {
    const passages = doc.passages.filter(
      (p) => !p.fallback && Array.isArray(p.query_ids) && p.query_ids.length > 0,
    );
    if (!passages.length) continue;
    const clueIds = [...new Set(passages.flatMap((p) => p.query_ids))].sort((a, b) => a - b);
    const first = passages[0];
    const unit = typeof doc.passage_unit === "string" ? doc.passage_unit : undefined;
    const rank = rankOf.get(unit ?? doc.docid) ?? rankOf.get(doc.docid) ?? Number.MAX_SAFE_INTEGER;
    located.push({
      rank,
      docid: doc.docid,
      ...(unit ? { passage_unit: unit } : {}),
      title: titles.get(doc.docid) ?? null,
      clue_ids: clueIds,
      lines: first.lines,
      source_offsets_utf16: first.source_offsets_utf16,
      excerpt: cut(first.text, excerptChars),
      excerpt_truncated: first.text.length > excerptChars,
    });
  }
  if (!located.length) return null;
  let kept: NoticeDoc[];
  if (options.rule === "specificity") {
    // A clue that many scanned documents match is generic; weight each clue by 1/(documents
    // matching it in this scan). Keep documents whose weighted coverage reaches minScore, best
    // first; if none does, keep the single best so a lead is never silently dropped.
    const count = new Map<number, number>();
    for (const d of located) for (const c of d.clue_ids) count.set(c, (count.get(c) ?? 0) + 1);
    const score = (d: NoticeDoc) => d.clue_ids.reduce((s, c) => s + 1 / count.get(c)!, 0);
    for (const d of located) d.score = Math.round(score(d) * 1000) / 1000;
    located.sort((a, b) => b.score! - a.score! || a.rank - b.rank || a.docid.localeCompare(b.docid));
    const minScore = options.minScore ?? 0.5;
    kept = located.filter((d) => d.score! >= minScore);
    if (!kept.length) kept = located.slice(0, 1);
  } else {
    located.sort(
      (a, b) =>
        b.clue_ids.length - a.clue_ids.length || a.rank - b.rank || a.docid.localeCompare(b.docid),
    );
    kept = located;
  }
  const ranks = units.map((u) => u.rank);
  return {
    search_id: searchId,
    ranks: [Math.min(...ranks), Math.max(...ranks)],
    units_scanned: units.length,
    clues,
    located: kept.slice(0, maxDocs),
    note: NOTE,
  };
}

export function attachNoticesToText(text: string, notices: Notice[]): string {
  return notices.length ? `${text}\n\n${NOTICE_MARKER} ${JSON.stringify(notices)}` : text;
}

export type ScanReader = (
  params: { reason: string; docids: string[]; queries: string[] },
  backend: PiSearchBackend,
  signal?: AbortSignal,
) => Promise<{
  content: { type: "text"; text: string }[];
  details?: { jevFindRead?: { batch: number } };
}>;

type Options = {
  scan: ScanReader;
  resolveUnit: ResolveUnit;
  audit: (row: Record<string, unknown>) => void;
  store?: EvidenceStore;
  top?: number;
  maxDocs?: number;
  excerptChars?: number;
  rule?: NoticeRule;
  minScore?: number;
  titleOf?: (docid: string, signal?: AbortSignal) => Promise<string | null | undefined>;
  remainingTimeMs?: () => number;
  minRemainingMs?: number;
  onScanned?: (units: string[], parents: string[]) => void;
};

export function createAutoScanner(o: Options) {
  const top = o.top ?? 60;
  const scanned = new Set<string>();
  let pending: Notice[] = [];
  let queue: Promise<void> = Promise.resolve();
  let controller = new AbortController();
  let active = true,
    seq = 0,
    inFlight = 0;
  const stats = { scans: 0, units: 0, located: 0, notices: 0, skipped: 0, errors: 0 };

  async function run(
    id: number,
    searchId: string,
    units: ScannedUnit[],
    backend: PiSearchBackend,
    clues: string[],
  ) {
    if (!active) {
      stats.skipped++;
      o.audit({ type: "auto_scan_skip", id, search_id: searchId, reason: "stopped" });
      return;
    }
    const remaining = o.remainingTimeMs?.() ?? Infinity;
    if (remaining < (o.minRemainingMs ?? 45_000)) {
      stats.skipped++;
      o.audit({
        type: "auto_scan_skip",
        id,
        search_id: searchId,
        reason: "time_budget",
        remaining_ms: Math.round(remaining),
      });
      return;
    }
    const signal = controller.signal,
      started = performance.now();
    const documents: EvidenceDoc[] = [],
      batches: number[] = [];
    inFlight++;
    try {
      for (let i = 0; i < units.length; i += 60) {
        const chunk = units.slice(i, i + 60);
        const r = await o.scan(
          { reason: `auto_scan:${id}`, docids: chunk.map((u) => u.unit), queries: clues },
          backend,
          signal,
        );
        documents.push(...(JSON.parse(r.content[0].text).documents as EvidenceDoc[]));
        if (r.details?.jevFindRead) batches.push(r.details.jevFindRead.batch);
      }
    } finally {
      inFlight--;
    }
    const translated = translateFindOutput({ documents }, o.resolveUnit);
    const titles = new Map<string, string | null | undefined>();
    if (o.titleOf)
      for (const d of translated.documents)
        if (d.passages.some((p) => !p.fallback && p.query_ids.length)) {
          try {
            titles.set(d.docid, await o.titleOf(d.docid, signal));
          } catch {
            titles.set(d.docid, null);
          }
        }
    const notice = buildNotice(searchId, units, translated.documents, titles, clues, o);
    stats.scans++;
    stats.units += units.length;
    if (notice) {
      stats.notices++;
      stats.located += notice.located.length;
    }
    o.audit({
      type: "auto_scan_public",
      id,
      utc: new Date().toISOString(),
      search_id: searchId,
      batches,
      ranks: [units[0].rank, units[units.length - 1].rank],
      units: units.map((u) => u.unit),
      clues,
      output: translated,
      notice,
      elapsed_ms: Math.round(performance.now() - started),
    });
    if (o.store)
      o.audit({
        type: "evidence_commit",
        source_call: `auto_scan:${id}`,
        entries: o.store.add(documents, `auto_scan:${id}`, clues),
      });
    o.onScanned?.(
      units.map((u) => u.unit),
      parentDocidsOf(
        units.map((u) => u.unit),
        o.resolveUnit,
      ),
    );
    if (notice && active) pending.push(notice);
  }

  return {
    stats,
    /** Queue a scan of the top ranks of a fresh search ranking (units not scanned before). */
    onSearch(searchId: string, ranking: string[], backend: PiSearchBackend, clues: string[]) {
      if (!active || !clues.length) return 0;
      const units = ranking
        .slice(0, top)
        .map((unit, i) => ({ unit, rank: i + 1 }))
        .filter((u) => !scanned.has(u.unit));
      if (!units.length) {
        o.audit({ type: "auto_scan_skip", search_id: searchId, reason: "all_scanned" });
        return 0;
      }
      for (const u of units) scanned.add(u.unit);
      const id = ++seq;
      o.audit({
        type: "auto_scan_queued",
        id,
        search_id: searchId,
        units: units.length,
        top,
        clues: clues.length,
      });
      queue = queue
        .then(() => run(id, searchId, units, backend, clues))
        .catch((e) => {
          stats.errors++;
          o.audit({
            type: "auto_scan_error",
            id,
            search_id: searchId,
            aborted: Boolean(controller.signal.aborted),
            error: e instanceof Error ? e.message : String(e),
          });
        });
      return units.length;
    },
    /** Notices not yet delivered; delivering clears them. */
    drain(): Notice[] {
      const out = pending;
      pending = [];
      return out;
    },
    get pendingCount() {
      return pending.length;
    },
    get inFlight() {
      return inFlight;
    },
    /** Whether `unit` was already covered by an auto-scan. */
    has(unit: string) {
      return scanned.has(unit);
    },
    /** Stop scanning: abort in-flight Jev work and drop queued scans and undelivered notices. */
    stop() {
      active = false;
      controller.abort();
      pending = [];
    },
    reset() {
      controller.abort();
      controller = new AbortController();
      scanned.clear();
      pending = [];
      queue = Promise.resolve();
      active = true;
      seq = 0;
    },
    /** Resolves when queued scans have finished (for tests and shutdown). */
    idle() {
      return queue;
    },
  };
}
