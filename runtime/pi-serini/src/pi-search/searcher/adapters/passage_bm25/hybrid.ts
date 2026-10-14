/** Hybrid BM25 backend: fusion of a whole-document ranking and a passage ranking for the same query.
 *
 * The passage ranking is reduced to documents by each document's best passage (MaxP). Default fusion is a
 * convex combination of min-max normalised scores, score(d) = lambda * norm(doc) + (1 - lambda) * norm(maxP)
 * (Bendersky & Kurland 2008; Bruch et al. 2023); reciprocal rank fusion remains available. Short documents
 * (at most `shortChars` UTF-16 units) are read whole under their plain docid; longer documents contribute
 * their top `passagesPerDoc` passages as consecutive units `docid#n`, each served by the passage backend as
 * a verbatim pseudo-document. A long document with no ranked passage is read whole.
 */
import {
  DEFAULT_PASSAGE_ID_PREFIX,
  parsePassageId,
  parseUnitId,
  passageIdFor,
  unitIdFor,
  type PassageBm25Backend,
  type PassageHelperTransport,
  type PassageUnitRef,
  type UnitMapping,
} from "./adapter";
import { parseRenderSearchResultsPayload, parseSearchPayload } from "../../../protocol/parse";
import type { PiSearchBackend } from "../../contract/interface";
import type {
  SearchBackendCapabilities,
  SearchBackendReadDocumentRequest,
  SearchBackendReadDocumentResponse,
  SearchBackendSearchHit,
  SearchBackendSearchRequest,
  SearchBackendSearchResponse,
} from "../../contract/types";

export type FusedEntry = {
  docid: string;
  score: number;
  docRank?: number;
  passageRank?: number;
  bestPassage?: number;
};

const best = (e: FusedEntry) => Math.min(e.docRank ?? Infinity, e.passageRank ?? Infinity);

/** Reciprocal rank fusion at document level; passage ranks are counted over distinct documents. */
export function rrfFuse(docRanking: string[], passages: PassageUnitRef[], k = 60): FusedEntry[] {
  const docRank = new Map<string, number>();
  for (const docid of docRanking) if (!docRank.has(docid)) docRank.set(docid, docRank.size + 1);
  const passageRank = new Map<string, number>();
  const bestPassage = new Map<string, number>();
  for (const unit of passages) {
    if (passageRank.has(unit.docid)) continue;
    passageRank.set(unit.docid, passageRank.size + 1);
    bestPassage.set(unit.docid, unit.index);
  }
  const fused: FusedEntry[] = [];
  for (const docid of new Set([...docRank.keys(), ...passageRank.keys()])) {
    const a = docRank.get(docid),
      b = passageRank.get(docid);
    fused.push({
      docid,
      score: (a ? 1 / (k + a) : 0) + (b ? 1 / (k + b) : 0),
      ...(a ? { docRank: a } : {}),
      ...(b ? { passageRank: b, bestPassage: bestPassage.get(docid) } : {}),
    });
  }
  fused.sort((x, y) => y.score - x.score || best(x) - best(y) || x.docid.localeCompare(y.docid));
  return fused;
}

/** Min-max normalisation of (id, score) pairs over the list; an empty or constant list maps to 0. */
export function minMax(pairs: [string, number][]): Map<string, number> {
  const out = new Map<string, number>();
  if (!pairs.length) return out;
  let lo = Infinity,
    hi = -Infinity;
  for (const [, s] of pairs) {
    if (s < lo) lo = s;
    if (s > hi) hi = s;
  }
  const range = hi - lo || 1;
  for (const [id, s] of pairs) if (!out.has(id)) out.set(id, (s - lo) / range);
  return out;
}

/** Convex combination of min-max normalised document and best-passage scores:
 * score(d) = lambda * norm(doc BM25) + (1 - lambda) * norm(max passage BM25); a missing side counts 0.
 * Passage scores are reduced per document to the best passage (MaxP) before normalisation. */
