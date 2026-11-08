"""Per-question document pool with RE2 full-text grep for JevGPT w/ pool_grep.

Serves the full ClimbMix Anserini index on loopback next to services/cmass_search.py.
Every `search` of the runtime adds the query's top-1000 BM25 documents (full text) to the
question's pool; `pool_grep` scans that pool. No qrels, gold answers or model calls.
"""

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services"))
from cmass_search import document

CAP = 8000  # characters returned per pool_grep call
DEEP_K = 1000  # documents added per search
TIME_LIMIT = 5.0  # seconds per pool_grep call


def pattern(value):
    import re2

    if not isinstance(value, str) or not value or len(value) > 200:
        raise ValueError("Patterns must contain 1 to 200 characters")
    options = re2.Options()
    options.case_sensitive = False
    options.log_errors = False
    try:
        return re2.compile(value, options=options)
    except re2.error as error:
        raise ValueError("Invalid or unsupported RE2 pattern") from error


class Pool:
    """One question's pool: docid -> full text, best rank and the search that first added it."""

    def __init__(self):
        self.docs = {}

    def add(self, hits, search_id):
        """hits: iterable of (docid, text) in rank order; text may be a callable that loads the text."""
        for rank, (docid, text) in enumerate(hits, 1):
            docid = str(docid)
            old = self.docs.get(docid)
            if old is None:
                if callable(text):
                    text = text()
                if not isinstance(text, str):
                    raise ValueError("Pool source missing")
                title = " ".join(text.split("\n", 1)[0].split())[:220]
                self.docs[docid] = dict(docid=docid, title=title, best_rank=rank, search_id=search_id, text=text)
            elif rank < old["best_rank"]:
                old.update(best_rank=rank, search_id=search_id)

    def grep(self, args):
        start = time.monotonic()
        patterns = args.get("all_of")
        if not isinstance(patterns, list) or not 1 <= len(patterns) <= 4:
            raise ValueError("all_of must contain 1 to 4 patterns")
        all_of = [pattern(p) for p in patterns]
        show = pattern(args.get("show", patterns[0]))
        near = pattern(args["near"]) if args.get("near") is not None else None
        window, max_docs, offset = args.get("window", 150), args.get("max_docs", 20), args.get("offset", 0)
        if type(window) is not int or not 0 <= window <= 300:
            raise ValueError("window must be 0 to 300")
        if type(max_docs) is not int or not 1 <= max_docs <= 40:
            raise ValueError("max_docs must be 1 to 40")
        if type(offset) is not int or offset < 0:
            raise ValueError("offset must be nonnegative")

        def check_time():
            if time.monotonic() - start > TIME_LIMIT:
                raise TimeoutError(f"pool_grep exceeded {TIME_LIMIT:g} seconds; narrow the patterns")

        matches = []
        for doc in sorted(self.docs.values(), key=lambda d: (d["best_rank"], d["docid"])):
            check_time()
            text = doc["text"]
            if not all(p.search(text) is not None for p in all_of):
                continue
            windows = []
            for m in show.finditer(text):
                check_time()
                a, b = max(0, m.start() - window), min(len(text), m.end() + window)
                snippet = text[a:b]
                if near is not None and near.search(snippet) is None:
                    continue
                windows.append(dict(start=a, end=b, text=snippet))
                if len(windows) == 3:
                    break
            if near is not None and not windows:
                continue
            matches.append({k: v for k, v in doc.items() if k != "text"} | {"windows": windows})
        count = len(matches)
        output = f"pool size: {len(self.docs)}; matching documents: {count}; offset: {offset}\n"
        returned = []
        for doc in matches[offset : offset + max_docs]:
            block = json.dumps(doc, ensure_ascii=False) + "\n"
            if len(output) + len(block) + 100 > CAP:
                # A very long show match can exceed the cap: keep the document with bounded windows.
                if not returned:
                    doc = dict(doc, windows=[dict(w, text=w["text"][:1000], window_truncated=True) for w in doc["windows"]])
                    block = json.dumps(doc, ensure_ascii=False) + "\n"
                if len(output) + len(block) + 100 > CAP:
                    break
            output += block
            returned.append(doc["docid"])
        next_offset = offset + len(returned)
        truncated = next_offset < count
        if truncated:
            output += f"truncated, use offset={next_offset}\n"
        return dict(text=output, pool_size=len(self.docs), matching_documents=count, returned_docids=returned,
                    offset=offset, next_offset=next_offset, truncated=truncated,
                    elapsed_ms=(time.monotonic() - start) * 1000)


