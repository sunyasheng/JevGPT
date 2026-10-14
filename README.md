<p align="center">
  <img src="assets/banner.jpg" alt="JevGPT: a fast System One inspects sources in parallel while a deliberate System Two plans the research" width="100%">
</p>

<h1 align="center">JevGPT: Thinking Fast and Slow in Autonomous Research</h1>

<p align="center">
  Yasheng Sun · Yanning Dai · Yimeng Chen · Nanbo Li · Firas Laakom · Yifan Xu ·
  Piotr Piękos · Mateusz Ostaszewski · Wenyi Wang · Cheng Luo · Yuhui Wang · Jürgen Schmidhuber
  <br>
  King Abdullah University of Science and Technology (KAUST)
</p>

<p align="center">
  <a href="https://arxiv.org/abs/2610.18272"><img src="https://img.shields.io/badge/arXiv-2610.18272-b31b1b?logo=arxiv&amp;logoColor=white" alt="arXiv 2610.18272"></a>
  <a href="https://huggingface.co/datasets/yashengsun/JevGPT-runs"><img src="https://img.shields.io/badge/%F0%9F%A4%97%20Dataset-Runs-ff9d00" alt="Hugging Face dataset: runs"></a>
  <a href="https://sunyasheng.github.io/projects/JevGPT.html"><img src="https://img.shields.io/badge/Project-Page-1f6feb?logo=googlechrome&amp;logoColor=white" alt="Project page"></a>
  <a href="https://huggingface.co/papers/2610.18272"><img src="https://img.shields.io/badge/%F0%9F%A4%97%20Hugging%20Face-Paper-ffd21e" alt="Hugging Face paper"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-2ea44f" alt="License: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/Python-3.10%2B-3776ab?logo=python&amp;logoColor=white" alt="Python 3.10+">
  <img src="https://img.shields.io/badge/Node.js-Pi--Serini%20runtime-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js runtime">
</p>

<p align="center">
  <a href="#-tldr">TL;DR</a> ·
  <a href="#-how-jevgpt-works">Method</a> ·
  <a href="#-results">Results</a> ·
  <a href="#-quick-start">Quick start</a> ·
  <a href="#-run-new-experiments">Run</a> ·
  <a href="#-runs-and-trajectories">Runs</a> ·
  <a href="#-citation">Citation</a>
</p>

---

## 🔥 News

