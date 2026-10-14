/** Passage-level BM25 backend for pi-search.
 *
 * Ranking unit: one indexed passage (Meng et al. passage index: at most 250 words, document
 * title prepended, whitespace-normalised body). Each unit is exposed as a pseudo-document whose
 * id is `${docid}#${n}`. Its text is verbatim original source copied from the parent document in
 * the document-level index: the document front matter (title/date block, when present) followed
 * by the original character span that the indexed passage was cut from. Every pseudo-document
 * records how its local UTF-16 offsets map back to parent-document offsets, so evidence located
 * inside a unit can be returned to the researcher in parent-document coordinates.
 *
 * Plain parent docids are delegated unchanged to the document-level backend, so read_document on
 * a docid still reads the full original document.
 */
import {
  parseReadDocumentPayload,
  parseRenderSearchResultsPayload,
  parseSearchPayload,
} from "../../../protocol/parse";
import type { PiSearchBackend } from "../../contract/interface";
import type {
  SearchBackendCapabilities,
  SearchBackendReadDocumentRequest,
  SearchBackendReadDocumentResponse,
  SearchBackendSearchHit,
  SearchBackendSearchRequest,
  SearchBackendSearchResponse,
} from "../../contract/types";

/** Same shape as the Anserini helper transport; declared locally so this adapter only depends on the searcher contract. */
export type PassageHelperTransport = {
  request(
    commandType: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string>;
  dispose?(): void;
};

export const PASSAGE_UNIT_SEPARATOR = "#";
export const DEFAULT_PASSAGE_ID_PREFIX = "browsecomp_plus_";
const SEARCH_PREVIEW_WINDOW = 50;
const SEARCH_PREVIEW_MAX_CHARS = 220;
const FULL_READ_LIMIT = 1_000_000;
const TITLE_HEAD_LINES = 6;

export type PassageUnitRef = { docid: string; index: number };
export type UnitPiece = { local: [number, number]; doc: [number, number] };
export type UnitMapping = {
  unitId: string;
  docid: string;
  index: number;
  title?: string;
  /** false when the indexed passage could not be located in the parent document; text is then the index copy. */
  aligned: boolean;
  /** Pseudo-document text served for this unit. */
  text: string;
  /** Verbatim pieces: local pseudo-document span -> parent document span. Empty when not aligned. */
  pieces: UnitPiece[];
  docLength: number;
  docText: string;
};

export function unitIdFor(docid: string, index: number): string {
  return `${docid}${PASSAGE_UNIT_SEPARATOR}${index}`;
}

export function parseUnitId(id: string): PassageUnitRef | undefined {
  const cut = id.lastIndexOf(PASSAGE_UNIT_SEPARATOR);
  if (cut <= 0 || cut === id.length - 1) return undefined;
  const digits = id.slice(cut + 1);
  if (!/^\d+$/.test(digits)) return undefined;
  const index = Number(digits);
  if (!Number.isSafeInteger(index)) return undefined;
  return { docid: id.slice(0, cut), index };
}

export function passageIdFor(prefix: string, unit: PassageUnitRef): string {
  return `${prefix}${unit.docid}_${unit.index}`;
}

export function parsePassageId(prefix: string, passageId: string): PassageUnitRef | undefined {
  if (!passageId.startsWith(prefix)) return undefined;
  const rest = passageId.slice(prefix.length);
  const cut = rest.lastIndexOf("_");
  if (cut <= 0) return undefined;
  const digits = rest.slice(cut + 1);
  if (!/^\d+$/.test(digits)) return undefined;
  return { docid: rest.slice(0, cut), index: Number(digits) };
}

export type Frontmatter = { end: number; title?: string };

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0],
      last = trimmed[trimmed.length - 1];
    // Only a fully quoted scalar is unquoted; a title such as `"A" was influenced by "B"` is kept verbatim.
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = trimmed.slice(1, -1);
      if (!inner.includes(first)) return inner.trim();
    }
  }
  return trimmed;
}

