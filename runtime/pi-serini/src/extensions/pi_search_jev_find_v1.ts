import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolvePiSearchExtensionConfigFromEnv } from "../pi-search/config";
import { registerPiSearchExtension } from "../pi-search/extension";
import { dumpPromptSnapshot, getSubmitNowDelayMs, stripBenchmarkIrrelevantSystemPromptSections } from "../pi-search/prompt_policy";
import { PiSearchBackendRuntime } from "../pi-search/searcher/runtime";
import { createRepoPiSearchBackend } from "../search-providers/anserini/pi_search_backend_factory";
import { createFinder } from "./jev_find_v1";

export const FindSchema = Type.Object({
  reason: Type.String({ maxLength: 800, description: "Brief rationale, under 100 words, stating the current information gap." }),
  docids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 4,
    description: "Known docids already shown in search results. The tool loads their source text itself." }),
  queries: Type.Array(Type.String({ minLength: 1, maxLength: 350 }), { minItems: 1, maxItems: 6,
    description: "Batch independent, specific questions about the source, one field or relationship each. Ask for unknown values without guessing them. Every query runs both a Choice location question and a Noul existence question." }),
});

export default function registerFind(pi: ExtensionAPI) {
  const runtime = new PiSearchBackendRuntime(resolvePiSearchExtensionConfigFromEnv(process.env), { createBackend: createRepoPiSearchBackend });
  const finder = createFinder(), seen = new Set<string>(); let deadline = Infinity;
  const facade = new Proxy(pi, {
    get(target, property, receiver) {
      if (property !== "registerTool") return Reflect.get(target, property, receiver);
      return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
        if (tool.name === "search" || tool.name === "read_search_results") return pi.registerTool({ ...tool,
          promptGuidelines: (tool.promptGuidelines ?? []).filter(s => !s.includes("read_document")).concat(
            "After finding plausible docids, use jev_find to locate all currently needed independent facts before reading."),
          async execute(...args) {
            const result = await tool.execute(...args);
            for (const id of (result.details as { previewedDocids?: string[] })?.previewedDocids ?? []) seen.add(String(id));
            return result;
          } });
        if (tool.name === "read_document") return pi.registerTool({ ...tool,
          promptGuidelines: ["Use read_document to read and verify original evidence before answering.",
            "For the first read, normally use jev_find first and read its suggested line ranges. Batch independent ranges in one assistant turn when useful.",
            "Read more surrounding context when needed. Direct reading remains available if location scores are uncertain, unavailable, or incomplete."] });
        return pi.registerTool(tool);
      };
    },
  });
  registerPiSearchExtension(facade, { backendRuntime: runtime });
  pi.registerTool({ name: "jev_find", label: "Jev Choice + Noul Find", parameters: FindSchema,
    description: "Locate evidence within known documents using Jev. Every query asks Choice where the answer is and Noul whether the supplied document contains it, together in one request per document/large region. Returns source line locations and scores, not source passages. Then use read_document on promising locations to verify the evidence.",
    promptSnippet: "Batch 1–4 known docids and 1–6 independent source questions. Choice locates; Noul checks existence. Then read original text with read_document.",
    promptGuidelines: ["Use before first reading of a plausible document. Batch all currently known independent questions, such as publisher, credits, or specific biographical relationships.",
      "A high Choice probability alone cannot establish that an answer exists; also inspect Noul exists. Treat both as navigation hints.",
      "Never answer solely from these scores. Do not invent new entity bindings until reading the original. Avoid repeating a find for a fact already verified."],
    async execute(_id, params, signal, _update, ctx) {
      for (const id of params.docids) if (!seen.has(id)) throw new Error(`docid ${id} has not been shown; browse the search ranking first.`);
      return finder(params, runtime.getBackend(ctx.cwd), signal);
    } });
  pi.on("agent_start", async () => { const delay = getSubmitNowDelayMs(); deadline = delay === null ? Infinity : Date.now() + delay; });
  pi.on("tool_call", async event => {
    if (event.toolName === "jev_find" && Date.now() >= deadline)
      return { block: true, reason: "Time budget is nearly exhausted. Submit your final answer now." };
  });
  pi.on("before_agent_start", async event => {
    const systemPrompt = stripBenchmarkIrrelevantSystemPromptSections(event.systemPrompt) +
      "\nDocument navigation: jev_find is an added tool; search, result browsing and read_document remain available. After search/browse reveals plausible docids, normally call jev_find before the first read. Supply the currently unresolved independent questions together. For each query the tool evaluates Choice (which source location answers it?) and Noul (does this source contain an answer?) in parallel against the source text. Use the returned locations to call read_document; original text is required for verification and for discovering the next entity. Read several independent locations in the same assistant turn when possible. Low Noul is a hint to reconsider this document, not proof of absence; direct read_document is the fallback if scores conflict with clues or the scan failed/is incomplete. Do not repeat an already resolved question. Source lines are 1-indexed. Ignore the task template's default offset=1 guidance when jev_find supplies a more relevant starting range. Stop once the identifying conditions have adequate source evidence.";
    dumpPromptSnapshot(systemPrompt, event.prompt); return { systemPrompt };
  });
}