- **2026-10-14** · Code released: the JevGPT runtime, frozen configurations, evaluation scripts and per-item records for Tables 1 and 2.
- **2026-10-14** · Run outputs (per-item records and full trajectories) are on [Hugging Face](https://huggingface.co/datasets/yashengsun/JevGPT-runs).
- **2026-10-14** · The paper is on [arXiv](https://arxiv.org/abs/2610.18272) and [Hugging Face Papers](https://huggingface.co/papers/2610.18272).

## 💡 TL;DR

Research agents built on a single autoregressive LLM spend the same heavy computation on every step, from planning down to small local decisions about whether a source is relevant. **JevGPT** splits these roles. A deliberative LLM (**System Two**, GPT-5.5) sets evidence objectives and integrates findings. A fast judgment model (**System One**, Jev) inspects many sources in parallel, locates support and returns only the selected original passages. On BrowseComp-Plus and NeuCLIRBench, JevGPT reaches the highest observed task performance among the compared agents, with faster completion and lower API cost than comparably effective research agents.

<p align="center">
  <img src="assets/teaser.png" alt="JevGPT dual-system architecture" width="92%">
  <br>
  <em><b>Figure 1.</b> System Two plans searches and integrates findings; System One guides parallel evidence inspection and returns source passages.</em>
</p>

## 🧠 How JevGPT works

| | ⚡ **System One** (Jev) | 🧭 **System Two** (GPT-5.5) |
| --- | --- | --- |
| Role | Fast, bounded local judgments | Deliberative research planning |
| Reads | One source region at a time, under an explicit evidence objective | The accumulated investigation |
| Decides | Does this source support the request? Where is the passage? Read further? | What to search next, what evidence to request, when to answer |
| Runs | Many judgments in parallel | One reasoning thread |

Evidence requests flow from System Two to System One. Selected original passages, with source coordinates, flow back and inform the next research step. Proactive discovery lets System One inspect further retrieved candidates while System Two keeps working.

<p align="center">
  <img src="assets/method.png" alt="Overview of JevGPT" width="92%">
  <br>
  <em><b>Figure 2.</b> Overview of evidence acquisition, localization, adaptive reading and discovery in JevGPT.</em>
</p>

## 📊 Results

**BrowseComp-Plus** · 830 questions

| Method | Accuracy (%) ↑ | Time (s) ↓ | Cost ($) ↓ |
| --- | ---: | ---: | ---: |
| BCP/ReAct | 77.11 | 182.1 | 3.0798 |
| Pi-Serini | 82.05 | 112.6 | 0.4053 |
| Agentica | 84.46 | 111.7 | 0.7919 |
| AtlasNav | 89.16 | 144.0 | 1.5257 |
| RISE | 89.88 | 111.0 | 1.1050 |
| Reason-ColBERT | 90.00 | 136.2 | 1.6090 |
| **JevGPT** | **90.48** | **91.7** | 0.6681 |

**NeuCLIRBench** · 105 topics

| Method | nDCG@20 ↑ | Time (s) ↓ | Cost ($) ↓ |
| --- | ---: | ---: | ---: |
| BM25 | 0.3608 | – | – |
| Qwen3-Reranker | 0.5138 | – | – |
| RankGPT | 0.4843 | 141.3 | 0.6402 |
| BCP/ReAct | 0.4847 | 186.8 | 0.9707 |
| Agentica | 0.5107 | 211.0 | 0.8256 |
| Pi-Serini | 0.5240 | 177.0 | 0.8515 |
| **JevGPT** | **0.5390** | **79.3** | **0.5838** |

Time and cost are per-question or per-topic means. Cost covers both systems: GPT-5.5 at medium effort for System Two and Jev-1.13.0 for System One. The full tables with retrievers, tokens, searches and the per-system cost split are in the [paper](https://arxiv.org/abs/2610.18272). This release reproduces the **JevGPT** rows exactly; baseline rows are quoted from the paper.

<p align="center">
  <img src="assets/cost-quality.png" alt="Quality versus API cost" width="46%">
  &nbsp;
  <img src="assets/bcp-evidence.png" alt="Gold-evidence recall during research" width="46%">
  <br>
  <em><b>Left:</b> quality versus API cost (upper left is better). <b>Right:</b> how gold evidence reaches the research loop on BrowseComp-Plus.</em>
</p>

## 🚀 Quick start

Rebuild the paper rows from the released per-item records. Python 3.10+ is enough, and no model is called:

```bash
python3 scripts/report.py --check --out artifacts/paper-tables
```

The script checks every unrounded aggregate and token cost against `results/paper.json`, then writes Markdown, CSV, JSON and LaTeX rows.

| Task | Retriever | N | Main metric | Tokens (K) | Searches | Time (s) | S2 ($) | S1 ($) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| BrowseComp-Plus | Hybrid BM25 | 830 | 90.48 % accuracy | 433 | 9.13 | 91.7 | 0.6081 | 0.0600 |
| NeuCLIRBench | Hybrid BM25 | 105 | 0.5390 nDCG@20 · 36.10 % F1@20 | 158 | 2.68 | 79.3 | 0.5756 | 0.0082 |

Tokens include cached GPT input and output. Costs use the paper's frozen nominal rates and exclude grading and local compute. See [evaluation and attempt selection](docs/protocol.md).

## 🧪 Run new experiments

Install the runtime, prepare the data and configure model access with the [reproduction guide](docs/reproduce.md). Then:

```bash
python scripts/run.py browsecomp --out runs/browsecomp
python scripts/run.py neuclir --out runs/neuclir
```

- `--dry-run` prints the frozen settings, the selected IDs and the first worker command without starting services.
- `--ids 1,2` runs a BrowseComp-Plus subset; `--ids 200,201` runs a NeuCLIRBench subset.
- Every live run writes to a fresh output directory and keeps failed outcomes.

Live experiments need GPT and Jev access and the benchmark indexes.

## 📦 Runs and trajectories

The per-item records in `results/` are enough to rebuild the paper rows. The full trajectories of the same runs, with every System Two step and every System One judgment, are on Hugging Face at [yashengsun/JevGPT-runs](https://huggingface.co/datasets/yashengsun/JevGPT-runs):

```bash
hf download yashengsun/JevGPT-runs --repo-type dataset --local-dir runs/paper
```

The BrowseComp-Plus trajectories are encrypted with the official BrowseComp-Plus canary, as in the benchmark itself; the dataset card shows how to decrypt them. The NeuCLIRBench trajectories are in plain text.

## 🗂️ Repository layout

| Path | Contents |
| --- | --- |
| `runtime/pi-serini/` | Pi-Serini runtime and the JevGPT evidence readers, imported from the evaluated code |
| `configs/` | Frozen settings for each task |
| `scripts/` | Data preparation, experiment launcher, accounting and table generation |
| `services/` | NeuCLIRBench hybrid BM25 service and document adapter |
| `evaluation/` | Official BrowseComp-Plus grader prompt and parser, NeuCLIRBench metrics |
| `results/`, `splits/` | Per-item records, rankings and the original cohort and attempt selections |
| `provenance/` | Source mappings, pinned data versions and file hashes |
| `assets/` | Figures from the paper and an AI-generated banner |

The live entry points are `pi_search_jev_hybrid_v2.ts` for question answering and `pi_search_jev_unified_v1.ts` for ranking, which dispatches to `pi_search_jev_ranking_autoscan_v1.ts`. Hybrid retrieval is in `runtime/pi-serini/src/pi-search/searcher/adapters/passage_bm25/hybrid.ts` for BrowseComp-Plus and in `services/neuclir_hybrid.py` for NeuCLIRBench. Some file names and run tags keep historical internal names, such as `neuclir_assay_hybrid`, because the evaluated code and records use them. `provenance/source-files.json` records the original hash of every imported file and each packaging change.

## ✅ Verify the release

Install the Python and Node dependencies first. The runtime tests call the pinned Python text splitter through `JEV_SPLITTER_PYTHON`, so point it at the Python that has `requirements.txt` installed:

```bash
python -m pip install -r requirements.txt
npm ci --prefix runtime/pi-serini --ignore-scripts --no-audit --no-fund
```

Then run:

```bash
python scripts/check_release.py
python -m unittest discover -s tests -v
JEV_SPLITTER_PYTHON="$(python -c 'import sys; print(sys.executable)')" \
  npm --prefix runtime/pi-serini test
npm --prefix runtime/pi-serini run typecheck
```

## 📝 Citation

If you find JevGPT useful, please cite:

```bibtex
@article{sun2026jevgpt,
  title   = {{JevGPT}: Thinking Fast and Slow in Autonomous Research},
  author  = {Sun, Yasheng and Dai, Yanning and Chen, Yimeng and Li, Nanbo
             and Laakom, Firas and Xu, Yifan and Pi{\k{e}}kos, Piotr
             and Ostaszewski, Mateusz and Wang, Wenyi and Luo, Cheng
             and Wang, Yuhui and Schmidhuber, J{\"u}rgen},
  journal = {arXiv preprint arXiv:2610.18272},
  year    = {2026}
}
```

## 🙏 Acknowledgments and license

JevGPT builds on [Pi-Serini](https://github.com/justram/pi-serini), [BrowseComp-Plus](https://github.com/texttron/BrowseComp-Plus) and [NeuCLIRBench](https://arxiv.org/abs/2511.14758), and uses Jev, the System One model from [TypeSafe AI](https://typesafe.ai/blog/introducing-system-one-models-and-jev).

Project code is released under Apache-2.0. The vendored Pi-Serini components and the official BrowseComp-Plus grader keep their MIT notices; see [third-party notices](THIRD_PARTY_NOTICES.md). Datasets and hosted models keep their own licenses and access requirements.
