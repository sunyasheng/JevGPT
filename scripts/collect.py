"""Read a trial's Pi events and Jev ledger using the paper's accounting rules."""
import argparse
import json
import re
from pathlib import Path

try:
    from .common import PRICES, gpt_cost, read_json, read_jsonl, sha256, write_jsonl
except ImportError:
    from common import PRICES, gpt_cost, read_json, read_jsonl, sha256, write_jsonl


def parse_docids(text):
    """The paper's Exact Answer JSON-list parser; duplicates retain first rank."""
    match = re.search(r"^\s*Exact Answer:\s*", text or "", re.M)
    if not match:
        raise ValueError("Missing Exact Answer")
    rest = text[match.end():].lstrip()
    if rest.startswith("```"):
        rest = rest.split("\n", 1)[1].lstrip()
    result, _ = json.JSONDecoder().raw_decode(rest)
    if not isinstance(result, list) or any(not isinstance(d, str) or not d.strip() for d in result):
        raise ValueError("Exact Answer is not a list of nonempty docids")
    return list(dict.fromkeys(result))


def collect_trial(folder, qid, benchmark, prices=None):
    prices = prices or (dict(input=None, cached_input=None, output=None, jev_input=0.042) if benchmark == "cmass" else PRICES)
    folder = Path(folder)
    run_path = folder / f"{qid}.json"
    if not run_path.is_file():
        return {"query_id": qid, "status": "infrastructure_failed", "final_answer": "",
                **({"dataset": qid.split("__", 1)[0]} if benchmark == "cmass" else {}),
                "usage_unknown": True, "submitted_docids": [], "parse_error": "Missing trial artifact"}
    run = read_json(run_path)
    events = read_jsonl(folder / "raw-events" / f"{qid}.jsonl")
    jev_path = folder / "jev-find.jsonl"
    jev = read_jsonl(jev_path) if jev_path.is_file() else []
    messages = [e["message"] for e in events
                if e.get("type") == "message_end" and e.get("message", {}).get("role") == "assistant"]
    usage = {k: sum((m.get("usage") or {}).get(k, 0) for m in messages)
             for k in ("input", "cacheRead", "cacheWrite", "output")}
    total_input = usage["input"] + usage["cacheRead"] + usage["cacheWrite"]
    judgments = [r for r in jev if r.get("type") in ("judge", "adaptive_gate")]
    jev_tokens = sum(((r.get("response") or {}).get("usage") or {}).get("input_tokens", 0)
                     for r in judgments)
    missing_gpt = sum(not isinstance(m.get("usage"), dict) or not any(
        m["usage"].get(k, 0) for k in ("input", "cacheRead", "cacheWrite")) for m in messages)
    missing_jev = sum("input_tokens" not in ((r.get("response") or {}).get("usage") or {})
                      for r in judgments)
    # A failed request without usage remains unpriced, never silently counted as free.
    record = {
        "query_id": str(qid), "status": run["status"],
        "final_answer": next((r["output"] for r in reversed(run.get("result", []))
                              if r.get("type") == "output_text" and not r["output"].startswith("pi stderr:")), ""),
        "input_tokens": total_input, "cached_input_tokens": usage["cacheRead"],
        "output_tokens": usage["output"], "gpt_calls": len(messages),
        "gpt_cost_usd": ((total_input - usage["cacheRead"]) * prices["input"] + usage["cacheRead"] * prices["cached_input"] + usage["output"] * prices["output"]) / 1e6
            if all(prices.get(k) is not None for k in ("input", "cached_input", "output")) else None,
        "jev_input_tokens": jev_tokens, "jev_cost_usd": jev_tokens * PRICES["jev_input"] / 1e6,
        "jev_requests": len(judgments), "jev_failed_requests": sum(not r.get("ok") for r in judgments),
        "search_calls": sum(e.get("type") == "tool_execution_start" and e.get("toolName") == "search"
                            for e in events),
        "elapsed_seconds": run["stats"]["elapsed_seconds"],
        "usage_unknown": bool(missing_gpt or missing_jev or not messages),
        "gpt_calls_missing_usage": missing_gpt, "jev_requests_missing_usage": missing_jev,
        "raw_result_sha256": sha256(run_path),
    }
    if benchmark == "cmass":
        ends = [e for e in events if e.get("type") == "tool_execution_end" and not e.get("isError")]
        previewed, delivered = set(), set()
        for e in ends:
            if e.get("toolName") in ("search", "read_search_results"):
                result = e.get("result", {})
                rendered = "\n".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
                displayed = set(re.findall(r"shard_\d{5}_\d+", rendered))
                if not result.get("isError"):
                    previewed.update(displayed & set((result.get("details") or {}).get("previewedDocids", [])))
            if e.get("toolName") in ("search", "read_search_results", "jev_find", "read_document"):
                delivered.update(re.findall(r"shard_\d{5}_\d+", json.dumps(e.get("result", {}).get("content", []))))
        requests = folder / "backend-requests.jsonl"
        backend = read_jsonl(requests) if requests.exists() else []
        record.update(dataset=qid.split("__", 1)[0], search_shown_docids=sorted(previewed),
            tool_visible_docids=sorted(delivered),
            cached_retrieval_docids=sorted({d for r in backend if r["operation"] == "search" for d in r["docids"]}),
            backend_read_docids=sorted({r["request"]["docid"] for r in backend if r["operation"] == "readDocument" and r.get("found")}),
            read_document_calls=sum(e.get("type") == "tool_execution_start" and e.get("toolName") == "read_document" for e in events),
            jev_find_calls=sum(e.get("type") == "tool_execution_start" and e.get("toolName") == "jev_find" for e in events),
            prices_usd_per_million=prices, cost_unknown=any(prices.get(k) is None for k in ("input", "cached_input", "output")))
        # Pi assistant events do not expose compaction token usage. Preserve
        # known observations and mark the missing amount rather than pricing it
        # at zero. Published records retain their original transport accounting.
        compactions = sum(e.get("type") == "compaction_start" for e in events)
        missing = missing_gpt + compactions
        unknown_gpt = bool(missing or not messages)
        unknown_jev = bool(missing_jev or (record["jev_find_calls"] and not jev_path.is_file()))
        record.update(compaction_requests=compactions,
                      accounting_basis="Pi assistant events; compaction usage unreported",
                      gpt_requests_missing_usage=missing,
                      known_jev_cost_usd=jev_tokens * prices["jev_input"] / 1e6,
                      known_gpt_cost_usd=record["gpt_cost_usd"],
                      input_tokens_total=total_input if not unknown_gpt else None,
                      jev_input_tokens_total=jev_tokens if not unknown_jev else None,
                      unknown_input_tokens=None if unknown_gpt or unknown_jev else 0,
                      unknown_cost_usd=None if unknown_gpt or unknown_jev else 0,
                      usage_unknown=unknown_gpt or unknown_jev)
        if unknown_gpt:
            record["gpt_cost_usd"] = None
        record["jev_cost_usd"] = record["known_jev_cost_usd"] if not unknown_jev else None
        record["cost_unknown"] = record["gpt_cost_usd"] is None or record["jev_cost_usd"] is None
    if benchmark == "neuclir":
        try:
            record.update(submitted_docids=parse_docids(record["final_answer"]), parse_error=None)
        except (ValueError, IndexError) as error:
            record.update(submitted_docids=[], parse_error=str(error))
    return record


def collect_run(folder):
    folder = Path(folder)
    manifest = read_json(folder / "manifest.json")
    return [collect_trial(folder / "trials" / q, q, manifest["benchmark"], manifest.get("prices_usd_per_million"))
            for q in manifest["ids"]]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    rows = collect_run(args.run)
    write_jsonl(args.out, rows)
    print(json.dumps({"records": len(rows), "usage_unknown": sum(r["usage_unknown"] for r in rows)}))


if __name__ == "__main__":
    main()
