"""Offline regression checks for release-specific launch, grading and accounting boundaries."""
import argparse
from contextlib import redirect_stdout
import gzip
import io
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from evaluation.browsecomp import grade
from evaluation.browsecomp_parser import parse_judge_response
from evaluation.neuclir import evaluate, load_trec, rank_records, topic_metrics
from scripts.collect import collect_trial, parse_docids
from scripts.report import summarize
from prepare_neuclir_corpus import prepare
from run import inputs


class MetricsTests(unittest.TestCase):
    def test_linear_gain_unjudged_and_fixed_precision_denominator(self):
        metrics = topic_metrics(["low", "unjudged", "high"], {"high": 3, "low": 1})
        expected = (1 + 3 / math.log2(4)) / (3 + 1 / math.log2(3))
        self.assertAlmostEqual(metrics["nDCG@20"], expected)
        self.assertEqual(metrics["P@20"], 2 / 20)
        self.assertEqual(metrics["R@20"], 1)

    def test_missing_and_failed_topics_retain_denominator(self):
        rankings = rank_records([{"query_id": "a", "status": "failed", "submitted_docids": ["gold"]}], ["a", "b"])
        result = evaluate(rankings, {"a": {"gold": 3}, "b": {"other": 1}}, ["a", "b"])
        self.assertEqual(result["topics"], 2)
        self.assertEqual(result["metrics"]["nDCG@20"], 0)

    def test_macro_f1_is_not_f1_of_macro_precision_and_recall(self):
        result = evaluate({"a": ["x"], "b": [str(i) for i in range(20)]},
                          {"a": {"x": 1}, "b": {str(i): 1 for i in range(100)}}, ["a", "b"])
        per = result["per_topic"]
        expected = (per["a"]["F1@20"] + per["b"]["F1@20"]) / 2
        self.assertEqual(result["metrics"]["F1@20"], expected)
        p, r = result["metrics"]["P@20"], result["metrics"]["R@20"]
        self.assertNotAlmostEqual(expected, 2 * p * r / (p + r))

    def test_trec_ambiguous_scores_and_duplicate_docids_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "run.trec"
            for text in ("a Q0 x 1 1 tag\na Q0 y 2 1 tag\n", "a Q0 x 1 2 tag\na Q0 x 2 1 tag\n"):
                path.write_text(text)
                with self.assertRaises(ValueError):
                    load_trec(path)

    def test_rank_parser_retains_first_duplicate_and_rejects_prose(self):
        self.assertEqual(parse_docids('Reasoning.\nExact Answer: ["b", "a", "b"]'), ["b", "a"])
        with self.assertRaises(ValueError):
            parse_docids("The relevant documents are a and b")

    def test_report_rejects_dropped_questions_and_unknown_grade_is_not_zero(self):
        row = {"query_id": "1", "status": "completed", "correct": None, "usage_unknown": True}
        with self.assertRaises(ValueError):
            summarize([row], ["1", "2"], "browsecomp")
        with self.assertRaises(ValueError):
            summarize([row, row], ["1"], "browsecomp")
        result = summarize([row], ["1"], "browsecomp")
        self.assertIsNone(result["accuracy_percent"])
        self.assertIsNone(result["s2_usd_mean"])