def handler(search, fingerprint):
    """search(query) -> list of (docid, text) for the top DEEP_K documents."""
    pools, lock = {}, threading.RLock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def send_json(self, obj, status):
            payload = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            try:
                self.wfile.write(payload)
            except BrokenPipeError:
                pass

        def do_GET(self):
            self.send_json(fingerprint, 200)

        def do_POST(self):
            try:
                args = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                pool_id = args["pool_id"]
                if not isinstance(pool_id, str) or not re.fullmatch(r"[0-9a-fA-F-]{1,100}", pool_id):
                    raise ValueError("Invalid pool identity")
                with lock:
                    if self.path == "/add":
                        query, search_id = args["query"], args["search_id"]
                        if not isinstance(query, str) or not query.strip() or len(query) > 10000:
                            raise ValueError("Invalid query")
                        hits = search(query)
                        pool = pools.setdefault(pool_id, Pool())
                        pool.add(hits, str(search_id))
                        result = dict(pool_size=len(pool.docs), deep_docids=[d for d, _ in hits])
                    elif self.path == "/grep":
                        result = pools.get(pool_id, Pool()).grep(args)
                    elif self.path == "/finish":
                        result = dict(pool_size=len(pools.pop(pool_id, Pool()).docs))
                    else:
                        raise ValueError("Unknown operation")
                self.send_json(result, 200)
            except Exception as error:
                self.send_json(dict(error=f"{type(error).__name__}: {error}"), 400)

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", type=Path, required=True)
    parser.add_argument("--anserini-jar", type=Path, required=True)
    parser.add_argument("--port", type=int, default=29782)
    parser.add_argument("--heap", default="8g", help="JVM heap, e.g. 8g")
    args = parser.parse_args()
    if not args.index.is_dir() or not re.fullmatch(r"[1-9]\d*[mMgG]", args.heap):
        parser.error("Expected an existing index directory and a JVM heap size")
    pattern("warmup")  # fail early without the RE2 module
    pin = json.loads((ROOT / "provenance/cmass-index.json").read_text())
    with args.anserini_jar.open("rb") as stream:
        digest = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != pin["anserini_jar_sha256"]:
        parser.error("Anserini jar does not match the evaluated version/hash")
    config = json.loads((ROOT / "configs/cmass-poolgrep.json").read_text())
    import jnius_config

    jnius_config.add_options("-Xmx" + args.heap, "-XX:ActiveProcessorCount=8", "--enable-native-access=ALL-UNNAMED")
    jnius_config.set_classpath(str(args.anserini_jar.resolve()))
    from jnius import autoclass

    engine = autoclass("io.anserini.search.SimpleSearcher")(str(args.index.resolve()))
    server = None
    try:
        engine.set_bm25(config["bm25"]["k1"], config["bm25"]["b"])
        engine.search("climbmix warmup", 1)
        fingerprint = {
            "ready": True,
            "mode": "pool",
            "index": config["retrieval"]["index"],
            "documents": int(engine.get_total_num_docs()),
            "bm25": config["bm25"],
            "documents_per_search": DEEP_K,
            "grep_return_chars": CAP,
            "grep_seconds": TIME_LIMIT,
        }
        if fingerprint["documents"] != config["retrieval"]["documents"]:
            parser.error("Index does not contain the full CMASS corpus")

        def search(query):
            return [(str(hit.docid), document(str(hit.lucene_document.get("raw")))["text"])
                    for hit in engine.search(query, DEEP_K)]

        server = ThreadingHTTPServer(("127.0.0.1", args.port), handler(search, fingerprint))
        print(json.dumps({"type": "server_ready", "port": server.server_port, "fingerprint": fingerprint}), flush=True)
        server.serve_forever()
    finally:
        if server is not None:
            server.server_close()
        engine.close()


if __name__ == "__main__":
    main()