export function convexFuse(
  docRanking: [string, number][],
  passages: (PassageUnitRef & { score: number })[],
  lambda = 0.5,
  passagesPerDoc = 1,
): (FusedEntry & { normDoc: number; normPassage: number; topPassages: number[] })[] {
  const docRank = new Map<string, number>();
  for (const [docid] of docRanking) if (!docRank.has(docid)) docRank.set(docid, docRank.size + 1);
  const passageRank = new Map<string, number>();
  const best = new Map<string, number>();
  const top = new Map<string, number[]>();
  for (const unit of passages) {
    if (!passageRank.has(unit.docid)) {
      passageRank.set(unit.docid, passageRank.size + 1);
      best.set(unit.docid, unit.score);
      top.set(unit.docid, []);
    }
    const list = top.get(unit.docid)!;
    if (list.length < passagesPerDoc) list.push(unit.index);
  }
  const nd = minMax(docRanking);
  const np = minMax([...best].map(([d, s]) => [d, s] as [string, number]));
  const fused = [];
  for (const docid of new Set([...docRank.keys(), ...passageRank.keys()])) {
    const a = nd.get(docid) ?? 0,
      b = np.get(docid) ?? 0;
    fused.push({
      docid,
      score: lambda * a + (1 - lambda) * b,
      normDoc: a,
      normPassage: b,
      topPassages: top.get(docid) ?? [],
      ...(docRank.has(docid) ? { docRank: docRank.get(docid) } : {}),
      ...(passageRank.has(docid)
        ? { passageRank: passageRank.get(docid), bestPassage: top.get(docid)![0] }
        : {}),
    });
  }
  fused.sort(
    (x, y) =>
      y.score - x.score ||
      Math.max(y.normDoc, y.normPassage) - Math.max(x.normDoc, x.normPassage) ||
      x.docid.localeCompare(y.docid),
  );
  return fused;
}

/** Plain docid for short documents or when no passage ranked; otherwise the best passage unit. */
export function chooseUnit(
  entry: FusedEntry,
  length: number | undefined,
  shortChars: number,
): string {
  if (entry.bestPassage === undefined) return entry.docid;
  if (length !== undefined && length <= shortChars) return entry.docid;
  return unitIdFor(entry.docid, entry.bestPassage);
}

export type HybridBm25BackendOptions = {
  passages: PassageHelperTransport;
  documentHelper: PassageHelperTransport;
  documents: PiSearchBackend;
  units: PassageBm25Backend;
  docLengths: Map<string, number>;
  shortChars?: number;
  rrfK?: number;
  /** "cc" (convex combination, default) or "rrf". */
  fusion?: "cc" | "rrf";
  /** Weight of the document side in the convex combination. */
  lambda?: number;
  /** Long documents contribute this many of their top passages as consecutive units. */
  passagesPerDoc?: number;
  passageIdPrefix?: string;
  previewWindow?: number;
};

const HYBRID_CAPABILITIES: SearchBackendCapabilities = {
  backendId: "anserini-bm25-hybrid",
  supportsScore: true,
  supportsSnippets: true,
  supportsExactTotalHits: false,
};
const PREVIEW_MAX_CHARS = 220;

export class HybridBm25Backend implements PiSearchBackend {
  readonly capabilities = HYBRID_CAPABILITIES;
  private readonly prefix: string;
  private readonly shortChars: number;
  private readonly k: number;
  private readonly previewWindow: number;
  private readonly fusion: "cc" | "rrf";
  private readonly lambda: number;
  private readonly passagesPerDoc: number;

  constructor(private readonly options: HybridBm25BackendOptions) {
    this.prefix = options.passageIdPrefix ?? DEFAULT_PASSAGE_ID_PREFIX;
    this.shortChars = options.shortChars ?? 8000;
    this.k = options.rrfK ?? 60;
    this.previewWindow = options.previewWindow ?? 50;
    this.fusion = options.fusion ?? "cc";
    this.lambda = options.lambda ?? 0.5;
    this.passagesPerDoc = Math.max(1, options.passagesPerDoc ?? 2);
  }

  /** Title of a parent document (front matter), for notices about ranked results. */
  titleOf(docid: string, signal?: AbortSignal): Promise<string | undefined> {
    return this.options.units.titleOf(docid, signal);
  }

  getUnitMapping(unitId: string): UnitMapping | undefined {
    return this.options.units.getUnitMapping(unitId);
  }

