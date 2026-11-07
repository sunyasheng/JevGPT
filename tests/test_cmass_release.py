"""Offline release checks: interruption, scoring integrity and portable CLIs."""

import argparse
import copy
import io
from http.client import IncompleteRead
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]
from evaluation.cmass import Transport, grade, parse_verdict
from scripts.cmass_results import (
    released_report,
    summarize,
    validate_ids,
    verify_release,
    verify_selection,
)
from scripts.collect import collect_trial
from scripts.common import read_jsonl, sha256, write_json, write_jsonl
from scripts.cmass_config import validate_health, validate_budget, validate_hybrid_health
from services.cmass_search import handler, document


def response(correct=True, model="gpt-6.1-sol", echo='"gold"'):
    verdict = dict(
        extracted_final_answer="answer",
        correct_answer=echo,
        reasoning="Synthetic test",
        correct=correct,
        confidence=90,
    )
    return dict(
        status="completed",
        model=model,
        usage=dict(input_tokens=10, output_tokens=5),
        output=[
            dict(
                type="message",
                content=[dict(type="output_text", text=json.dumps(verdict))],
            )
        ],
    )


class JudgeTests(unittest.TestCase):
    def test_broken_stream_is_recorded_unknown_without_crashing_or_retrying(self):
        import ssl

        for error in (
            IncompleteRead(b"partial"),
            ssl.SSLError("Synthetic TLS failure"),
        ):
            with (
                self.subTest(error=type(error).__name__),
                tempfile.TemporaryDirectory() as tmp,
            ):
                transport = Mock()
                transport.request.side_effect = error
                result = grade(self.row, self.gold, self.args, Path(tmp), transport)
                self.assertIsNone(result["correct"])
                self.assertEqual(result["grade_status"], "unknown")
                self.assertEqual(result["judge_attempts"], 1)
                self.assertEqual(result["judge_error_type"], type(error).__name__)
                self.assertEqual(
                    json.loads((Path(tmp) / "error-1.json").read_text()),
                    {"error_type": type(error).__name__},
                )
                self.assertTrue((Path(tmp) / "outcome.json").exists())
                transport.request.assert_called_once()

    def setUp(self):
        self.args = argparse.Namespace(model="deployment", expected_model="gpt-6.1-sol")
        self.row = dict(query_id="bcp__1", status="completed", final_answer="answer")
        self.gold = dict(dataset="bcp", query="Synthetic question?", answer='"gold"')

    def test_normalization_changes_only_scalar_echo_and_preserves_false(self):
        value = response(False, echo="gold")["output"][0]["content"][0]["text"]
        verdict, strict, relaxed = parse_verdict(value, self.gold)
        self.assertEqual(verdict["correct_answer"], '"gold"')
        self.assertFalse(strict)
        self.assertFalse(relaxed)
        with self.assertRaises(ValueError):
            parse_verdict(value, {**self.gold, "answer": '["gold"]'})

    def test_saved_first_verdict_and_raw_response_survive_resume(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / "judge"
            transport = Mock()
            raw = response(False, echo="gold")
            transport.request.return_value = raw
            first = grade(self.row, self.gold, self.args, folder, transport)
            self.assertFalse(first["correct"])
            self.assertTrue(first["grade_representation_normalized"])
            self.assertEqual(json.loads((folder / "response-1.json").read_text()), raw)
            transport.request.side_effect = AssertionError("No second request")
            self.assertEqual(
                grade(self.row, self.gold, self.args, folder, transport), first
            )
            self.assertEqual(transport.request.call_count, 1)

    def test_interruption_never_reissues_an_uncertain_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            write_json(folder / "started-1.json", {"attempt": 1})
            transport = Mock()
            transport.request.side_effect = AssertionError("Unexpected model call")
            result = grade(self.row, self.gold, self.args, folder, transport)
            self.assertIsNone(result["correct"])
            self.assertEqual(result["grade_status"], "interrupted_unknown")
            transport.request.assert_not_called()

    def test_resume_replays_a_saved_response_after_a_recorded_429(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            for attempt in (1, 2):
                write_json(folder / f"started-{attempt}.json", {"attempt": attempt})
            write_json(folder / "error-1.json", {"http_status": 429})
            write_json(folder / "response-2.json", response())
            transport = Mock()
            result = grade(self.row, self.gold, self.args, folder, transport)
            self.assertTrue(result["correct"])
            transport.request.assert_not_called()

    def test_transport_retry_is_explicit_and_invalid_model_is_unknown(self):
        with tempfile.TemporaryDirectory() as tmp, patch("evaluation.cmass.time.sleep"):
            transport = Mock()
            transport.request.side_effect = [
                HTTPError("url", 429, "limited", {}, None),
                response(model="wrong-model"),
            ]
            result = grade(self.row, self.gold, self.args, Path(tmp), transport)
            self.assertIsNone(result["correct"])
            self.assertEqual(transport.request.call_count, 2)
            request = transport.request.call_args.args[0]
            self.assertEqual(request["tools"], [])
            self.assertEqual(request["tool_choice"], "none")
            self.assertEqual(request["reasoning"], {"effort": "high"})

    def test_failed_research_never_calls_the_judge(self):
        with tempfile.TemporaryDirectory() as tmp:
            transport = Mock()
            result = grade(
                {**self.row, "status": "timeout"},
                self.gold,
                self.args,
                Path(tmp),
                transport,
            )
            self.assertFalse(result["correct"])
            transport.request.assert_not_called()

    def test_sse_multiline_and_truncated_stream(self):
        args = argparse.Namespace(
            base_url="https://example.invalid/v1", auth_header="Authorization"
        )
        data = response()
        stream = io.BytesIO(
            (
                'event: response.completed\ndata: {"type":"response.completed",\n'
                'data: "response":' + json.dumps(data) + "}\n\n"
            ).encode()
        )
        with patch("evaluation.cmass.urlopen", return_value=stream):
            self.assertEqual(Transport(args, "synthetic").request({}), data)
        with patch(
            "evaluation.cmass.urlopen", return_value=io.BytesIO(b"data: [DONE]\n\n")
        ):
            with self.assertRaises(RuntimeError):
                Transport(args, "synthetic").request({})


class ReleaseTests(unittest.TestCase):
    def test_service_contract_preserves_source_and_rejects_bad_limits(self):
        config = json.loads((ROOT / "configs/cmass.json").read_text())
        fingerprint = dict(
            status="ready",
            mode="full",
            index="climbmix-400b",
            documents=553240576,
            bm25=config["bm25"],
        )
        validate_health(fingerprint, config)
        for field, value in (
            ("documents", 10),
            ("mode", "pilot"),
            ("bm25", {"k1": 1.2, "b": 0.75}),
        ):
            with self.assertRaises(ValueError):
                validate_health({**fingerprint, field: value}, config)
        with self.assertRaises(ValueError):
            validate_budget({**config, "submit_now_seconds": 210})
        raw = '{"text":"Original\nsource 😀"}'
        engine = Mock()
        engine.doc_raw.return_value = raw
        engine.search.return_value = [
            argparse.Namespace(
                docid="shard_00001_2", score=2.0, lucene_document={"raw": raw}
            )
        ]
        server = ThreadingHTTPServer(
            ("127.0.0.1", 0), handler(engine, fingerprint, 100)
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            with urlopen(
                base + "/v1/climbmix-400b/search?query=synthetic&hits=5"
            ) as response:
                hits = json.load(response)["candidates"]
            self.assertEqual(hits[0]["doc"]["text"], "Original\nsource 😀")
            self.assertEqual(document(raw)["text"], hits[0]["doc"]["text"])
            with self.assertRaises(HTTPError) as error:
                urlopen(base + "/v1/climbmix-400b/search?query=synthetic&hits=101")
            self.assertEqual(error.exception.code, 400)
            engine.search.assert_called_once_with("synthetic", 5)
            with urlopen(base + "/v1/climbmix-400b/doc/shard_00001_2") as response:
                self.assertEqual(
                    json.load(response)["doc"]["text"], "Original\nsource 😀"
                )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_environment_cannot_silently_change_the_cmass_model(self):
        import os

        with tempfile.TemporaryDirectory() as tmp:
            cmd = [
                sys.executable,
                str(ROOT / "scripts/run.py"),
                "cmass",
                "--out",
                tmp + "/new",
                "--dry-run",
            ]
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                env={**os.environ, "JEVGPT_MODEL": "openai/gpt-5.5"},
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("--allow-model-change", result.stderr)

    def test_released_cohort_and_every_published_aggregate(self):
        result = released_report()
        verify_release(result)
        self.assertEqual(result["all"]["n"], 423)
        self.assertEqual(result["all"]["strict_correct"], 395)
        self.assertEqual(result["by_dataset"]["dsqa"]["relaxed_correct"], 70)
        self.assertIsNone(result["all"]["total_cost_usd"])

    def test_selection_rejects_changed_identity_resources_and_event_claims(self):
        ledger = json.loads((ROOT / "provenance/cmass-selection.json").read_text())
        split = json.loads((ROOT / "splits/cmass.json").read_text())
        history = ledger["queries_with_multiple_artifacts"][0]["history"]
        selected = next(i for i, item in enumerate(history) if item["selected"])
        query_path = ("queries_with_multiple_artifacts", 0)
        selected_path = query_path + ("history", selected)
        changes = [
            (("historical_manifest_commitment",), "changed"),
            (query_path + ("dataset",), "trqa"),
            (query_path + ("selected_raw_sha256",), "changed"),
            (selected_path + ("elapsed_seconds",), history[selected]["elapsed_seconds"] + 1),
            (selected_path + ("usage_unknown",), not history[selected]["usage_unknown"]),
            (selected_path + ("execution_class",), "non_completed"),
        ]
        for path, value in changes:
            with self.subTest(field=path[-1]):
                changed = copy.deepcopy(ledger)
                target = changed
                for key in path[:-1]:
                    target = target[key]
                target[path[-1]] = value
                with patch(
                    "scripts.cmass_results.read_json",
                    side_effect=lambda p: changed if p.name == "cmass-selection.json" else split,
                ):
                    with self.assertRaises(ValueError):
                        verify_selection()

    def test_invalid_cohort_and_contradictory_dsqa_grades_are_rejected(self):
        for ids in (["bcp__../secret"], ["bcp__1", "bcp__1"], []):
            with self.assertRaises(ValueError):
                validate_ids(ids)
        with self.assertRaises(ValueError):
            summarize(
                [
                    dict(
                        query_id="dsqa__1",
                        dataset="dsqa",
                        status="completed",
                        correct=True,
                        relaxed_correct=False,
                    )
                ]
            )

    def test_compaction_and_jev_failure_keep_unknown_usage_separate(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            write_json(
                folder / "bcp__1.json",
                dict(status="completed", stats={"elapsed_seconds": 1}, result=[]),
            )
            write_jsonl(
                folder / "raw-events/bcp__1.jsonl",
                [
                    dict(
                        type="message_end",
                        message=dict(
                            role="assistant",
                            usage=dict(input=10, cacheRead=20, output=3),
                        ),
                    ),
                    dict(type="compaction_start"),
                    dict(
                        type="tool_execution_end",
                        toolName="search",
                        result=dict(
                            details={
                                "previewedDocids": ["shard_00001_1", "shard_00001_2"]
                            },
                            content=[dict(type="text", text="Shown shard_00001_1")],
                        ),
                    ),
                ],
            )
            write_jsonl(folder / "jev-find.jsonl", [dict(type="judge", ok=False)])
            row = collect_trial(folder, "bcp__1", "cmass")
            self.assertEqual(row["input_tokens"], 30)
            self.assertEqual(row["gpt_requests_missing_usage"], 1)
            self.assertIsNone(row["input_tokens_total"])
            self.assertIsNone(row["jev_cost_usd"])
            self.assertEqual(row["search_shown_docids"], ["shard_00001_1"])
            self.assertTrue(row["usage_unknown"])

    def test_research_dry_run_needs_no_models_credentials_or_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "run"
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts/run.py"),
                    "cmass",
                    "--out",
                    str(out),
                    "--dry-run",
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            plan = json.loads(result.stdout)
            self.assertEqual(len(plan["ids"]), 423)
            self.assertEqual(plan["config"]["thinking"], "high")
            self.assertEqual(plan["workers"], 8)
            self.assertFalse(out.exists())

    def test_evaluator_dry_run_checks_bound_inputs_without_creating_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            run, inputs, out = base / "run", base / "inputs", base / "evaluation"
            question = dict(
                query_id="bcp__1", dataset="bcp", query="Synthetic question?"
            )
            write_jsonl(inputs / "questions.jsonl", [question])
            write_jsonl(
                inputs / "evaluator-only/gold.jsonl", [{**question, "answer": '"gold"'}]
            )
            write_jsonl(inputs / "evaluator-only/qrels.jsonl", [])
            revision = json.loads((ROOT / "provenance/cmass-data.json").read_text())[
                "revision"
            ]
            write_json(
                inputs / "prepared.json",
                dict(
                    revision=revision,
                    files={
                        str(p.relative_to(inputs)): sha256(p)
                        for p in inputs.rglob("*.jsonl")
                    },
                ),
            )
            write_json(
                run / "manifest.json",
                dict(
                    benchmark="cmass",
                    ids=["bcp__1"],
                    questions_sha256=sha256(inputs / "questions.jsonl"),
                    data=dict(
                        revision=revision,
                        prepared_sha256=sha256(inputs / "prepared.json"),
                    ),
                ),
            )
            write_json(run / "complete.json", {})
            write_json(run / "inputs/bcp__1.json", question)
            write_jsonl(
                run / "records.jsonl",
                [dict(query_id="bcp__1", status="completed", final_answer="answer")],
            )
            cmd = [
                sys.executable,
                str(ROOT / "evaluation/cmass.py"),
                "--run",
                str(run),
                "--inputs",
                str(inputs),
                "--out",
                str(out),
                "--dry-run",
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout)["workers"], 1)
            self.assertFalse(out.exists())
            (inputs / "questions.jsonl").write_text("changed")
            result = subprocess.run(cmd, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(out.exists())

class HybridReleaseTests(unittest.TestCase):
    def test_hybrid_records_reproduce_the_published_aggregates(self):
        result = released_report("hybrid")
        verify_release(result, "hybrid")
        self.assertEqual(result["all"]["strict_correct"], 395)
        self.assertEqual(result["all"]["relaxed_correct"], 398)
        self.assertEqual(result["by_dataset"]["bcp"]["strict_correct"], 68)
        self.assertEqual(result["all"]["input_tokens_total"], 244760022)
        self.assertIsNone(result["all"]["jev_input_tokens_total"])
        self.assertEqual(result["all"]["jev_requests_missing_usage"], 22)
        self.assertTrue(result["by_dataset"]["trqa"]["usage_complete"])
        self.assertFalse(result["by_dataset"]["trqa"]["accounting_complete"])
        rows = [dict(r) for r in read_jsonl(ROOT / "results/cmass-hybrid.jsonl")[:2]]
        rows[0].update(input_tokens_total=None, usage_unknown=True)  # e.g. no assistant messages
        self.assertIsNone(summarize(rows)["all"]["input_tokens_total"])

    def test_hybrid_services_must_match_both_full_indexes(self):
        config = json.loads((ROOT / "configs/cmass-hybrid.json").read_text())
        health = {
            "document": dict(ready=True, mode="document", documents=553240576, bm25={"b": 1.0, "k1": 25.0}),
            "passage": dict(ready=True, mode="passage", documents=1372692008, bm25={"b": 0.4, "k1": 0.9}),
        }
        self.assertIs(validate_hybrid_health(health, config), health)
        for side, key, value in (
            ("document", "bm25", {"k1": 0.9, "b": 0.4}),
            ("passage", "documents", 1000),
            ("passage", "mode", "document"),
            ("document", "ready", False),
        ):
            changed = copy.deepcopy(health)
            changed[side][key] = value
            with self.assertRaises(ValueError):
                validate_hybrid_health(changed, config)

    def test_hybrid_dry_run_selects_its_config_and_document_mode_drops_inherited_switches(self):
        import os

        with tempfile.TemporaryDirectory() as tmp:
            base = [sys.executable, str(ROOT / "scripts/run.py"), "cmass", "--out", tmp + "/run", "--dry-run"]
            plan = json.loads(subprocess.run(base + ["--retrieval", "hybrid"], capture_output=True,
                                             text=True, check=True).stdout)
            self.assertEqual(plan["retrieval_variant"], "hybrid")
            self.assertEqual(plan["config_sha256"], sha256(ROOT / "configs/cmass-hybrid.json"))
            self.assertEqual(plan["workers"], 4)
            self.assertIn("src/extensions/pi_search_jev_cmass_hybrid_v1.ts", plan["first_command"])
            other = subprocess.run([sys.executable, str(ROOT / "scripts/run.py"), "neuclir", "--out",
                                    tmp + "/n", "--dry-run", "--retrieval", "hybrid"], capture_output=True, text=True)
            self.assertNotEqual(other.returncode, 0)
            neuclir = json.loads(subprocess.run([sys.executable, str(ROOT / "scripts/run.py"), "neuclir", "--out",
                                                 tmp + "/n", "--dry-run"], capture_output=True, text=True, check=True).stdout)
            self.assertNotIn("retrieval_variant", neuclir)
        from scripts.run import environment

        config = json.loads((ROOT / "configs/cmass.json").read_text())
        with patch.dict(os.environ, {"CMASS_HYBRID": "1", "PI_SEARCH_QUESTION_LIFETIME": "1"}):
            env = environment(config, argparse.Namespace(benchmark="cmass", retrieval="document"))
        self.assertNotIn("CMASS_HYBRID", env)
        self.assertNotIn("PI_SEARCH_QUESTION_LIFETIME", env)
        hybrid = json.loads((ROOT / "configs/cmass-hybrid.json").read_text())
        args = argparse.Namespace(benchmark="cmass", retrieval="hybrid", document_url="http://d", passage_url="http://p")
        env = environment(hybrid, args)
        self.assertEqual((env["CMASS_HYBRID"], env["PI_SEARCH_QUESTION_LIFETIME"]), ("1", "1"))
        self.assertEqual((env["CMASS_HYBRID_DOCUMENT_URL"], env["CMASS_HYBRID_PASSAGE_URL"]), ("http://d", "http://p"))

    def test_hybrid_backend_constants_match_the_config(self):
        hybrid = json.loads((ROOT / "configs/cmass-hybrid.json").read_text())["hybrid"]
        source = (ROOT / "runtime/pi-serini/src/search-providers/anserini/cmass_hybrid_backend.ts").read_text()
        expected = (f"shortChars:{hybrid['short_chars_utf16']},fusion:\"{hybrid['fusion']}\",lambda:.5,"
                    f"passagesPerDoc:{hybrid['passages_per_doc']}")
        self.assertEqual(hybrid["lambda"], 0.5)
        self.assertIn(expected, source)
        self.assertIn(f"previewWindow:{hybrid['preview_window']}", source)


class PoolGrepReleaseTests(unittest.TestCase):
    def test_poolgrep_records_reproduce_the_published_aggregates(self):
        result = released_report("poolgrep")
        verify_release(result, "poolgrep")
        self.assertEqual(result["all"]["strict_correct"], 406)
        self.assertEqual(result["all"]["relaxed_correct"], 408)
        self.assertEqual(result["by_dataset"]["bcp"]["strict_correct"], 72)
        published = json.loads((ROOT / "results/cmass-poolgrep-summary.json").read_text())
        self.assertAlmostEqual(result["all"]["pool_grep_calls_mean"], published["all"]["pool_grep_calls_mean"])
        self.assertAlmostEqual(result["all"]["pool_grep_calls_mean"], 790 / 423)
        self.assertNotIn("pool_grep_calls_mean", released_report("bm25")["all"])

    def test_pool_service_must_match_the_config(self):
        from scripts.cmass_config import validate_pool_health

        config = json.loads((ROOT / "configs/cmass-poolgrep.json").read_text())
        health = dict(ready=True, mode="pool", index="climbmix-400b", documents=553240576,
                      bm25={"k1": 0.9, "b": 0.4}, documents_per_search=1000, grep_return_chars=8000, grep_seconds=5)
        self.assertIs(validate_pool_health(health, config), health)
        for key, value in (("documents", 1000), ("bm25", {"k1": 25, "b": 1}), ("documents_per_search", 100), ("ready", False)):
            with self.assertRaises(ValueError):
                validate_pool_health({**health, key: value}, config)

    def test_pool_grep_dry_run_selects_its_config_and_switch(self):
        import os

        with tempfile.TemporaryDirectory() as tmp:
            base = [sys.executable, str(ROOT / "scripts/run.py"), "cmass", "--out", tmp + "/run", "--dry-run"]
            plan = json.loads(subprocess.run(base + ["--pool-grep"], capture_output=True, text=True, check=True).stdout)
            self.assertTrue(plan["pool_grep"])
            self.assertEqual(plan["config_sha256"], sha256(ROOT / "configs/cmass-poolgrep.json"))
            self.assertEqual(plan["workers"], 4)
            self.assertIn("src/extensions/pi_search_jev_cmass_v1.ts", plan["first_command"])
            plain = json.loads(subprocess.run(base, capture_output=True, text=True, check=True).stdout)
            self.assertNotIn("pool_grep", plain)
            self.assertNotEqual(subprocess.run(base + ["--pool-grep", "--retrieval", "hybrid"],
                                               capture_output=True, text=True).returncode, 0)
        from scripts.run import environment

        config = json.loads((ROOT / "configs/cmass-poolgrep.json").read_text())
        with patch.dict(os.environ, {"CMASS_POOL_URL": "http://stale"}):
            env = environment(config, argparse.Namespace(benchmark="cmass", retrieval="document", pool_grep=True, pool_url="http://p"))
            self.assertEqual(env["CMASS_POOL_URL"], "http://p")
            env = environment(config, argparse.Namespace(benchmark="cmass", retrieval="document"))
            self.assertNotIn("CMASS_POOL_URL", env)

    def test_pool_grep_semantics(self):
        try:
            import re2  # noqa: F401
        except ImportError:
            self.skipTest("google-re2 is not installed")
        from services.cmass_pool import Pool

        pool = Pool()
        pool.add([("d1", "Title one\nThe Faun poem against yon pine, forlorn yet divine."),
                  ("d2", "Title two\nNo rhyme here."), ("d3", "Title three\npine trees and a divine view " * 3)], "s1")
        pool.add([("d3", "ignored: already pooled"), ("d4", "Title four\nAnother pine, another divine.")], "s2")
        self.assertEqual(pool.docs["d3"]["best_rank"], 1)
        self.assertEqual(pool.docs["d3"]["search_id"], "s2")
        result = pool.grep({"all_of": ["pine", "divine"], "window": 10})
        self.assertEqual(result["returned_docids"], ["d1", "d3", "d4"])
        self.assertEqual(result["matching_documents"], 3)
        self.assertTrue(result["text"].startswith("pool size: 4; matching documents: 3; offset: 0\n"))
        near = pool.grep({"all_of": ["pine"], "show": "pine", "near": "Faun", "window": 40})
        self.assertEqual(near["returned_docids"], ["d1"])
        paged = pool.grep({"all_of": ["pine"], "max_docs": 1, "offset": 1})
        self.assertEqual((paged["returned_docids"], paged["truncated"], paged["next_offset"]), (["d3"], True, 2))
        for bad in ({"all_of": []}, {"all_of": ["("]}, {"all_of": ["pine"], "window": 301}, {"all_of": ["pine"], "max_docs": 0}):
            with self.assertRaises(ValueError):
                pool.grep(bad)


if __name__ == "__main__":
    unittest.main()
