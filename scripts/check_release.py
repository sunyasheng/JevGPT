"""Verify the self-contained release inventory, imported source hashes and paper rows."""
import json
from pathlib import Path
import re
import shutil
import subprocess

from common import ROOT, read_json, read_jsonl, sha256
from report import paper_rows, verify_paper
from cmass_results import released_report, table_rows, verify_release as verify_cmass


def check_cohorts(task, split, total):
    first = [q for c in split["cohorts"] if not c["tag"].endswith("-attempt2") for q in c["query_ids"]]
    retry = {q for c in split["cohorts"] if c["tag"].endswith("-attempt2") for q in c["query_ids"]}
    if len(split["all"]) != total or len(first) != len(set(first)) or set(first) != set(split["all"]):
        raise ValueError(f"{task} cohorts do not partition the {total} IDs")
    if retry != set(split.get("second_attempts", [])):
        raise ValueError(f"{task} retry cohorts disagree with the frozen retry IDs")


def main():
    listed = (ROOT / "public-files.txt").read_text().splitlines()
    if (ROOT / ".git").exists() and shutil.which("git"):
        present = subprocess.check_output(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard"], cwd=ROOT, text=True
        ).splitlines()
        if set(present) != set(listed):
            raise ValueError("Git checkout and public release inventory disagree")
    if len(set(listed)) != len(listed):
        raise ValueError("Duplicate release inventory entries")
    for name in listed:
        path = Path(name)
        if path.is_absolute() or ".." in path.parts or not (ROOT / path).is_file():
            raise ValueError(f"Invalid or missing release file: {name}")
    expected = read_json(ROOT / "provenance/file-hashes.json")
    if set(expected) != set(listed) - {"provenance/file-hashes.json"}:
        raise ValueError("Hash manifest and public inventory disagree")
    for name, digest in expected.items():
        if sha256(ROOT / name) != digest:
            raise ValueError(f"Release file hash changed: {name}")
    sources = read_json(ROOT / "provenance/source-files.json")
    unchanged = 0
    for name, source in sources.items():
        digest = sha256(ROOT / name)
        original = source.get("source_sha256", source.get("extracted_sha256"))
        if digest == original:
            unchanged += 1
        elif digest != source.get("release_sha256") or not (source.get("portability_change") or source.get("release_change")):
            raise ValueError(f"Unrecorded change to imported code: {name}")
    verify_paper(paper_rows())
    cmass = released_report()
    verify_cmass(cmass)
    section = (ROOT / "README.md").read_text().split("### CMASS\n", 1)[1].split("\n## ", 1)[0]
    observed = []
    for line in section.splitlines():
        if line.startswith("|"):
            cells = [c.strip().replace("*", "") for c in line.strip("|").split("|")]
            if len(cells) == 3 and re.fullmatch(r"\d+\s*/\s*\d+", cells[1]):
                observed.append((cells[1].replace(" ", ""), cells[2].removesuffix("%")))
    if observed != [(row[1], row[2]) for row in table_rows(cmass)]:
        raise ValueError("README CMASS table differs from the frozen records")
    bcp = read_jsonl(ROOT / "results/browsecomp.jsonl")
    split = read_json(ROOT / "splits/browsecomp.json")
    check_cohorts("BCP", split, 830)
    if {r["query_id"] for r in bcp if r["attempt"] == 2} != set(split["second_attempts"]) or len(split["second_attempts"]) != 13:
        raise ValueError("BCP selected attempts disagree with the frozen retry IDs")
    provenance = read_json(ROOT / "provenance/paper.json")
    if sum(r["first_attempt_correct"] for r in bcp) != provenance["browsecomp_first_attempt_correct"]:
        raise ValueError("BCP first-attempt accounting mismatch")
    neuclir = read_json(ROOT / "splits/neuclir.json")
    check_cohorts("NeuCLIR", neuclir, 105)
    print(json.dumps({"release_files": len(listed), "imported_files": len(sources),
                      "unchanged_imports": unchanged, "paper_rows_verified": 2, "cmass_questions_verified": 423, "status": "passed"}, indent=2))


if __name__ == "__main__":
    main()
