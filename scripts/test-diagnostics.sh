#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/stats-diagnostics-tests.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT
swiftc Stats/SyntheticExperience.swift Stats/DiagnosticText.swift Stats/DiagnosticsCore.swift Stats/SyntheticRoundtripCore.swift Stats/SyntheticSocketProtocol.swift Stats/SyntheticSocketTransport.swift Stats/SyntheticRuntimeDiscovery.swift DiagnosticsTests/main.swift -o "$build_dir/rules-test"
"$build_dir/rules-test"

python3 DiagnosticsTests/socket_fixture.py "$build_dir/rules-test"

python3 DiagnosticsTests/discovery_fixture.py "$build_dir/rules-test"

# The rendered windows use isolated test state and a fake discovery function.
mkdir -p build/ui-checks
swiftc Stats/SyntheticExperience.swift Stats/DiagnosticText.swift Stats/DiagnosticsCore.swift Stats/SyntheticRoundtripCore.swift Stats/SyntheticSocketProtocol.swift Stats/SyntheticSocketTransport.swift Stats/SyntheticRuntimeDiscovery.swift Stats/SyntheticRoundtripController.swift Stats/SyntheticStatusWindow.swift DiagnosticsTests/UI/main.swift -o "$build_dir/ui-test"
"$build_dir/ui-test" -AppleLanguages '(en)' build/ui-checks
"$build_dir/ui-test" -AppleLanguages '(zh-Hans)' --chinese build/ui-checks
