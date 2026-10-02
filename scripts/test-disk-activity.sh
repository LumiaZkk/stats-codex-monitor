#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/stats-disk-activity-tests.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT
swiftc Kit/DiskActivityRate.swift DiskActivityTests/main.swift -o "$build_dir/disk-activity-test"
"$build_dir/disk-activity-test"
