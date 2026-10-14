import { readFileSync } from "node:fs";
import { Bm25TcpRpcClient } from "./bm25_tcp_rpc_client";
import { createRepoPiSearchBackend } from "./pi_search_backend_factory";
import { resolvePassageRpcEndpoint } from "./passage_backend_factory";
import type { PiSearchExtensionConfig } from "../../pi-search/config";
import {
  DEFAULT_PASSAGE_ID_PREFIX,
  PassageBm25Backend,
} from "../../pi-search/searcher/adapters/passage_bm25/adapter";
import { HybridBm25Backend } from "../../pi-search/searcher/adapters/passage_bm25/hybrid";

/** "docid<TAB>length" lines, as written by scripts/term_explain/DocLengths.java. */
export function loadDocLengths(path: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const tab = line.indexOf("\t");
    if (tab > 0) map.set(line.slice(0, tab), Number(line.slice(tab + 1)));
  }
  if (!map.size) throw new Error(`No document lengths in ${path}`);
  return map;
}

export function createHybridPiSearchBackend(
  cwd: string,
  config: PiSearchExtensionConfig,
  env: NodeJS.ProcessEnv = process.env,
  observe?: (row: Record<string, unknown>) => void,
): HybridBm25Backend {
  if (config.backend.kind !== "anserini-bm25" || config.backend.transport.kind !== "tcp")
    throw new Error("The hybrid backend needs the TCP document-index daemon.");
  const lengthsPath = env.PI_HYBRID_DOC_LENGTHS?.trim();
  if (!lengthsPath)
    throw new Error("PI_HYBRID_DOC_LENGTHS must point at the document length table.");
  const documents = createRepoPiSearchBackend(cwd, config);
  const documentHelper = new Bm25TcpRpcClient({
    host: config.backend.transport.host,
    port: config.backend.transport.port,
  });
  const passages = new Bm25TcpRpcClient(resolvePassageRpcEndpoint(env));
  const passageIdPrefix = env.PI_PASSAGE_ID_PREFIX?.trim() || DEFAULT_PASSAGE_ID_PREFIX;
  const units = new PassageBm25Backend({ passages, documents, passageIdPrefix, observe });
  return new HybridBm25Backend({
    passages,
    documentHelper,
    documents,
    units,
    docLengths: loadDocLengths(lengthsPath),
    shortChars: Number(env.PI_HYBRID_SHORT_CHARS ?? 8000),
    rrfK: Number(env.PI_HYBRID_RRF_K ?? 60),
    fusion: env.PI_HYBRID_FUSION === "rrf" ? "rrf" : "cc",
    lambda: Number(env.PI_HYBRID_LAMBDA ?? 0.5),
    passagesPerDoc: Number(env.PI_HYBRID_PASSAGES_PER_DOC ?? 2),
    passageIdPrefix,
  });
}
