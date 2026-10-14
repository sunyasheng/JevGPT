// Ranking auto-scan: the rank_documents counterpart of jev_auto_scan_v1. After every search, Jev
// assesses the top ranked documents that no earlier judgment covered, against the original topic,
// with the same document ranking reader and cache that jev_find uses. Likely relevant documents
// reach the model as a notice attached to its next search or jev_find result, and their cached
// judgments let a later jev_find(docids) return original pages without new Jev requests.
// The research process receives only the topic: no qrels or relevance labels are used here.
import type { PiSearchBackend } from "../pi-search/searcher/contract/interface";
import type { RankedDocument } from "./jev_document_ranking_reader";

export const RANKING_NOTICE_MARKER = "AUTO_SCAN_NOTICES:";
const NOTE =
  "Jev assessed these ranked results in the background against the original topic. Listed documents have an estimated relevance probability of at least the stated threshold; estimates are fallible, not official labels. Excerpts are verbatim prefixes of a selected page. Use jev_find(docids=[...]) to receive their original pages from cached judgments, or read_document(docid). Assessed documents that are not listed are less likely relevant, not proven irrelevant.";

export type RankingNoticeDoc = {
  rank: number;
  docid: string;
  title: string;
  relevance_score: number | null;
  relevant_probability: number | null;
  excerpt: string;
  excerpt_truncated: boolean;
};
export type RankingNotice = {
  search_id: string;
  ranks: [number, number];
  units_scanned: number;
  min_probability: number;
  located: RankingNoticeDoc[];
  assessed_not_listed: number;
  note: string;
};
type Unit = { docid: string; rank: number };
type ReadResult = { output: { documents: RankedDocument[] }; attemptedDocids: string[] };
export type RankingReaderLike = {
  read(
    input: { topic: string; docids: string[]; targeted?: boolean },
    backend: PiSearchBackend,
    signal?: AbortSignal,
  ): Promise<ReadResult>;
  assessedIds(): Set<string>;
};

/** Likely relevant, complete, not yet delivered documents, best estimate first, then ranking order. */
export function buildRankingNotice(
  searchId: string,
  units: Unit[],
  documents: RankedDocument[],
  options: { minProbability?: number; maxDocs?: number; excerptChars?: number; exclude?: Set<string> } = {},
): RankingNotice | null {
  if (!units.length) return null;
  const minProbability = options.minProbability ?? 0.5,
    maxDocs = options.maxDocs ?? 10,
    excerptChars = options.excerptChars ?? 240,
    exclude = options.exclude ?? new Set<string>();
  const rank = new Map(units.map((u) => [u.docid, u.rank]));
  const located = documents
    .filter(
      (d) =>
        rank.has(d.docid) &&
        !d.scan_incomplete &&
        !exclude.has(d.docid) &&
        (d.relevance.probability ?? 0) >= minProbability,
    )
    .sort(
      (a, b) =>
        (b.relevance.probability ?? 0) - (a.relevance.probability ?? 0) ||
        rank.get(a.docid)! - rank.get(b.docid)! ||
        a.docid.localeCompare(b.docid),
    )
    .slice(0, maxDocs)
    .map((d) => {
      const text = d.passages[0]?.text ?? "";
      return {
        rank: rank.get(d.docid)!,
        docid: d.docid,
        title: d.title,
        relevance_score: d.relevance.score,
        relevant_probability: d.relevance.probability,
        excerpt: text.slice(0, excerptChars),
        excerpt_truncated: text.length > excerptChars,
      };
    });
  if (!located.length) return null;
  const ranks = units.map((u) => u.rank);
  return {
    search_id: searchId,
    ranks: [Math.min(...ranks), Math.max(...ranks)],
    units_scanned: units.length,
    min_probability: minProbability,
    located,
    assessed_not_listed: units.length - located.length,
    note: NOTE,
  };
}

export function attachRankingNotices(text: string, notices: RankingNotice[]): string {
  return notices.length ? `${text}\n\n${RANKING_NOTICE_MARKER} ${JSON.stringify(notices)}` : text;
}

