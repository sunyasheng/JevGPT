/** NeuCLIR runner for the unified entry: run_neuclirbench_jev_medium_v1.ts with a configurable query set id and extension. */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { prepareIsolatedAgentDir } from "../src/runtime/pi_agent_dir";
import { startPiJsonProcess } from "../src/runtime/pi_process";
import { formatPiSearchPrompt } from "../src/pi-search/agent_prompt";
import { getBenchmarkDefinition } from "../src/benchmarks/registry";
import { normalizeNeuclirTopic, neuclirTopicMode } from "../src/benchmarks/neuclir_topic";

export function buildPrompt(query: string, benchmarkName: string): string {
  const benchmark = getBenchmarkDefinition(benchmarkName);
  return formatPiSearchPrompt(query, benchmark.piSearchPromptVariant);
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    if (i < 0 || !args[i + 1]) throw new Error(`Missing ${flag}`);
    return args[i + 1];
  };
  const output = resolve(value("--output"));
  const benchmark = getBenchmarkDefinition(value("--benchmark"));
  const input = JSON.parse(readFileSync(value("--topic"), "utf8"));
  const topic =
    benchmark.id === "neuclir24-mlir"
      ? normalizeNeuclirTopic(
          input,
          neuclirTopicMode(
            args.includes("--topic-mode") ? value("--topic-mode") : "title_description",
          ),
        )
      : (input as { query_id: string; query: string; topic_fields?: string[] });
  const extension = resolve(
    args.includes("--extension") ? value("--extension") : "src/extensions/pi_search_jev_unified_v1.ts",
  );
  const model = args.includes("--model") ? value("--model") : "openai/gpt-5.5";
  const timeoutSeconds = Number(value("--timeout-seconds"));
  const qid = String(topic.query_id);
  if (existsSync(resolve(output, `${qid}.json`))) throw new Error("Never overwrite a trial");
  mkdirSync(resolve(output, "raw-events"), { recursive: true });
  mkdirSync(resolve(output, "stderr"), { recursive: true });
  const rawPath = resolve(output, "raw-events", `${qid}.jsonl`);
  const stderrPath = resolve(output, "stderr", `${qid}.log`);
  writeFileSync(rawPath, "", { flag: "wx" });
  writeFileSync(stderrPath, "", { flag: "wx" });
  const agentDir = prepareIsolatedAgentDir(output);
  const started = performance.now();
  const events: any[] = [];
  let timedOut = false;
  let parseErrors = 0;
  let killed: ReturnType<typeof setTimeout> | undefined;
  const child = startPiJsonProcess({
    piBinary: resolve("node_modules/.bin/pi"),
    extensionPath: extension,
    model,
    thinking: "medium",
    prompt: buildPrompt(topic.query, benchmark.id),
    isolatedAgentDir: agentDir,
    extraEnv: {
      PI_BENCHMARK: benchmark.id,
      PI_SEARCH_TASK_MODE: benchmark.taskMode ?? "answer_question",
      TIMEOUT_SECONDS: String(timeoutSeconds),
      OUTPUT_DIR: output,
      PI_SEARCH_DUMP_PROMPTS: "1",
      PI_NEUCLIR_TRANSPORT_AUDIT: resolve(output, "transport-settings.jsonl"),
      NODE_OPTIONS: [process.env.NODE_OPTIONS ?? "", `--import=${resolve("../../scripts/transport_audit.mjs")}`].filter(Boolean).join(" "),
    },
  });
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    appendFileSync(rawPath, line + "\n");
    try {
      events.push(JSON.parse(line));
    } catch {
      parseErrors++;
    }
  });
  child.stderr!.on("data", (data) => appendFileSync(stderrPath, data));
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    killed = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5000);
  }, timeoutSeconds * 1000);
  let exitCode: number | null = null;
  try {
    exitCode = await new Promise<number | null>((res, rej) => {
      child.once("error", rej);
      child.once("close", res);
    });
  } finally {
    clearTimeout(timer);
    if (killed) clearTimeout(killed);
    lines.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
  const messages = events.filter(
    (e) => e.type === "message_end" && e.message?.role === "assistant",
  );
  const starts = events.filter((e) => e.type === "tool_execution_start");
  const ends = events.filter((e) => e.type === "tool_execution_end");
  const text = (content: any[]) =>
    (content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  const final =
    messages
      .map((e) => text(e.message.content))
      .filter(Boolean)
      .at(-1) ?? "";
  const succeeded =
    exitCode === 0 &&
    !parseErrors &&
    final &&
    events.some((e) => e.type === "agent_end") &&
    !messages.some((e) => e.message.errorMessage);
  const status = timedOut ? "timeout" : succeeded ? "completed" : "failed";
  const counts: Record<string, number> = {};
  for (const e of starts) counts[e.toolName] = (counts[e.toolName] ?? 0) + 1;
  const byId = new Map(starts.map((e) => [e.toolCallId, e]));
  const result = ends.map((e) => ({
    type: "tool_call",
    tool_name: e.toolName,
    arguments: byId.get(e.toolCallId)?.args ?? null,
    output: text(e.result?.content),
  }));
  if (final)
    result.push({ type: "output_text", tool_name: null, arguments: null, output: final } as any);
  const record = {
    metadata: {
      benchmark_id: "neuclirbench-mono-eng",
      task_registry_id: benchmark.id,
      task_mode: benchmark.taskMode ?? "answer_question",
      query_set_id: args.includes("--query-set-id") ? value("--query-set-id") : "unspecified",
      thinking: "medium",
      query: topic.query,
      topic_fields: topic.topic_fields,
      model,
      output_dir: output,
      prompt_variant: benchmark.piSearchPromptVariant,
      extension,
    },
    query_id: qid,
    status,
    tool_call_counts: counts,
    stats: {
      elapsed_seconds: (performance.now() - started) / 1000,
      assistant_turns: messages.length,
      tool_calls_total: starts.length,
      timed_out: timedOut,
      parse_errors: parseErrors,
      exit_code: exitCode,
    },
    result,
  };
  writeFileSync(resolve(output, `${qid}.json`), JSON.stringify(record, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(JSON.stringify({ qid, status, stats: record.stats }));
}

if (process.argv[1]?.endsWith("run_neuclir_unified_medium_v1.ts")) await main();
