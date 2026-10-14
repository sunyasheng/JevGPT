"""Bounded output pages. Input extraction chunking is unchanged."""
import json
import sys
from importlib.metadata import version
from semantic_text_splitter import TextSplitter

assert version("semantic-text-splitter") == "0.33.0"
splitter = TextSplitter.from_callback(lambda s: len(s.encode("utf-16-le")) // 2,
                                      4000, overlap=128, trim=False)
for line in sys.stdin:
    request = None
    try:
        request = json.loads(line)
        text = request["text"]
        offsets = [0]
        for c in text:
            offsets.append(offsets[-1] + (2 if ord(c) > 0xFFFF else 1))
        chunks, cursor = [], 0
        for start, part in splitter.chunk_indices(text):
            end = start + len(part)
            assert text[start:end] == part and start <= cursor and end > cursor
            assert offsets[end] - offsets[start] <= 4000
            for pos in (start, end):
                assert not (0 < pos < len(text) and text[pos-1:pos+1] == "\r\n")
            chunks.append(dict(start_utf16=offsets[start], end_utf16=offsets[end]))
            cursor = end
        assert cursor == len(text)
        result = dict(id=request["id"], ok=True, chunks=chunks)
    except Exception as error:
        result = dict(id=request.get("id") if request else None, ok=False, error=str(error))
    print(json.dumps(result), flush=True)