type Options = {
  reader: RankingReaderLike;
  audit: (record: object) => void;
  remainingTimeMs?: () => number;
  isDelivered?: (docid: string) => boolean;
  onAttempted?: (docids: string[]) => void;
  top?: number;
  maxDocs?: number;
  minProbability?: number;
  excerptChars?: number;
  minRemainingMs?: number;
};

export function createRankingAutoScanner(o: Options) {
  const top = o.top ?? 60;
  const scanned = new Set<string>();
  const inflight = new Set<Promise<void>>();
  let pending: RankingNotice[] = [];
  let controller = new AbortController();
  let active = true,
    seq = 0;
  const stats = { scans: 0, units: 0, located: 0, notices: 0, skipped: 0, errors: 0 };

  function schedule(searchId: string, ranking: string[], backend: PiSearchBackend, topic: string) {
    if (!active || !topic) return;
    const assessed = o.reader.assessedIds();
    const units = ranking
      .slice(0, top)
      .map((docid, i) => ({ docid, rank: i + 1 }))
      .filter((u) => !assessed.has(u.docid) && !scanned.has(u.docid));
    const id = ++seq;
    if (!units.length) {
      stats.skipped++;
      o.audit({ type: "auto_scan_skip", id, search_id: searchId, reason: "no_unassessed_units" });
      return;
    }
    const remaining = o.remainingTimeMs?.() ?? Infinity;
    if (remaining < (o.minRemainingMs ?? 45_000)) {
      stats.skipped++;
      o.audit({ type: "auto_scan_skip", id, search_id: searchId, reason: "low_remaining_time", remaining_ms: remaining });
      return;
    }
    for (const u of units) scanned.add(u.docid);
    o.audit({ type: "auto_scan_queued", id, search_id: searchId, units: units.length, top, task_mode: "rank_documents" });
    const signal = controller.signal;
    const job = o.reader
      .read({ topic, docids: units.map((u) => u.docid), targeted: true }, backend, signal)
      .then((result) => {
        if (signal.aborted) return;
        o.onAttempted?.(result.attemptedDocids);
        const notice = buildRankingNotice(searchId, units, result.output.documents, {
          minProbability: o.minProbability,
          maxDocs: o.maxDocs,
          excerptChars: o.excerptChars,
          exclude: new Set(units.map((u) => u.docid).filter((d) => o.isDelivered?.(d))),
        });
        stats.scans++;
        stats.units += units.length;
        if (notice) {
          stats.notices++;
          stats.located += notice.located.length;
          pending.push(notice);
        }
        o.audit({ type: "auto_scan_public", id, search_id: searchId, units: units.map((u) => u.docid), attempted: result.attemptedDocids.length, notice });
      })
      .catch((error) => {
        if (signal.aborted) return;
        stats.errors++;
        o.audit({ type: "auto_scan_error", id, search_id: searchId, error: error instanceof Error ? error.message : String(error) });
      });
    inflight.add(job);
    void job.finally(() => inflight.delete(job));
  }

  function take(tool: string): RankingNotice[] {
    if (!pending.length) return [];
    const notices = pending;
    pending = [];
    o.audit({ type: "auto_scan_delivery", tool, notices: notices.map((n) => ({ search_id: n.search_id, ranks: n.ranks, located: n.located.length })) });
    return notices;
  }

  function stop() {
    if (!active) return;
    active = false;
    controller.abort();
    o.audit({ type: "auto_scan_summary", task_mode: "rank_documents", ...stats, undelivered_notices: pending.length });
  }

  function reset() {
    controller.abort();
    controller = new AbortController();
    scanned.clear();
    pending = [];
    active = true;
    seq = 0;
    Object.assign(stats, { scans: 0, units: 0, located: 0, notices: 0, skipped: 0, errors: 0 });
  }

  return {
    schedule,
    take,
    stop,
    reset,
    stats: () => ({ ...stats }),
    flush: () => Promise.allSettled([...inflight]).then(() => undefined),
  };
}
