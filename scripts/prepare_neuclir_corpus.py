"""Convert the three official NeuCLIR1 English-MT gzip files to a Lucene JsonCollection."""
import argparse
from collections import Counter
from contextlib import ExitStack
import gzip
import json
from pathlib import Path

from common import write_json


def prepare(mt_dir, out, shards=48, expected_documents=10038763):
    if shards < 1:
        raise ValueError("Shards must be positive")
    files = {lang: Path(mt_dir) / f"{lang}.mt.eng-00000-of-00001.jsonl.gz" for lang in ("fas", "rus", "zho")}
    for path in files.values():
        if not path.is_file():
            raise FileNotFoundError(path)
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    seen, per_lang = set(), Counter()
    count = duplicates = empty = 0
    with ExitStack() as stack:
        handles = [stack.enter_context((out / f"part{i:02d}.jsonl").open("x", encoding="utf-8")) for i in range(shards)]
        for lang, path in files.items():
            with gzip.open(path, "rt", encoding="utf-8") as source:
                for line in source:
                    row = json.loads(line)
                    docid = row["id"]
                    if docid in seen:
                        duplicates += 1
                        continue
                    seen.add(docid)
                    title, text = (row.get("title") or "").strip(), (row.get("text") or "").strip()
                    empty += not title and not text
                    record = {"id": docid, "contents": (title + "\n\n" + text).strip(), "lang": lang}
                    handles[count % shards].write(json.dumps(record, ensure_ascii=False) + "\n")
                    count += 1
                    per_lang[lang] += 1
            print(f"{lang}: {per_lang[lang]} documents", flush=True)
    stats = {"documents": count, "per_language": dict(per_lang), "duplicates_skipped": duplicates,
             "empty_documents": empty, "shards": shards}
    # Keep metadata outside the collection so the indexer only sees document JSONL.
    write_json(out.parent / f"{out.name}-stats.json", stats)
    if count != expected_documents:
        raise ValueError(f"Expected {expected_documents} documents, got {count}; do not use this as the paper index")
    return stats


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mt-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--shards", type=int, default=48)
    args = parser.parse_args()
    print(json.dumps(prepare(args.mt_dir, args.out, args.shards), indent=2))


if __name__ == "__main__":
    main()
