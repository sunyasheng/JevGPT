/** Isolated long-line repair. Normal documents use the frozen reader unchanged.
 * Jev sees numbered source chunks; GPT receives exact original source slices.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { PiSearchBackend } from "../pi-search/searcher/contract/interface";
import type { SearchBackendReadDocumentResponse } from "../pi-search/searcher/contract/types";
import { FIND_LIMITS, type FindParams } from "./jev_find_v1";
import { createBatchFindReader as createLegacyReader } from "./jev_find_read_batch_budget_v2";

// 40 fallback chunks fit within 16k source characters. Existing +/-4/8
// context expansion and 20k return budget remain unchanged.
export const LONG_LINE_CHUNK_BYTES = 400;
export type SourceSegment = { start_utf16: number; end_utf16: number; source_line: number };
export type ChunkView = { text: string; original: string; segments: SourceSegment[]; splitLines: number[] };
type SplitResult = { chunks: { text: string; start_utf16: number; end_utf16: number }[] };
type Split = (text: string) => Promise<SplitResult>;
type Observe = (record: Record<string, unknown>) => void;
type Options = { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; observe?: Observe; maxDocs?: number; concurrency?: number };

export class SplitWorker {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, { child: ChildProcessWithoutNullStreams; resolve: (r: SplitResult) => void; reject: (e: Error) => void }>();
  constructor(private env: NodeJS.ProcessEnv) {}
  async split(text: string): Promise<SplitResult> {
    if (!this.child) {
      const python = this.env.JEV_SPLITTER_PYTHON, script = this.env.JEV_SPLITTER_SCRIPT;
      assert.ok(python && script, "Configure the pinned text-splitter Python and adapter paths");
      const child = spawn(python, [script], { stdio: ["pipe", "pipe", "pipe"], env: this.env });
      this.child = child;
      let errorText = "";
      child.stderr.on("data", b => { errorText = (errorText + String(b)).slice(-2000); });
      const fail = (e: Error) => {
        for (const [id, p] of this.pending) if (p.child === child) { p.reject(e); this.pending.delete(id); }
      };
      child.on("error", fail);
      child.on("exit", code => {
        if (this.child === child) this.child = undefined;
        if (this.pending.size) fail(new Error(`text-splitter exited ${code}: ${errorText}`));
      });
      createInterface({ input: child.stdout }).on("line", line => {
        try {
          const row = JSON.parse(line), p = this.pending.get(row.id);
          if (!p) return;
          this.pending.delete(row.id);
          if (row.ok) p.resolve(row); else p.reject(new Error(row.error));
        } catch (e) { fail(e instanceof Error ? e : new Error(String(e))); }
      });
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { child: this.child!, resolve, reject });
      this.child!.stdin.write(JSON.stringify({ id, text, max_utf8_bytes: LONG_LINE_CHUNK_BYTES }) + "\n");
    });
  }
  close() { const child = this.child; this.child = undefined; child?.stdin.end(); }
}

export async function makeChunkView(original: string, split: Split): Promise<ChunkView | undefined> {
  const lines = original.split(/\r?\n/);
  const splitLines = lines.flatMap((s, i) => Buffer.byteLength(s, "utf8") + 1 > FIND_LIMITS.sourceBytesPerRegion ? [i + 1] : []);
  if (!splitLines.length) return undefined;
  const oversized = new Set(splitLines), segments: SourceSegment[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (oversized.has(i + 1)) {
      const result = await split(line);
      let cursor = 0;
      for (const part of result.chunks) {
        assert.equal(part.start_utf16, cursor);
        assert.equal(line.slice(part.start_utf16, part.end_utf16), part.text);
        assert.ok(part.text.length && Buffer.byteLength(part.text, "utf8") <= LONG_LINE_CHUNK_BYTES);
        segments.push({ start_utf16: offset + part.start_utf16, end_utf16: offset + part.end_utf16, source_line: i + 1 });
        cursor = part.end_utf16;
      }
      assert.equal(cursor, line.length, "Incomplete splitter source coverage");
    } else segments.push({ start_utf16: offset, end_utf16: offset + line.length, source_line: i + 1 });
    offset += line.length;
    if (i < lines.length - 1) offset += original.startsWith("\r\n", offset) ? 2 : 1;
  }
  assert.equal(offset, original.length);
  return { original, splitLines, segments,
    text: segments.map(s => original.slice(s.start_utf16, s.end_utf16)).join("\n") };
}

export function mapChunkRange(view: ChunkView, start: number, end: number) {
  assert.ok(Number.isInteger(start) && start >= 1 && end >= start && end <= view.segments.length);
  const first = view.segments[start - 1], last = view.segments[end - 1];
  return { lines: [first.source_line, last.source_line] as [number, number],
    source_offsets_utf16: [first.start_utf16, last.end_utf16] as [number, number],
    text: view.original.slice(first.start_utf16, last.end_utf16) };
}

export function createBatchFindReader(options: Options = {}) {
  const env = options.env ?? process.env;
  const observe: Observe = options.observe ?? (record => {
    if (env.JEV_FIND_LOG) appendFileSync(env.JEV_FIND_LOG, JSON.stringify(record) + "\n");
  });
  const worker = new SplitWorker(env), views = new Map<string, ChunkView>();
  const originals = new Map<string, Extract<SearchBackendReadDocumentResponse, { found: true }>>();
  const readRecords = new Map<number, Record<string, unknown>>();
  let active = 0;
  const legacy = createLegacyReader({ ...options, env, observe(record) {
    if (record.type === "find_read") { readRecords.set(Number(record.batch), record); return; }
    observe(record);
  } });
  return async (params: FindParams, backend: PiSearchBackend, signal?: AbortSignal) => {
    active++;
    const facade: PiSearchBackend = {
      capabilities: backend.capabilities, search: backend.search.bind(backend),
      async readDocument(request, readSignal): Promise<SearchBackendReadDocumentResponse> {
        const full = (request.offset ?? 1) === 1 && request.limit === FIND_LIMITS.readLines;
        let view = views.get(request.docid);
        if (!view) {
          const result = await backend.readDocument(request, readSignal);
          if (!full || !result.found) return result;
          view = await makeChunkView(result.text, text => worker.split(text));
          if (!view) return result;
          assert.ok(!result.truncated, "Do not repair an incomplete source silently");
          views.set(request.docid, view);
          originals.set(request.docid, result);
          observe({ type: "source_chunk_map", docid: request.docid,
            source_sha256: createHash("sha256").update(view.original).digest("hex"),
            source_chars_utf16: view.original.length, split_lines: view.splitLines,
            chunk_bytes: LONG_LINE_CHUNK_BYTES, segments: view.segments,
            coordinate_space: "internal line IDs index source segments; public spans use original UTF-16 offsets" });
          return { ...result, text: view.text, totalUnits: view.segments.length,
            returnedOffsetStart: 1, returnedOffsetEnd: view.segments.length };
        }
        // The finder gets the numbered chunk view. Its subsequent automatic
        // reads get exact original slices, without the inserted chunk newlines.
        const start = request.offset ?? 1, end = Math.min(view.segments.length, start + (request.limit ?? 40) - 1);
        const slice = full ? { text: view.text } : mapChunkRange(view, start, end);
        return { ...originals.get(request.docid)!, text: slice.text, offset: start,
          limit: request.limit ?? 40, totalUnits: view.segments.length,
          returnedOffsetStart: start, returnedOffsetEnd: end,
          truncated: end < view.segments.length };
      },
    };
    let batch: number | undefined;
    try {
      const result = await legacy(params, facade, signal);
      batch = result.details.jevFindRead.batch;
      const record = readRecords.get(batch); assert.ok(record);
      const output = JSON.parse(result.content[0].text);
      let mapped = false;
      for (const doc of output.documents) {
        const view = views.get(doc.docid); if (!view) continue;
        mapped = true;
        for (const passage of doc.passages) {
          const span = mapChunkRange(view, passage.lines[0], passage.lines[1]);
          assert.equal(passage.text, span.text);
          Object.assign(passage, { lines: span.lines, source_offsets_utf16: span.source_offsets_utf16 });
        }
        for (const key of ["omitted_ranges", "read_errors"]) if (doc[key]) {
          const ranges = doc[key].map(([a, b]: [number, number]) => mapChunkRange(view, a, b));
          doc[`${key}_offsets_utf16`] = ranges.map((r: ReturnType<typeof mapChunkRange>) => r.source_offsets_utf16);
          doc[key] = ranges.map((r: ReturnType<typeof mapChunkRange>) => r.lines);
        }
      }
      if (mapped) output.note += " Long source lines were divided into chunks. Public lines refer to original lines; source_offsets_utf16 are exact half-open character ranges in the original document. Text is verbatim; a partial line is not the entire original line.";
      observe({ ...record, output, source_chunk_policy: "oversized_lines_only_400_bytes_v1" });
      return { ...result, content: [{ type: "text" as const, text: JSON.stringify(output) }] };
    } finally {
      if (batch !== undefined) readRecords.delete(batch);
      active--;
      if (!active) worker.close();
    }
  };
}
