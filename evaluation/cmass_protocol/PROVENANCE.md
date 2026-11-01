# Official CMASS evaluation sources

Protocol, metrics and all seven prompt templates are copied unchanged from
[castorini/cmass](https://github.com/castorini/cmass/tree/c99792cc025a8f1feba7b9b2d03309ed5964e85b/evaluation),
commit `c99792cc025a8f1feba7b9b2d03309ed5964e85b`.
Their upstream paths and SHA-256 values are in `provenance/source-files.json`.
The Apache-2.0 `LICENSE` and Piika-derived material's MIT `PIIKA_LICENSE` are
retained in this directory.

JevGPT's caller is `evaluation/cmass.py`. Transport, resume handling and the
scalar gold-echo representation normalization live outside these official files.
Our data snapshot is CMASS v2026.10.25
(`b45390693461d948d47fdd835f27b46026b5e2a2`).
