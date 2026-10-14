"""Existing semantic-text-splitter's overlapping spans, with lossless JS offsets."""
import json
import sys
from importlib.metadata import version
from semantic_text_splitter import TextSplitter

assert version("semantic-text-splitter") == "0.33.0"
splitter = TextSplitter.from_callback(lambda s: len(s.encode("utf-8")), 60000, overlap=1024, trim=False)
for line in sys.stdin:
    request = None
    try:
        request = json.loads(line)
        text = request["text"]
        # Codepoint -> UTF16 prefix table; overlap means offsets cannot be accumulated per chunk.
        offsets = [0]
        for c in text:
            offsets.append(offsets[-1] + (2 if ord(c) > 0xFFFF else 1))
        chunks, cursor = [], 0
        for start, part in splitter.chunk_indices(text):
            end = start + len(part)
            assert text[start:end] == part and start <= cursor and end > cursor
            assert len(part.encode("utf-8")) <= 60000
            chunks.append(dict(start_utf16=offsets[start], end_utf16=offsets[end]))
            cursor = end
        assert cursor == len(text)
        result = dict(id=request["id"], ok=True, chunks=chunks)
    except Exception as error:
        result = dict(id=request.get("id") if request else None, ok=False, error=str(error))
    print(json.dumps(result), flush=True)
