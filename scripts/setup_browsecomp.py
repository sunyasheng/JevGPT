"""Compile the frozen BM25 helper and export the hybrid retriever's UTF-16 document lengths."""
import argparse
import os
from pathlib import Path
import ssl
import subprocess
from urllib.request import urlopen

from common import ROOT, RUNTIME, read_json, sha256

JAR_URL = "https://repo.maven.apache.org/maven2/io/anserini/anserini/1.6.0/anserini-1.6.0-fatjar.jar"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--doc-index", type=Path, default=ROOT / "data/browsecomp/document-index")
    parser.add_argument("--out", type=Path, default=ROOT / "data/browsecomp/doc-lengths.tsv")
    parser.add_argument("--anserini-jar", type=Path, default=RUNTIME / "vendor/anserini/anserini-1.6.0-fatjar.jar")
    parser.add_argument("--java", default="java")
    parser.add_argument("--javac", default="javac")
    args = parser.parse_args()
    if not args.doc_index.is_dir():
        parser.error("Download or provide the BCP document index first; see docs/data.md")
    if args.out.exists():
        parser.error("Use a new output path for the document-length table")
    if not args.anserini_jar.is_file():
        import certifi
        args.anserini_jar.parent.mkdir(parents=True, exist_ok=True)
        partial = args.anserini_jar.with_suffix(".partial")
        with urlopen(JAR_URL, timeout=120, context=ssl.create_default_context(cafile=certifi.where())) as response, partial.open("xb") as handle:
            for block in iter(lambda: response.read(1024 * 1024), b""):
                handle.write(block)
        partial.rename(args.anserini_jar)
    expected = read_json(ROOT / "provenance/data-sources.json")["anserini_sha256"]
    if sha256(args.anserini_jar) != expected:
        raise ValueError("Anserini jar differs from the frozen 1.6.0 dependency")
    classes = RUNTIME / "jvm/build/classes"
    classes.mkdir(parents=True, exist_ok=True)
    subprocess.run([args.javac, "--release", "21", "-proc:none", "-cp", str(args.anserini_jar), "-d", str(classes),
                    str(RUNTIME / "jvm/src/main/java/dev/jhy/piserini/Bm25Server.java"),
                    str(ROOT / "tools/DocumentLengths.java")], check=True)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x") as handle:
        subprocess.run([args.java, "-cp", os.pathsep.join([str(classes), str(args.anserini_jar)]),
                        "DocumentLengths", str(args.doc_index)], stdout=handle, check=True)
    with args.out.open() as handle:
        count = sum(1 for _ in handle)
    if count != 100195:
        raise ValueError(f"Expected 100195 document lengths, got {count}")
    print(f"Compiled BM25 server and exported {count} UTF-16 document lengths to {args.out}")


if __name__ == "__main__":
    main()
