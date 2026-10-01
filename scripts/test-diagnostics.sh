#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/stats-diagnostics-tests.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT
swiftc Stats/DiagnosticsCore.swift Stats/SyntheticRoundtripCore.swift Stats/SyntheticSocketProtocol.swift Stats/SyntheticSocketTransport.swift Stats/SyntheticRuntimeDiscovery.swift DiagnosticsTests/main.swift -o "$build_dir/rules-test"
"$build_dir/rules-test"

python3 DiagnosticsTests/socket_fixture.py "$build_dir/rules-test"

python3 DiagnosticsTests/discovery_fixture.py "$build_dir/rules-test"
