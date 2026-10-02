#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/stats-diagnostics-tests.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT
swiftc Stats/SyntheticExperience.swift Stats/DiagnosticText.swift Stats/DiagnosticsCore.swift Stats/SyntheticRoundtripCore.swift Stats/SyntheticSocketProtocol.swift Stats/SyntheticSocketTransport.swift Stats/SyntheticRuntimeDiscovery.swift DiagnosticsTests/main.swift -o "$build_dir/rules-test"
# Presentation assertions below intentionally use English; AppKit is tested in
# both English and Chinese later, independently of the Mac's preferred language.
"$build_dir/rules-test" -AppleLanguages '(en)'

python3 DiagnosticsTests/socket_fixture.py "$build_dir/rules-test"

python3 DiagnosticsTests/discovery_fixture.py "$build_dir/rules-test"

./scripts/test-disk-activity.sh
./scripts/test-real-optimization.sh

# The rendered windows use isolated test state and a fake discovery function.
mkdir -p build/ui-checks
swiftc -D DIAGNOSTICS_TESTS Stats/SyntheticExperience.swift Stats/DiagnosticText.swift Stats/DiagnosticsCore.swift Stats/SyntheticRoundtripCore.swift Stats/SyntheticSocketProtocol.swift Stats/SyntheticSocketTransport.swift Stats/SyntheticRuntimeDiscovery.swift Stats/SyntheticRoundtripController.swift Stats/SyntheticStatusWindow.swift Stats/RealAppProbe.swift Stats/RealOptimizationCore.swift Stats/RealReceiptStorage.swift Stats/RealOptimizationController.swift DiagnosticsTests/UI/main.swift -o "$build_dir/ui-test"
if ! "$build_dir/ui-test" -AppleLanguages '(en)' build/ui-checks; then
    lldb --batch -o run -o 'thread backtrace all' -- "$build_dir/ui-test" -AppleLanguages '(en)' build/ui-checks || true
    exit 1
fi
"$build_dir/ui-test" -AppleLanguages '(zh-Hans)' --chinese build/ui-checks
