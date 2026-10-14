# Release validation

Validated on 2026-10-05 with Python 3.13, Node.js 25.8.1 and Java 25 (the Java helpers compile with `--release 21`).

## Code and records

- All 42 imported runtime tests and 13 release-specific Python tests pass; the runtime tests need `JEV_SPLITTER_PYTHON`, as shown in the README. TypeScript type checking passes.
- Both paper rows are reconstructed from the 830 BCP and 105 NeuCLIR records. Every unrounded aggregate and per-item token cost matches the frozen paper values.
- All 105 released NeuCLIR rankings were rescored with the pinned official qrels downloaded by `scripts/prepare_data.py neuclir`. All per-topic nDCG, recall, precision and F1 values match the original evaluation within `1e-12`.
- The 830 BCP questions were prepared from the official decrypted dataset. Every generated research TSV is byte-identical to the corresponding evaluated input, including embedded tabs in four questions. Gold answers are stored separately from research inputs.
- All 14 document-index and 18 passage-index content files were checked against their pinned Hugging Face revisions during preparation; optional `write.lock` files are excluded. Their hashes are retained in `provenance/data-sources.json`.
- `scripts/setup_browsecomp.py` compiled the frozen Java BM25 service and exported all 100,195 document lengths from the existing document index. Every UTF-16 length matches the original experiment's table.
- 12 random BCP records and 8 random NeuCLIR records were rebuilt with `scripts/collect.py` from the original trajectories. Their source hashes, tokens, searches, Jev requests, costs and NeuCLIR rankings all match the released records.
- The source inventory, imported-file hashes, documented portability edits, cohort membership and selected BCP recovery attempts are checked by `scripts/check_release.py`.

## Launcher checks

Both launchers were exercised through their real Python → TypeScript → Pi process chain against local HTTP response fixtures, with one item each. The BCP launch used the actual document and passage indexes. The NeuCLIR bridge used a local health-response fixture with the frozen retrieval settings. Both registered the research tools, requested medium reasoning, completed, and collected the fixture's cached/uncached token usage correctly.

The BCP evaluator was exercised against a local judge-response fixture, including deployment-alias verification and resume without another request. NeuCLIR fresh-run records were passed through the public scorer.
