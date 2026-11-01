"""ClimbMix GET API → Pi contract. Document BM25 only; no qrels or model calls."""

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from urllib.error import HTTPError
from urllib.parse import urlencode, quote
from urllib.request import urlopen
import time
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from cmass_config import validate_health

CONFIG = json.loads(
    (Path(__file__).resolve().parents[1] / "configs/cmass.json").read_text()
)
RETRIEVAL = CONFIG["retrieval"]
from neuclir_bridge import Bridge


def adapt_cmass_hits(hits, limit):
    """Bound normalized preview text; cached source remains verbatim."""

    def bounded(text, units):
        return text.encode("utf-16-le")[: units * 2].decode(
            "utf-16-le", errors="ignore"
        )

    result = []
    for i, hit in enumerate(hits):
        row = dict(docid=str(hit["docid"]), score=hit["score"])
        if i < 50:
            source = hit.get("snippet", "")
            title = bounded(
                " ".join(source.split("\n", 1)[0].split()),
                RETRIEVAL["preview_title_utf16"],
            )
            normalized = " ".join(source.split())
            budget = RETRIEVAL["preview_utf16"] - len(title.encode("utf-16-le")) // 2
            snippet = bounded(normalized, budget)
            row.update(
                title=title, snippet=snippet, snippetTruncated=snippet != normalized
            )
        result.append(row)
    return dict(hits=result, hasMore=len(hits) >= limit)


class CmassBridge(Bridge):
    def request(self, path, body=None):
        if body is not None:
            raise ValueError("ClimbMix bridge only makes GET requests")
        with urlopen(self.upstream + path, timeout=90) as r:
            return json.load(r)

    def cache_source(self, docid, text):
        if text is not None and not isinstance(text, str):
            raise ValueError("Expected original document text")
        with self.lock:
            if docid in self.cache:
                if self.cache[docid] != text:
                    raise ValueError("Source changed within a trial")
                return text
            self.cache[docid] = text
            name = hashlib.sha256(docid.encode()).hexdigest() + ".json"
            with (self.sources / name).open("x", encoding="utf-8") as f:
                json.dump(
                    dict(
                        docid=docid,
                        text=text,
                        sha256=hashlib.sha256(text.encode()).hexdigest()
                        if text is not None
                        else None,
                    ),
                    f,
                    ensure_ascii=False,
                )
        return text

    def source(self, docid):
        with self.lock:
            if docid in self.cache:
                return self.cache[docid]
        try:
            result = self.request("/v1/climbmix-400b/doc/" + quote(docid, safe=""))
            if result["docid"] != docid:
                raise ValueError("Document identity mismatch")
            text = result["doc"]["text"]
        except HTTPError as e:
            if e.code != 404:
                raise
            text = None
        return self.cache_source(docid, text)

    def execute(self, operation, body):
        if operation != "search":
            return super().execute(operation, body)
        start = time.monotonic()
        query, limit, offset = (
            str(body["query"]),
            int(body["limit"]),
            int(body.get("offset", 1)),
        )
        # The validated local REST endpoint has a hard top-100 boundary.
        if (
            not query.strip()
            or limit < 1
            or offset < 1
            or offset - 1 + limit > RETRIEVAL["max_cached_hits"]
        ):
            raise ValueError(
                "ClimbMix search requires 1 <= offset, limit and offset-1+limit <= 100"
            )
        upstream = self.request(
            "/v1/climbmix-400b/search?"
            + urlencode(dict(query=query, hits=offset - 1 + limit))
        )
        hits = []
        for hit in upstream["candidates"][offset - 1 : offset - 1 + limit]:
            text = self.cache_source(hit["docid"], hit["doc"]["text"])
            hits.append(dict(docid=hit["docid"], score=hit["score"], snippet=text))
        result = adapt_cmass_hits(hits, limit)
        result["hasMore"] = (
            len(hits) >= limit and offset - 1 + limit < RETRIEVAL["max_cached_hits"]
        )
        result["timingMs"] = dict(request=(time.monotonic() - start) * 1000)
        with self.lock, (self.artifact_dir / "backend-requests.jsonl").open("a") as f:
            f.write(
                json.dumps(
                    dict(
                        operation=operation,
                        request=body,
                        elapsed_ms=result["timingMs"]["request"],
                        docids=[h["docid"] for h in hits],
                        result_sha256=hashlib.sha256(
                            json.dumps(result, sort_keys=True).encode()
                        ).hexdigest(),
                    )
                )
                + "\n"
            )
        return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--upstream", required=True)
    p.add_argument("--artifact-dir", required=True)
    p.add_argument("--port", type=int, default=0)
    args = p.parse_args()
    bridge = CmassBridge(args.upstream, args.artifact_dir)
    health = bridge.request("/health")
    validate_health(health, CONFIG)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            try:
                body = json.loads(
                    self.rfile.read(int(self.headers.get("content-length", 0)))
                )
                result, status = bridge.execute(self.path.lstrip("/"), body), 200
            except Exception as e:
                result, status = dict(error=f"{type(e).__name__}: {e}"), 502
            payload = json.dumps(result, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            try:
                self.wfile.write(payload)
            except BrokenPipeError:
                pass

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(
        json.dumps(
            dict(type="server_ready", port=server.server_port, fingerprint=health)
        ),
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
