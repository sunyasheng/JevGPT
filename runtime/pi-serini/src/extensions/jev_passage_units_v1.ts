/** Translate evidence located inside passage pseudo-documents back to parent-document coordinates.
 *
 * The frozen Jev reader scans whatever readDocument serves. With the passage backend that is a
 * verbatim pseudo-document (front matter + passage span), so located lines and
 * source_offsets_utf16 are local to the unit. The researcher reads full documents by parent
 * docid, so public output is rewritten: docid becomes the parent docid, every page and omission
 * is re-sliced from the parent text at translated offsets, and lines are parent line numbers.
 * Text is never regenerated: each translated page equals the parent text at its offsets.
 */
import type { EvidenceDoc } from "./jev_adaptive_overlap_v1";
import { originalLineAt, originalLineStarts } from "./read_document_paged_v1";

export type UnitPiece = { local: [number, number]; doc: [number, number] };
export type UnitSource = {
  unitId: string;
  docid: string;
  title?: string;
  aligned: boolean;
  text: string;
  pieces: UnitPiece[];
  docLength: number;
  docText: string;
};
export type ResolveUnit = (unitId: string) => UnitSource | undefined;
type Interval = [number, number];

/** Map a half-open local interval onto parent-document intervals, in order, merged when adjacent. */
export function mapLocalInterval(pieces: UnitPiece[], interval: Interval): Interval[] {
  const [a, b] = interval;
  const out: Interval[] = [];
  for (const piece of pieces) {
    const start = Math.max(a, piece.local[0]),
      end = Math.min(b, piece.local[1]);
    if (end <= start) continue;
    const mapped: Interval = [
      piece.doc[0] + (start - piece.local[0]),
      piece.doc[0] + (end - piece.local[0]),
    ];
    const last = out.at(-1);
    if (last && last[1] === mapped[0]) last[1] = mapped[1];
    else out.push(mapped);
  }
  return out;
}

function localOffsets(
  unit: UnitSource,
  page: { source_offsets_utf16?: unknown; lines?: unknown },
): Interval | undefined {
  const offsets = page.source_offsets_utf16 as number[] | undefined;
  if (
    Array.isArray(offsets) &&
    offsets.length === 2 &&
    offsets.every((n) => Number.isSafeInteger(n))
  )
    return [offsets[0], offsets[1]];
  const lines = page.lines as number[] | undefined;
  if (!Array.isArray(lines) || lines.length !== 2) return undefined;
  const starts = originalLineStarts(unit.text);
  const [first, last] = lines;
  if (first < 1 || last < first || first > starts.length) return undefined;
  const start = starts[first - 1];
  const end = last < starts.length ? Math.max(start, starts[last] - 1) : unit.text.length;
  return [start, end];
}

type Translated = { docText: string; starts: number[] };
function translatePage(
  unit: UnitSource,
  context: Translated,
  page: Record<string, unknown>,
  withText: boolean,
): Record<string, unknown>[] {
  const local = localOffsets(unit, page);
  if (!local) return [{ ...page, translation_error: "no_local_coordinates" }];
  const mapped = mapLocalInterval(unit.pieces, local);
  if (!mapped.length) return [{ ...page, translation_error: "outside_unit_pieces" }];
  if (withText) {
    // The page must be the unit text at its local offsets, and that text must be what the parent holds there.
    const expected = unit.text.slice(local[0], local[1]);
    const actual = mapped.map(([c, d]) => context.docText.slice(c, d)).join("");
    if (expected !== actual || (typeof page.text === "string" && page.text !== expected))
      return [{ ...page, translation_error: "text_mismatch" }];
  }
  return mapped.map(([c, d]) => ({
    ...page,
    lines: [originalLineAt(context.starts, c), originalLineAt(context.starts, Math.max(c, d - 1))],
    source_offsets_utf16: [c, d],
    ...(withText ? { text: context.docText.slice(c, d) } : {}),
  }));
}

/** Rewrite one evidence document from unit coordinates to parent-document coordinates. */
export function translateEvidenceDoc(doc: EvidenceDoc, resolve: ResolveUnit): EvidenceDoc {
  const unit = resolve(doc.docid);
  if (!unit) return doc;
  if (!unit.aligned) {
    return {
      ...doc,
      parent_docid: unit.docid,
      ...(unit.title ? { title: unit.title } : {}),
      passage_unit: unit.unitId,
      coordinates: "passage_unit_only",
    };
  }
  const context: Translated = { docText: unit.docText, starts: originalLineStarts(unit.docText) };
  const passages = doc.passages.flatMap((p) =>
    translatePage(unit, context, p, true),
  ) as EvidenceDoc["passages"];
  const omitted = ((doc.omitted_pages as Record<string, unknown>[] | undefined) ?? []).flatMap(
    (p) => translatePage(unit, context, p, false),
  );
  const hits = ((doc.selected_hits as Record<string, unknown>[] | undefined) ?? []).flatMap((h) =>
    translatePage(unit, context, h, false),
  );
  const {
    omitted_pages: _o,
    omitted_ranges: _r,
    omitted_ranges_offsets_utf16: _f,
    selected_hits: _h,
    ...rest
  } = doc;
  const result: EvidenceDoc = {
    ...rest,
    docid: unit.docid,
    passage_unit: unit.unitId,
    ...(unit.title ? { title: unit.title } : {}),
    passages,
    ...(doc.selected_hits ? { selected_hits: hits } : {}),
    ...(typeof doc.source_length_utf16 === "number" ? { source_length_utf16: unit.docLength } : {}),
  };
  if (omitted.length) {
    result.omitted_pages = omitted;
    result.omitted_ranges = omitted.map((p) => p.lines as number[]);
    result.omitted_ranges_offsets_utf16 = omitted
      .filter((p) => p.source_offsets_utf16)
      .map((p) => p.source_offsets_utf16 as number[]);
  }
  return result;
}

/** Rewrite a complete jev_find public output. Adaptive metadata keeps unit ids; a unit map is added. */
export function translateFindOutput<
  T extends { documents: EvidenceDoc[]; adaptive?: Record<string, unknown> },
>(output: T, resolve: ResolveUnit): T & { passage_units: Record<string, string> } {
  const units: Record<string, string> = {};
  const documents = output.documents.map((doc) => {
    const unit = resolve(doc.docid);
    if (unit) units[unit.unitId] = unit.docid;
    return translateEvidenceDoc(doc, resolve);
  });
  return { ...output, documents, passage_units: units };
}

export function parentDocidsOf(ids: Iterable<string>, resolve: ResolveUnit): string[] {
  const parents = new Set<string>();
  for (const id of ids) {
    const unit = resolve(id);
    if (unit) parents.add(unit.docid);
  }
  return [...parents];
}
