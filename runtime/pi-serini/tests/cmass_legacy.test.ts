import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import registerHybrid from "../src/extensions/pi_search_jev_hybrid_v2";
import { formatPiSearchPrompt } from "../src/pi-search/agent_prompt";
import { getBenchmarkDefinition } from "../src/benchmarks/registry";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export async function legacySnapshot(register = registerHybrid) {
  const saved = { ...process.env };
  const tools: object[] = [];
  const hooks = new Map<string, Function[]>();
  try {
    for (const key of Object.keys(process.env)) {
      if (/^(JEV_|PI_SEARCH_|PI_BM25_|PI_HYBRID_|PI_PASSAGE_)/.test(key)) delete process.env[key];
    }
    const config = JSON.parse(readFileSync(new URL("../../../configs/browsecomp.json", import.meta.url), "utf8"));
    Object.assign(process.env, config.environment, {
      JEV_BATCH_SIZE: String(config.batch_size), JEV_GPT_SOURCE_CHARS: String(config.gpt_source_chars),
      JEV_MODEL: config.system_one_model,
      PI_SEARCH_EXTENSION_CONFIG: JSON.stringify({ backend: { kind: "mock", documents: [] } }),
    });
    register({
      registerTool: (tool: any) => { const { execute, ...description } = tool; tools.push(description); },
      on: (event: string, callback: Function) => hooks.set(event, [...(hooks.get(event) ?? []), callback]),
    } as any);
    let systemPrompt = "Synthetic base system prompt.";
    for (const callback of hooks.get("before_agent_start") ?? []) {
      const result = await callback({ systemPrompt });
      systemPrompt = result?.systemPrompt ?? systemPrompt;
    }
    return {
      tools_sha256: digest(JSON.stringify(tools)), system_prompt_sha256: digest(systemPrompt),
      user_prompts: Object.fromEntries(["browsecomp-plus", "neuclir"].map((id) => [id,
        digest(formatPiSearchPrompt("Synthetic question?", getBenchmarkDefinition(id).piSearchPromptVariant))])),
      config_sha256: Object.fromEntries(["browsecomp", "neuclir"].map((id) => [id,
        digest(readFileSync(new URL(`../../../configs/${id}.json`, import.meta.url), "utf8"))])),
    };
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test("CMASS integration preserves the released legacy prompts, tool descriptions and settings", async () => {
  const reference = JSON.parse(readFileSync(new URL("fixtures/cmass-legacy.json", import.meta.url), "utf8"));
  assert.deepEqual(await legacySnapshot(), reference.snapshot);
});
