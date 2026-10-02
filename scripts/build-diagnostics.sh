#!/bin/bash
# Build locally without developer credentials, notarization, install, or launch.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo "The application needs macOS and full Xcode. Source checks can run on Linux." >&2
  exit 2
fi
module_cache="$PWD/build/ModuleCache"
mkdir -p "$module_cache"
export CLANG_MODULE_CACHE_PATH="$module_cache"
export SWIFT_MODULECACHE_PATH="$module_cache"
build_flags=()
# Some installed CoreWLAN SDKs document 11be without exporting its enum case.
# Probe the actual compiler/SDK; preserve the mapping wherever it is supported.
if ! xcrun swiftc -typecheck -module-cache-path "$module_cache" - > build/corewlan-probe.txt 2>&1 <<'SWIFT'
import CoreWLAN
let supportedMode = CWPHYMode.mode11be
SWIFT
then
  if grep -q "type 'CWPHYMode' has no member 'mode11be'" build/corewlan-probe.txt; then
    build_flags+=('SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) STATS_LEGACY_COREWLAN')
  else
    cat build/corewlan-probe.txt >&2
    exit 2
  fi
fi
./scripts/test-diagnostics.sh
xcodebuild -project Stats.xcodeproj -scheme Stats -configuration Release \
  -destination 'platform=macOS' -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO "${build_flags[@]}" build
app="$PWD/build/Build/Products/Release/Stats Diagnostics.app"
[[ -d "$app" ]] || { echo "Expected app was not produced" >&2; exit 1; }
# FileProvider-backed folders can re-add FinderInfo during signing. Stage only
# build output in a fresh local directory, without extended attributes/resources.
stage_dir="$(mktemp -d /tmp/stats-diagnostics-release.XXXXXX)"
staged_app="$stage_dir/Stats Diagnostics.app"
ditto --noextattr --norsrc "$app" "$staged_app"
# Ad-hoc local signature only; never uses/copies developer certificates.
codesign --force --deep --sign - "$staged_app"
codesign --verify --deep --strict "$staged_app"
/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$staged_app/Contents/Info.plist"
echo "Built and signed locally: $staged_app"
echo 'No installation, automatic launch, or login-item change was performed.'
