import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePiSearchExtensionConfigFromEnv, type PiSearchExtensionConfig } from "./config";
import {
  BENCHMARK_TIMEOUT_SECONDS,
  dumpPromptSnapshot,
  getSubmitNowDelayMs,
  stripBenchmarkIrrelevantSystemPromptSections,
  SUBMIT_NOW_STEER_MESSAGE,
  SUBMIT_NOW_TRIGGER_RATIO,
} from "./prompt_policy";
import {
  PlainSearchParamsSchema,
  ReadDocumentParamsSchema,
  ReadSearchResultsParamsSchema,
} from "./protocol/schemas";
import { SearchSessionStore } from "./search_cache";
import {
  PiSearchBackendRuntime,
  type PiSearchBackendFactory,
  type PiSearchBackendRuntimeOptions,
} from "./searcher/runtime";
import { ManagedTempSpillDir } from "./spill";
import {
  executeReadDocumentTool,
  executeReadSearchResultsTool,
  executeSearchTool,
} from "./tool_handlers";

export type PiSearchExtensionOptions = {
  executeSearch?: typeof executeSearchTool;
  resolveConfig?: (env: NodeJS.ProcessEnv) => PiSearchExtensionConfig;
  backendRuntime?: PiSearchBackendRuntime;
  createBackend?: PiSearchBackendFactory;
  buildCacheKey?: PiSearchBackendRuntimeOptions["buildCacheKey"];
  spillDirPrefix?: string;
};

