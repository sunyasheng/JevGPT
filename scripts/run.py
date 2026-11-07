"""Run released JevGPT on BrowseComp, NeuCLIR, or CMASS with document or hybrid BM25 retrieval."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager
from datetime import datetime, timezone
import json
import os
import re
from pathlib import Path
import select
import signal
import subprocess
import sys
from urllib.parse import urlsplit

from common import ROOT, RUNTIME, browsecomp_research_query, by_id, read_json, read_jsonl, sha256, write_json, write_jsonl
from collect import collect_trial
from cmass_config import validate_health as validate_cmass_health, validate_budget as validate_cmass_budget, validate_hybrid_health, validate_pool_health


def inputs(path, benchmark):
    rows = []
    for item in read_jsonl(path):
        qid = str(item.get("query_id", item.get("topic_id", "")))
        if benchmark == "cmass":
            if not re.fullmatch(r"(?:bcp|trqa|dsqa|hotpotqa)__[A-Za-z0-9_-]+", qid) or item.get("dataset") != qid.split("__", 1)[0]:
                raise ValueError("CMASS requires dataset-scoped safe IDs")
            query = browsecomp_research_query(item["query"])
            rows.append({"query_id": qid, "dataset": item["dataset"], "query": query})
            continue
        if not qid.isdigit():
            raise ValueError("Query IDs must be nonnegative integers")
        if benchmark == "browsecomp":
            query = browsecomp_research_query(item["query"])
            # Only question text is written to research inputs, even when reading a decrypted dataset.
            rows.append({"query_id": qid, "query": query})
        else:
            if "topics" in item:
                matches = [t for t in item["topics"] if t.get("lang") == "eng" and t.get("source") == "original"]
                if len(matches) != 1:
                    raise ValueError(f"Expected one original English topic: {qid}")
                topic = matches[0]
            else:
                topic = item["topic"]
            if topic.get("lang") != "eng" or topic.get("source") != "original":
                raise ValueError(f"Expected an original English topic: {qid}")
            kept = {k: topic[k] for k in ("lang", "source", "topic_title", "topic_description")}
            if not all(isinstance(kept[k], str) and kept[k].strip()
                       for k in ("topic_title", "topic_description")):
                raise ValueError(f"Missing title or description: {qid}")
            rows.append({"query_id": qid, "topic": kept, "topic_fields": ["title", "description"],
                         "query": f"Title: {kept['topic_title']}\n\nDescription: {kept['topic_description']}"})
    return by_id(rows)


def environment(config, args):
    # Do not inherit experimental knob overrides from another worktree/session.
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("JEV_", "PI_BM25_", "PI_PASSAGE_", "PI_HYBRID_", "PI_SEARCH_", "INSPECT_", "CMASS_HYBRID", "CMASS_POOL"))}
    env.update(config["environment"])
    env.update(JEV_MODEL=config["system_one_model"], JEV_BATCH_SIZE=str(config["batch_size"]),
               JEV_GPT_SOURCE_CHARS=str(config["gpt_source_chars"]),
               JEV_URL=os.environ.get("JEV_URL", "https://api.typesafe.ai/v1/systemone"),
               JEV_SPLITTER_PYTHON=sys.executable,
               JEV_SPLITTER_SCRIPT=str(ROOT / "scripts/jev_source_chunker_v1.py"),
               JEV_OVERLAP_SCRIPT=str(ROOT / "scripts/jev_overlap_chunker_v1.py"),
               JEV_EVIDENCE_PAGE_SCRIPT=str(ROOT / "scripts/jev_evidence_page_chunker_v1.py"),
               PI_SEARCH_DUMP_PROMPTS="1", TIMEOUT_SECONDS=str(config["timeout_seconds"]))
    if args.benchmark == "browsecomp":
        env.update(PI_BM25_K1=str(config["bm25"]["k1"]), PI_BM25_B=str(config["bm25"]["b"]),
                   PI_BM25_THREADS="1", ANSERINI_FATJAR_PATH=str(args.anserini_jar),
                   PI_PASSAGE_ID_PREFIX="browsecomp_plus_", PI_HYBRID_DOC_LENGTHS=str(args.doc_lengths),
                   PI_SEARCH_TASK_MODE="answer_question")
    elif args.benchmark == "cmass":
        env["PI_SEARCH_TASK_MODE"] = "answer_question"
        if args.retrieval == "hybrid":
            env.update(CMASS_HYBRID="1", CMASS_HYBRID_DOCUMENT_URL=args.document_url,
                       CMASS_HYBRID_PASSAGE_URL=args.passage_url)
        if getattr(args, "pool_grep", False):
            env["CMASS_POOL_URL"] = args.pool_url  # enables the pool, pool_grep and the compact jev_find return
    else:
        env["PI_SEARCH_TASK_MODE"] = "rank_documents"
    return env


def command(qid, config, args):
    trial = args.out / "trials" / qid
    prefix = [str(RUNTIME / "node_modules/.bin/tsx")]
    if args.benchmark == "browsecomp":
        return prefix + ["src/orchestration/query_set.ts", "--benchmark", "browsecomp-plus", "--query-set", "qfull",
                         "--query-file", str(args.out / "inputs" / f"{qid}.tsv"), "--model", args.model,
                         "--thinking", config["thinking"], "--timeout-seconds", str(config["timeout_seconds"]),
                         "--prompt-variant", config["prompt_variant"], "--index-path", str(args.doc_index),
                         "--qrels", str(args.out / "inputs/empty-qrels.txt"),
                         "--pi", str(RUNTIME / "node_modules/.bin/pi"), "--extension", config["extension"],
                         "--output-dir", str(trial)]
    return prefix + ["scripts/run_cmass_v1.ts" if args.benchmark == "cmass" else "scripts/run_neuclir_unified_medium_v1.ts", "--benchmark", args.benchmark,
                     "--topic", str(args.out / "inputs" / f"{qid}.json"), "--topic-mode", "title_description",
                     "--output", str(trial), "--model", args.model, "--extension", config["extension"],
                     "--timeout-seconds", str(config["timeout_seconds"]), "--query-set-id", args.split,
                     "--thinking", config["thinking"]]


def stop(child):
    if child.poll() is not None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=5)


@contextmanager
def service(cmd, logfile, env):
    """Start a fresh local backend; always reap the process group on exit."""
    with Path(logfile).open("x") as log:
        child = subprocess.Popen(cmd, cwd=RUNTIME, env=env, stdout=subprocess.PIPE, stderr=log,
                                 text=True, start_new_session=True)
        try:
            if not select.select([child.stdout], [], [], 30)[0]:
                raise RuntimeError(f"Backend readiness timed out; see {logfile}")
            ready = json.loads(child.stdout.readline())
            if ready.get("type") != "server_ready":
                raise RuntimeError(f"Invalid backend readiness; see {logfile}")
            yield ready
        finally:
            stop(child)
            child.stdout.close()


def hybrid_health(args, config):
    """Both CMASS hybrid services must serve the full corpus with the frozen BM25 settings."""
    from urllib.request import urlopen
    health = {}
    for side, url in (("document", args.document_url), ("passage", args.passage_url)):
        with urlopen(url + "/health", timeout=60) as response:
            health[side] = json.load(response)
    return validate_hybrid_health(health, config)


def bm25_command(args, index, params):
    return [args.java, "-cp", os.pathsep.join([str(RUNTIME / "jvm/build/classes"), str(args.anserini_jar)]),
            "dev.jhy.piserini.Bm25Server", "--index-path", str(index), "--transport", "tcp",
            "--host", "127.0.0.1", "--port", "0", "--k1", str(params["k1"]), "--b", str(params["b"]),
            "--threads", "1"]


def trial(qid, config, args, env):
    folder = args.out / "trials" / qid
    folder.mkdir(parents=True, exist_ok=False)
    local = dict(env, JEV_FIND_LOG=str(folder / "jev-find.jsonl"))
    try:
        with ExitStack() as stack:
            if args.benchmark == "browsecomp":
                doc = stack.enter_context(service(bm25_command(args, args.doc_index, config["bm25"]), folder / "doc-backend.log", local))
                passage = stack.enter_context(service(bm25_command(args, args.passage_index, config["passage_bm25"]), folder / "passage-backend.log", local))
                local.update(PI_BM25_RPC_HOST=doc["host"], PI_BM25_RPC_PORT=str(doc["port"]),
                             PI_PASSAGE_RPC_HOST=passage["host"], PI_PASSAGE_RPC_PORT=str(passage["port"]))
                write_json(folder / "backend.json", {"document": doc, "passage": passage})
            elif args.benchmark == "cmass" and args.retrieval == "hybrid":
                # The extension queries both services directly; this entry only configures the shared runtime.
                health = hybrid_health(args, config)
                local["PI_SEARCH_EXTENSION_CONFIG"] = json.dumps({"backend": {
                    "kind": "http-json", "capabilities": {"backendId": "cmass-hybrid", "supportsScore": True,
                    "supportsSnippets": True, "supportsExactTotalHits": False,
                    "maxPageSize": config["retrieval"]["max_cached_hits"]},
                    "endpoints": {"searchUrl": args.document_url + "/search", "readDocumentUrl": args.document_url + "/doc"}}})
                write_json(folder / "backend.json", {"hybrid": health})
            else:
                backend = stack.enter_context(service([sys.executable, str(ROOT / ("services/cmass_bridge.py" if args.benchmark == "cmass" else "services/neuclir_bridge.py")),
                    "--upstream", args.search_url, "--artifact-dir", str(folder)], folder / "backend.log", local))
                fingerprint = backend["fingerprint"]
                if args.benchmark == "neuclir" and (fingerprint.get("hybrid") != config["retriever"] or fingerprint.get("bm25") != config["bm25"]):
                    raise ValueError("NeuCLIR service does not match the frozen hybrid BM25 configuration")
                url = f"http://127.0.0.1:{backend['port']}"
                local["PI_SEARCH_EXTENSION_CONFIG"] = json.dumps({"backend": {
                    "kind": "http-json", "capabilities": {"backendId": "cmass-climbmix-bm25" if args.benchmark == "cmass" else "neuclir-mt-bm25",
                    **({"maxPageSize": config["retrieval"]["max_cached_hits"]} if args.benchmark == "cmass" else {}), "supportsScore": True,
                    "supportsSnippets": True, "supportsExactTotalHits": False},
                    "endpoints": {"searchUrl": url + "/search", "readDocumentUrl": url + "/readDocument"}}})
                write_json(folder / "backend.json", backend)
            cmd = command(qid, config, args)
            write_json(folder / "invocation.json", {"command": cmd})
            with (folder / "controller.log").open("x") as log:
                child = subprocess.Popen(cmd, cwd=RUNTIME, env=local, stdout=log, stderr=subprocess.STDOUT,
                                         start_new_session=True)
                try:
                    child.wait(timeout=config["timeout_seconds"] + 120)
                finally:
                    stop(child)
            row = collect_trial(folder, qid, args.benchmark, config["prices_usd_per_million"])
    except Exception as error:
        # Every selected ID retains a terminal record, including startup failures.
        row = {"query_id": qid, "status": "infrastructure_failed", "final_answer": "",
               **({"dataset": qid.split("__", 1)[0]} if args.benchmark == "cmass" else {}),
               "usage_unknown": True, "error": f"{type(error).__name__}: {error}",
               "submitted_docids": [], "parse_error": "Trial failed"}
    write_json(args.out / "answers" / f"{qid}.json", row)
    print(json.dumps({"query_id": qid, "status": row["status"], "usage_unknown": row["usage_unknown"]}), flush=True)
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("benchmark", choices=("browsecomp", "neuclir", "cmass"))
    parser.add_argument("--questions", type=Path)
    parser.add_argument("--split", default="all", help="Key in splits/<benchmark>.json")
    parser.add_argument("--ids", help="Comma-separated subset of the selected split")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model", default=os.environ.get("JEVGPT_MODEL"))
    parser.add_argument("--allow-model-change", action="store_true", help="Explicitly allow a different CMASS model for a new experiment")
    parser.add_argument("--workers", type=int, help="Defaults: 3 BCP, 4 NeuCLIR, 8 CMASS, 4 CMASS hybrid questions")
    parser.add_argument("--retrieval", choices=("document", "hybrid"), default="document",
                        help="CMASS: document BM25 (default) or document + passage hybrid BM25")
    parser.add_argument("--pool-grep", action="store_true",
                        help="JevGPT w/ pool_grep: CMASS document BM25 plus services/cmass_pool.py (configs/cmass-poolgrep.json)")
    parser.add_argument("--pool-url", default="http://127.0.0.1:29782", help="CMASS pool_grep service")
    parser.add_argument("--document-url", default="http://127.0.0.1:29761", help="CMASS hybrid document service")
    parser.add_argument("--passage-url", default="http://127.0.0.1:29762", help="CMASS hybrid passage service")
    parser.add_argument("--doc-index", type=Path, default=ROOT / "data/browsecomp/document-index")
    parser.add_argument("--passage-index", type=Path, default=ROOT / "data/browsecomp/passage-index")
    parser.add_argument("--doc-lengths", type=Path, default=ROOT / "data/browsecomp/doc-lengths.tsv")
    parser.add_argument("--anserini-jar", type=Path, default=RUNTIME / "vendor/anserini/anserini-1.6.0-fatjar.jar")
    parser.add_argument("--java", default="java")
    parser.add_argument("--search-url", help="Defaults to localhost:19431 for CMASS, :19421 for NeuCLIR")
    parser.add_argument("--splits", type=Path, help="CMASS prepared splits.json; defaults beside --questions")
    parser.add_argument("--dry-run", action="store_true", help="Print the plan; no services, credentials or model calls")
    args = parser.parse_args()
    if args.retrieval == "hybrid" and args.benchmark != "cmass":
        parser.error("--retrieval hybrid applies to CMASS only")
    if args.pool_grep and (args.benchmark != "cmass" or args.retrieval != "document"):
        parser.error("--pool-grep applies to CMASS document retrieval only")
    config_path = ROOT / "configs" / ("cmass-hybrid.json" if args.retrieval == "hybrid"
                                      else "cmass-poolgrep.json" if args.pool_grep else f"{args.benchmark}.json")
    config = read_json(config_path)
    args.model = args.model or config.get("provider", "openai") + "/" + config["system_two_model"]
    if args.benchmark == "cmass":
        validate_cmass_budget(config)
        if args.model.split("/", 1)[-1] != config["system_two_model"] and not args.allow_model_change:
            parser.error("CMASS requires gpt-6.1-sol; check JEVGPT_MODEL or explicitly use --allow-model-change")
    args.search_url = args.search_url or ("http://127.0.0.1:19431" if args.benchmark == "cmass" else "http://127.0.0.1:19421")
    if args.benchmark == "cmass":
        args.questions = (args.questions or ROOT / "data/cmass/inputs/questions.jsonl").expanduser().resolve()
        splits_path = args.splits or (args.questions.parent / "splits.json"
                                     if args.questions.exists() else ROOT / "splits/cmass.json")
    else:
        splits_path = args.splits or ROOT / "splits" / f"{args.benchmark}.json"
    splits = read_json(splits_path)
    if args.split not in splits or not isinstance(splits[args.split], list) or not all(isinstance(q, str) for q in splits[args.split]):
        parser.error("Unknown ID split")
    ids = args.ids.split(",") if args.ids else splits[args.split]
    if not ids or len(set(ids)) != len(ids) or not set(ids) <= set(splits[args.split]):
        parser.error("IDs must be a nonempty, unique subset of the selected split")
    args.workers = args.workers if args.workers is not None else config["workers"]
    if args.workers < 1:
        parser.error("--workers must be positive")
    for name in ("out", "doc_index", "passage_index", "doc_lengths", "anserini_jar"):
        setattr(args, name, getattr(args, name).expanduser().resolve())
    args.questions = (args.questions or (ROOT / "data/browsecomp/inputs/questions.jsonl" if args.benchmark == "browsecomp"
                                       else ROOT / "inputs/neuclir-topics.jsonl")).expanduser().resolve()
    query_rows = inputs(args.questions, args.benchmark) if args.questions.is_file() else None
    if query_rows is not None and not set(ids) <= set(query_rows):
        parser.error("The question file is missing selected IDs")
    manifest = {"benchmark": args.benchmark, **({"retrieval_variant": args.retrieval} if args.benchmark == "cmass" else {}),
                **({"pool_grep": True} if args.pool_grep else {}),
                "ids": ids, "config": config, "model": args.model,
                "workers": args.workers, "questions_sha256": sha256(args.questions) if query_rows else None,
                "config_sha256": sha256(config_path),
                "prices_usd_per_million": config["prices_usd_per_million"],
                "reporting_policy": "One attempt per selected item; failed outcomes retained; no automatic reruns."}
    if args.dry_run:
        print(json.dumps({**manifest, "questions": str(args.questions), "out": str(args.out),
                          "first_command": command(ids[0], config, args)}, indent=2))
        return
    if args.out.exists():
        parser.error("Use a new output directory; existing runs are never overwritten")
    if query_rows is None:
        parser.error(f"Missing question file: {args.questions}")
    if not os.environ.get("TYPESAFE_API_KEY"):
        parser.error("Export TYPESAFE_API_KEY before starting a live run")
    for binary in ("pi", "tsx"):
        if not (RUNTIME / "node_modules/.bin" / binary).is_file():
            parser.error("Run npm ci --prefix runtime/pi-serini first")
    try:
        import importlib.metadata
        if importlib.metadata.version("semantic-text-splitter") != "0.33.0":
            raise ValueError("Unexpected splitter version")
    except (importlib.metadata.PackageNotFoundError, ValueError):
        parser.error("Install requirements.txt in the Python environment used to launch this command")
    if args.benchmark == "browsecomp":
        for p in (args.doc_index, args.passage_index, args.doc_lengths, args.anserini_jar,
                  RUNTIME / "jvm/build/classes/dev/jhy/piserini/Bm25Server.class"):
            if not p.exists():
                parser.error(f"Missing BCP asset: {p}; see docs/reproduce.md#browsecomp-plus")
        manifest["retrieval"] = {"doc_index": str(args.doc_index), "passage_index": str(args.passage_index),
                                 "doc_lengths_sha256": sha256(args.doc_lengths), "anserini_sha256": sha256(args.anserini_jar)}
    else:
        names = (("document_url", "passage_url") if args.retrieval == "hybrid"
                 else ("search_url", "pool_url") if args.pool_grep else ("search_url",))
        for name in names:
            url = urlsplit(getattr(args, name))
            if url.scheme not in ("http", "https") or not url.netloc or url.username or url.password or url.query or url.fragment:
                parser.error(f"--{name.replace('_', '-')} must be an HTTP(S) service URL without embedded credentials")
            setattr(args, name, getattr(args, name).rstrip("/"))
        manifest["retrieval"] = {name: getattr(args, name) for name in names}
    if args.benchmark == "cmass":
        prepared_path = args.questions.parent / "prepared.json"
        prepared = read_json(prepared_path)
        if prepared["revision"] != read_json(ROOT / "provenance/cmass-data.json")["revision"]:
            parser.error("CMASS prepared dataset revision differs from the release")
        if prepared["files"]["questions.jsonl"] != sha256(args.questions) or prepared["files"]["splits.json"] != sha256(splits_path):
            parser.error("CMASS prepared inputs were changed")
        manifest["data"] = {"revision": prepared["revision"], "prepared_sha256": sha256(prepared_path)}
        agent_dir = Path(os.environ.get("PI_CODING_AGENT_DIR", str(Path.home() / ".pi/agent"))).expanduser()
        models_path = agent_dir / "models.json"
        if not models_path.is_file() or "/" not in args.model:
            parser.error("CMASS needs an explicit Pi model profile; see configs/cmass-models.example.json")
        provider, model = args.model.split("/", 1)
        definitions = read_json(models_path).get("providers", {}).get(provider, {}).get("models", [])
        matches = [entry for entry in definitions if entry.get("id") == model]
        if len(matches) != 1 or matches[0].get("contextWindow") != config["configured_context_tokens"] or matches[0].get("maxTokens") != config["max_output_tokens"]:
            parser.error("CMASS model profile must explicitly set contextWindow=200000 and maxTokens=16384")
        manifest["provider_profile_sha256"] = sha256(models_path)
        # Reject unavailable/mismatched retrieval before consuming any question.
        from urllib.request import urlopen
        import ssl
        import certifi
        try:
            if args.retrieval == "hybrid":
                manifest["retrieval"]["fingerprint"] = hybrid_health(args, config)
            else:
                with urlopen(args.search_url.rstrip("/") + "/health", timeout=30,
                             context=ssl.create_default_context(cafile=certifi.where())) as response:
                    manifest["retrieval"]["fingerprint"] = validate_cmass_health(json.load(response), config)
                if args.pool_grep:
                    with urlopen(args.pool_url + "/health", timeout=30,
                                 context=ssl.create_default_context(cafile=certifi.where())) as response:
                        manifest["retrieval"]["pool_fingerprint"] = validate_pool_health(json.load(response), config)
        except Exception as error:
            parser.error("CMASS retrieval preflight failed (" + type(error).__name__ + "); no questions started")
    manifest["started_at"] = datetime.now(timezone.utc).isoformat()
    manifest["runtime_sources"] = {str(p.relative_to(ROOT)): sha256(p)
        for base, pattern in [(RUNTIME / "src", "*.ts"), (RUNTIME / "scripts", "*.ts"), (ROOT / "scripts", "*.py"), (ROOT / "services", "*.py"), (ROOT / "services", "*.java"), (ROOT / "scripts", "*.mjs"), (ROOT / "evaluation/cmass_protocol/prompts", "*.txt")]
        for p in sorted(base.rglob(pattern))}
    args.out.mkdir(parents=True, exist_ok=False)
    write_json(args.out / "manifest.json", manifest)
    (args.out / "inputs").mkdir()
    (args.out / "inputs/empty-qrels.txt").write_text("")
    for q in ids:
        if args.benchmark == "browsecomp":
            (args.out / "inputs" / f"{q}.tsv").write_text(f"{q}\t{query_rows[q]['query']}\n", encoding="utf-8")
        else:
            write_json(args.out / "inputs" / f"{q}.json", query_rows[q])
    env = environment(config, args)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        rows = list(pool.map(lambda q: trial(q, config, args, env), ids))
    write_jsonl(args.out / "records.jsonl", rows)
    write_json(args.out / "complete.json", {"selected": len(ids), "terminal": len(rows),
               "completed": sum(r["status"] == "completed" for r in rows),
               "failed": sum(r["status"] != "completed" for r in rows),
               "usage_unknown": sum(r["usage_unknown"] for r in rows)})
    if any(r["status"] != "completed" for r in rows):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
