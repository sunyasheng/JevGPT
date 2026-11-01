import type { BenchmarkDefinition } from "./types";

export const cmassBenchmark: BenchmarkDefinition = {
  id: "cmass", aliases: ["climbmix-agentic-search-suite"],
  displayName: "CMASS v2026.10.25", datasetId: "castorini/cmass@b45390693461d948d47fdd835f27b46026b5e2a2",
  taskMode: "answer_question", piSearchPromptVariant: "plain_minimal",
  defaultQuerySetId: "all", defaultQueryPath: "data/cmass/inputs/questions.jsonl",
  querySets: { all: "data/cmass/inputs/questions.jsonl" },
  defaultQrelsPath: "data/cmass/inputs/evaluator-only/qrels.jsonl",
  defaultIndexPath: "climbmix-400b", managedPresets: {}, setup: { steps: {} },
  retrievalEvaluation: { runFileBackend: "internal", runDirBackend: "internal" },
};
