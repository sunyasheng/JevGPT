/** Recover explicit Jev input overflows; preserve v6 routing and the configurable GPT handoff.
 * Source capture follows the frozen budget wrapper so scanner maps and later reads share an observer.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { PiSearchBackend } from "../pi-search/searcher/contract/interface";
import { createRoutingReader as frozenReader } from "./jev_context_selection_routing_v1";
import { gptSourceBudget, widenGptEvidence } from "./jev_gpt_return_budget_v1";
import { createBatchFindReader } from "./jev_evidence_pages_reader_v2";
export { gptSourceBudget } from "./jev_gpt_return_budget_v1";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type Options = NonNullable<Parameters<typeof frozenReader>[0]> & {
  gptSourceChars?: number;
  maxSplitDepth?: number;
};
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
  const ownedScan = options.scan
    ? undefined
    : createBatchFindReader({
        ...options,
        env,
        observe,
        maxDocs: 60,
        concurrency: 60,
      });
  const routingOptions = { ...options, observe, scan: options.scan ?? ownedScan! };
  let frozen = frozenReader(routingOptions);
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
    ownedScan?.reset();
    sources.clear();
    locatedVersion.clear();
    frozen = frozenReader(routingOptions);
  };
  return read;
}
