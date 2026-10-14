import { getBenchmarkDefinition } from "../benchmarks/registry";

export type TaskMode = "answer_question" | "rank_documents";

export function taskModeForBenchmark(name = "browsecomp-plus"): TaskMode {
  return getBenchmarkDefinition(name).taskMode ?? "answer_question";
}

export function resolveTaskMode(env: NodeJS.ProcessEnv = process.env): TaskMode {
  const value = env.PI_SEARCH_TASK_MODE;
  if (value !== undefined) {
    if (value !== "answer_question" && value !== "rank_documents") {
      throw new Error("PI_SEARCH_TASK_MODE must be answer_question or rank_documents");
    }
    return value;
  }
  return taskModeForBenchmark(env.PI_BENCHMARK ?? "browsecomp-plus");
}
