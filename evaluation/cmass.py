"""Grade CMASS with the pinned official prompts and report multiple retrieval scopes."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from http.client import HTTPException
import os
import re
from pathlib import Path
import ssl
import sys
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.common import (
    ROOT,
    by_id,
    read_json,
    read_jsonl,
    sha256,
    write_json,
    write_jsonl,
)
from evaluation.cmass_protocol.protocol import judge_request, verify_dsqa_verdict
from scripts.cmass_results import summarize, validate_ids


def text(response):
    return "\n".join(
        c.get("text", "")
        for m in response.get("output", [])
        if m.get("type") == "message"
        for c in m.get("content", [])
        if c.get("type") == "output_text"
    )


def visible_search_ids(events):
    """A truncated preview may advertise more IDs in details than it displays."""
    found = set()
    for event in events:
        if event.get("type") != "tool_execution_end" or event.get("toolName") not in (
            "search",
            "read_search_results",
        ):
            continue
        result = event.get("result", {})
        if event.get("isError") or result.get("isError"):
            continue
        rendered = "\n".join(
            c.get("text", "")
            for c in result.get("content", [])
            if c.get("type") == "text"
        )
        displayed = set(re.findall(r"shard_\d{5}_\d+", rendered))
        found.update(
            displayed & set((result.get("details") or {}).get("previewedDocids", []))
        )
    return sorted(found)


def parse_verdict(value, gold):
    obj = json.loads(value)
    if gold["dataset"] == "dsqa":
        strict, relaxed = verify_dsqa_verdict(obj, gold["answer_set"])
    else:
        if set(obj) != {
            "extracted_final_answer",
            "correct_answer",
            "reasoning",
            "correct",
            "confidence",
        }:
            raise ValueError("Invalid scalar verdict schema")
        if obj["correct_answer"] != gold["answer"]:
            # Only normalize a serialized scalar's outer JSON quotes. Keep the
            # original response on disk and never infer/change the verdict.
            try:
                decoded = json.loads(gold["answer"])
            except ValueError:
                decoded = None
            if not isinstance(decoded, str) or obj["correct_answer"] != decoded:
                raise ValueError("Gold echo differs beyond outer JSON quotes")
            obj = {**obj, "correct_answer": gold["answer"]}
        if type(obj["correct"]) is not bool or not isinstance(obj["reasoning"], str):
            raise ValueError("Invalid scalar verdict")
        if obj["extracted_final_answer"] is not None and not isinstance(
            obj["extracted_final_answer"], str
        ):
            raise ValueError("Invalid extracted answer")
        if (
            type(obj["confidence"]) not in (int, float)
            or not 0 <= obj["confidence"] <= 100
        ):
            raise ValueError("Invalid confidence")
        strict = relaxed = obj["correct"]
    return obj, strict, relaxed


class Transport:
    """Standard Responses SSE transport; authentication never enters artifacts."""

    def __init__(self, args, api_key):
        self.args = args
        self.api_key = api_key

    def request(self, body):
        import certifi

        value = (
            "Bearer " + self.api_key
            if self.args.auth_header == "Authorization"
            else self.api_key
        )
        request = Request(
            self.args.base_url.rstrip("/") + "/responses",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", self.args.auth_header: value},
        )
        with urlopen(
            request,
            timeout=240,
            context=ssl.create_default_context(cafile=certifi.where()),
        ) as response:
            data = []
            for raw in response:
                line = raw.decode("utf-8").rstrip("\r\n")
                if line.startswith("data:"):
                    data.append(line[5:].lstrip(" "))
                elif not line and data:
                    payload = "\n".join(data)
                    data = []
                    if payload == "[DONE]":
                        break
                    event = json.loads(payload)
                    if event.get("type") in (
                        "response.completed",
                        "response.failed",
                        "response.incomplete",
                    ):
                        return event["response"]
                    if event.get("type") == "error":
                        raise RuntimeError("Judge stream returned an error")
        raise RuntimeError("Judge stream ended without a terminal response")


def grade(row, gold, args, folder, transport):
    """Keep the first terminal grade; resume never repeats an uncertain request."""
    folder.mkdir(exist_ok=True)
    outcome_path = folder / "outcome.json"
    if outcome_path.exists():
        return read_json(outcome_path)
    outcome = dict(
        query_id=row["query_id"],
        dataset=gold["dataset"],
        correct=None,
        relaxed_correct=None,
        grade_status="unknown",
    )
    if row["status"] != "completed" or not row.get("final_answer", "").strip():
        outcome.update(
            correct=False, relaxed_correct=False, grade_status="research_failed"
        )
    else:
        body = judge_request(
            gold["dataset"],
            gold["query"],
            row["final_answer"],
            gold.get("answer_set", gold["answer"]),
        )
        body.update(model=args.model, max_output_tokens=8192)
        request_path = folder / "request.json"
        if request_path.exists():
            if read_json(request_path) != body:
                raise ValueError("Saved judge request differs from the frozen inputs")
        else:
            write_json(request_path, body)
        for attempt in range(1, 4):
            response_path = folder / f"response-{attempt}.json"
            started_path = folder / f"started-{attempt}.json"
            if not response_path.exists() and started_path.exists():
                error_path = folder / f"error-{attempt}.json"
                if (
                    error_path.exists()
                    and (folder / f"started-{attempt + 1}.json").exists()
                ):
                    status = read_json(error_path).get("http_status", 0)
                    if status == 429 or 500 <= status < 600:
                        continue
                outcome["grade_status"] = "interrupted_unknown"
                break
            try:
                if response_path.exists():
                    response = read_json(response_path)
                else:
                    write_json(started_path, {"attempt": attempt})
                    response = transport.request(body)
                    write_json(response_path, response)
                outcome.update(
                    judge_usage=response.get("usage"),
                    returned_model=response.get("model"),
                    judge_attempts=attempt,
                )
                expected = re.escape(args.expected_model) + r"(?:-\d{4}-\d{2}-\d{2})?"
                if response.get("status") != "completed" or not re.fullmatch(
                    expected, str(response.get("model", ""))
                ):
                    raise ValueError("Judge model/status mismatch")
                original = text(response)
                verdict, strict, relaxed = parse_verdict(original, gold)
                normalized = (
                    gold["dataset"] != "dsqa"
                    and json.loads(original)["correct_answer"]
                    != verdict["correct_answer"]
                )
                outcome.update(
                    correct=strict,
                    relaxed_correct=relaxed,
                    grade_status="valid",
                    verdict=verdict,
                    grade_representation_normalized=normalized,
                )
                break
            except HTTPError as error:
                write_json(
                    folder / f"error-{attempt}.json", {"http_status": error.code}
                )
                outcome.update(judge_http_status=error.code, judge_attempts=attempt)
                if attempt == 3 or (error.code != 429 and not 500 <= error.code < 600):
                    break
                try:
                    delay = max(2**attempt, float(error.headers.get("retry-after", 0)))
                except (TypeError, ValueError):
                    delay = 2**attempt
                time.sleep(min(delay, 120))
            except (
                OSError,
                HTTPException,
                RuntimeError,
                ValueError,
                KeyError,
                TypeError,
            ) as error:
                # Ambiguous transport failures and invalid completed judgments
                # remain unknown; a resume cannot silently select another answer.
                error_path = folder / f"error-{attempt}.json"
                if not error_path.exists():
                    write_json(error_path, {"error_type": type(error).__name__})
                outcome.update(
                    judge_error_type=type(error).__name__, judge_attempts=attempt
                )
                break
    write_json(outcome_path, outcome)
    return outcome


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--run", type=Path, required=True)
    p.add_argument("--inputs", type=Path, default=ROOT / "data/cmass/inputs")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument(
        "--base-url",
        default=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    )
    p.add_argument(
        "--model", default=os.environ.get("CMASS_GRADER_MODEL", "gpt-6.1-sol")
    )
    p.add_argument("--expected-model", help="Returned model ID for a deployment alias")
    p.add_argument("--api-key-env", default="OPENAI_API_KEY")
    p.add_argument(
        "--auth-header", choices=("Authorization", "api-key"), default="Authorization"
    )
    p.add_argument("--workers", type=int, default=1)
    p.add_argument(
        "--resume",
        action="store_true",
        help="Reuse saved first grades; uncertain requests remain unknown",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate inputs without credentials or network calls",
    )
    args = p.parse_args()
    args.expected_model = args.expected_model or args.model
    from urllib.parse import urlsplit

    url = urlsplit(args.base_url)
    if (
        url.scheme not in ("http", "https")
        or not url.netloc
        or url.username
        or url.password
        or url.query
        or url.fragment
    ):
        p.error(
            "--base-url must be an HTTP(S) URL without embedded credentials or query parameters"
        )
    if args.workers < 1:
        p.error("--workers must be positive")
    manifest = read_json(args.run / "manifest.json")
    if manifest["benchmark"] != "cmass" or not (args.run / "complete.json").exists():
        p.error("Expected terminal CMASS run")
    validate_ids(manifest["ids"])
    records = by_id(read_jsonl(args.run / "records.jsonl"))
    gold = by_id(read_jsonl(args.inputs / "evaluator-only/gold.jsonl"))
    if set(records) != set(manifest["ids"]) or not set(records) <= set(gold):
        p.error("Cohort mismatch")
    prepared = read_json(args.inputs / "prepared.json")
    pin = read_json(ROOT / "provenance/cmass-data.json")
    if (
        prepared["revision"] != pin["revision"]
        or manifest.get("data", {}).get("revision") != pin["revision"]
    ):
        p.error("CMASS dataset revision mismatch")
    if manifest["data"]["prepared_sha256"] != sha256(args.inputs / "prepared.json"):
        p.error("Prepared manifest differs from generation")
    for name in (
        "questions.jsonl",
        "evaluator-only/gold.jsonl",
        "evaluator-only/qrels.jsonl",
    ):
        if sha256(args.inputs / name) != prepared["files"][name]:
            p.error("Prepared input changed: " + name)
    if manifest["questions_sha256"] != sha256(args.inputs / "questions.jsonl"):
        p.error("Generation question file changed")
    for q in records:
        question = read_json(args.run / "inputs" / f"{q}.json")
        dataset = q.split("__", 1)[0]
        if (
            question["query"] != gold[q]["query"]
            or question["dataset"] != dataset
            or gold[q]["dataset"] != dataset
        ):
            p.error("Generation/gold question or dataset mismatch")
        records[q]["dataset"] = dataset
        raw_events = args.run / "trials" / q / "raw-events" / f"{q}.jsonl"
        if raw_events.exists():
            records[q]["search_shown_docids"] = visible_search_ids(
                read_jsonl(raw_events)
            )
    protocol = dict(
        ids=manifest["ids"],
        model=args.model,
        expected_model=args.expected_model,
        reasoning="high",
        base_url=args.base_url,
        auth_header=args.auth_header,
        max_output_tokens=8192,
        retry_policy="up to 3 HTTP 429/5xx attempts; uncertain/invalid results stay unknown",
        records_sha256=sha256(args.run / "records.jsonl"),
        gold_sha256=sha256(args.inputs / "evaluator-only/gold.jsonl"),
        qrels_sha256=sha256(args.inputs / "evaluator-only/qrels.jsonl"),
        manifest_sha256=sha256(args.run / "manifest.json"),
        generation_input_hashes={
            q: sha256(args.run / "inputs" / f"{q}.json") for q in manifest["ids"]
        },
        raw_event_hashes={
            q: sha256(args.run / "trials" / q / "raw-events" / f"{q}.jsonl")
            if (args.run / "trials" / q / "raw-events" / f"{q}.jsonl").exists()
            else None
            for q in manifest["ids"]
        },
        dataset_revision=prepared["revision"],
        evaluator_sha256=sha256(Path(__file__)),
        metrics_sha256=sha256(ROOT / "scripts/cmass_results.py"),
        protocol_sources={
            str(f.relative_to(ROOT)): sha256(f)
            for f in (ROOT / "evaluation/cmass_protocol").rglob("*")
            if f.is_file() and "__pycache__" not in str(f)
        },
    )
    if args.dry_run:
        print(
            json.dumps(
                {
                    "questions": len(records),
                    "model": args.model,
                    "expected_model": args.expected_model,
                    "reasoning": "high",
                    "workers": args.workers,
                }
            )
        )
        return
    if args.out.exists():
        if not args.resume or read_json(args.out / "protocol.json") != protocol:
            p.error(
                "Use a new evaluator directory, or --resume with identical inputs/settings"
            )
    else:
        args.out.mkdir(parents=True, mode=0o700)
        write_json(args.out / "protocol.json", protocol)
    api_key = os.environ.get(args.api_key_env, "")
    pending = [
        q
        for q in records
        if not (args.out / q / "outcome.json").exists()
        and records[q]["status"] == "completed"
        and records[q].get("final_answer", "").strip()
        and not (args.out / q / "started-1.json").exists()
    ]
    if pending and not api_key:
        p.error(f"Export {args.api_key_env} for the separate evaluator")
    transport = Transport(args, api_key)

    def score(q):
        outcome = grade(records[q], gold[q], args, args.out / q, transport)
        print(
            json.dumps(
                {
                    k: outcome[k]
                    for k in ("query_id", "grade_status", "correct", "relaxed_correct")
                }
            ),
            flush=True,
        )
        return {**records[q], **outcome}

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        scored = list(pool.map(score, manifest["ids"]))
    qrels = {}
    for row in read_jsonl(args.inputs / "evaluator-only/qrels.jsonl"):
        qrels.setdefault((row["query_id"], row["role"]), set()).add(row["docid"])
    summary = summarize(scored, qrels)
    if not (args.out / "scored.jsonl").exists():
        write_jsonl(args.out / "scored.jsonl", scored)
    elif read_jsonl(args.out / "scored.jsonl") != scored:
        raise ValueError("Saved scored records differ from per-item outcomes")
    if not (args.out / "summary.json").exists():
        write_json(args.out / "summary.json", summary)
    elif read_json(args.out / "summary.json") != summary:
        raise ValueError("Saved summary differs from per-item outcomes")
    print(json.dumps(summary["all"]), flush=True)
    if any(row["correct"] is None for row in scored):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