class BoundaryTests(unittest.TestCase):
    def test_bcp_questions_preserve_embedded_tabs_in_the_original_tsv_transport(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "input.jsonl"
            path.write_text(json.dumps({"query_id": "155", "query": "First part.\tSecond  part?"}) + "\n")
            self.assertEqual(inputs(path, "browsecomp")["155"]["query"], "First part.\tSecond  part?")
            path.write_text(json.dumps({"query_id": "155", "query": "An invalid\nTSV record"}) + "\n")
            with self.assertRaises(ValueError):
                inputs(path, "browsecomp")

    def test_question_input_drops_gold_and_topic_input_drops_narrative(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "input.jsonl"
            path.write_text(json.dumps({"query_id": "1", "query": "Question?", "answer": "SECRET", "gold_docs": ["x"]}) + "\n")
            self.assertEqual(inputs(path, "browsecomp"), {"1": {"query_id": "1", "query": "Question?"}})
            topic = {"lang": "eng", "source": "original", "topic_title": "Title", "topic_description": "Description", "topic_narrative": "EXCLUDED"}
            path.write_text(json.dumps({"topic_id": 200, "topics": [topic]}) + "\n")
            result = inputs(path, "neuclir")["200"]
            self.assertEqual(result["query"], "Title: Title\n\nDescription: Description")
            self.assertNotIn("EXCLUDED", json.dumps(result))

    def test_failed_research_is_incorrect_without_a_judge_request(self):
        with patch("evaluation.browsecomp.urlopen", side_effect=AssertionError("Unexpected API request")):
            result = grade({"query_id": "1", "status": "timeout", "final_answer": "maybe correct"},
                           {}, "unused", argparse.Namespace(), Path("unused"), "unused")
        self.assertFalse(result["correct"])
        self.assertEqual(result["grade_status"], "research_failed")

    def test_official_grader_parser_keeps_unknown_separate(self):
        self.assertTrue(parse_judge_response("correct: yes")["correct"])
        self.assertFalse(parse_judge_response("**correct:** no")["correct"])
        self.assertTrue(parse_judge_response("unparseable")["parse_error"])
        self.assertIsNone(parse_judge_response("unparseable")["correct"])

    def test_accounting_includes_cached_input_once_and_all_local_judgments(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder / "raw-events").mkdir()
            run = {"status": "completed", "stats": {"elapsed_seconds": 2}, "result": [{"type": "output_text", "output": "Answer"}]}
            (folder / "1.json").write_text(json.dumps(run))
            events = [{"type": "message_end", "message": {"role": "assistant", "usage": {"input": 10, "cacheRead": 20, "cacheWrite": 3, "output": 4}}},
                      {"type": "tool_execution_start", "toolName": "search"}]
            (folder / "raw-events/1.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))
            logs = [{"type": "judge", "ok": True, "response": {"usage": {"input_tokens": 60}}},
                    {"type": "adaptive_gate", "ok": True, "response": {"usage": {"input_tokens": 40}}}]
            (folder / "jev-find.jsonl").write_text("".join(json.dumps(e) + "\n" for e in logs))
            result = collect_trial(folder, "1", "browsecomp")
            self.assertEqual(result["input_tokens"], 33)
            self.assertEqual(result["cached_input_tokens"], 20)
            self.assertAlmostEqual(result["gpt_cost_usd"], (13 * 5 + 20 * 0.5 + 4 * 30) / 1e6)
            self.assertEqual(result["jev_input_tokens"], 100)
            self.assertFalse(result["usage_unknown"])
            with (folder / "jev-find.jsonl").open("a") as handle:
                handle.write(json.dumps({"type": "judge", "ok": False}) + "\n")
            result = collect_trial(folder, "1", "browsecomp")
            self.assertTrue(result["usage_unknown"])
            self.assertEqual(result["jev_failed_requests"], 1)

    def test_corpus_conversion_preserves_ids_text_and_first_duplicate(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            for lang, records in {"fas": [{"id": "a", "title": " T ", "text": " Body "}],
                                  "rus": [{"id": "a", "title": "duplicate", "text": "ignored"}],
                                  "zho": [{"id": "b", "text": "汉字"}]}.items():
                with gzip.open(base / f"{lang}.mt.eng-00000-of-00001.jsonl.gz", "wt") as handle:
                    for row in records:
                        handle.write(json.dumps(row) + "\n")
            with redirect_stdout(io.StringIO()):
                stats = prepare(base, base / "collection", shards=2, expected_documents=2)
            rows = [json.loads(p.read_text()) for p in sorted((base / "collection").glob("*.jsonl"))]
            self.assertEqual(stats["duplicates_skipped"], 1)
            self.assertEqual(rows[0]["contents"], "T\n\nBody")
            self.assertEqual(rows[1]["id"], "b")
            self.assertEqual(rows[1]["contents"], "汉字")

    def test_dry_runs_need_no_keys_indexes_or_generated_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            for benchmark, qid in (("browsecomp", "1"), ("neuclir", "200")):
                out = Path(tmp) / benchmark
                result = subprocess.run([sys.executable, str(ROOT / "scripts/run.py"), benchmark, "--ids", qid,
                                         "--out", str(out), "--dry-run"], capture_output=True, text=True, check=True)
                plan = json.loads(result.stdout)
                self.assertEqual(plan["ids"], [qid])
                self.assertEqual(plan["config"]["timeout_seconds"], 300)
                self.assertEqual(plan["config"]["submit_now_seconds"], 210)
                self.assertFalse(out.exists())


if __name__ == "__main__":
    unittest.main()
