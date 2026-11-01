"""Offline CMASS accuracy, accounting and optional retrieval summaries."""

import math
import re
import csv
import io
import json
from datetime import datetime

try:
    from .common import ROOT, by_id, read_json, read_jsonl, sha256
except ImportError:
    from common import ROOT, by_id, read_json, read_jsonl, sha256

DATASETS = ("bcp", "trqa", "dsqa", "hotpotqa")
ID_PATTERN = re.compile(r"(bcp|trqa|dsqa|hotpotqa)__[A-Za-z0-9_-]+")
RECALL_SCOPES = {
    "search_shown_docids": "IDs actually displayed by search/result previews; Recall@all scope.",
    "tool_visible_docids": "IDs in all model-visible tool text, including Jev notices.",
    "cached_retrieval_docids": "Backend candidates; not all shown to the researcher.",
    "backend_read_docids": "Sources read by Jev or native reading; not causal evidence use.",
}


def validate_ids(ids):
    if not ids or any(
        not isinstance(q, str) or not ID_PATTERN.fullmatch(q) for q in ids
    ):
        raise ValueError("Expected nonempty, dataset-scoped CMASS IDs")
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate CMASS IDs")


def summarize(rows, qrels=None):
    """Unknown grades suppress accuracy; known token sums are not full bills."""
    validate_ids([r["query_id"] for r in rows])
    by_id(rows)
    for row in rows:
        if row.get("dataset") != row["query_id"].split("__", 1)[0]:
            raise ValueError("CMASS dataset/ID mismatch")
        strict, relaxed = row.get("correct"), row.get("relaxed_correct")
        if any(v is not None and type(v) is not bool for v in (strict, relaxed)):
            raise ValueError("Grades must be Boolean or null")
        if (strict is None) != (relaxed is None) or (
            strict is True and relaxed is not True
        ):
            raise ValueError("Inconsistent strict/relaxed grades")
        if row["dataset"] != "dsqa" and strict != relaxed:
            raise ValueError("Only DSQA has distinct strict/relaxed criteria")

    def section(items):
        unknown = sum(type(r.get("correct")) is not bool for r in items)
        result = {
            "n": len(items),
            "completed": sum(r["status"] == "completed" for r in items),
            "unknown_grades": unknown,
            "items_with_unknown_usage": sum(
                bool(r.get("usage_unknown", True)) for r in items
            ),
        }
        for field, key in (("strict", "correct"), ("relaxed", "relaxed_correct")):
            count = sum(r.get(key) is True for r in items)
            result[field + "_correct"] = count
            result[field + "_accuracy_percent"] = (
                100 * count / len(items) if not unknown else None
            )
        for key in (
            "elapsed_seconds",
            "search_calls",
            "read_document_calls",
            "jev_find_calls",
            "input_tokens",
            "cached_input_tokens",
            "output_tokens",
            "jev_input_tokens",
            "jev_requests",
            "jev_failed_requests",
            "jev_cost_usd",
            "gpt_cost_usd",
        ):
            values = [r.get(key) for r in items]
            valid = all(
                type(v) in (int, float) and math.isfinite(v) and v >= 0 for v in values
            )
            usage = "tokens" in key or "cost" in key
            result[key + "_mean"] = (
                sum(values) / len(items)
                if valid and not (usage and result["items_with_unknown_usage"])
                else None
            )
        for key in (
            "input_tokens",
            "cached_input_tokens",
            "output_tokens",
            "jev_input_tokens",
        ):
            values = [r.get(key) for r in items]
            result["known_" + key] = sum(v for v in values if type(v) is int and v >= 0)
        for key in ("jev_requests_missing_usage", "gpt_requests_missing_usage"):
            values = [r.get(key) for r in items]
            result[key] = (
                sum(values) if all(type(v) is int and v >= 0 for v in values) else None
            )
        result["total_cost_usd"] = (
            (result["jev_cost_usd_mean"] + result["gpt_cost_usd_mean"]) * len(items)
            if result["jev_cost_usd_mean"] is not None
            and result["gpt_cost_usd_mean"] is not None
            else None
        )
        result["accounting_complete"] = (
            not result["items_with_unknown_usage"]
            and result["total_cost_usd"] is not None
        )
        if qrels is not None:
            result["recall"] = {}
            for role in ("all", "inclusion", "exclusion"):
                eligible = [r for r in items if qrels.get((r["query_id"], role))]
                scopes = {}
                for scope in RECALL_SCOPES:
                    complete = all(scope in r for r in eligible)
                    scopes[scope] = (
                        100
                        * sum(
                            len(set(r[scope]) & qrels[r["query_id"], role])
                            / len(qrels[r["query_id"], role])
                            for r in eligible
                        )
                        / len(eligible)
                        if eligible and complete
                        else None
                    )
                result["recall"][role] = {"eligible": len(eligible), "percent": scopes}
        return result

    result = {
        "all": section(rows),
        "by_dataset": {
            d: section([r for r in rows if r["dataset"] == d])
            for d in DATASETS
            if any(r["dataset"] == d for r in rows)
        },
    }
    if qrels is not None:
        result["recall_definitions"] = RECALL_SCOPES
    return result


