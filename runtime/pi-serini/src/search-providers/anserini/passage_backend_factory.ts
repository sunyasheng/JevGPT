import { Bm25TcpRpcClient } from "./bm25_tcp_rpc_client";
import { createRepoPiSearchBackend } from "./pi_search_backend_factory";
import type { PiSearchExtensionConfig } from "../../pi-search/config";
import type { PiSearchBackend } from "../../pi-search/searcher/contract/interface";
import {
  DEFAULT_PASSAGE_ID_PREFIX,
  PassageBm25Backend,
} from "../../pi-search/searcher/adapters/passage_bm25/adapter";

export type PassageRpcEndpoint = { host: string; port: number };

/** The passage-index daemon is a second Bm25Server, announced through PI_PASSAGE_RPC_HOST/PORT. */
export function resolvePassageRpcEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): PassageRpcEndpoint {
  const host = env.PI_PASSAGE_RPC_HOST?.trim();
  const rawPort = env.PI_PASSAGE_RPC_PORT?.trim();
  if (!host || !rawPort)
    throw new Error(
      "PI_PASSAGE_RPC_HOST and PI_PASSAGE_RPC_PORT must both point at the passage-index BM25 daemon.",
    );
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isFinite(port) || port <= 0)
    throw new Error(`Invalid PI_PASSAGE_RPC_PORT=${rawPort}`);
  return { host, port };
}

/** Document-level backend from the standard config, wrapped by the passage-unit backend. */
export function createPassagePiSearchBackend(
  cwd: string,
  config: PiSearchExtensionConfig,
  env: NodeJS.ProcessEnv = process.env,
  observe?: (row: Record<string, unknown>) => void,
): PassageBm25Backend {
  const documents: PiSearchBackend = createRepoPiSearchBackend(cwd, config);
  const endpoint = resolvePassageRpcEndpoint(env);
  return new PassageBm25Backend({
    passages: new Bm25TcpRpcClient(endpoint),
    documents,
    passageIdPrefix: env.PI_PASSAGE_ID_PREFIX?.trim() || DEFAULT_PASSAGE_ID_PREFIX,
    observe,
  });
}
