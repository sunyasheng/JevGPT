import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { dumpPromptSnapshot } from "../../src/pi-search/prompt_policy";

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

void test("dumpPromptSnapshot writes prompt dumps when PI_SEARCH_DUMP_PROMPTS=1", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "pi-search-prompt-policy-"));

  try {
    withEnv(
      {
        OUTPUT_DIR: outputDir,
        PI_SEARCH_DUMP_PROMPTS: "1",
        PI_BM25_DUMP_PROMPTS: undefined,
      },
      () => {
        dumpPromptSnapshot("system prompt", "user prompt");
      },
    );

    const dumpDir = join(outputDir, "prompt-dumps");
    assert.equal(existsSync(dumpDir), true);

    const dumpFiles = readdirSync(dumpDir).sort();
    assert.equal(dumpFiles.length, 2);
    assert.match(dumpFiles[0], /\.system\.txt$|\.user\.txt$/);
    assert.match(dumpFiles[1], /\.system\.txt$|\.user\.txt$/);

    const contents = dumpFiles
      .map((fileName) => readFileSync(join(dumpDir, fileName), "utf8"))
      .sort();
    assert.deepEqual(contents, ["system prompt", "user prompt"]);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

void test("dumpPromptSnapshot ignores the stale BM25-branded env name", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "pi-search-prompt-policy-"));

  try {
    withEnv(
      {
        OUTPUT_DIR: outputDir,
        PI_SEARCH_DUMP_PROMPTS: undefined,
        PI_BM25_DUMP_PROMPTS: "1",
      },
      () => {
        dumpPromptSnapshot("system prompt", "user prompt");
      },
    );

    const dumpDir = join(outputDir, "prompt-dumps");
    assert.equal(existsSync(dumpDir), false);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
