#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JAR="${ANSERINI_FATJAR_PATH:-$ROOT/vendor/anserini/anserini-1.6.0-fatjar.jar}"
SRC_ROOT="$ROOT/jvm/src/main/java"
BUILD_ROOT="$ROOT/jvm/build"
CLASSES_DIR="$BUILD_ROOT/classes"

if [[ ! -f "$JAR" ]]; then
  echo "Missing Anserini fatjar: $JAR" >&2
  exit 1
fi

mkdir -p "$CLASSES_DIR"
find "$CLASSES_DIR" -type f -delete
javac \
  --release 21 \
  -proc:none \
  -cp "$JAR" \
  -d "$CLASSES_DIR" \
  $(find "$SRC_ROOT" -type f -name '*.java' | sort)
