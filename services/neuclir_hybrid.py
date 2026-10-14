"""Hybrid BM25 search service for NeuCLIR1 English MT: document BM25 fused with best-passage BM25.

Same HTTP API as jevneuclir.bm25_server (POST /search, GET /doc, GET /health), so the agent bridge is unchanged.
For each query the document BM25 top CAND hits are re-scored. Each candidate is split into passages of the title
plus at most 250 body words; a passage is scored with BM25 (k1=0.9, b=0.4, document-level IDF, mean passage length
AVGPL from the offline replay). The document's best passage is its MaxP score. Fused score =
LAMBDA * minmax(doc) + (1 - LAMBDA) * minmax(MaxP) over the candidates, as in hybrid v2 for BrowseComp-Plus.
Hits beyond CAND keep their document order with score 0. Units stay whole documents.
This process never opens an evaluation file.
"""
import argparse
import hashlib
import json
import math
import os
import threading
import time
from collections import OrderedDict, defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from multiprocessing import get_context
from urllib.parse import parse_qs, urlparse

SNIP, CAND, WORDS, LAMBDA, K1P, BP, AVGPL = 1500, 500, 250, 0.5, 0.9, 0.4, 144.7
_w = {}


def fingerprint(index, bm25):
    files = sorted((f, os.path.getsize(os.path.join(index, f))) for f in os.listdir(index))
    h = hashlib.sha256(json.dumps(files).encode())
    for f in [f for f, _ in files if f.startswith("segments_")]:
        h.update(open(os.path.join(index, f), "rb").read())
    src = hashlib.sha256(open(__file__, "rb").read()).hexdigest()
    return {"sha256": h.hexdigest(), "index": os.path.abspath(index), "n_files": len(files),
            "bytes": sum(s for _, s in files), "server_sha256": src, "bm25": bm25, "snippet_chars": SNIP,
            "hybrid": {"candidates": CAND, "passage_words": WORDS, "lambda": LAMBDA, "passage_bm25": {"k1": K1P, "b": BP},
                       "mean_passage_tokens": AVGPL, "idf": "document-level", "units": "whole documents"}}


def worker_init(index, k1, b):
    from pyserini.analysis import Analyzer, get_lucene_analyzer
    from pyserini.index.lucene import LuceneIndexReader
    from pyserini.search.lucene import LuceneSearcher
    s = LuceneSearcher(index)
    s.set_bm25(k1, b)
    r = LuceneIndexReader(index)
    _w.update(s=s, a=Analyzer(get_lucene_analyzer()), r=r, n=r.stats()["documents"], idf={})


def contents(docid):
    d = _w["s"].doc(docid)
    if d is None:
        return ""
    raw = d.raw()
    try:
        return json.loads(raw).get("contents", "")
    except Exception:
        return raw


def idf(term):
    cache = _w["idf"]
    if term not in cache:
        df, _ = _w["r"].get_term_counts(term, analyzer=None)
        n = _w["n"]
        cache[term] = math.log(1 + (n - df + 0.5) / (df + 0.5)) if df else 0.0
    return cache[term]


def maxp(text, qterms):
    title, _, body = text.partition("\n\n")
    words = body.split()
    chunks = [title + " " + " ".join(words[i:i + WORDS]) for i in range(0, len(words), WORDS)] or [title]
    best = 0.0
    for p in chunks:
        toks = _w["a"].analyze(p)
        tf = defaultdict(int)
        for t in toks:
            tf[t] += 1
        s = sum(idf(t) * tf[t] / (tf[t] + K1P * (1 - BP + BP * len(toks) / AVGPL)) for t in qterms if tf[t])
        best = max(best, s)
    return best


def fused_search(query, k):
    hits = _w["s"].search(query, k=max(k, CAND)) if query.strip() else []
    cand, tail = hits[:CAND], hits[CAND:]
    qterms = sorted(set(_w["a"].analyze(query)))
    texts = {h.docid: contents(h.docid) for h in hits[:max(k, CAND)]}
    ps = [maxp(texts[h.docid], qterms) for h in cand]
    ds = [float(h.score) for h in cand]

    def norm(v):
        lo, hi = (min(v), max(v)) if v else (0, 0)
        return [(x - lo) / (hi - lo) if hi > lo else 0.0 for x in v]

    fused = [LAMBDA * a + (1 - LAMBDA) * b for a, b in zip(norm(ds), norm(ps))]
    order = sorted(range(len(cand)), key=lambda i: (-fused[i], i))
    out = [{"docid": cand[i].docid, "score": round(fused[i], 4), "snippet": texts[cand[i].docid][:SNIP]} for i in order]
    out += [{"docid": h.docid, "score": 0.0, "snippet": texts.get(h.docid, contents(h.docid))[:SNIP]} for h in tail]
    return out[:k]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", required=True)
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()
    k1, b = 0.9, 0.4
    worker_init(a.index, k1, b)
    fp = fingerprint(a.index, {"k1": k1, "b": b})
    fp["num_docs"] = _w["s"].num_docs
    pool = get_context("spawn").Pool(a.workers, initializer=worker_init, initargs=(a.index, k1, b))
    lock, cache_lock, cache = threading.Lock(), threading.Lock(), OrderedDict()

    def search(query, k):
        key = (query, k if k > CAND else CAND)
        with cache_lock:
            if key in cache:
                cache.move_to_end(key)
                return cache[key][:k]
        result = pool.apply(fused_search, (query, key[1]))
        with cache_lock:
            cache[key] = result
            while len(cache) > 512:
                cache.popitem(last=False)
        return result[:k]

    class H(BaseHTTPRequestHandler):
        def _send(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *x):
            pass

        def do_GET(self):
            u = urlparse(self.path)
            if u.path == "/health":
                return self._send(200, {"ok": True, "fingerprint": fp})
            if u.path == "/doc":
                d = (parse_qs(u.query).get("docid") or [""])[0]
                with lock:
                    doc = _w["s"].doc(d)
                    t = contents(d) if doc is not None else None
                return self._send(200 if t is not None else 404, {"docid": d, "text": t})
            self._send(404, {"error": "not found"})

        def do_POST(self):
            if urlparse(self.path).path != "/search":
                return self._send(404, {"error": "not found"})
            body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
            qs = [str(q) for q in body.get("queries") or []]
            k = int(body.get("k") or 20)
            t0 = time.time()
            out = [search(q, k) for q in qs]
            self._send(200, {"results": out, "seconds": round(time.time() - t0, 3)})

    print(json.dumps(fp), flush=True)
    ThreadingHTTPServer(("127.0.0.1", a.port), H).serve_forever()


if __name__ == "__main__":
    main()
