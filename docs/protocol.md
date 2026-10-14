# Paper configurations and reporting

Both tasks use GPT-5.5 medium with Jev-1.13.0, a 300-second research budget and a submission reminder at 210 seconds. A tool can consider up to 60 candidates and return up to 100,000 UTF-16 source characters. Independent local judgments run concurrently; research steps retain their dependencies.

## Table 1: BrowseComp-Plus

- All 830 questions over 100,195 documents.
- The QA entry combines document BM25 (`k1=25, b=1`) with passage BM25 (`k1=0.9, b=0.4`). Both score lists are min-max normalized and mixed with weight 0.5. Short documents use the whole document; long documents expose up to two best passages. The threshold is 8,000 UTF-16 characters.
- Background scan: top 60 units, concurrency 12, specificity rule, minimum score 0.5, at most three notice documents. The exact knobs are in `configs/browsecomp.json`.
- Three questions run concurrently. Gold answers and qrels are absent from the research input.
- Original question text, including embedded tabs in four questions, is preserved. The per-question TSV reader splits at the first tab only; all 830 research inputs were checked against the evaluated runs.
- The reported row retains the latest selected attempt per question: **751/830 correct**. Thirteen questions with infrastructure failures were attempted a second time. Original cohort membership, retry IDs, selected attempt numbers, first-attempt correctness, and answer/grade hashes are retained in `splits/` and `results/`.
- Evaluation uses the official BCP grading prompt/parser with a separate GPT-5.5 medium judge. Failed research and empty answers are incorrect without a judge call. Unresolved grades stay unknown and keep their place in the denominator; `scripts/report.py` reports no accuracy until every grade is resolved.

## Table 2: NeuCLIRBench

- All 105 official MLIR topics (54 from 2023, 51 from 2024), using original English title and description over the combined English-MT corpus. Narratives are excluded.
- The unified entry selects the document-ranking reader with relevance background scanning. Four topics run concurrently.
- Document BM25 uses `k1=0.9, b=0.4`. The top 500 candidates are rescored using their best passage, which holds up to 250 body words prefixed with the document title. Passage BM25 uses `k1=0.9, b=0.4`, document-level IDF and fixed average passage length 144.7 tokens. The normalized document and best-passage scores each receive weight 0.5. Retrieval units remain whole documents.
- All 105 reported outcomes are first attempts. Two isolated Jev transport failures were retained.
- nDCG@20 uses the official **linear 0/1/3 gains**, without exponentiating them. Recall/precision treat gain greater than zero as relevant. Precision divides by 20 even if fewer documents are returned. F1 is computed per topic and then macro averaged. Unjudged documents contribute zero gain. Failed/malformed rankings score as empty, without dropping topics.
- The ranking parser takes the `Exact Answer:` JSON list and retains the first occurrence of duplicate IDs. TREC export assigns strictly decreasing scores to preserve the submitted order. No relevance-based repairs are applied.

## Released records

`results/browsecomp.jsonl` holds the 830 selected records with correctness, resources, attempt and cohort IDs, and SHA-256 hashes of the original answers, grades and raw results. `results/neuclir.jsonl` holds the 105 records with submitted document IDs, resources and metrics, and `results/neuclir.trec` holds the submitted rankings unchanged. Every record was checked against the paper snapshot and the original result hashes before export.

## Resource accounting

GPT input includes uncached, cache-read and cache-write tokens, each counted once. Output includes reasoning tokens as reported by Pi. The table's token column is mean `(input + output) / 1,000`. Searches count retrieval calls; elapsed time is per-item runtime at the recorded question/topic concurrency.

Frozen nominal prices per million tokens: GPT uncached input $5, cached input $0.50, output $30; Jev input $0.042. Jev usage includes both region judgments and local continuation/context gates. Research costs exclude the answer grader, probes, local compute and unreported usage; they are not account invoices. The release's fresh-run collector explicitly flags missing usage instead of inventing token counts.

`scripts/report.py --check` reconstructs every unrounded scalar from JevGPT's per-item records, checks token costs and verifies the result against `results/paper.json`. `evaluation/neuclir.py` reproduces every per-topic nDCG, recall, precision and F1 value of the original `ir_measures` evaluation within `1e-12` on the pinned official qrels.
