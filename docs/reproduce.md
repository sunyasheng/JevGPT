# Run and evaluate JevGPT

Run the following commands from the release root. Use Python 3.10+, Node.js 22.12+ and Java 21+. The NeuCLIR index service can run on a separate machine with its own Python environment.

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

Follow [data setup](data.md#browsecomp-plus) to prepare the document index, passage index, UTF-16 document lengths, questions and separate gold file. The default paths are under `data/browsecomp/`.

Inspect the plan, then run all 830 questions with three workers:

```bash
python scripts/run.py browsecomp --out runs/browsecomp --dry-run
python scripts/run.py browsecomp --out runs/browsecomp
```

For existing local assets, override the paths:

```bash
python scripts/run.py browsecomp \
  --questions /path/to/questions.jsonl \
  --doc-index /path/to/document-index \
  --passage-index /path/to/passage-index \
  --doc-lengths /path/to/doc-lengths.tsv \
  --anserini-jar /path/to/anserini-1.6.0-fatjar.jar \
  --out runs/browsecomp
```

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

Follow [data setup](data.md#neuclirbench) to download the official qrels and build the English-MT document index. Start the frozen hybrid service on the index host:

```bash
export JAVA_HOME=/path/to/jdk-21
OPENAI_API_KEY=unused python services/neuclir_hybrid.py \
  --index /path/to/neuclir-mt-index --port 19421 --workers 8
```

Pyserini locates the JVM through `JAVA_HOME`, so point it at a JDK 21+ installation. Pyserini 1.2.0 also creates an OpenAI client when it is imported. The service never calls OpenAI, but the import fails unless `OPENAI_API_KEY` is set, so any placeholder value works.

The service listens on `127.0.0.1`, and the launcher reaches it at `http://127.0.0.1:19421` by default. If the index host is another machine, forward the port first, for example with `ssh -N -L 19421:127.0.0.1:19421 user@index-host`; pass `--search-url` if you forward to a different local port. The launcher verifies the corpus size and hybrid retrieval parameters before starting the agent.

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
