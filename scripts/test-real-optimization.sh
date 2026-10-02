#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/stats-real-tests.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT
swiftc Stats/DiagnosticText.swift Stats/SyntheticExperience.swift Stats/DiagnosticsCore.swift Stats/SyntheticRoundtripCore.swift Stats/SyntheticSocketProtocol.swift Stats/SyntheticSocketTransport.swift Stats/SyntheticRuntimeDiscovery.swift Stats/RealAppProbe.swift Stats/RealOptimizationCore.swift Stats/RealReceiptStorage.swift Stats/SyntheticStatusWindow.swift Stats/RealOptimizationController.swift RealOptimizationTests/main.swift -o "$build_dir/real-test"
"$build_dir/real-test"
# Typecheck the actual AppKit controller; no target process is touched by this check.
swiftc -typecheck Stats/DiagnosticText.swift Stats/SyntheticExperience.swift Stats/DiagnosticsCore.swift Stats/SyntheticRoundtripCore.swift Stats/SyntheticSocketProtocol.swift Stats/SyntheticSocketTransport.swift Stats/SyntheticRuntimeDiscovery.swift Stats/SyntheticStatusWindow.swift Stats/RealAppProbe.swift Stats/RealOptimizationCore.swift Stats/RealReceiptStorage.swift Stats/RealOptimizationController.swift