/** Leading `---` YAML-style block as used by the BrowseComp-Plus corpus. `end` is the UTF-16 offset just past it. */
export function parseFrontmatter(text: string): Frontmatter {
  if (!/^---\r?\n/.test(text)) return { end: 0 };
  const close = /\r?\n---(?:\r?\n|$)/g;
  close.lastIndex = 3;
  const match = close.exec(text);
  if (!match || match.index > 4000) return { end: 0 };
  const end = match.index + match[0].length;
  const title = titleFromHead(text.slice(0, match.index));
  return title ? { end, title } : { end };
}

/** Title line from the first lines of a document, without requiring the closing delimiter. */
export function titleFromHead(head: string): string | undefined {
  if (!/^---\r?\n/.test(head)) return undefined;
  const match = /^title:[ \t]*(.*)$/m.exec(head);
  const title = match ? unquote(match[1]) : "";
  return title ? title : undefined;
}

// Exactly the JavaScript `\s` class, so compact mapping and `replace(/\s/g, "")` agree.
function isWhitespace(code: number): boolean {
  return (
    code === 0x20 ||
    (code >= 0x09 && code <= 0x0d) ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

export type CompactText = { text: string; positions: Int32Array };

/** Text with all whitespace removed plus, for each remaining code unit, its original offset. */
export function compactText(text: string): CompactText {
  const positions = new Int32Array(text.length);
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (!isWhitespace(text.charCodeAt(i))) positions[count++] = i;
  }
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(text[positions[i]]);
  return { text: out.join(""), positions: positions.subarray(0, count) };
}

/** Remove the prepended document title from an indexed passage, tolerating whitespace differences. */
export function stripTitlePrefix(contents: string, title: string | undefined): string {
  if (!title) return contents;
  const compactTitle = compactText(title).text;
  if (!compactTitle) return contents;
  const compactContents = compactText(contents);
  if (compactContents.text.length <= compactTitle.length) return contents;
  if (!compactContents.text.startsWith(compactTitle)) return contents;
  const bodyStart = compactContents.positions[compactTitle.length];
  return contents.slice(bodyStart);
}

function occurrences(haystack: string, needle: string, limit: number): number[] {
  const found: number[] = [];
  let from = 0;
  while (found.length < limit) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    found.push(at);
    from = at + 1;
  }
  return found;
}

/** Locate a whitespace-normalised passage body inside the original document text.
 * Returns the half-open original span, or undefined when the body does not occur. `notBefore`
 * selects the first occurrence at or after that original offset when several exist. */
export function alignBody(
  doc: { text: string; compact: CompactText },
  body: string,
  notBefore = 0,
): [number, number] | undefined {
  if (!body.trim()) return undefined;
  const exact = occurrences(doc.text, body, 8).filter((at) => at >= notBefore);
  if (exact.length) return [exact[0], exact[0] + body.length];
  const compactBody = compactText(body).text;
  if (!compactBody) return undefined;
  const hits = occurrences(doc.compact.text, compactBody, 8).filter(
    (at) => doc.compact.positions[at] >= notBefore,
  );
  if (!hits.length) return undefined;
  const at = hits[0];
  return [doc.compact.positions[at], doc.compact.positions[at + compactBody.length - 1] + 1];
}

export function countOccurrences(
  doc: { text: string; compact: CompactText },
  body: string,
): number {
  const exact = occurrences(doc.text, body, 8).length;
  if (exact) return exact;
  const compactBody = compactText(body).text;
  return compactBody ? occurrences(doc.compact.text, compactBody, 8).length : 0;
}

/** Compose the pseudo-document for one unit: verbatim front matter plus the verbatim passage span. */
export function buildUnitText(
  docText: string,
  frontmatter: Frontmatter,
  span: [number, number],
): { text: string; pieces: UnitPiece[] } {
  const [start, end] = span;
  if (frontmatter.end > 0 && start > frontmatter.end) {
    const front = frontmatter.end;
    return {
      text: docText.slice(0, front) + docText.slice(start, end),
      pieces: [
        { local: [0, front], doc: [0, front] },
        { local: [front, front + (end - start)], doc: [start, end] },
      ],
    };
  }
  const from = frontmatter.end > 0 ? 0 : start;
  return { text: docText.slice(from, end), pieces: [{ local: [0, end - from], doc: [from, end] }] };
}

