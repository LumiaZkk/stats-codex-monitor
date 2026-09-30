#!/bin/bash
# Build locally without developer credentials, notarization, install, or launch.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo "The application needs macOS and full Xcode. Source checks can run on Linux." >&2
  exit 2
fi
./scripts/test-diagnostics.sh
xcodebuild -project Stats.xcodeproj -scheme Stats -configuration Release \
  -destination 'platform=macOS' -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
app="$PWD/build/Build/Products/Release/Stats Diagnostics.app"
[[ -d "$app" ]] || { echo "Expected app was not produced" >&2; exit 1; }
# Ad-hoc local signature only; never uses/copies developer certificates.
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Contents/Info.plist"
echo "Built locally: $app"
echo 'No installation, automatic launch, or login-item change was performed.'
