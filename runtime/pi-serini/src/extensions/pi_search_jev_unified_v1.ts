/** One research loop for both task modes. answer_question uses the BrowseComp-Plus final entry
 * (hybrid document and passage retrieval plus clue auto-scan); rank_documents uses the document
 * ranking reader plus relevance auto-scan. Both keep search, jev_find and read_document. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveTaskMode } from "../pi-search/task_profile";
import registerAnswer from "./pi_search_jev_hybrid_v2";
import registerRanking from "./pi_search_jev_ranking_autoscan_v1";

export default function registerUnified(pi: ExtensionAPI) {
  return resolveTaskMode() === "rank_documents" ? registerRanking(pi) : registerAnswer(pi);
}
