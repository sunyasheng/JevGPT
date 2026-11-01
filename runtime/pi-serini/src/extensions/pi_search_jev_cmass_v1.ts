import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerJevAnswerV2 } from "./pi_search_jev_hybrid_v2";

/** CMASS changes retrieval, not Jev's released evidence selection workflow. */
export default function registerCmass(pi: ExtensionAPI) {
  registerJevAnswerV2(pi, "document");
}
