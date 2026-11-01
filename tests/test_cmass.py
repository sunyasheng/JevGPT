"""CMASS boundary tests: data isolation, source fidelity and backend limits."""

import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "scripts"), str(ROOT / "services"), str(ROOT)]
from run import inputs, command
from cmass_bridge import CmassBridge
from evaluation.cmass_protocol.protocol import verify_dsqa_verdict
from collect import collect_trial


class CmassTests(unittest.TestCase):
    def test_research_command_propagates_effort_and_timeout(self):
        from argparse import Namespace

        args = Namespace(
            out=Path("/tmp/new-sol-run"),
            benchmark="cmass",
            model="azure-cmass/gpt-6.1-sol",
            split="smoke4",
        )
        cmd = command(
            "bcp__1",
            dict(
                thinking="high",
                timeout_seconds=1800,
                extension="src/extensions/pi_search_jev_cmass_v1.ts",
            ),
            args,
        )
        self.assertEqual(cmd[cmd.index("--thinking") + 1], "high")
        self.assertEqual(cmd[cmd.index("--timeout-seconds") + 1], "1800")
        self.assertEqual(cmd[cmd.index("--model") + 1], args.model)

    def test_namespace_and_gold_isolation(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "q.jsonl"
            p.write_text(
                "\n".join(
                    json.dumps(
                        dict(
                            query_id=f"{s}__1",
                            dataset=s,
                            query="Question?",
                            answer="SECRET",
                            answer_set=["SECRET"],
                        )
                    )
                    for s in ("bcp", "dsqa")
                )
            )
            result = inputs(p, "cmass")
            self.assertEqual(len(result), 2)
            self.assertNotIn("SECRET", json.dumps(result))
            p.write_text(
                json.dumps(dict(query_id="bcp__../x", dataset="bcp", query="Q"))
            )
            with self.assertRaises(ValueError):
                inputs(p, "cmass")

    def test_bridge_pages_original_unicode_source_and_caches_search_hits(self):
        with tempfile.TemporaryDirectory() as d:
            b = CmassBridge("http://unused", d)
            text = "Title\nnon-BMP 😀\n\nTail\n"
            with patch.object(
                b,
                "request",
                return_value={
                    "candidates": [
                        {"docid": "shard_00001_2", "score": 1.2, "doc": {"text": text}}
                    ]
                },
            ) as request:
                result = b.execute("search", dict(query="Title", limit=100, offset=1))
                self.assertEqual(result["hits"][0]["snippet"], " ".join(text.split()))
                self.assertFalse(result["hasMore"])
                page = b.execute(
                    "readDocument", dict(docid="shard_00001_2", offset=2, limit=2)
                )
                self.assertEqual(page["text"], "non-BMP 😀\n")
                self.assertEqual(page["nextOffset"], 4)
                self.assertEqual(b.source("shard_00001_2"), text)
                self.assertEqual(request.call_count, 1)
            with self.assertRaises(ValueError):
                b.execute("search", dict(query="x", offset=100, limit=2))
            with patch.object(
                b, "request", side_effect=HTTPError("url", 404, "missing", {}, None)
            ):
                self.assertFalse(
                    b.execute("readDocument", dict(docid="shard_00001_999"))["found"]
                )

    def test_preview_bounds_do_not_modify_long_original_unicode_source(self):
        with tempfile.TemporaryDirectory() as d:
            b = CmassBridge("http://unused", d)
            text = ("😀  long\tline " * 2000) + "\n\n  Tail\r\n"
            with patch.object(
                b,
                "request",
                return_value={
                    "candidates": [
                        {"docid": "shard_00001_2", "score": 1, "doc": {"text": text}}
                    ]
                },
            ):
                hit = b.execute("search", dict(query="line", limit=5))["hits"][0]
            self.assertLessEqual(len(hit["title"]), 220)
            self.assertLessEqual(len(hit["title"]) + len(hit["snippet"]), 500)
            self.assertLessEqual(
                len((hit["title"] + hit["snippet"]).encode("utf-16-le")) // 2, 500
            )
            self.assertTrue(hit["snippetTruncated"])
            self.assertNotIn("\t", hit["title"] + hit["snippet"])
            self.assertEqual(b.source("shard_00001_2"), text)
            cached = json.loads(
                next((Path(d) / "source-cache").glob("*.json")).read_text()
            )
            self.assertEqual(cached["text"], text)

    def test_dsqa_subset_and_wrong_extra_are_distinct(self):
        v = dict(
            answers=[dict(text="first", gold_indices=[0])],
            strict_correct=False,
            relaxed_correct=True,
            reasoning="subset",
        )
        self.assertEqual(
            verify_dsqa_verdict(v, [{"member": "first"}, {"member": "second"}]),
            (False, True),
        )
        v["answers"].append(dict(text="wrong", gold_indices=[]))
        with self.assertRaises(ValueError):
            verify_dsqa_verdict(v, [{}, {}])
        v["relaxed_correct"] = False
        self.assertEqual(verify_dsqa_verdict(v, [{}, {}]), (False, False))

    def test_unpriced_model_and_recall_uses_shown_not_cache(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            (p / "raw-events").mkdir()
            (p / "bcp__1.json").write_text(
                json.dumps(
                    dict(status="completed", stats={"elapsed_seconds": 1}, result=[])
                )
            )
            events = [
                dict(
                    type="message_end",
                    message=dict(role="assistant", usage=dict(input=100, output=5)),
                ),
                dict(
                    type="tool_execution_end",
                    toolName="search",
                    result={
                        "details": {"previewedDocids": ["shard_00001_1"]},
                        "content": [{"type": "text", "text": "shard_00001_1"}],
                    },
                ),
            ]
            (p / "raw-events/bcp__1.jsonl").write_text(
                "\n".join(json.dumps(x) for x in events)
            )
            (p / "backend-requests.jsonl").write_text(
                json.dumps(
                    dict(operation="search", docids=["shard_00001_1", "shard_00001_2"])
                )
            )
            row = collect_trial(p, "bcp__1", "cmass")
            self.assertIsNone(row["gpt_cost_usd"])
            self.assertEqual(row["search_shown_docids"], ["shard_00001_1"])
            self.assertEqual(len(row["cached_retrieval_docids"]), 2)


class ScoringTests(unittest.TestCase):
    def test_truncated_preview_does_not_count_hidden_ids_or_unrelated_notices(self):
        from evaluation.cmass import visible_search_ids

        events = [
            dict(
                type="tool_execution_end",
                toolName="search",
                result=dict(
                    details={"previewedDocids": ["shard_00001_1", "shard_00001_2"]},
                    content=[
                        dict(
                            type="text",
                            text="Visible: shard_00001_1; autoscan: shard_00001_3",
                        )
                    ],
                ),
            )
        ]
        self.assertEqual(visible_search_ids(events), ["shard_00001_1"])

    def test_strict_grading_and_unknown_denominator(self):
        from evaluation.cmass import parse_verdict, summarize

        gold = dict(dataset="bcp", answer="gold")
        with self.assertRaises(ValueError):
            parse_verdict(
                json.dumps(
                    dict(
                        extracted_final_answer="x",
                        correct_answer="other",
                        reasoning="x",
                        correct=True,
                        confidence=99,
                    )
                ),
                gold,
            )
        rows = [
            dict(
                query_id="bcp__1",
                dataset="bcp",
                status="completed",
                correct=True,
                relaxed_correct=True,
                search_shown_docids=["a"],
                cached_retrieval_docids=["a", "b"],
            ),
            dict(
                query_id="bcp__2",
                dataset="bcp",
                status="failed",
                correct=None,
                relaxed_correct=None,
                search_shown_docids=[],
                cached_retrieval_docids=[],
            ),
        ]
        report = summarize(
            rows, {("bcp__1", "all"): {"a", "b"}, ("bcp__2", "all"): {"c"}}
        )["all"]
        self.assertIsNone(report["strict_accuracy_percent"])
        self.assertEqual(report["n"], 2)
        self.assertEqual(report["recall"]["all"]["percent"]["search_shown_docids"], 25)
        self.assertEqual(
            report["recall"]["all"]["percent"]["cached_retrieval_docids"], 50
        )


if __name__ == "__main__":
    unittest.main()
