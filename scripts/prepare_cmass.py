"""Prepare pinned CMASS questions and isolated evaluator inputs, without model calls."""

import base64
import hashlib
import json
from pathlib import Path
import random
import re
import ssl
from urllib.request import urlopen

from common import ROOT, read_json, write_json, write_jsonl, sha256

COUNTS = {"bcp": 80, "trqa": 68, "dsqa": 71, "hotpotqa": 204}


def decode(row):
    result = dict(row)
    key = hashlib.sha256(row["canary"].encode()).digest()
    for name in ("id", "question", "answer", "query_id", "doc_id", "answer_set"):
        if name in row:
            raw = base64.b64decode(row[name], validate=True)
            result[name] = bytes(
                c ^ key[i % len(key)] for i, c in enumerate(raw)
            ).decode()
            if name == "answer_set":
                result[name] = json.loads(result[name])
    return result


def prepare(source, out):
    pin = read_json(ROOT / "provenance/cmass-data.json")
    if out.exists():
        raise FileExistsError("Use a new CMASS input directory")
    questions, gold, qrels, source_hashes, splits = [], [], [], {}, {}

    def rows(name):
        if source:
            raw = (source / name).read_bytes()
        else:
            import certifi

            with urlopen(
                f"https://huggingface.co/datasets/castorini/cmass/resolve/{pin['revision']}/{name}",
                timeout=120,
                context=ssl.create_default_context(cafile=certifi.where()),
            ) as r:
                raw = r.read()
        blob = hashlib.sha1(f"blob {len(raw)}\0".encode() + raw).hexdigest()
        if blob != pin["files"][name]:
            raise ValueError(f"CMASS source hash mismatch: {name}")
        source_hashes[name] = hashlib.sha256(raw).hexdigest()
        return [decode(json.loads(line)) for line in raw.splitlines() if line.strip()]

    for dataset, count in COUNTS.items():
        items = rows(f"{dataset}/queries.jsonl")
        ids = [str(x["id"]) for x in items]
        if len(items) != count or len(set(ids)) != count:
            raise ValueError(f"Invalid {dataset} question count")
        sets = (
            {str(r["id"]): r["answer_set"] for r in rows("dsqa/answer_sets.jsonl")}
            if dataset == "dsqa"
            else {}
        )
        if dataset == "dsqa" and (
            set(sets) != set(ids)
            or any(not isinstance(v, list) or not v for v in sets.values())
        ):
            raise ValueError("DSQA answer-set membership mismatch")
        splits[dataset] = []
        for item in items:
            bare = str(item["id"])
            if not re.fullmatch(r"[A-Za-z0-9_-]+", bare):
                raise ValueError("Unsafe source ID")
            qid = f"{dataset}__{bare}"
            query = re.sub(r"[\t\r\n]+", " ", item["question"]).strip()
            if not query or not isinstance(item["answer"], str):
                raise ValueError("Invalid question or answer")
            question = dict(query_id=qid, dataset=dataset, source_id=bare, query=query)
            questions.append(question)
            gold.append(
                dict(
                    question,
                    answer=item["answer"],
                    **({"answer_set": sets[bare]} if sets else {}),
                )
            )
            splits[dataset].append(qid)
        seen = set()
        for role, name in [
            ("all", "qrels"),
            ("inclusion", "qrels_inclusion"),
            ("exclusion", "qrels_exclusion"),
        ]:
            pairs = set()
            for item in rows(f"{dataset}/{name}.jsonl"):
                bare, doc = str(item["query_id"]), item["doc_id"]
                if (
                    bare not in ids
                    or item["relevance"] != 1
                    or not re.fullmatch(r"shard_\d{5}_\d+", doc)
                ):
                    raise ValueError("Invalid qrel")
                if (bare, doc) in pairs:
                    raise ValueError("Duplicate qrel")
                pairs.add((bare, doc))
                qrels.append(dict(query_id=f"{dataset}__{bare}", docid=doc, role=role))
            if role == "all":
                seen = {i for i, _ in pairs}
        if seen != set(ids):
            raise ValueError("Missing qrels")
    if sum(r["role"] == "all" for r in qrels) != 40736:
        raise ValueError("Unexpected v2026.10.25 qrel count")
    splits["all"] = [r["query_id"] for r in questions]
    rng = random.Random(20261031)
    samples = {d: rng.sample(splits[d], 5) for d in COUNTS}
    splits["pilot20"] = [samples[d][i] for i in range(5) for d in COUNTS]
    splits["smoke4"] = splits["pilot20"][:4]
    out.mkdir(parents=True, mode=0o700)
    write_jsonl(out / "questions.jsonl", questions)
    write_jsonl(out / "evaluator-only/gold.jsonl", gold)
    write_jsonl(out / "evaluator-only/qrels.jsonl", qrels)
    write_json(out / "splits.json", splits)
    write_json(
        out / "prepared.json",
        dict(
            revision=pin["revision"],
            tag=pin["tag"],
            questions=len(questions),
            qrels=40736,
            source_sha256=source_hashes,
            normalization="TAB/CR/LF runs replaced by one space; strip ends",
            seed=20261031,
            files={
                str(p.relative_to(out)): sha256(p)
                for p in out.rglob("*")
                if p.is_file()
            },
        ),
    )
    print(json.dumps(dict(questions=len(questions), qrels=40736, out=str(out))))