const LINE_BREAK = /\r\n|\n|\r/;

/** Mirror of the Java read_document line window on in-memory text. */
export function sliceLines(text: string, offset: number, limit: number) {
  const lines = text.split(LINE_BREAK);
  const normalizedOffset = Math.max(1, Math.floor(offset)),
    normalizedLimit = Math.max(1, Math.floor(limit));
  const total = lines.length;
  const startIndex = Math.min(normalizedOffset - 1, total);
  const endIndex = Math.min(startIndex + normalizedLimit, total);
  const truncated = endIndex < total;
  return {
    offset: normalizedOffset,
    limit: normalizedLimit,
    totalUnits: total,
    returnedOffsetStart: startIndex < total ? startIndex + 1 : 0,
    returnedOffsetEnd: startIndex < total ? endIndex : 0,
    truncated,
    nextOffset: truncated ? endIndex + 1 : undefined,
    text:
      startIndex === 0 && endIndex === total ? text : lines.slice(startIndex, endIndex).join("\n"),
  };
}

type CachedDocument = {
  text: string;
  frontmatter: Frontmatter;
  compact?: CompactText;
};

export type PassageBm25BackendOptions = {
  passages: PassageHelperTransport;
  documents: PiSearchBackend;
  passageIdPrefix?: string;
  previewWindow?: number;
  documentCacheEntries?: number;
  documentCacheChars?: number;
  observe?: (row: Record<string, unknown>) => void;
};

const PASSAGE_BM25_CAPABILITIES: SearchBackendCapabilities = {
  backendId: "anserini-bm25-passage",
  supportsScore: true,
  supportsSnippets: true,
  supportsExactTotalHits: false,
};

export class PassageBm25Backend implements PiSearchBackend {
  readonly capabilities = PASSAGE_BM25_CAPABILITIES;
  private readonly prefix: string;
  private readonly previewWindow: number;
  private readonly cacheEntries: number;
  private readonly cacheChars: number;
  private readonly documents = new Map<string, CachedDocument>();
  private cachedChars = 0;
  private readonly titles = new Map<string, string | undefined>();
  private readonly units = new Map<string, UnitMapping>();
  private readonly pending = new Map<string, Promise<UnitMapping | undefined>>();

  constructor(private readonly options: PassageBm25BackendOptions) {
    this.prefix = options.passageIdPrefix ?? DEFAULT_PASSAGE_ID_PREFIX;
    this.previewWindow = options.previewWindow ?? SEARCH_PREVIEW_WINDOW;
    this.cacheEntries = options.documentCacheEntries ?? 32;
    this.cacheChars = options.documentCacheChars ?? 40_000_000;
  }

  /** Title from the parent document's front matter; cached per docid. */
  async titleOf(docid: string, signal?: AbortSignal): Promise<string | undefined> {
    return this.titleFor(docid, signal);
  }

  /** Mapping of a unit already served by readDocument, for coordinate translation. */
  getUnitMapping(unitId: string): UnitMapping | undefined {
    return this.units.get(unitId);
  }

  async search(
    request: SearchBackendSearchRequest,
    signal?: AbortSignal,
  ): Promise<SearchBackendSearchResponse> {
    const output = await this.options.passages.request(
      "search",
      { query: request.query, query_mode: "plain", k: request.limit, rerank_clues: [] },
      signal,
    );
    const parsed = parseSearchPayload(output);
    const rows = (parsed.results ?? []).flatMap((result) => {
      const unit = parsePassageId(this.prefix, result.docid);
      return unit ? [{ passageId: result.docid, unit, score: result.score }] : [];
    });
    const hits: SearchBackendSearchHit[] = rows.map((row) => ({
      docid: unitIdFor(row.unit.docid, row.unit.index),
      score: row.score,
      metadata: { parent_docid: row.unit.docid, passage_index: row.unit.index },
    }));
    const previewed = await this.renderPreviews(
      rows.slice(0, this.previewWindow),
      request.query,
      signal,
    );
    for (let i = 0; i < previewed.length; i++) Object.assign(hits[i], previewed[i]);
    return {
      hits,
      hasMore: hits.length >= request.limit,
      timingMs: {
        request: parsed.timing_ms?.command,
        backendInit: parsed.timing_ms?.init,
        backendUptime: parsed.timing_ms?.server_uptime,
      },
    };
  }