def table_rows(report):
    rows = []
    for dataset, label in (
        ("bcp", "BCP"),
        ("trqa", "TRQA"),
        ("dsqa", "DSQA"),
        ("hotpotqa", "HotpotQA"),
    ):
        if dataset not in report["by_dataset"]:
            continue
        section = report["by_dataset"][dataset]
        for criterion in ("strict", "relaxed") if dataset == "dsqa" else ("strict",):
            name = label + (" " + criterion if dataset == "dsqa" else "")
            rows.append((name, section, criterion))
    rows.extend(("Overall " + c, report["all"], c) for c in ("strict", "relaxed"))
    return [
        [
            label,
            f"{section[criterion + '_correct']}/{section['n']}",
            f"{section[criterion + '_accuracy_percent']:.2f}"
            if section[criterion + "_accuracy_percent"] is not None
            else "—",
        ]
        for label, section, criterion in rows
    ]


def released_report():
    rows = read_jsonl(ROOT / "results/cmass.jsonl")
    ids = read_json(ROOT / "splits/cmass.json")["all"]
    if set(by_id(rows)) != set(ids):
        raise ValueError("Released CMASS records do not cover the frozen cohort")
    validate_ids(ids)
    return summarize(rows)


def verify_release(report):
    expected = read_json(ROOT / "results/cmass-summary.json")

    def compare(actual, reference, path):
        for key, value in reference.items():
            found = actual.get(key)
            if isinstance(value, dict):
                compare(found, value, path + "." + key)
            elif type(value) is float:
                if type(found) not in (int, float) or not math.isclose(
                    found, value, rel_tol=1e-10, abs_tol=1e-10
                ):
                    raise ValueError("CMASS release mismatch: " + path + "." + key)
            elif found != value:
                raise ValueError("CMASS release mismatch: " + path + "." + key)

    compare(report, {key: expected[key] for key in ("all", "by_dataset")}, "cmass")
    verify_selection()


