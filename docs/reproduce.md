# Run and evaluate JevGPT

Run the following commands from the release root. Use Python 3.10+, Node.js 22.12+ and Java 21+. The NeuCLIR index service can run on a separate machine with its own Python environment.

External collections and indexes are downloaded separately. BrowseComp-Plus dataset revisions and index file hashes are recorded in `provenance/data-sources.json`; the original NeuCLIR index fingerprint is recorded in `provenance/paper.json`.

## Install

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
npm ci --prefix runtime/pi-serini --ignore-scripts --no-audit --no-fund
```

Export `OPENAI_API_KEY` for GPT and `TYPESAFE_API_KEY` for Jev. `.env.example` lists the supported variables; the launcher reads the process environment, so source your local `.env` if using that file:

```bash
set -a
source .env
set +a
```

The default research model is `openai/gpt-5.5`. An existing Pi provider can be selected with `--model provider/gpt-5.5` or `JEVGPT_MODEL`. Pi reads provider definitions from `PI_CODING_AGENT_DIR` or `~/.pi/agent`; the worker copies only model/auth files into a temporary isolated agent directory. The paper used an Azure GPT-5.5 deployment at medium reasoning effort.

## BrowseComp-Plus

### Prepare the data

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

### Run

Inspect the plan, then run all 830 questions with three workers:

```bash
python scripts/run.py browsecomp --out runs/browsecomp --dry-run
python scripts/run.py browsecomp --out runs/browsecomp
```

The default paths are under `data/browsecomp/`. For existing local assets, override the paths:

```bash
python scripts/run.py browsecomp \
  --questions /path/to/questions.jsonl \
  --doc-index /path/to/document-index \
  --passage-index /path/to/passage-index \
  --doc-lengths /path/to/doc-lengths.tsv \
  --anserini-jar /path/to/anserini-1.6.0-fatjar.jar \
  --out runs/browsecomp
```

### Grade and report

Grade the completed run separately, with the official BCP prompt and parser:

```bash
python evaluation/browsecomp.py \
  --run runs/browsecomp \
  --gold data/browsecomp/inputs/evaluator-only/gold.jsonl \
  --out runs/browsecomp/evaluator-only

python scripts/report.py --benchmark browsecomp \
  --records runs/browsecomp/evaluator-only/scored.jsonl \
  --cohort runs/browsecomp/manifest.json --out artifacts/browsecomp
```

The evaluator uses GPT-5.5 medium through `OPENAI_BASE_URL` (default `https://api.openai.com/v1`) and `OPENAI_API_KEY`. Override `--model`, `--base-url`, `--api-key-env` or `--auth-header api-key` for another compatible deployment. If a deployment alias differs from the returned model ID, add `--expected-model gpt-5.5`; the evaluator checks the returned ID, allowing a dated model suffix. `--dry-run` checks grading inputs without calling the judge. `--resume` retains existing first grades only when all inputs/settings match; interrupted or invalid judgments remain explicitly unknown. Grading cost is excluded from research cost.

## NeuCLIRBench

### Prepare the data

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

### Start the search service

Start the frozen hybrid service on the index host:

```bash
export JAVA_HOME=/path/to/jdk-21
OPENAI_API_KEY=unused python services/neuclir_hybrid.py \
  --index /path/to/neuclir-mt-index --port 19421 --workers 8
```

Pyserini locates the JVM through `JAVA_HOME`, so point it at a JDK 21+ installation. Pyserini 1.2.0 also creates an OpenAI client when it is imported. The service never calls OpenAI, but the import fails unless `OPENAI_API_KEY` is set, so any placeholder value works.

The service listens on `127.0.0.1`, and the launcher reaches it at `http://127.0.0.1:19421` by default. If the index host is another machine, forward the port first, for example with `ssh -N -L 19421:127.0.0.1:19421 user@index-host`; pass `--search-url` if you forward to a different local port. The launcher verifies the corpus size and hybrid retrieval parameters before starting the agent.

### Run, score and report

```bash
python scripts/run.py neuclir --out runs/neuclir --dry-run
python scripts/run.py neuclir --out runs/neuclir

python evaluation/neuclir.py \
  --records runs/neuclir/records.jsonl \
  --qrels data/neuclir/qrels.mlir.gains.txt \
  --cohort runs/neuclir/manifest.json --out runs/neuclir/scored.jsonl

python scripts/report.py --benchmark neuclir \
  --records runs/neuclir/scored.jsonl \
  --cohort runs/neuclir/manifest.json --out artifacts/neuclir
```

The released `inputs/neuclir-topics.jsonl` contains the exact original English title/description inputs for all 105 topics. Narratives and relevance judgments are absent from agent input.

You can independently rescore the paper's released rankings without model access:

```bash
python evaluation/neuclir.py --run results/neuclir.trec \
  --qrels data/neuclir/qrels.mlir.gains.txt --out artifacts/neuclir-rescored.json
```

## Run artifacts

Each run records its selected IDs, settings, input/source hashes and prices in `manifest.json`. `trials/<id>/` contains Pi events, Jev decisions, backend provenance and prompt snapshots. `answers/<id>.json` and `records.jsonl` contain terminal outcomes and observed token usage. `complete.json` records how many selected items succeeded or failed. A failed run exits nonzero while retaining those artifacts.

Every invocation performs one fresh attempt per selected item and does not automatically replace failed attempts. The original BCP paper row used 13 explicitly selected infrastructure-recovery attempts; their IDs and selected outcomes are retained in the released records.
