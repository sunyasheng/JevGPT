import assert from "node:assert/strict";
import test from "node:test";
import { executeSearchTool } from "../../src/pi-search/tool_handlers";
import { PiSearchBackendRuntime } from "../../src/pi-search/searcher/runtime";
import { SearchSessionStore } from "../../src/pi-search/search_cache";
import { ManagedTempSpillDir } from "../../src/pi-search/spill";

void test("search honors an HTTP backend's result cap while retaining the original default", async () => {
  for (const cap of [100, undefined]) {
    let requested = 0;
    const backendRuntime = new PiSearchBackendRuntime({ backend: { kind: "mock", documents: [] } }, {
      createBackend: () => ({
        capabilities: { backendId: "fixture", supportsScore: true, supportsSnippets: true,
          supportsExactTotalHits: false, maxPageSize: cap },
        search: async (req) => {
          requested = req.limit;
          if (cap && req.limit > cap) throw new Error("REST result cap exceeded");
          return { hasMore: false, hits: Array.from({ length: 10 }, (_, i) => ({ docid: `doc${i}`, score: 10-i })) };
        },
        readDocument: async () => { throw new Error("Unexpected read"); },
      }),
    });
    const spillDir = new ManagedTempSpillDir("cmass-limit-test-");
    try {
      const output = await executeSearchTool({ reason: "Look up a clue", query: "clue" }, undefined,
        { cwd: "." }, { backendRuntime, searchStore: new SearchSessionStore(), spillDir, nextSpillSequence: () => 1 });
      assert.equal(requested, cap ?? 1000);
      assert.equal(output.details.k, cap ?? 1000);
      assert.equal(output.details.retrievedDocids.length, 10);
      assert.equal(output.details.previewedDocids?.length, 5);
    } finally { spillDir.cleanup(); backendRuntime.dispose(); }
  }
});
