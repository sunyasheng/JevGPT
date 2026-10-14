"""Small file and accounting helpers shared by the release commands."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "runtime/pi-serini"
PRICES = {"input": 5.0, "cached_input": 0.5, "output": 30.0, "jev_input": 0.042}


def browsecomp_research_query(query):
    """Preserve original BCP text; the TSV reader splits at the first tab only."""
    if not isinstance(query, str) or not query.strip():
        raise ValueError("Expected a nonempty BCP question")
    if "\n" in query or "\r" in query:
        raise ValueError("The BCP TSV transport requires a question without CR/LF characters")
    return query


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def read_jsonl(path):
    with Path(path).open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")


def write_jsonl(path, rows):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n")


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def by_id(rows):
    result = {}
    for row in rows:
        qid = str(row["query_id"])
        if qid in result:
            raise ValueError(f"Duplicate query ID: {qid}")
        result[qid] = row
    return result


def gpt_cost(input_tokens, cached_input_tokens, output_tokens):
    if not 0 <= cached_input_tokens <= input_tokens:
        raise ValueError("Cached input must be a subset of total input")
    return ((input_tokens - cached_input_tokens) * PRICES["input"]
            + cached_input_tokens * PRICES["cached_input"]
            + output_tokens * PRICES["output"]) / 1e6
