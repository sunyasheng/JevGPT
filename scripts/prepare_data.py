"""Prepare input-only BCP questions or download the pinned NeuCLIRBench qrels."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import ssl
from urllib.request import urlopen

from common import ROOT, by_id, read_json, read_jsonl, sha256, write_json, write_jsonl

BCP_REVISION = "144cff8e35b5eaef7e526346aa60774a9deb941f"
NEUCLIR_REVISION = "8f02c196151e2efcb035ce453cd866dc0d1adf39"
QRELS_SHA256 = "35538038818f73f8bb40dacf9cc894cd8356c885f2aa361706f7f7cfa21796c2"


def decrypt(text, password):
    cipher = base64.b64decode(text)
    block = hashlib.sha256(password.encode()).digest()
    return bytes(value ^ block[i % len(block)] for i, value in enumerate(cipher)).decode()


def prepare_browsecomp(rows, out):
    indexed = by_id(rows)
    ids = read_json(ROOT / "splits/browsecomp.json")["all"]
    if set(indexed) != set(ids):
        raise ValueError("Expected the full official 830-question BCP dataset")
    questions, gold = [], []
    for q in ids:
        query, answer = indexed[q]["query"], indexed[q]["answer"]
        if not isinstance(query, str) or not query.strip() or not isinstance(answer, str):
            raise ValueError(f"Invalid decrypted question/answer: {q}")
        questions.append({"query_id": q, "query": query})
        gold.append({"query_id": q, "query": query, "answer": answer})
    expected = read_json(ROOT / "provenance/data-sources.json")["browsecomp_questions_sha256"]
    body = "".join(json.dumps(q, ensure_ascii=False) + "\n" for q in questions)
    if hashlib.sha256(body.encode()).hexdigest() != expected:
        raise ValueError("Question text differs from the frozen paper cohort")
    out.mkdir(parents=True, exist_ok=False)
    write_jsonl(out / "questions.jsonl", questions)
    write_jsonl(out / "evaluator-only/gold.jsonl", gold)
    write_json(out / "prepared.json", {"questions": len(ids), "questions_sha256": sha256(out / "questions.jsonl"),
                                      "gold_sha256": sha256(out / "evaluator-only/gold.jsonl")})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="benchmark", required=True)
    bcp = commands.add_parser("browsecomp")
    source = bcp.add_mutually_exclusive_group(required=True)
    source.add_argument("--source", type=Path, help="Existing official decrypted JSONL")
    source.add_argument("--download", action="store_true", help="Download/decrypt official test split; set BROWSECOMP_PLUS_CANARY")
    bcp.add_argument("--out", type=Path, default=ROOT / "data/browsecomp/inputs")
    neuclir = commands.add_parser("neuclir")
    neuclir.add_argument("--out", type=Path, default=ROOT / "data/neuclir/qrels.mlir.gains.txt")
    args = parser.parse_args()
    if args.benchmark == "browsecomp":
        if args.source:
            rows = read_jsonl(args.source)
        else:
            password = os.environ.get("BROWSECOMP_PLUS_CANARY")
            if not password:
                parser.error("Set BROWSECOMP_PLUS_CANARY to the official dataset canary; see docs/reproduce.md#browsecomp-plus")
            from datasets import load_dataset
            dataset = load_dataset("Tevatron/browsecomp-plus", revision=BCP_REVISION, split="test")
            rows = [{"query_id": str(row["query_id"]), "query": decrypt(row["query"], password),
                     "answer": decrypt(row["answer"], password)} for row in dataset]
        prepare_browsecomp(rows, args.out)
        print(f"Prepared 830 questions and separate evaluator-only gold in {args.out}")
    else:
        if args.out.exists():
            if sha256(args.out) != QRELS_SHA256:
                parser.error("Existing qrels have a different hash; choose another path")
            print("Pinned qrels already present and verified")
            return
        import certifi
        url = f"https://huggingface.co/datasets/neuclir/bench/resolve/{NEUCLIR_REVISION}/data/qrels.mlir.gains.txt"
        with urlopen(url, context=ssl.create_default_context(cafile=certifi.where()), timeout=120) as response:
            body = response.read()
        if hashlib.sha256(body).hexdigest() != QRELS_SHA256:
            raise ValueError("Downloaded qrels do not match the frozen paper version")
        args.out.parent.mkdir(parents=True, exist_ok=True)
        with args.out.open("xb") as handle:
            handle.write(body)
        print(f"Downloaded and verified official 105-topic qrels: {args.out}")


if __name__ == "__main__":
    main()