def verify_selection():
    """Check the public history projection against every selected record."""
    rows = by_id(read_jsonl(ROOT / "results/cmass.jsonl"))
    ledger = read_json(ROOT / "provenance/cmass-selection.json")
    if ledger["numeric_records_sha256"] != sha256(ROOT / "results/cmass.jsonl"):
        raise ValueError("CMASS selection ledger binds different records")
    split = read_json(ROOT / "splits/cmass.json")
    if ledger["historical_manifest_commitment"] != split["selection_manifest_sha256"]:
        raise ValueError("CMASS historical manifest commitment mismatch")
    histories = by_id(ledger["queries_with_multiple_artifacts"])
    expected = {q for q, row in rows.items() if row["attempt"] > 1}
    if set(histories) != expected or ledger["single_artifact_queries"] != len(
        rows
    ) - len(expected):
        raise ValueError("CMASS execution history coverage mismatch")
    if ledger["query_count"] != len(rows) or ledger["historical_attempt_count"] != sum(
        r["attempt"] for r in rows.values()
    ):
        raise ValueError("CMASS execution history counts mismatch")
    for q, row in rows.items():
        if (
            row["model"] != "gpt-6.1-sol"
            or row["reasoning_effort"] != "high"
            or row["cohort"] != "cmass-sol61-high-1800s"
        ):
            raise ValueError("Unexpected CMASS model/settings/cohort")
        if row["jev_requests_missing_usage"] and (
            row["jev_cost_usd"] is not None or row["jev_input_tokens_total"] is not None
        ):
            raise ValueError("Incomplete Jev usage must not have a total cost")
        if row["jev_cost_usd"] is not None and not math.isclose(
            row["jev_cost_usd"], row["jev_input_tokens"] * 0.042 / 1e6, abs_tol=1e-10
        ):
            raise ValueError("CMASS Jev cost mismatch")
        if q not in histories:
            continue
        query_history = histories[q]
        if (
            query_history["dataset"] != row["dataset"]
            or query_history["selected_raw_sha256"] != row["raw_result_sha256"]
        ):
            raise ValueError("Per-question history identity mismatch")
        history = query_history["history"]
        if (
            len(history) != row["attempt"]
            or histories[q]["recorded_attempts"] != row["attempt"]
        ):
            raise ValueError("Per-question history count mismatch")
        selected = [item for item in history if item["selected"]]
        if len(selected) != 1:
            raise ValueError("Expected exactly one selected artifact")
        selected = selected[0]
        if (
            selected["artifact_hashes"]["raw_result_sha256"] != row["raw_result_sha256"]
            or selected["artifact_hashes"]["outcome_sha256"] != row["grade_sha256"]
        ):
            raise ValueError("Selected artifact hash mismatch")
        if any(
            selected[key] != row[key]
            for key in (
                "status", "grade_status", "correct", "relaxed_correct", "usage_unknown"
            )
        ):
            raise ValueError("Selected outcome mismatch")
        if not math.isclose(
            selected["elapsed_seconds"], row["elapsed_seconds"], abs_tol=1e-10
        ):
            raise ValueError("Selected elapsed time mismatch")
        eligible = [
            item
            for item in history
            if item["status"] == "completed" and item["grade_status"] == "valid"
        ]
        latest = max(
            eligible,
            key=lambda item: datetime.fromisoformat(
                item["started_at"].replace("Z", "+00:00")
            ),
        )
        if selected != latest:
            raise ValueError(
                "Selected artifact is not the latest completed, scored output"
            )
        for item in history:
            events = item["observed_events"]
            if item["status"] != "completed":
                execution_class = "non_completed"
            elif any(events[key] for key in (
                "provider_non_200", "jev_failed_http_statuses", "quota_wait_events",
                "transport_retry_events",
            )):
                execution_class = "completed_with_recorded_service_events"
            else:
                execution_class = "completed_without_recorded_service_errors"
            if item["execution_class"] != execution_class:
                raise ValueError("Execution class disagrees with observed events")
            if (
                not item["selected"]
                and execution_class == "completed_without_recorded_service_errors"
            ):
                raise ValueError(
                    "Unselected completed output lacks recorded execution/service events"
                )


def report_cli(args):
    if args.records or args.cohort:
        if not (args.records and args.cohort) or args.check:
            raise ValueError(
                "New CMASS reports require --records and --cohort, without --check"
            )
        cohort = read_json(args.cohort)
        ids = (
            cohort if isinstance(cohort, list) else cohort.get("ids", cohort.get("all"))
        )
        validate_ids(ids)
        rows = read_jsonl(args.records)
        if set(by_id(rows)) != set(ids):
            raise ValueError("CMASS records must match the complete selected cohort")
        report = summarize(rows)
    else:
        report = released_report()
    if args.check:
        verify_release(report)
    headers = ["Dataset / criterion", "Correct / total", "Accuracy (%)"]
    cells = table_rows(report)
    markdown = (
        "\n".join(
            ["| " + " | ".join(headers) + " |", "| --- | ---: | ---: |"]
            + ["| " + " | ".join(row) + " |" for row in cells]
        )
        + "\n"
    )
    if report["all"]["unknown_grades"]:
        markdown += f"\nUnresolved grades: {report['all']['unknown_grades']}; accuracy is unavailable.\n"
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "cmass.md").write_text(markdown, encoding="utf-8")
        (args.out / "cmass.json").write_text(
            json.dumps(report, indent=2, allow_nan=False) + "\n"
        )
        stream = io.StringIO()
        csv.writer(stream).writerows([headers] + cells)
        (args.out / "cmass.csv").write_text(stream.getvalue())
        (args.out / "cmass.tex").write_text(
            "\n".join(" & ".join(row) + r"\\" for row in cells) + "\n"
        )
    print(markdown)
    if args.check:
        print("Verified CMASS scores and known usage against the frozen release.")
