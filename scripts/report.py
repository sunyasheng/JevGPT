"""Rebuild JevGPT's rows of paper Tables 1 and 2 from per-item records, without APIs."""
import argparse
import csv
import io
import json
import math
from pathlib import Path
from statistics import mean

try:
    from .common import ROOT, by_id, gpt_cost, read_json, read_jsonl
except ImportError:
    from common import ROOT, by_id, gpt_cost, read_json, read_jsonl


def cohort_ids(path):
    value = read_json(path)
    ids = value if isinstance(value, list) else value.get("ids", value.get("all"))
    if not ids or not all(isinstance(q, str) for q in ids) or len(set(ids)) != len(ids):
        raise ValueError("Cohort must contain a nonempty list of unique string IDs")
    return ids


def summarize(rows, ids, benchmark):
    grouped = by_id(rows)
    if set(grouped) != set(ids):
        raise ValueError(f"Records must match the frozen cohort: missing={sorted(set(ids)-set(grouped))}, "
                         f"extra={sorted(set(grouped)-set(ids))}")
    rows = [grouped[q] for q in ids]
    result = {"n": len(ids), "completed": sum(r["status"] == "completed" for r in rows),
              "items_with_unknown_usage": sum(bool(r.get("usage_unknown", True)) for r in rows)}

    def average(field, usage=False):
        if usage and result["items_with_unknown_usage"]:
            return None
        values = [r.get(field) for r in rows]
        if any(not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) for v in values):
            return None
        if any(v < 0 for v in values):
            raise ValueError(f"Negative resource measurement: {field}")
        return mean(values)

    inp, out = average("input_tokens", True), average("output_tokens", True)
    result.update(tokens_mean_k=(inp + out) / 1000 if inp is not None and out is not None else None,
                  searches_mean=average("search_calls"), seconds_mean=average("elapsed_seconds"),
                  s2_usd_mean=average("gpt_cost_usd", True), s1_usd_mean=average("jev_cost_usd", True))
    if benchmark == "browsecomp":
        result["correct"] = sum(r.get("correct") is True for r in rows)
        result["unknown_grades"] = sum(type(r.get("correct")) is not bool for r in rows)
        result["accuracy_percent"] = 100 * result["correct"] / len(ids) if not result["unknown_grades"] else None
    else:
        measures = [r["metrics"] for r in rows]
        for metric in measures:
            for key in ("nDCG@20", "R@20", "P@20", "F1@20"):
                if not isinstance(metric.get(key), (float, int)) or not 0 <= metric[key] <= 1 + 1e-12:
                    raise ValueError(f"Invalid metric: {key}")
            p, recall = metric["P@20"], metric["R@20"]
            f1 = 2 * p * recall / (p + recall) if p + recall else 0.0
            if not math.isclose(f1, metric["F1@20"], abs_tol=1e-12):
                raise ValueError("F1 must be calculated per topic before macro averaging")
        result.update(ndcg20=mean(m["nDCG@20"] for m in measures),
                      recall20_percent=100 * mean(m["R@20"] for m in measures),
                      f1_20_percent=100 * mean(m["F1@20"] for m in measures))
    return result


def paper_rows():
    return {b: summarize(read_jsonl(ROOT / "results" / f"{b}.jsonl"),
                         cohort_ids(ROOT / "splits" / f"{b}.json"), b)
            for b in ("browsecomp", "neuclir")}


def verify_paper(rows):
    expected = read_json(ROOT / "results/paper.json")
    for benchmark, computed in rows.items():
        for key, reference in expected[benchmark].items():
            value = computed.get(key)
            if value is None or not math.isclose(value, reference, rel_tol=1e-10, abs_tol=1e-10):
                raise ValueError(f"Paper mismatch: {benchmark}.{key}: {value} != {reference}")
        for row in read_jsonl(ROOT / "results" / f"{benchmark}.jsonl"):
            cost = gpt_cost(row["input_tokens"], row["cached_input_tokens"], row["output_tokens"])
            if not math.isclose(cost, row["gpt_cost_usd"], abs_tol=1e-9):
                raise ValueError(f"GPT accounting mismatch: {benchmark}/{row['query_id']}")
            if not math.isclose(row["jev_input_tokens"] * 0.042 / 1e6, row["jev_cost_usd"], abs_tol=1e-9):
                raise ValueError(f"Jev accounting mismatch: {benchmark}/{row['query_id']}")