  async search(
    request: SearchBackendSearchRequest,
    signal?: AbortSignal,
  ): Promise<SearchBackendSearchResponse> {
    const params = {
      query: request.query,
      query_mode: "plain",
      k: request.limit,
      rerank_clues: [],
    };
    const [docOut, passageOut] = await Promise.all([
      this.options.documentHelper.request("search", params, signal),
      this.options.passages.request("search", params, signal),
    ]);
    const docParsed = parseSearchPayload(docOut),
      passageParsed = parseSearchPayload(passageOut);
    const docScored = (docParsed.results ?? []).map(
      (row) => [row.docid, row.score] as [string, number],
    );
    const passageUnits = (passageParsed.results ?? []).flatMap((row) => {
      const unit = parsePassageId(this.prefix, row.docid);
      return unit ? [{ ...unit, score: row.score }] : [];
    });
    const fused: (FusedEntry & { topPassages?: number[] })[] =
      this.fusion === "rrf"
        ? rrfFuse(
            docScored.map(([d]) => d),
            passageUnits,
            this.k,
          )
        : convexFuse(docScored, passageUnits, this.lambda, this.passagesPerDoc);
    const hits: SearchBackendSearchHit[] = [];
    for (const entry of fused) {
      if (hits.length >= request.limit) break;
      const length = this.options.docLengths.get(entry.docid);
      const unit = chooseUnit(entry, length, this.shortChars);
      const units =
        unit === entry.docid
          ? [unit]
          : (entry.topPassages ?? [entry.bestPassage!]).map((n) => unitIdFor(entry.docid, n));
      for (const u of units) {
        if (hits.length >= request.limit) break;
        hits.push({
          docid: u,
          score: Math.round(entry.score * 1e6) / 1e6,
          metadata: {
            parent_docid: entry.docid,
            unit_kind: u === entry.docid ? "document" : "passage",
            doc_rank: entry.docRank ?? null,
            passage_rank: entry.passageRank ?? null,
            doc_length_utf16: length ?? null,
            fusion: this.fusion,
          },
        });
      }
    }
    await this.attachPreviews(hits.slice(0, this.previewWindow), request.query, signal);
    const t = (x: number | undefined) => x ?? 0;
    return {
      hits,
      hasMore: hits.length >= request.limit,
      timingMs: {
        request: Math.max(t(docParsed.timing_ms?.command), t(passageParsed.timing_ms?.command)),
        backendInit: docParsed.timing_ms?.init,
        backendUptime: docParsed.timing_ms?.server_uptime,
      },
    };
  }

  async readDocument(
    request: SearchBackendReadDocumentRequest,
    signal?: AbortSignal,
  ): Promise<SearchBackendReadDocumentResponse> {
    if (parseUnitId(request.docid)) return this.options.units.readDocument(request, signal);
    return this.options.documents.readDocument(request, signal);
  }

  async close(): Promise<void> {
    this.options.passages.dispose?.();
    this.options.documentHelper.dispose?.();
    await this.options.documents.close?.();
  }

  private async render(
    helper: PassageHelperTransport,
    ids: string[],
    query: string,
    signal?: AbortSignal,
  ): Promise<Map<string, { excerpt: string; excerpt_truncated: boolean }>> {
    if (!ids.length) return new Map();
    try {
      const output = await helper.request(
        "render_search_results",
        {
          docids: ids,
          snippet_max_chars: PREVIEW_MAX_CHARS,
          inline_highlights: false,
          highlight_clues: query.trim() ? [{ text: query.trim(), category: "any", boost: 1 }] : [],
        },
        signal,
      );
      return new Map(
        (parseRenderSearchResultsPayload(output).results ?? []).map((row) => [row.docid, row]),
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      return new Map();
    }
  }

  private async attachPreviews(
    hits: SearchBackendSearchHit[],
    query: string,
    signal?: AbortSignal,
  ) {
    const passageIds = new Map<string, string>(),
      docIds: string[] = [];
    for (const hit of hits) {
      const unit = parseUnitId(hit.docid);
      if (unit) passageIds.set(hit.docid, passageIdFor(this.prefix, unit));
      else docIds.push(hit.docid);
    }
    const [passagePreviews, docPreviews] = await Promise.all([
      this.render(this.options.passages, [...passageIds.values()], query, signal),
      this.render(this.options.documentHelper, docIds, query, signal),
    ]);
    for (const hit of hits) {
      const parent = String((hit.metadata as { parent_docid: string }).parent_docid);
      let title: string | undefined;
      try {
        title = await this.options.units.titleOf(parent, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
      }
      const passageId = passageIds.get(hit.docid);
      const preview = passageId ? passagePreviews.get(passageId) : docPreviews.get(hit.docid);
      let excerpt = preview?.excerpt;
      if (passageId && title && excerpt?.startsWith(title + " "))
        excerpt = excerpt.slice(title.length + 1);
      if (title) hit.title = title;
      if (excerpt) {
        hit.snippet = excerpt;
        hit.snippetTruncated = preview!.excerpt_truncated;
      }
    }
  }
}
