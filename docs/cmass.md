# CMASS

This adapter runs JevGPT on [CMASS](https://github.com/castorini/cmass): BCP (80),
TRQA (68), DSQA (71) and HotpotQA (204). It reuses the released Jev evidence
reader, memory and background scan with whole-document ClimbMix BM25 retrieval.

## Rebuild the released results

No credentials, corpus or model calls are needed:

```bash
python3 scripts/report.py --benchmark cmass --check --out artifacts/cmass
```

The 423 numeric records in `results/cmass.jsonl` and the cohort in
`splits/cmass.json` are identical to the published
[Hugging Face records](https://huggingface.co/datasets/yashengsun/JevGPT-runs).
The report includes DSQA strict/relaxed and both overall criteria, each counting
423 questions once. Encoded trajectories and their decoder remain on Hugging
Face. Questions, answers and source documents are not included in the GitHub
records. Hashes connect each record to its answer, grade and trajectory.

Published rows use one finalized, validated output per fixed question. The
[execution and selection ledger](../provenance/cmass-selection.json) records the
selection rule, artifact counts, saved outcomes and service events. Resource
figures cover the selected outputs. The commands below start a fresh run and
do not repeat the archived campaign's additional executions.

## Prepare inputs

Follow the [shared installation steps](reproduce.md#install), then:

```bash
python scripts/prepare_data.py cmass
# Or use an existing obfuscated snapshot:
python scripts/prepare_data.py cmass --source /path/to/cmass-v2026.10.25
```

The preparer checks pinned upstream Git blob hashes before decoding. It uses
`castorini/cmass` v2026.10.25, revision
`b45390693461d948d47fdd835f27b46026b5e2a2`: 423 questions and 40,736 positive
qrels. Question-only inputs go to `data/cmass/inputs/questions.jsonl`; gold,
canonical DSQA sets and qrels go to `evaluator-only/`. Dataset-scoped IDs prevent
collisions. TAB/CR/LF runs in questions become spaces, following the official
preparation convention. Generated splits include `all`, each dataset, `smoke4`
and `pilot20`; the latter two are deterministic convenience subsets.

## Configure retrieval and model access

An external **full-corpus ClimbMix BM25 service** is required. The index is not
bundled; `services/cmass_search.py` serves an existing index using the evaluated
Anserini 2.3.0 search class and BM25 settings. See the [official retrieval setup](https://github.com/castorini/cmass/blob/c99792cc025a8f1feba7b9b2d03309ed5964e85b/REPRODUCING.md)
and [ClimbMix service documentation](https://github.com/TREC-RAG/trec-rag-skills/tree/main/skills/pyserini-rest-api)
for corpus/service access. This adapter expects the following JSON contract;
check that your deployment provides it before starting a run. The launcher
checks health before creating the run or starting any question:

| Request | Required response fields |
| --- | --- |
| `GET /health` | `status: "ready"`, `mode: "full"`, `index: "climbmix-400b"`, `documents: 553240576`, `bm25: {"k1": 0.9, "b": 0.4}` |
| `GET /v1/climbmix-400b/search?query=...&hits=N` | `candidates: [{"docid": "...", "score": 1.0, "doc": {"text": "..."}}]` in rank order |
| `GET /v1/climbmix-400b/doc/<URL-encoded-docid>` | `docid` and `doc.text`; HTTP 404 for a missing document |

`services/cmass_bridge.py` adapts that service to Pi's search/read interface.
It checks the fingerprint, caches up to 100 hits per search, preserves original
document text and pages on original newline boundaries. Each preview's title
and snippet together are capped at 500 UTF-16 units (title at most 220); the
initial preview shows five results. No qrels, gold answers or model calls enter
the bridge. Health metadata alone does not establish identical ranking to the
authors' hosted index; record your service/index revision in its fingerprint.

For a local service, use JDK 21+, `requirements-cmass-server.txt` and the
[Anserini 2.3.0 fatjar](https://repo.maven.apache.org/maven2/io/anserini/anserini/2.3.0/anserini-2.3.0-fatjar.jar), also distributed with Pyserini 2.4.0. Its exact SHA-256 and the
corpus/indexing settings are pinned in `provenance/cmass-index.json`. Then:

```bash
python -m pip install -r requirements-cmass-server.txt
export JAVA_HOME=/path/to/jdk-21
python services/cmass_search.py --index /path/to/climbmix-index \
  --anserini-jar /path/to/anserini-2.3.0-fatjar.jar --port 19431
```

To build the index, obtain all 6,543 parquet shards from
`karpathy/climbmix-400b-shuffle` at revision
`915333b4f8b8684f39aeaafea600fea6f43fb703`. This is a 400B-token corpus and
requires substantial local disk and indexing resources. The evaluated index
uses the original filenames to retain `shard_XXXXX_N` document IDs, the
`FineWebCollection` reader, default Porter stemming/stopword removal, and raw
document storage. The equivalent full-corpus indexing command is:

```bash
hf download karpathy/climbmix-400b-shuffle --repo-type dataset \
  --revision 915333b4f8b8684f39aeaafea600fea6f43fb703 \
  --include '*.parquet' --local-dir data/cmass/corpus
java -Xmx48g -cp /path/to/anserini-2.3.0-fatjar.jar \
  io.anserini.index.IndexCollection -collection FineWebCollection \
  -input data/cmass/corpus -index data/cmass/index \
  -generator DefaultLuceneDocumentGenerator -threads 24 -memoryBuffer 4096 -storeRaw
```

Use a fresh index directory and verify all shards downloaded, indexing counters
`unindexable`, `empty`, `skipped`, `errors` are zero, and the index contains
553,240,576 documents. The service refuses a different document count or jar.
It uses tolerant JSON parsing for literal control characters in the stored raw
field, preserving source text. The release's service wrapper replaces the
campaign's local startup monitor; it performs no corpus downloads itself.

Configure a Pi provider using the included example:

```bash
mkdir -p .pi/cmass-agent
cp configs/cmass-models.example.json .pi/cmass-agent/models.json
export PI_CODING_AGENT_DIR="$PWD/.pi/cmass-agent"
export OPENAI_API_KEY=...      # your compatible Responses deployment
export TYPESAFE_API_KEY=...    # Jev
```

Edit `baseUrl`, authentication and the model/deployment ID for your provider.
The example's zero cost entries are Pi schema placeholders, not prices; the
collector leaves Sol cost unknown. CMASS requires an explicit model definition
with `contextWindow: 200000` and `maxTokens: 16384`; the launcher verifies these
limits and saves the profile hash without copying credentials into run records.
The launcher rejects a different model inherited from `JEVGPT_MODEL`; explicitly
use `--allow-model-change` only for a new configuration or deployment alias.
Model availability and authentication depend on your provider. The released
interface uses standard Pi provider configuration and a standard Responses
judge; account-specific brokers and workstation service managers are not needed.

## Run, grade and report

```bash
python scripts/run.py cmass --model cmass/gpt-6.1-sol \
  --out runs/cmass --dry-run
python scripts/run.py cmass --model cmass/gpt-6.1-sol \
  --search-url http://127.0.0.1:19431 --workers 8 --out runs/cmass

python evaluation/cmass.py --run runs/cmass \
  --out runs/cmass/evaluator-only --dry-run
python evaluation/cmass.py --run runs/cmass \
  --out runs/cmass/evaluator-only

python scripts/report.py --benchmark cmass \
  --records runs/cmass/evaluator-only/scored.jsonl \
  --cohort runs/cmass/manifest.json --out artifacts/cmass-new
```

Use `--split smoke4` or a dataset split for a smaller new run. Every run uses a
fresh output directory, takes one attempt per selected question and retains
failed outcomes. One launcher owns the queue; `--workers` controls research
concurrency. The separate judge defaults to one worker. Research uses Sol 6.1
high, Jev 1.13.0, an 1800-second budget and a 1260-second submit reminder.

The judge accepts `--base-url` / `OPENAI_BASE_URL`, `--api-key-env`,
`--auth-header api-key`, `--model` / `CMASS_GRADER_MODEL`, and `--expected-model`
for deployment aliases. It sends the pinned official high-effort, no-tools
requests. `--resume` requires matching inputs/settings and preserves first
grades; a started request with no saved response stays unknown. Only explicit
HTTP 429/5xx failures receive up to three transport attempts. Invalid judgments
remain unknown. Original responses are retained; scalar gold-echo outer JSON
quotes may be normalized without changing the judge's Boolean decision.
Unknown outcomes are terminal in that evaluation directory, including an
interruption during a retry delay. A separate evaluation in a new directory is
required to obtain new judgments; `--resume` never fills them with fresh calls.

DSQA strict requires the complete gold set with no wrong extras. Relaxed accepts
a nonempty correct subset with no wrong extras. Both use the same answer and
judge call; order is ignored. Official prompts, protocol and metrics are pinned
under `evaluation/cmass_protocol/` with their licenses.

Accuracy keeps the full selected denominator; unknown grades suppress the
reported accuracy. Failed research is incorrect. Known token amounts are
separate from missing usage; unknown totals and costs remain null. New runs
collect Pi assistant usage; unreported compaction usage is flagged unknown.
Frozen published records preserve the campaign's transport-level accounting.

The evaluator additionally distinguishes search-shown, tool-visible, cached and
read document recall. Only displayed search results use the Recall@all scope;
missing retrieval traces are not treated as zero recall. It reports no Hop
Groundedness, since public qrels omit the required hop-to-document mapping.
This is the JevGPT configuration on CMASS, not an exact replay of the authors'
Piika experiment. See `provenance/cmass-adaptation.json` for evaluated source
hashes and the packaging changes in this release.
