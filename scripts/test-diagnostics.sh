#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/stats-diagnostics-tests.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT
swiftc Stats/DiagnosticsCore.swift DiagnosticsTests/main.swift -o "$build_dir/rules-test"
"$build_dir/rules-test"