COLUMNS = {
    "browsecomp": [("accuracy_percent", "Accuracy (%)", ".2f"), ("tokens_mean_k", "Tokens (K)", ".0f"),
                   ("searches_mean", "Searches", ".2f"), ("seconds_mean", "Time (s)", ".1f"),
                   ("s2_usd_mean", "S2 ($)", ".4f"), ("s1_usd_mean", "S1 ($)", ".4f")],
    "neuclir": [("ndcg20", "nDCG@20", ".4f"), ("recall20_percent", "Recall@20 (%)", ".2f"),
                ("f1_20_percent", "F1@20 (%)", ".2f"), ("tokens_mean_k", "Tokens (K)", ".0f"),
                ("searches_mean", "Searches", ".2f"), ("seconds_mean", "Time (s)", ".1f"),
                ("s2_usd_mean", "S2 ($)", ".4f"), ("s1_usd_mean", "S1 ($)", ".4f")],
}


def table(benchmark, row):
    headers = ["Method", "Retriever", "N"] + [label for _, label, _ in COLUMNS[benchmark]]
    cells = ["JevGPT", "Hybrid BM25", str(row["n"])] + [
        format(row[key], spec) if row[key] is not None else "—" for key, _, spec in COLUMNS[benchmark]]
    return headers, cells


def render_markdown(rows):
    parts = []
    for benchmark, row in rows.items():
        title = "BrowseComp-Plus · Table 1" if benchmark == "browsecomp" else "NeuCLIRBench · Table 2"
        headers, cells = table(benchmark, row)
        parts.extend([f"{title}\n", "| " + " | ".join(headers) + " |",
                      "| " + " | ".join(["---", "---"] + ["---:"] * (len(headers) - 2)) + " |",
                      "| " + " | ".join(cells) + " |", ""])
        if row["items_with_unknown_usage"] or row.get("unknown_grades"):
            parts.append(f"Unknown usage: {row['items_with_unknown_usage']}; unresolved grades: {row.get('unknown_grades', 0)}.\n")
    return "\n".join(parts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Compare every unrounded paper value and GPT token cost")
    parser.add_argument("--out", type=Path, help="Write Markdown, JSON, CSV and LaTeX rows to a generated directory")
    parser.add_argument("--benchmark", choices=COLUMNS)
    parser.add_argument("--records", type=Path, help="Scored JSONL from a new run")
    parser.add_argument("--cohort", type=Path, help="New run manifest.json (or a split with an all/ids list)")
    args = parser.parse_args()
    if args.records or args.benchmark or args.cohort:
        if not (args.records and args.benchmark and args.cohort) or args.check:
            parser.error("A new run needs --benchmark, --records and --cohort; --check applies to released paper records")
        rows = {args.benchmark: summarize(read_jsonl(args.records), cohort_ids(args.cohort), args.benchmark)}
    else:
        rows = paper_rows()
    if args.check:
        verify_paper(rows)
    markdown = render_markdown(rows)
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "jevgpt-tables.md").write_text(markdown, encoding="utf-8")
        (args.out / "jevgpt-tables.json").write_text(json.dumps(rows, indent=2, allow_nan=False) + "\n")
        for benchmark, row in rows.items():
            headers, cells = table(benchmark, row)
            stream = io.StringIO()
            writer = csv.writer(stream)
            writer.writerows([headers, cells])
            (args.out / f"{benchmark}.csv").write_text(stream.getvalue())
            # Standalone row fragments, ready to insert into the manuscript tables.
            tex = " & ".join(cells[:2] + [c if c != "—" else r"\textemdash{}" for c in cells[3:]]) + r"\\" + "\n"
            (args.out / f"{benchmark}.tex").write_text(tex)
    print(markdown)
    if args.check:
        print("Verified both rows against every unrounded paper value.")


if __name__ == "__main__":
    main()
