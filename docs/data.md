# Data and indexes

External collections and indexes are downloaded separately. Exact index file hashes and source revisions are recorded in `provenance/data-sources.json`.

## BrowseComp-Plus

Install the optional data dependencies:

```bash
python -m pip install -r requirements-data.txt
```

For an existing official decrypted dataset:

```bash
python scripts/prepare_data.py browsecomp --source /path/to/browsecomp_plus_decrypted.jsonl
```

Or set `BROWSECOMP_PLUS_CANARY` to the canary published by the [official dataset](https://huggingface.co/datasets/Tevatron/browsecomp-plus), then:

```bash
python scripts/prepare_data.py browsecomp --download
```

The script pins dataset revision `144cff8e35b5eaef7e526346aa60774a9deb941f`, selects all 830 questions and checks their exact text against the paper cohort. It writes question-only input to `data/browsecomp/inputs/questions.jsonl` and gold answers separately under `inputs/evaluator-only/`.

Download the two public BM25 indexes (approximately 2.2 GB and 4.7 GB):

```bash
hf download Tevatron/browsecomp-plus-indexes --repo-type dataset \
  --revision b3f37f70c33829eb09d04784a54277a31871fd63 \
  --include 'bm25/*' --local-dir data/browsecomp/document-download
hf download grill-lab/browsecomp-plus-indexes --repo-type dataset \
  --revision 11a7f3f0f9ce45619f5aa4dcc08c93451b657b07 \
  --include 'index.bm25.passage/*' --local-dir data/browsecomp/passage-download
mv data/browsecomp/document-download/bm25 data/browsecomp/document-index
mv data/browsecomp/passage-download/index.bm25.passage data/browsecomp/passage-index
```

The document corpus has 100,195 documents. The passage index uses title-prefixed passages of at most 250 words, with IDs such as `browsecomp_plus_64576_14`; source evidence is mapped back to parent-document coordinates. Both pinned downloads were checked against the indexes used for the reported BCP outcomes. The indexes' optional `write.lock` is not part of their content hashes.

Compile the frozen Java search service and export document lengths:

```bash
python scripts/setup_browsecomp.py
```

This downloads the pinned Anserini 1.6.0 fatjar if needed, verifies its hash, compiles the helper and writes `data/browsecomp/doc-lengths.tsv`. Lengths must be Java/UTF-16 `contents.length()`, because the 8,000-character whole-document/passage switch uses that quantity. Existing indexes/jars can be supplied with `--doc-index` and `--anserini-jar`.

## NeuCLIRBench

Download the pinned official 105-topic judgments:

```bash
python scripts/prepare_data.py neuclir
```

These are `neuclir/bench@8f02c196151e2efcb035ce453cd866dc0d1adf39`'s `qrels.mlir.gains.txt`; its SHA-256 is verified. The query file is already included in `inputs/neuclir-topics.jsonl`. The task uses the original English title and description, retrieving English machine translations of Persian, Russian and Chinese documents.

On the machine that will host the index:

```bash
python -m pip install -r requirements-data.txt -r requirements-neuclir-server.txt
hf download neuclir/neuclir1 --repo-type dataset \
  --revision eae8670cf1a4b63f4c4718e48698f4c27613cc68 \
  --include 'data/fas.mt.eng-*.jsonl.gz' 'data/rus.mt.eng-*.jsonl.gz' 'data/zho.mt.eng-*.jsonl.gz' \
  --local-dir data/neuclir/mt-download
python scripts/prepare_neuclir_corpus.py \
  --mt-dir data/neuclir/mt-download/data --out data/neuclir/collection
python -m pyserini.index.lucene \
  --collection JsonCollection --input data/neuclir/collection \
  --index data/neuclir/index --generator DefaultLuceneDocumentGenerator \
  --threads 8 --storePositions --storeDocvectors --storeRaw
```

The conversion reproduces `contents = (title.strip() + '\n\n' + text.strip()).strip()`, keeps document IDs unchanged, skips later duplicate IDs, and checks for 10,038,763 unique documents. The Lucene index alone is approximately 30 GB; the downloaded and converted corpus requires additional space. Choose indexing workers and JVM heap for the host's available memory.

The original index fingerprint is retained in `provenance/paper.json`. The NeuCLIR1 revision above is pinned, and the paper's frozen ranking can be rescored exactly with the pinned qrels.

Start `services/neuclir_hybrid.py` on the resulting index as shown in the [reproduction guide](reproduce.md#neuclirbench).
