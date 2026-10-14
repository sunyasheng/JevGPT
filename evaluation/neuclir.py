"""Offline NeuCLIRBench scoring: linear 0/1/3 gains, fixed P@20, macro topic means."""
import argparse
from collections import defaultdict
import json
import math
from pathlib import Path
from statistics import mean
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.common import ROOT, by_id, read_jsonl, sha256, write_json, write_jsonl
from scripts.report import cohort_ids


def read_qrels(path):
    result = defaultdict(dict)
    with Path(path).open() as handle:
        for line in handle:
            if not line.strip():
                continue
            qid, _, docid, gain = line.split()
            gain = int(gain)
            if gain not in (0, 1, 3):
                raise ValueError("Expected official NeuCLIRBench 0/1/3 gains, without another gain transform")
            if docid in result[qid] and result[qid][docid] != gain:
                raise ValueError(f"Conflicting qrel: {qid}/{docid}")
            result[qid][docid] = gain
    return dict(result)


def topic_metrics(docids, judgments):
    if len(docids) != len(set(docids)):
        raise ValueError("Duplicate document IDs in a ranking")
    top = docids[:20]
    gains = [judgments.get(d, 0) for d in top]
    ideal = sorted(judgments.values(), reverse=True)[:20]
    dcg = sum(g / math.log2(rank + 2) for rank, g in enumerate(gains))
    idcg = sum(g / math.log2(rank + 2) for rank, g in enumerate(ideal))
    relevant = sum(g > 0 for g in judgments.values())
    hits = sum(g > 0 for g in gains)
    precision = hits / 20
    recall = hits / relevant if relevant else 0.0
    return {"nDCG@20": dcg / idcg if idcg else 0.0, "R@20": recall, "P@20": precision,
            "F1@20": 2 * precision * recall / (precision + recall) if precision + recall else 0.0,
            "returned": len(docids)}


def load_trec(path):
    rows = defaultdict(list)
    for line in Path(path).read_text().splitlines():
        if not line.strip():
            continue
        qid, _, docid, rank, score, _ = line.split()
        rows[qid].append((int(rank), float(score), docid))
    result = {}
    for qid, ranking in rows.items():
        ranking.sort()
        if [r[0] for r in ranking] != list(range(1, len(ranking) + 1)):
            raise ValueError(f"Expected consecutive one-based ranks: {qid}")
        scores = [r[1] for r in ranking]
        if not all(math.isfinite(s) for s in scores) or any(a <= b for a, b in zip(scores, scores[1:])):
            raise ValueError("TREC scores must strictly decrease with rank (the released/exported runs do)")
        docids = [r[2] for r in ranking]
        if len(docids) != len(set(docids)):
            raise ValueError(f"Duplicate query/document pair: {qid}")
        result[qid] = docids
    return result


def evaluate(rankings, qrels, ids):
    if not set(ids) <= set(qrels):
        raise ValueError("The qrels do not contain every selected topic")
    if set(rankings) - set(ids):
        raise ValueError("Run contains topics outside the selected cohort")
    per = {q: topic_metrics(rankings.get(q, []), qrels[q]) for q in ids}
    return {"topics": len(ids), "topics_with_output": sum(bool(rankings.get(q)) for q in ids),
            "metrics": {k: mean(m[k] for m in per.values()) for k in ("nDCG@20", "R@20", "P@20", "F1@20")},
            "per_topic": per}


def rank_records(rows, ids):
    indexed = by_id(rows)
    if set(indexed) - set(ids):
        raise ValueError("Records contain topics outside the selected cohort")
    return {q: list(dict.fromkeys(indexed[q].get("submitted_docids", [])))
            if q in indexed and indexed[q]["status"] == "completed" and not indexed[q].get("parse_error") else []
            for q in ids}


def export_trec(rankings, ids, path):
    with Path(path).open("x") as handle:
        for qid in ids:
            for rank, docid in enumerate(rankings.get(qid, []), 1):
                if not isinstance(docid, str) or not docid or any(c.isspace() for c in docid):
                    raise ValueError("Invalid document ID")
                handle.write(f"{qid} Q0 {docid} {rank} {len(rankings[qid]) + 1 - rank} jevgpt\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--run", type=Path, help="TREC run with strictly decreasing rank scores")
    source.add_argument("--records", type=Path, help="records.jsonl from scripts/run.py")
    parser.add_argument("--qrels", type=Path, required=True)
    parser.add_argument("--cohort", type=Path, default=ROOT / "splits/neuclir.json")
    parser.add_argument("--out", type=Path, required=True, help="JSON evaluation (TREC input) or scored JSONL (records input)")
    args = parser.parse_args()
    ids = cohort_ids(args.cohort)
    records = read_jsonl(args.records) if args.records else None
    rankings = rank_records(records, ids) if records is not None else load_trec(args.run)
    result = evaluate(rankings, read_qrels(args.qrels), ids)
    result["qrels_sha256"] = sha256(args.qrels)
    result["input_sha256"] = sha256(args.records or args.run)
    if records is None:
        write_json(args.out, result)
    else:
        indexed = by_id(records)
        rows = [{**indexed.get(q, {"query_id": q, "status": "missing", "usage_unknown": True}),
                 "metrics": result["per_topic"][q]} for q in ids]
        write_jsonl(args.out, rows)
        write_json(args.out.with_suffix(".evaluation.json"), result)
        export_trec(rankings, ids, args.out.with_suffix(".trec"))
    print(json.dumps({k: result[k] for k in ("topics", "topics_with_output", "metrics")}, indent=2))


if __name__ == "__main__":
    main()
