import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerJevAnswerV2 } from "./pi_search_jev_hybrid_v2";

/** CMASS with the paper's document + passage BM25 workflow; CMASS_HYBRID=1 selects the ClimbMix services. */
export default function registerCmassHybrid(pi: ExtensionAPI) {
  registerJevAnswerV2(pi, "hybrid");
}
