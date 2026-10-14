"""Read-only adapter from the frozen NeuCLIR MT service to Pi's HTTP contract.

No qrels, relevance labels, reranking or model calls. Both experiment arms use
this adapter. Full source documents are cached verbatim for offline audits.
"""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def page_document(docid, text, offset=1, limit=200):
    if text is None:
        return dict(found=False, docid=docid)
    if not isinstance(offset, int) or offset < 1 or not isinstance(limit, int) or limit < 1:
        raise ValueError('offset and limit must be positive integers')
    lines = text.split('\n')
    start = min(offset - 1, len(lines))
    end = min(start + limit, len(lines))
    result = dict(found=True, docid=docid, text='\n'.join(lines[start:end]),
                  offset=offset, limit=limit, totalUnits=len(lines), truncated=end < len(lines))
    if end > start:
        result.update(returnedOffsetStart=start + 1, returnedOffsetEnd=end)
    if end < len(lines):
        result['nextOffset'] = end + 1
    return result


def adapt_hits(hits, limit):
    result = []
    for i, hit in enumerate(hits):
        row = dict(docid=str(hit['docid']), score=hit['score'])
        # Match the original Anserini adapter's 50 preview entries and 220 chars.
        if i < 50:
            source = hit.get('snippet', '')
            row.update(title=source.split('\n', 1)[0], snippet=source[:220],
                       snippetTruncated=len(source) > 220)
        result.append(row)
    return dict(hits=result, hasMore=len(hits) >= limit)


class Bridge:
    def __init__(self, upstream, artifact_dir):
        self.upstream = upstream.rstrip('/')
        self.artifact_dir = Path(artifact_dir)
        self.sources = self.artifact_dir / 'source-cache'
        self.sources.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.cache = {}

    def request(self, path, body=None):
        req = Request(self.upstream + path,
                      data=json.dumps(body).encode() if body is not None else None,
                      headers={'content-type': 'application/json'})
        with urlopen(req, timeout=30) as r:
            return json.load(r)

    def source(self, docid):
        with self.lock:
            if docid in self.cache:
                return self.cache[docid]
        try:
            value = self.request('/doc?' + urlencode({'docid': docid}))
            assert value['docid'] == docid and isinstance(value['text'], str)
            text = value['text']
        except HTTPError as e:
            if e.code != 404:
                raise
            text = None
        with self.lock:
            if docid not in self.cache:
                self.cache[docid] = text
                name = hashlib.sha256(docid.encode()).hexdigest() + '.json'
                record = dict(docid=docid, text=text,
                              sha256=hashlib.sha256(text.encode()).hexdigest() if text is not None else None)
                with (self.sources / name).open('x') as f:
                    json.dump(record, f, ensure_ascii=False)
        return text

    def execute(self, operation, body):
        start = time.monotonic()
        if operation == 'search':
            query, limit, offset = str(body['query']), int(body['limit']), int(body.get('offset', 1))
            if not query.strip() or limit < 1 or offset < 1:
                raise ValueError('invalid search request')
            upstream = self.request('/search', dict(queries=[query], k=offset - 1 + limit))
            hits = upstream['results'][0][offset - 1:offset - 1 + limit]
            result = adapt_hits(hits, limit)
        elif operation == 'readDocument':
            docid = str(body['docid'])
            result = page_document(docid, self.source(docid), body.get('offset', 1), body.get('limit', 200))
        else:
            raise ValueError('unknown operation')
        elapsed = (time.monotonic() - start) * 1000
        result['timingMs'] = dict(request=elapsed)
        with self.lock, (self.artifact_dir / 'backend-requests.jsonl').open('a') as f:
            record = dict(operation=operation, request=body, elapsed_ms=elapsed,
                          result_sha256=hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest())
            if operation == 'search':
                record['docids'] = [h['docid'] for h in result['hits']]
            else:
                record['found'] = result['found']
            f.write(json.dumps(record, ensure_ascii=False) + '\n')
        return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--upstream', required=True)
    parser.add_argument('--artifact-dir', required=True)
    parser.add_argument('--port', type=int, default=0)
    args = parser.parse_args()
    bridge = Bridge(args.upstream, args.artifact_dir)
    health = bridge.request('/health')
    assert health['ok'] and health['fingerprint']['num_docs'] == 10038763

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))))
                result = bridge.execute(self.path.lstrip('/'), body)
                status = 200
            except Exception as e:
                result, status = dict(error=f'{type(e).__name__}: {e}'), 502
            payload = json.dumps(result, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(payload)))
            self.end_headers()
            try:
                self.wfile.write(payload)
            except BrokenPipeError:
                pass

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(json.dumps(dict(type='server_ready', port=server.server_port,
                          fingerprint=health['fingerprint'])), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
