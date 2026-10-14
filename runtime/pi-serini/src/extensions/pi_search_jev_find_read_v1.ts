import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePiSearchExtensionConfigFromEnv } from "../pi-search/config";
import { registerPiSearchExtension } from "../pi-search/extension";
import { dumpPromptSnapshot, getSubmitNowDelayMs, stripBenchmarkIrrelevantSystemPromptSections } from "../pi-search/prompt_policy";
import { PiSearchBackendRuntime } from "../pi-search/searcher/runtime";
import { createRepoPiSearchBackend } from "../search-providers/anserini/pi_search_backend_factory";
import { FindSchema } from "./pi_search_jev_find_v1";
import { createFindReader } from "./jev_find_read_v1";

export function updateFusedWorkflow(text: string) {
  return text.replace("4. If a promising candidate document appears in the ranking, inspect it with read_document.",
    "4. If promising candidate documents appear, call jev_find with their docids and all currently unresolved independent questions. It runs Choice location and Noul existence judgments together and immediately reads the selected source ranges.")
    .replace("5. When reading a document, start with offset=1 and a moderate limit. If it is truncated and still relevant, continue reading the same document.",
    "5. Use the original source excerpts returned by jev_find to verify facts and discover the next entity. No separate read is required for supplied excerpts. Use read_document to fill gaps, check surrounding context, or recover from an incomplete scan.");
}

export default function registerFindRead(pi: ExtensionAPI) {
  const runtime = new PiSearchBackendRuntime(resolvePiSearchExtensionConfigFromEnv(process.env), { createBackend: createRepoPiSearchBackend });
  const finder = createFindReader(), seen = new Set<string>(), attempted = new Set<string>(); let deadline = Infinity;
  const facade = new Proxy(pi, {
    get(target, property, receiver) {
      if (property !== "registerTool") return Reflect.get(target, property, receiver);
      return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
        if (tool.name === "search" || tool.name === "read_search_results") return pi.registerTool({ ...tool,
          promptGuidelines: (tool.promptGuidelines ?? []).filter(s => !s.includes("read_document")).concat(
            "After finding plausible docids, use jev_find to locate and read all currently needed independent facts together."),
          async execute(...args) {
            const result = await tool.execute(...args);
            for (const id of (result.details as { previewedDocids?: string[] })?.previewedDocids ?? []) seen.add(String(id));
            return result;
          } });
        if (tool.name === "read_document") return pi.registerTool({ ...tool,
          promptGuidelines: ["Use read_document to supplement source excerpts already supplied by jev_find, read surrounding context, or recover after failed/incomplete finding.",
            "Use jev_find first for each new docid. Avoid rereading evidence already supplied; batch independent supplemental reads when useful."],
          async execute(...args) {
            if (!attempted.has((args[1] as { docid: string }).docid)) throw new Error("First use jev_find for this docid. It returns original source; then read_document may supply missing context.");
            return tool.execute(...args);
          } });
        return pi.registerTool(tool);
      };
    },
  });
  registerPiSearchExtension(facade, { backendRuntime: runtime });
  pi.registerTool({ name: "jev_find", label: "Jev Find and Read", parameters: FindSchema,
    description: "Locate AND READ evidence within known documents in one call. For every query Jev runs Choice location and Noul existence together; the tool merges promising ranges and fetches original text. Returns source excerpts with docids and line ranges, not location distributions. Use this evidence directly; read_document remains available for missing context.",
    promptSnippet: "Batch 1–4 known docids and 1–6 independent source questions; receive original evidence selected by Choice+Noul immediately.",
    promptGuidelines: ["First use jev_find for plausible documents; batch currently unresolved fields together. The returned text is original source, so no separate read is required for those excerpts.",
      "Verify requested relationships from the text. A query association is a navigation hint, not proof. Missing or omitted excerpts do not establish absence; read directly for context when needed.",
      "Do not invent entity bindings before reading their evidence. Continue multi-hop research after the current evidence establishes the next entity."],
    async execute(_id, params, signal, _update, ctx) {
      for (const id of params.docids) if (!seen.has(id)) throw new Error(`docid ${id} has not been shown; browse the search ranking first.`);
      const result = await finder(params, runtime.getBackend(ctx.cwd), signal);
      for (const id of params.docids) attempted.add(id);
      return result;
    } });
  pi.on("session_start", async () => {
    if (process.env.JEV_FIND_LOG) appendFileSync(process.env.JEV_FIND_LOG, JSON.stringify({ type: "navigation_start", active_tools: pi.getActiveTools() }) + "\n");
  });
  pi.on("input", async event => {
    const text = updateFusedWorkflow(event.text); if (text !== event.text) return { action: "transform" as const, text };
  });
  pi.on("agent_start", async () => { const delay = getSubmitNowDelayMs(); deadline = delay === null ? Infinity : Date.now() + delay; });
  pi.on("tool_call", async event => {
    if (event.toolName === "jev_find" && Date.now() >= deadline) return { block: true, reason: "Time budget is nearly exhausted. Submit your final answer now." };
  });
  pi.on("before_agent_start", async event => {
    const systemPrompt = stripBenchmarkIrrelevantSystemPromptSections(event.systemPrompt) +
      "\nDocument navigation: first call jev_find with known candidate docids and all currently unresolved independent questions. It evaluates Choice (source location) and Noul (answer existence) in parallel, merges selected ranges, and returns original source passages immediately. Location distributions and confidence tables stay inside the tool. Use the returned source to verify facts and discover the next entity. Both jev_find and read_document are always available: a prior find attempt is required per docid, and read_document is the fallback for missing or omitted evidence, incomplete scans, and necessary context. Do not reread already supplied excerpts without a reason. Batch independent supplemental reads. Missing results are not proof of absence. Stop when the identifying conditions have adequate source evidence.";
    dumpPromptSnapshot(systemPrompt, event.prompt); return { systemPrompt };
  });
}
