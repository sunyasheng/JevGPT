import type { BenchmarkDefinition } from "./types";

export const neuclirBenchmark: BenchmarkDefinition = {
  id: "neuclir24-mlir",
  aliases: ["neuclir", "neuclir24", "neuclir24-mlir-g3"],
  displayName: "NeuCLIR 2024 multilingual news retrieval",
  datasetId: "neuclir-1",
  taskMode: "rank_documents",
  piSearchPromptVariant: "rank_documents",
  defaultQuerySetId: "dev",
  defaultQueryPath: "data/neuclir/queries/dev-title-description.tsv",
  querySets: { dev: "data/neuclir/queries/dev-title-description.tsv" },
  defaultQrelsPath: "data/neuclir/qrels/2024-mlir.txt",
  defaultIndexPath: "indexes/neuclir-english-mt",
  managedPresets: {},
  setup: { steps: {} },
  retrievalEvaluation: {
    runFileBackend: "internal",
    runDirBackend: "internal",
    internalMetrics: {
      ndcgGainMode: "linear",
      recallRelevantThreshold: 3,
      binaryRelevantThreshold: 3,
    },
  },
};
