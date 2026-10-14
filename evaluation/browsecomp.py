"""Grade a completed BCP run with the original prompt/parser and a separate GPT-5.5 medium judge."""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import ssl
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evaluation.browsecomp_parser import parse_judge_response
from scripts.common import ROOT, browsecomp_research_query, by_id, read_json, read_jsonl, sha256, write_json, write_jsonl


def response_text(response):
    return "\n".join(c.get("text", "") for item in response.get("output", []) if item.get("type") == "message"
                     for c in item.get("content", []) if c.get("type") == "output_text")


def grade(row, gold, template, args, folder, api_key):
    outcome = {"query_id": row["query_id"], "correct": None, "grade_status": "unknown",
               "research_status": row["status"]}
    if row["status"] != "completed" or not row.get("final_answer", "").strip():
        outcome.update(correct=False, grade_status="research_failed" if row["status"] != "completed" else "empty_answer")
        return outcome
    prompt = template.format(question=gold["query"], response=row["final_answer"], correct_answer=gold["answer"])
    body = {"model": args.model, "input": prompt, "reasoning": {"effort": "medium", "summary": "detailed"},
            "max_output_tokens": 4096}
    write_json(folder / "request.json", body)
    request = Request(args.base_url.rstrip("/") + "/responses", data=json.dumps(body).encode(),
                      headers={"Content-Type": "application/json", args.auth_header:
                               "Bearer " + api_key if args.auth_header == "Authorization" else api_key})
    for attempt in range(1, 4):
        try:
            import certifi
            with urlopen(request, timeout=180, context=ssl.create_default_context(cafile=certifi.where())) as handle:
                response = json.load(handle)
            write_json(folder / f"response-{attempt}.json", response)
            parsed = parse_judge_response(response_text(response))
            returned = response.get("model", "")
            same_model = re.fullmatch(re.escape(args.expected_model) + r"(?:-\d{4}-\d{2}-\d{2})?", returned) is not None
            valid = not parsed["parse_error"] and response.get("status") == "completed" and same_model
            outcome.update(correct=parsed["correct"] if valid else None, grade_status="valid" if valid else "unknown",
                           judge_result=parsed, returned_model=returned, usage=response.get("usage"), attempts=attempt)
            return outcome
        except HTTPError as error:
            write_json(folder / f"error-{attempt}.json", {"http_status": error.code})
            outcome.update(http_status=error.code, attempts=attempt)
            if error.code != 429 and not 500 <= error.code < 600:
                return outcome
        except (URLError, TimeoutError, ConnectionError) as error:
            write_json(folder / f"error-{attempt}.json", {"error_type": type(error).__name__})
            outcome.update(error_type=type(error).__name__, attempts=attempt)
        if attempt < 3:
            time.sleep(2 ** attempt)
    return outcome


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True, help="Directory created by scripts/run.py browsecomp")
    parser.add_argument("--gold", type=Path, required=True, help="Decrypted official BCP JSONL; used only here")
    parser.add_argument("--out", type=Path, required=True, help="New evaluator-only directory")
    parser.add_argument("--base-url", default=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"))
    parser.add_argument("--model", default=os.environ.get("JEVGPT_GRADER_MODEL", "gpt-5.5"))
    parser.add_argument("--expected-model", help="Returned model ID to verify when --model is a deployment alias; defaults to --model")
    parser.add_argument("--api-key-env", default="OPENAI_API_KEY")
    parser.add_argument("--auth-header", choices=("Authorization", "api-key"), default="Authorization")
    parser.add_argument("--resume", action="store_true", help="Keep existing first grades after an interrupted evaluator")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    args.expected_model = args.expected_model or args.model
    manifest = read_json(args.run / "manifest.json")
    if manifest["benchmark"] != "browsecomp" or not (args.run / "complete.json").is_file():
        parser.error("Expected a completed BrowseComp-Plus run directory")
    ids = manifest["ids"]
    rows = by_id(read_jsonl(args.run / "records.jsonl"))
    gold = by_id(read_jsonl(args.gold))
    if set(rows) != set(ids) or not set(ids) <= set(gold):
        parser.error("Records and gold must cover the entire frozen run cohort")
    for q in ids:
        query = (args.run / "inputs" / f"{q}.tsv").read_text().rstrip("\n").split("\t", 1)[1]
        if browsecomp_research_query(gold[q]["query"]) != query:
            parser.error(f"Question text does not match the grading dataset: {q}")
    prompt_path = ROOT / "evaluation/browsecomp_prompt.txt"
    protocol = {"ids": ids, "model": args.model, "expected_model": args.expected_model,
                "base_url": args.base_url, "auth_header": args.auth_header, "effort": "medium", "max_output_tokens": 4096,
                "records_sha256": sha256(args.run / "records.jsonl"), "gold_sha256": sha256(args.gold),
                "prompt_sha256": sha256(prompt_path), "parser_sha256": sha256(ROOT / "evaluation/browsecomp_parser.py")}
    if args.dry_run:
        print(json.dumps({"topics": len(ids), "eligible_for_judge": sum(r["status"] == "completed" and bool(r.get("final_answer", "").strip()) for r in rows.values()),
                          "model": args.model, "expected_model": args.expected_model, "effort": "medium"}, indent=2))
        return
    api_key = os.environ.get(args.api_key_env)
    if not api_key:
        parser.error(f"Export {args.api_key_env} for the separate evaluator")
    if args.out.exists():
        if not args.resume or read_json(args.out / "protocol.json") != protocol:
            parser.error("Use a new evaluator directory, or --resume with identical inputs and settings")
    else:
        args.out.mkdir(parents=True)
        write_json(args.out / "protocol.json", protocol)
    template = prompt_path.read_text().strip()
    scored = []
    for q in ids:
        folder = args.out / q
        folder.mkdir(exist_ok=True)
        outcome_path = folder / "outcome.json"
        if outcome_path.exists():
            outcome = read_json(outcome_path)
        elif (folder / "started.json").exists():
            outcome = {"query_id": q, "correct": None, "grade_status": "interrupted_unknown"}
            write_json(outcome_path, outcome)
        else:
            write_json(folder / "started.json", {"query_id": q})
            outcome = grade(rows[q], gold[q], template, args, folder, api_key)
            write_json(outcome_path, outcome)
        scored.append({**rows[q], "correct": outcome["correct"], "grade_status": outcome["grade_status"]})
        print(json.dumps({"query_id": q, "grade_status": outcome["grade_status"], "correct": outcome["correct"]}), flush=True)
    scored_path = args.out / "scored.jsonl"
    if not scored_path.exists():
        write_jsonl(scored_path, scored)
    print(json.dumps({"n": len(ids), "correct": sum(r["correct"] is True for r in scored),
                      "unknown": sum(r["correct"] is None for r in scored)}))
    if any(r["correct"] is None for r in scored):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