export function registerPiSearchExtension(
  pi: ExtensionAPI,
  options: PiSearchExtensionOptions = {},
): void {
  const extensionConfig =
    options.resolveConfig?.(process.env) ?? resolvePiSearchExtensionConfigFromEnv(process.env);
  const searchStore = new SearchSessionStore();
  const backendRuntime =
    options.backendRuntime ??
    new PiSearchBackendRuntime(extensionConfig, {
      buildCacheKey: options.buildCacheKey,
      createBackend: options.createBackend,
    });
  const spillDir = new ManagedTempSpillDir(options.spillDirPrefix ?? "pi-search-extension-");
  const submitNowDelayMs = getSubmitNowDelayMs();
  let spillSequence = 0;
  let submitNowTimer: ReturnType<typeof setTimeout> | null = null;
  let submitNowMode = false;
  let promptSnapshotWritten = false;
  let spillCleanupRegistered = false;

  const cleanupSpillDir = () => {
    backendRuntime.dispose();
    spillDir.cleanup();
  };

  const registerSpillCleanup = () => {
    if (spillCleanupRegistered) return;
    spillCleanupRegistered = true;
    process.once("exit", cleanupSpillDir);
    process.once("SIGINT", cleanupSpillDir);
    process.once("SIGTERM", cleanupSpillDir);
  };

  const nextSpillSequence = (): number => {
    spillSequence += 1;
    return spillSequence;
  };

  const toolDeps = {
    backendRuntime,
    searchStore,
    spillDir,
    nextSpillSequence,
  };

  registerSpillCleanup();

  function clearSubmitNowTimer() {
    if (submitNowTimer !== null) {
      clearTimeout(submitNowTimer);
      submitNowTimer = null;
    }
  }

  pi.on("before_agent_start", async (event) => {
    const strippedSystemPrompt = stripBenchmarkIrrelevantSystemPromptSections(event.systemPrompt);
    if (!promptSnapshotWritten) {
      dumpPromptSnapshot(strippedSystemPrompt, event.prompt);
      promptSnapshotWritten = true;
    }
    if (strippedSystemPrompt === event.systemPrompt) {
      return;
    }
    return { systemPrompt: strippedSystemPrompt };
  });

  pi.on("agent_start", async (_event, ctx) => {
    clearSubmitNowTimer();
    submitNowMode = false;
    if (submitNowDelayMs === null) {
      return;
    }
    submitNowTimer = setTimeout(() => {
      if (submitNowMode || ctx.isIdle()) {
        return;
      }
      submitNowMode = true;
      try {
        console.error(
          `[pi-search] Time budget threshold reached at ${(submitNowDelayMs / 1000).toFixed(1)}s (${Math.round(SUBMIT_NOW_TRIGGER_RATIO * 100)}% of TIMEOUT_SECONDS=${BENCHMARK_TIMEOUT_SECONDS}); queueing submit-now steer and blocking further retrieval tools.`,
        );
        pi.sendUserMessage(SUBMIT_NOW_STEER_MESSAGE, { deliverAs: "steer" });
      } catch (error) {
        console.error(
          `[pi-search] Failed to queue submit-now steer: ${error instanceof Error ? error.message : String(error)}`,
        );
        submitNowMode = false;
      }
    }, submitNowDelayMs);
  });

  pi.on("tool_call", async (event) => {
    if (!submitNowMode) {
      return;
    }
    if (
      event.toolName === "search" ||
      event.toolName === "read_search_results" ||
      event.toolName === "read_document"
    ) {
      console.error(
        `[pi-search] Blocking ${event.toolName} after timeout steer; model must submit final answer now.`,
      );
      return {
        block: true,
        reason:
          "Time budget is nearly exhausted. Do not use more retrieval tools; submit your final answer right now.",
      };
    }
  });

  pi.on("agent_end", async () => {
    clearSubmitNowTimer();
    submitNowMode = false;
  });

  pi.on("session_shutdown", async () => {
    clearSubmitNowTimer();
    submitNowMode = false;
    cleanupSpillDir();
  });

  pi.registerTool({
    name: "search",
    label: "Search",
    description:
      "Search the configured pi-search backend using a raw query string. The first argument must be reason, a brief rationale of at most 100 words.",
    promptSnippet:
      "Always supply reason first, under 100 words. Use query for a concise raw search string based on the original wording or one grounded refinement. The tool returns a search_id plus the first page of results.",
    promptGuidelines: [
      "Always provide reason first. Keep it specific and under 100 words.",
      "Use query as a short raw lexical query string, not a structured object and not raw Lucene syntax.",
      "Start close to the original wording, then make grounded refinements only after browsing or reading.",
      "If the current ranking looks partially relevant, browse it before rewriting.",
      "After browsing a ranking that surfaces plausible candidates, inspect one with read_document(docid).",
    ],
    parameters: PlainSearchParamsSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return (options.executeSearch ?? executeSearchTool)(params, signal, ctx, toolDeps);
    },
  });

  pi.registerTool({
    name: "read_search_results",
    label: "Read Search Results",
    description:
      "Read a cached search result set by search_id. Supports offset and limit for paginated browsing of ranked hits, similar to the built-in read tool. The first argument must be reason, a brief rationale of at most 100 words.",
    promptSnippet:
      "Always supply reason first, with a brief rationale of at most 100 words. Then read a cached search result set by search_id in paginated ranked-hit chunks using offset and limit.",
    promptGuidelines: [
      "Always provide reason as the first argument. Keep it specific and under 100 words.",
      "Use read_search_results to browse deeper ranks from an existing search result set before rewriting the query.",
      "If the current ranking looks partly relevant, inspect more ranks here rather than issuing another search immediately.",
      "When browse surfaces plausible candidate biographies, open one with read_document(docid).",
    ],
    parameters: ReadSearchResultsParamsSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeReadSearchResultsTool(params, signal, ctx, toolDeps);
    },
  });

  pi.registerTool({
    name: "read_document",
    label: "Read Document",
    description:
      "Read a retrieved document by docid. Supports offset and limit for paginated line-based reading, similar to the built-in read tool. The first argument must be reason, a brief rationale of at most 100 words.",
    promptSnippet:
      "Always supply reason first, with a brief rationale of at most 100 words. Then read a retrieved document by docid in paginated line-based chunks using offset and limit.",
    promptGuidelines: [
      "Always provide reason as the first argument. Keep it specific and under 100 words.",
      "Use read_document to verify evidence from a specific docid before answering.",
      "Start with offset=1 and a moderate limit when first reading a document.",
      "If a document is truncated and still looks relevant, continue reading the same document with the suggested next offset before launching many new searches.",
    ],
    parameters: ReadDocumentParamsSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeReadDocumentTool(params, signal, ctx, toolDeps);
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerPiSearchExtension(pi);
}
