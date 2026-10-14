#!/usr/bin/env bash

pi_serini_realpath() {
  local path="$1"
  python3 - <<'PY' "$path"
import os
import sys

print(os.path.realpath(sys.argv[1]))
PY
}

pi_serini_detect_java_home_from_path() {
  local java_bin="$1"
  local resolved_java_bin
  resolved_java_bin="$(pi_serini_realpath "$java_bin")"
  dirname "$(dirname "$resolved_java_bin")"
}

pi_serini_setup_java() {
  if [[ -z "${JAVA_HOME:-}" ]]; then
    local uname_out
    uname_out="$(uname -s 2>/dev/null || printf 'unknown')"

    if [[ "$uname_out" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
      local openjdk_prefix
      openjdk_prefix="$(brew --prefix openjdk@21 2>/dev/null || true)"
      if [[ -n "$openjdk_prefix" ]]; then
        export JAVA_HOME="$openjdk_prefix/libexec/openjdk.jdk/Contents/Home"
      fi
    fi
  fi

  if [[ -z "${JAVA_HOME:-}" ]] && command -v java >/dev/null 2>&1; then
    export JAVA_HOME="$(pi_serini_detect_java_home_from_path "$(command -v java)")"
  fi

  if [[ -n "${JAVA_HOME:-}" ]]; then
    export PATH="$JAVA_HOME/bin:$PATH"
    if [[ -z "${JVM_PATH:-}" ]]; then
      local candidate
      for candidate in \
        "$JAVA_HOME/lib/server/libjvm.dylib" \
        "$JAVA_HOME/lib/server/libjvm.so" \
        "$JAVA_HOME/jre/lib/server/libjvm.dylib" \
        "$JAVA_HOME/jre/lib/server/libjvm.so" \
        "$JAVA_HOME/jre/lib/amd64/server/libjvm.so"
      do
        if [[ -f "$candidate" ]]; then
          export JVM_PATH="$candidate"
          break
        fi
      done
    fi
  fi
}