  async readDocument(
    request: SearchBackendReadDocumentRequest,
    signal?: AbortSignal,
  ): Promise<SearchBackendReadDocumentResponse> {
    const unit = parseUnitId(request.docid);
    if (!unit) return this.options.documents.readDocument(request, signal);
    const mapping = await this.resolveUnit(unit, signal);
    if (!mapping) return { found: false, docid: request.docid };
    const window = sliceLines(mapping.text, request.offset ?? 1, request.limit ?? 200);
    return {
      found: true,
      docid: request.docid,
      text: window.text,
      ...(mapping.title ? { title: mapping.title } : {}),
      offset: window.offset,
      limit: window.limit,
      totalUnits: window.totalUnits,
      ...(window.returnedOffsetStart ? { returnedOffsetStart: window.returnedOffsetStart } : {}),
      ...(window.returnedOffsetEnd ? { returnedOffsetEnd: window.returnedOffsetEnd } : {}),
      truncated: window.truncated,
      ...(window.nextOffset ? { nextOffset: window.nextOffset } : {}),
      metadata: {
        passage_unit: mapping.unitId,
        parent_docid: mapping.docid,
        passage_index: mapping.index,
        aligned: mapping.aligned,
        pieces: mapping.pieces,
        doc_length_utf16: mapping.docLength,
      },
    };
  }

  async close(): Promise<void> {
    this.options.passages.dispose?.();
    await this.options.documents.close?.();
  }

  private async renderPreviews(
    rows: { passageId: string; unit: PassageUnitRef }[],
    query: string,
    signal?: AbortSignal,
  ): Promise<Partial<SearchBackendSearchHit>[]> {
    if (!rows.length) return [];
    let excerpts = new Map<string, { excerpt: string; excerpt_truncated: boolean }>();
    try {
      const output = await this.options.passages.request(
        "render_search_results",
        {
          docids: rows.map((row) => row.passageId),
          snippet_max_chars: SEARCH_PREVIEW_MAX_CHARS,
          inline_highlights: false,
          highlight_clues: query.trim() ? [{ text: query.trim(), category: "any", boost: 1 }] : [],
        },
        signal,
      );
      const parsed = parseRenderSearchResultsPayload(output);
      excerpts = new Map((parsed.results ?? []).map((row) => [row.docid, row]));
    } catch {
      excerpts = new Map();
    }
    const titles = new Map<string, string | undefined>();
    for (const docid of new Set(rows.map((row) => row.unit.docid))) {
      try {
        titles.set(docid, await this.titleFor(docid, signal));
      } catch (error) {
        if (signal?.aborted) throw error;
        titles.set(docid, undefined);
      }
    }
    return rows.map((row) => {
      const preview = excerpts.get(row.passageId),
        title = titles.get(row.unit.docid);
      // The indexed passage starts with the document title; the preview line already shows it.
      const excerpt =
        title && preview?.excerpt.startsWith(title + " ")
          ? preview.excerpt.slice(title.length + 1)
          : preview?.excerpt;
      return {
        ...(title ? { title } : {}),
        ...(excerpt ? { snippet: excerpt, snippetTruncated: preview!.excerpt_truncated } : {}),
      };
    });
  }

  private async titleFor(docid: string, signal?: AbortSignal): Promise<string | undefined> {
    if (this.titles.has(docid)) return this.titles.get(docid);
    const cached = this.documents.get(docid);
    if (cached) {
      this.titles.set(docid, cached.frontmatter.title);
      return cached.frontmatter.title;
    }
    const head = await this.options.documents.readDocument(
      { docid, offset: 1, limit: TITLE_HEAD_LINES },
      signal,
    );
    const title = head.found ? titleFromHead(head.text) : undefined;
    this.titles.set(docid, title);
    return title;
  }

