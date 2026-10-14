/** Larger GPT handoff only. The frozen v6 reader still owns every Jev request and state update. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { PiSearchBackend } from "../pi-search/searcher/contract/interface";
import type { EvidenceDoc } from "./jev_adaptive_overlap_v1";
import { covered, mergeEvidence } from "./jev_evidence_pages_v1";
import { originalLineAt, originalLineStarts } from "./read_document_paged_v1";
import { createRoutingReader as frozenReader } from "./jev_evidence_pages_routing_v6";

export const DEFAULT_GPT_SOURCE_CHARS = 100000;
export function gptSourceBudget(env: NodeJS.ProcessEnv = process.env) {
  const value = Number(env.JEV_GPT_SOURCE_CHARS ?? DEFAULT_GPT_SOURCE_CHARS);
  assert.ok(
    Number.isSafeInteger(value) && value >= 20000,
    "JEV_GPT_SOURCE_CHARS must be an integer >= 20000",
  );
  return value;
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const chars = (docs: EvidenceDoc[]) =>
  docs.reduce((n, d) => n + d.passages.reduce((v, p) => v + p.text.length, 0), 0);
const omissions = (doc: EvidenceDoc) =>
  (doc.omitted_pages ?? []) as Omit<EvidenceDoc["passages"][number], "text">[];
const spans = (doc: EvidenceDoc) => doc.passages.map((p) => p.source_offsets_utf16 as number[]);
function safeBoundary(text: string, index: number) {
  if (index <= 0 || index >= text.length) return true;
  const a = text.charCodeAt(index - 1),
    b = text.charCodeAt(index);
  return !((a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff) || (a === 13 && b === 10));
}

/** Restore only recorded omitted windows; never read additional documents or select new passages. */
export function widenGptEvidence(
  documents: EvidenceDoc[],
  source: (docid: string) => string | undefined,
  budget = DEFAULT_GPT_SOURCE_CHARS,
) {
  assert.ok(Number.isSafeInteger(budget) && budget >= 20000);
  const before = chars(documents),
    missing = documents.reduce((n, d) => n + omissions(d).length, 0);
  assert.ok(before <= budget, "The larger handoff must retain the original evidence");
  const errors: { docid: string; message: string }[] = [];
  if (!missing || budget === before)
    return {
      documents,
      stats: {
        budget,
        before,
        after: before,
        omitted_before: missing,
        recovered: 0,
        omitted_after: missing,
        errors,
      },
    };
  const extra = documents.map((doc) => {
    const result: EvidenceDoc = { docid: doc.docid, passages: [] };
    if (!omissions(doc).length) return result;
    try {
      const text = source(doc.docid);
      assert.ok(typeof text === "string", "Original source is not in this reader's cache");
      assert.equal(text.length, doc.source_length_utf16, "Original source length changed");
      const starts = originalLineStarts(text);
      for (const page of doc.passages) {
        const [a, b] = page.source_offsets_utf16 as [number, number];
        assert.equal(
          text.slice(a, b),
          page.text,
          "Original source differs from the located source",
        );
      }
      result.passages = omissions(doc).map((page) => {
        const [a, b] = page.source_offsets_utf16 as [number, number];
        assert.ok(
          Number.isSafeInteger(a) && Number.isSafeInteger(b) && a >= 0 && b > a && b <= text.length,
          "Invalid omitted source window",
        );
        assert.ok(
          safeBoundary(text, a) && safeBoundary(text, b),
          "Omitted window splits Unicode or CRLF",
        );
        assert.deepEqual(
          page.lines,
          [originalLineAt(starts, a), originalLineAt(starts, b - 1)],
          "Original line coordinates changed",
        );
        return { ...page, query_ids: page.query_ids as number[], text: text.slice(a, b) };
      });
    } catch (error) {
      result.passages = [];
      errors.push({
        docid: doc.docid,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return result;
  });
  // Reserve every previously delivered page, then spend the extra capacity using the existing hit priorities.
  const added = mergeEvidence(extra, budget - before);
  const combined = documents.map((doc, i) => ({
    ...structuredClone(doc),
    passages: [...doc.passages, ...added[i].passages],
  }));
  const expanded = mergeEvidence(combined, budget);
  const recovered = documents.reduce(
    (n, doc, i) =>
      n +
      omissions(doc).filter((page) =>
        covered(page.source_offsets_utf16 as number[], spans(expanded[i])),
      ).length,
    0,
  );
  return {
    documents: expanded,
    stats: {
      budget,
      before,
      after: chars(expanded),
      omitted_before: missing,
      recovered,
      omitted_after: expanded.reduce((n, d) => n + omissions(d).length, 0),
      errors,
    },
  };
}

type Options = NonNullable<Parameters<typeof frozenReader>[0]> & { gptSourceChars?: number };
export function createRoutingReader(options: Options = {}) {
  const env = options.env ?? process.env,
    budget = options.gptSourceChars ?? gptSourceBudget(env);
  assert.ok(Number.isSafeInteger(budget) && budget >= 20000);
  const emit =
    options.observe ??
    ((row: Record<string, unknown>) => {
      if (env.JEV_FIND_LOG) appendFileSync(env.JEV_FIND_LOG, JSON.stringify(row) + "\n");
    });
  // Keep the already-read immutable source before any of v6's 20k merges. No additional backend reads.
  const sources = new Map<string, Map<string, string>>(),
    locatedVersion = new Map<string, string>();
  const observe: NonNullable<Options["observe"]> = (row) => {
    if (row.type === "overlap_source_map") locatedVersion.set(row.docid, row.source_sha256);
    emit(row);
  };
  let frozen = frozenReader({ ...options, observe });
  const read = async (...args: Parameters<typeof frozen>) => {
    const [input, backend, signal] = args;
    const captured: PiSearchBackend = {
      capabilities: backend.capabilities,
      search: (...params) => backend.search(...params),
      async readDocument(params, abort) {
        const result = await backend.readDocument(params, abort);
        if (result.found && (params.offset ?? 1) === 1) {
          let versions = sources.get(params.docid);
          if (!versions) sources.set(params.docid, (versions = new Map()));
          versions.set(sha(result.text), result.text);
        }
        return result;
      },
    };
    const result = await frozen(input, captured, signal);
    const output = JSON.parse(result.content[0].text);
    const widened = widenGptEvidence(
      output.documents,
      (docid) => {
        const versions = sources.get(docid),
          version = locatedVersion.get(docid);
        return version
          ? versions?.get(version)
          : versions?.size === 1
            ? versions.values().next().value
            : undefined;
      },
      budget,
    );
    const note =
      String(output.note ?? "").replace("20000 total", `${budget} total`) +
      (widened.stats.recovered
        ? " Additional previously omitted original pages are included. Jev's recorded local assessment is unchanged and does not certify every returned excerpt."
        : "") +
      (widened.stats.errors.length
        ? " Some omitted pages could not be restored from the captured source; their positions remain available for read_document."
        : "");
    const publicOutput = { ...output, documents: widened.documents, note };
    emit({
      type: "gpt_return_budget",
      policy: "gpt_return_budget_v1",
      call_id: output.adaptive?.call_id,
      ...widened.stats,
      output: publicOutput,
    });
    return {
      ...result,
      content: [{ type: "text" as const, text: JSON.stringify(publicOutput) }],
      details: { ...result.details, gptReturnBudget: widened.stats },
    };
  };
  read.reset = () => {
    frozen.reset();
    sources.clear();
    locatedVersion.clear();
    frozen = frozenReader({ ...options, observe });
  };
  return read;
}
