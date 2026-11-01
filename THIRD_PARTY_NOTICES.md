# Third-party notices

- `runtime/pi-serini/` includes the needed parts of [justram/pi-serini](https://github.com/justram/pi-serini), MIT, copyright 2026 Jheng-Hong YANG, together with the JevGPT extensions. The upstream license is retained at `runtime/pi-serini/LICENSE`.
- The official BrowseComp-Plus grader prompt and `parse_judge_response` function are extracted from the evaluated [texttron/BrowseComp-Plus](https://github.com/texttron/BrowseComp-Plus) source, MIT, copyright 2025 texttron. Its license is retained at `licenses/BrowseComp-Plus-LICENSE`.
- [semantic-text-splitter](https://github.com/benbrandt/text-splitter), MIT, is installed separately at version 0.33.0. The release includes our lossless source-coordinate adapters.
- Pi Coding Agent and its dependencies are installed through the pinned npm lockfile; their respective licenses remain applicable. Anserini and Pyserini are installed separately for BM25 indexing/search.
- BrowseComp-Plus corpus/indexes, the passage indexes from [Revisiting Text Ranking in Deep Research](https://github.com/ChuanMeng/text-ranking-in-deep-research), NeuCLIR1, NeuCLIRBench, GPT and Jev retain their own dataset/model/service terms. Corpus files, model weights, indexes and service credentials are not included in this release.

- `evaluation/cmass_protocol/` vendors the unmodified protocol, metrics and
  prompts from [castorini/cmass](https://github.com/castorini/cmass), commit
  `c99792cc025a8f1feba7b9b2d03309ed5964e85b`, Apache-2.0. Its `LICENSE` is retained
  in that directory. Piika-derived prompt material retains the upstream MIT
  notice in `evaluation/cmass_protocol/PIIKA_LICENSE`.
- CMASS and ClimbMix retain their respective data licenses and access terms.
  CMASS inputs are downloaded separately from the pinned release; detailed
  benchmark trajectories remain encoded on Hugging Face.
