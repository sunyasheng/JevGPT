"""Lossless source-span adapter for semantic-text-splitter==0.33.0.

Run as a persistent JSONL process with the isolated probe Python environment.
Input: {"id": ..., "text": ..., "max_utf8_bytes": 8000}.
This is a source chunker, not a Jev tokenizer or a research runner.
"""
import hashlib
import json
import sys
from functools import lru_cache

from semantic_text_splitter import TextSplitter


@lru_cache(maxsize=8)
def splitter(max_bytes):
    return TextSplitter.from_callback(
        lambda s: len(s.encode("utf-8")), max_bytes, overlap=0, trim=False
    )


def chunk_source(text, max_utf8_bytes=8000):
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    if type(max_utf8_bytes) is not int or max_utf8_bytes < 4:
        raise ValueError("max_utf8_bytes must be an integer >= 4")
    chunks = []
    cursor_cp = cursor_utf16 = cursor_bytes = 0
    start_line = 1
    for offset, part in splitter(max_utf8_bytes).chunk_indices(text):
        size_bytes = len(part.encode("utf-8"))
        size_utf16 = len(part.encode("utf-16-le")) // 2
        if offset != cursor_cp or text[offset:offset + len(part)] != part:
            raise ValueError("splitter source coverage mismatch")
        if not part or size_bytes > max_utf8_bytes:
            raise ValueError("splitter exceeded the source byte budget")
        newlines = part.count("\n")
        chunks.append({
            "id": f"C{cursor_utf16}-{cursor_utf16 + size_utf16}",
            "start_codepoint": offset, "end_codepoint": offset + len(part),
            "start_utf16": cursor_utf16, "end_utf16": cursor_utf16 + size_utf16,
            "start_byte": cursor_bytes, "end_byte": cursor_bytes + size_bytes,
            "start_line": start_line,
            "end_line": start_line + newlines - int(part.endswith("\n")),
            "text": part,
        })
        cursor_cp += len(part)
        cursor_utf16 += size_utf16
        cursor_bytes += size_bytes
        start_line += newlines
    if cursor_cp != len(text):
        raise ValueError("splitter did not cover the full source")
    return {"source_sha256": hashlib.sha256(text.encode()).hexdigest(),
            "max_utf8_bytes": max_utf8_bytes, "overlap": 0, "trim": False,
            "range_convention": "half-open; UTF-16 offsets are for JavaScript slice",
            "chunks": chunks}


def main():
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            result = chunk_source(request["text"], request.get("max_utf8_bytes", 8000))
            response = {"id": request.get("id"), "ok": True, **result}
        except Exception as exc:
            response = {"id": request.get("id") if isinstance(request, dict) else None,
                        "ok": False, "error": f"{type(exc).__name__}: {exc}"}
        print(json.dumps(response, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
