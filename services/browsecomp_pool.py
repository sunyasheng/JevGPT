"""Per-question document pool with RE2 full-text grep for JevGPT w/ pool_grep on BrowseComp-Plus.

Same pool and grep as services/cmass_pool.py. Every `search` of the runtime adds the query's
top-1,000 documents of the released document Bm25Server, with their full text, to the question's
pool; `pool_grep` scans that pool. scripts/run.py starts one instance per question next to the
question's document and passage servers.
"""

import argparse
from functools import partial
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import socket
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services"))
from cmass_pool import CAP, DEEP_K, TIME_LIMIT, handler, pattern


class DocumentServer:
    """Line-delimited JSON commands of the released dev.jhy.piserini.Bm25Server."""

    def __init__(self, host, port):
        self.address = (host, port)

    def call(self, command, **args):
        with socket.create_connection(self.address, timeout=90) as sock:
            sock.sendall((json.dumps(dict(id=1, type=command, **args)) + "\n").encode())
            with sock.makefile("r", encoding="utf-8") as stream:
                response = json.loads(stream.readline())
        if not response.get("success"):
            raise ValueError(response.get("error") or f"{command} failed")
        return response["data"]

    def search(self, query):
        """Top DEEP_K docids in rank order; each text loads on first use."""
        hits = self.call("search", query=query, query_mode="plain", k=DEEP_K, rerank_clues=[])["results"]
        return [(str(hit["docid"]), partial(self.text, str(hit["docid"]))) for hit in hits]

    def text(self, docid):
        row = self.call("read_document", docid=docid, offset=1, limit=2147483647)
        if not row.get("found") or row.get("truncated"):
            raise ValueError(f"Pool source missing: {docid}")
        return row["text"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--document-host", default="127.0.0.1", help="Document Bm25Server host")
    parser.add_argument("--document-port", type=int, required=True, help="Document Bm25Server port")
    parser.add_argument("--port", type=int, default=0, help="Loopback port; 0 picks a free port")
    args = parser.parse_args()
    pattern("warmup")  # fail early without the RE2 module
    config = json.loads((ROOT / "configs/browsecomp-poolgrep.json").read_text())
    documents = DocumentServer(args.document_host, args.document_port)
    documents.call("ping")
    fingerprint = {
        "ready": True,
        "mode": "pool",
        "index": "browsecomp-plus-document-bm25",
        "bm25": config["bm25"],
        "documents_per_search": DEEP_K,
        "grep_return_chars": CAP,
        "grep_seconds": TIME_LIMIT,
    }
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler(documents.search, fingerprint))
    try:
        print(json.dumps({"type": "server_ready", "port": server.server_port, "fingerprint": fingerprint}), flush=True)
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
