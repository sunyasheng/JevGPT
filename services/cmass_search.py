"""Serve the full ClimbMix Anserini index on loopback; no model calls."""

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import sys
from urllib.parse import parse_qs, unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from cmass_config import validate_health


def document(raw):
    # FineWebCollection raw JSON may contain literal ASCII control characters.
    # Tolerant parsing retains the original source text, as in the evaluated API.
    value = json.loads(raw, strict=False)
    if not isinstance(value, dict) or not isinstance(value.get("text"), str):
        raise ValueError("Index raw field does not contain original document text")
    return value


def handler(engine, fingerprint, max_hits):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            try:
                path = urlsplit(self.path)
                params = parse_qs(path.query)
                prefix = "/v1/" + fingerprint["index"]
                if path.path == "/health":
                    result = fingerprint
                elif path.path == prefix + "/search":
                    query = params.get("query", [""])[0]
                    hits = int(params.get("hits", ["5"])[0])
                    if (
                        not query.strip()
                        or len(query) > 10000
                        or not 1 <= hits <= max_hits
                    ):
                        raise ValueError("Invalid query or hit count")
                    candidates = [
                        {
                            "docid": str(hit.docid),
                            "score": float(hit.score),
                            "rank": rank,
                            "doc": document(str(hit.lucene_document.get("raw"))),
                        }
                        for rank, hit in enumerate(engine.search(query, hits), 1)
                    ]
                    result = {
                        "api": "v1",
                        "index": fingerprint["index"],
                        "candidates": candidates,
                    }
                elif path.path.startswith(prefix + "/doc/"):
                    docid = unquote(path.path[len(prefix + "/doc/") :])
                    if not re.fullmatch(r"shard_\d{5}_\d+", docid):
                        self.send_error(404)
                        return
                    raw = engine.doc_raw(docid)
                    if raw is None:
                        self.send_error(404)
                        return
                    result = {
                        "api": "v1",
                        "index": fingerprint["index"],
                        "docid": docid,
                        "doc": document(str(raw)),
                    }
                else:
                    self.send_error(404)
                    return
                payload, status = json.dumps(result, ensure_ascii=False).encode(), 200
            except (ValueError, TypeError, KeyError):
                payload, status = b'{"error":"Invalid request or source document"}', 400
            except Exception:
                payload, status = b'{"error":"Index request failed"}', 500
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            try:
                self.wfile.write(payload)
            except BrokenPipeError:
                pass

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", type=Path, required=True)
    parser.add_argument("--anserini-jar", type=Path, required=True)
    parser.add_argument("--port", type=int, default=19431)
    parser.add_argument("--heap", default="8g", help="JVM heap, e.g. 8g")
    args = parser.parse_args()
    if not args.index.is_dir() or not re.fullmatch(r"[1-9]\d*[mMgG]", args.heap):
        parser.error("Expected an existing index directory and a JVM heap size")
    pin = json.loads((ROOT / "provenance/cmass-index.json").read_text())
    with args.anserini_jar.open("rb") as stream:
        digest = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != pin["anserini_jar_sha256"]:
        parser.error("Anserini jar does not match the evaluated version/hash")
    config = json.loads((ROOT / "configs/cmass.json").read_text())
    import jnius_config

    jnius_config.add_options(
        "-Xmx" + args.heap,
        "-XX:ActiveProcessorCount=8",
        "--enable-native-access=ALL-UNNAMED",
    )
    jnius_config.set_classpath(str(args.anserini_jar.resolve()))
    from jnius import autoclass

    engine = autoclass("io.anserini.search.SimpleSearcher")(str(args.index.resolve()))
    server = None
    try:
        engine.set_bm25(config["bm25"]["k1"], config["bm25"]["b"])
        engine.search("climbmix warmup", 1)
        fingerprint = validate_health(
            {
                "status": "ready",
                "mode": "full",
                "index": config["retrieval"]["index"],
                "documents": int(engine.get_total_num_docs()),
                "bm25": config["bm25"],
                "anserini": pin["anserini"],
                "anserini_jar_sha256": digest.hexdigest(),
                "hosted_api_parity_verified": False,
            },
            config,
        )
        server = ThreadingHTTPServer(
            ("127.0.0.1", args.port),
            handler(engine, fingerprint, config["retrieval"]["max_cached_hits"]),
        )
        print(
            json.dumps(
                {
                    "type": "server_ready",
                    "port": server.server_port,
                    "fingerprint": fingerprint,
                }
            ),
            flush=True,
        )
        server.serve_forever()
    finally:
        if server is not None:
            server.server_close()
        engine.close()


if __name__ == "__main__":
    main()
