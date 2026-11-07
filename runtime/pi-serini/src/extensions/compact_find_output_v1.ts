/** GPT-facing projection only. The reader, cache and audit retain the full object. */
type ObjectValue = Record<string, unknown>;
export type FindTargets = {
  requestedDocids: readonly string[];
  attemptedDocids: readonly string[];
};

export const COMPACT_FIND_NOTE =
  "Excerpts are verbatim source in parent-document coordinates; query_ids mark association, not verification. source_offsets_utf16 are half-open and may cover part of a line; read_document(parent docid, start_index) reads missing context. Documents without excerpts, omissions and failures do not prove absence. The assessment covers only this call's questions and ranking; an unresolved local question or no_progress does not by itself require another search.";

const anomalies = ["error", "scan_incomplete", "deferred_queries", "omitted_pages",
  "omitted_ranges", "omitted_ranges_offsets_utf16", "translation_error"];
const documentFields = ["docid", "title", ...anomalies, "parent_docid", "passage_unit", "coordinates"];
const passageFields = ["text", "lines", "source_offsets_utf16", "query_ids", "translation_error"];
const adaptiveFields = ["call_id", "scanned", "available", "stop_reason", "complete",
  "assessment_status", "unresolved_queries", "suggested_action", "context_reads", "reused_from",
  "unassessed_queries", "assessment_error", "last_successful_assessment", "context_selection",
  "unassessed_context_pages"];
const object = (x: unknown): ObjectValue => x && typeof x === "object" && !Array.isArray(x)
  ? x as ObjectValue : {};
const objects = (x: unknown): ObjectValue[] => Array.isArray(x) ? x.map(object) : [];
function pick(x: ObjectValue, keys: readonly string[]): ObjectValue {
  return Object.fromEntries(keys.filter(k => Object.hasOwn(x, k)).map(k => [k, x[k]]));
}
function span(x: ObjectValue): [number, number] | undefined {
  const value = x.source_offsets_utf16;
  return Array.isArray(value) && value.length === 2 && value.every(Number.isSafeInteger)
    && value[0] >= 0 && value[1] >= value[0] ? value as [number, number] : undefined;
}
function covered(hit: ObjectValue, passages: ObjectValue[], doc: ObjectValue): boolean {
  if (Object.hasOwn(hit, "translation_error") || Object.hasOwn(doc, "translation_error")) return false;
  const h = span(hit);
  return !!h && passages.some(p => {
    if (Object.hasOwn(p, "translation_error")) return false;
    const s = span(p);
    return !!s && s[0] <= h[0] && h[1] <= s[1];
  });
}
/** Preserve assessment scope; remove only prior_ids entries that are internal 64-hex hashes. */
function withoutPriorHashes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPriorHashes);
  if (!value || typeof value !== "object") return value;
  const result: ObjectValue = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "prior_ids" && Array.isArray(item)) {
      const ids = item.filter(id => !(typeof id === "string" && /^[0-9a-f]{64}$/i.test(id)));
      if (ids.length) result[key] = ids;
    } else result[key] = withoutPriorHashes(item);
  }
  return result;
}

/** Targets provide execution metadata for explicit calls; neither argument is modified. */
export function compactFindOutput(output: ObjectValue, targets?: FindTargets): ObjectValue {
  const originalDocs = objects(output.documents);
  const documents = originalDocs.flatMap(doc => {
    const passages = objects(doc.passages);
    const hits = objects(doc.selected_hits).filter(h => !covered(h, passages, doc));
    if (!passages.length && !hits.length && !anomalies.some(k => Object.hasOwn(doc, k))) return [];
    return [{ ...pick(doc, documentFields), passages: passages.map(p => ({
      ...pick(p, passageFields), ...(p.context_read === true ? { context_read: true } : {}),
    })), ...(hits.length ? { selected_hits: hits } : {}) }];
  });
  const fullAdaptive = object(output.adaptive);
  const adaptive = pick(fullAdaptive, adaptiveFields);
  if (Object.hasOwn(adaptive, "last_successful_assessment"))
    adaptive.last_successful_assessment = withoutPriorHashes(adaptive.last_successful_assessment);
  adaptive.unscanned_count = Array.isArray(fullAdaptive.unscanned_docids) ? fullAdaptive.unscanned_docids.length : 0;
  if (targets) {
    const attempted = new Set(targets.attemptedDocids);
    const unitMap = object(output.passage_units);
    adaptive.attempted_without_excerpts = [...new Set(targets.requestedDocids)].filter(id =>
      attempted.has(id) && !originalDocs.some(d =>
        (d.docid === id || d.passage_unit === id || d.docid === unitMap[id]) && objects(d.passages).length > 0));
  }
  let note = COMPACT_FIND_NOTE;
  if (fullAdaptive.stop_reason === "no_progress") note += " This ranking stopped adding located evidence.";
  if (fullAdaptive.assessment_status === "unavailable")
    note += " No judgment of the latest evidence is available; this is not a finding of insufficient evidence.";
  return { documents, note, adaptive,
    ...(Object.hasOwn(output, "ranking") ? { ranking: output.ranking } : {}),
    ...(Object.keys(object(output.passage_units)).length ? { passage_units: output.passage_units } : {}),
    ...(Object.hasOwn(output, "auto_scan_notices") ? { auto_scan_notices: output.auto_scan_notices } : {}),
  };
}
