#!/bin/bash
# Archive Wisp for iPhone and upload it to TestFlight. See docs/signing.md for the four values.
#   APPLE_TEAM_ID=… ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_PATH=~/AuthKey_….p8 apps/ios/scripts/testflight.sh
# BUILD_NUMBER has to go up with each upload; it defaults to the time.
set -euo pipefail
: "${APPLE_TEAM_ID:?}" "${ASC_KEY_ID:?}" "${ASC_ISSUER_ID:?}" "${ASC_KEY_PATH:?}"
cd "$(dirname "$0")/.."
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
auth=(-allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")

xcodebuild archive -project Wisp.xcodeproj -scheme Wisp -destination 'generic/platform=iOS' -archivePath "$out/Wisp.xcarchive" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" CURRENT_PROJECT_VERSION="${BUILD_NUMBER:-$(date +%Y%m%d%H%M)}" "${auth[@]}"

cat > "$out/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$APPLE_TEAM_ID</string>
  <key>destination</key><string>upload</string>
  <key>signingStyle</key><string>automatic</string>
</dict>
</plist>
PLIST

xcodebuild -exportArchive -archivePath "$out/Wisp.xcarchive" -exportPath "$out/export" -exportOptionsPlist "$out/export.plist" "${auth[@]}"