  private async loadDocument(
    docid: string,
    signal?: AbortSignal,
  ): Promise<CachedDocument | undefined> {
    const cached = this.documents.get(docid);
    if (cached) {
      this.documents.delete(docid);
      this.documents.set(docid, cached);
      return cached;
    }
    const result = await this.options.documents.readDocument(
      { docid, offset: 1, limit: FULL_READ_LIMIT },
      signal,
    );
    if (!result.found || result.truncated) return undefined;
    const entry: CachedDocument = { text: result.text, frontmatter: parseFrontmatter(result.text) };
    this.titles.set(docid, entry.frontmatter.title);
    while (
      this.documents.size &&
      (this.documents.size >= this.cacheEntries ||
        this.cachedChars + entry.text.length > this.cacheChars)
    ) {
      const oldest = this.documents.keys().next().value!;
      this.cachedChars -= this.documents.get(oldest)!.text.length;
      this.documents.delete(oldest);
    }
    this.documents.set(docid, entry);
    this.cachedChars += entry.text.length;
    return entry;
  }

  private async readPassageContents(
    unit: PassageUnitRef,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const output = await this.options.passages.request(
      "read_document",
      { docid: passageIdFor(this.prefix, unit), offset: 1, limit: FULL_READ_LIMIT },
      signal,
    );
    const parsed = parseReadDocumentPayload(output);
    if (parsed.found === false) return undefined;
    return parsed.text ?? "";
  }

  private async resolveUnit(
    unit: PassageUnitRef,
    signal?: AbortSignal,
  ): Promise<UnitMapping | undefined> {
    const unitId = unitIdFor(unit.docid, unit.index);
    const known = this.units.get(unitId);
    if (known) return known;
    const inflight = this.pending.get(unitId);
    if (inflight) return inflight;
    const task = this.buildUnit(unit, unitId, signal).finally(() => this.pending.delete(unitId));
    this.pending.set(unitId, task);
    return task;
  }

  private async buildUnit(
    unit: PassageUnitRef,
    unitId: string,
    signal?: AbortSignal,
  ): Promise<UnitMapping | undefined> {
    const contents = await this.readPassageContents(unit, signal);
    if (contents === undefined) return undefined;
    const doc = await this.loadDocument(unit.docid, signal);
    const fallback = (reason: string): UnitMapping => {
      this.options.observe?.({ type: "passage_unit_unaligned", unit: unitId, reason });
      const mapping: UnitMapping = {
        unitId,
        docid: unit.docid,
        index: unit.index,
        title: doc?.frontmatter.title ?? this.titles.get(unit.docid),
        aligned: false,
        text: contents,
        pieces: [],
        docLength: doc?.text.length ?? 0,
        docText: doc?.text ?? "",
      };
      this.units.set(unitId, mapping);
      return mapping;
    };
    if (!doc) return fallback("parent_document_unavailable");
    doc.compact ??= compactText(doc.text);
    const body = stripTitlePrefix(contents, doc.frontmatter.title);
    const view = { text: doc.text, compact: doc.compact };
    let notBefore = 0;
    if (unit.index > 1 && countOccurrences(view, body) > 1) {
      // Ambiguous repeat: anchor on the end of the preceding passage.
      const previous = await this.readPassageContents(
        { docid: unit.docid, index: unit.index - 1 },
        signal,
      );
      const span = previous && alignBody(view, stripTitlePrefix(previous, doc.frontmatter.title));
      if (span) notBefore = span[1];
    }
    const span = alignBody(view, body, notBefore) ?? alignBody(view, body);
    if (!span) return fallback("passage_body_not_found");
    const built = buildUnitText(doc.text, doc.frontmatter, span);
    const mapping: UnitMapping = {
      unitId,
      docid: unit.docid,
      index: unit.index,
      ...(doc.frontmatter.title ? { title: doc.frontmatter.title } : {}),
      aligned: true,
      text: built.text,
      pieces: built.pieces,
      docLength: doc.text.length,
      docText: doc.text,
    };
    this.units.set(unitId, mapping);
    this.options.observe?.({
      type: "passage_unit_aligned",
      unit: unitId,
      span,
      pieces: built.pieces,
      chars: built.text.length,
      exact: doc.text.slice(span[0], span[1]) === body,
    });
    return mapping;
  }
}
