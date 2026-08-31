#!/bin/bash
# Select the newest Xcode with an iOS 26 SDK or later, and print what it found.
#
# WHY THIS EXISTS
#
# App Store Connect REFUSES any build made with an SDK older than iOS 26, and it
# refuses it at UPLOAD — after a full archive and export have already succeeded:
#
#   SDK version issue. This app was built with the iOS 18.5 SDK.
#
# The runner's default Xcode is not always the newest installed, and this
# project's deployment target being iOS 26.0 does NOT make xcodebuild pick a
# matching SDK — it archived against 18.5 without a word of complaint. So the
# choice is made explicitly here, and a runner that cannot satisfy it fails in
# seconds rather than fifteen minutes later at Apple.
#
# SORT BY FULL VERSION, NOT MAJOR
#
# Comparing only the major version picked whichever 26.x sorted first (26.0.1),
# whose iphonesimulator SDK matched none of the simulator runtimes installed on
# the image — and actool then failed the archive with "No simulator runtime
# version from [...] available", on a DEVICE build, over an app icon.
#
# WHY IT IS A FILE AND NOT AN INLINE `run:` BLOCK
#
# It started inline. A `case` statement containing '' inside a command
# substitution inside a double-quoted assignment does not parse, and the runner
# reported it as "syntax error near unexpected token `newline'" pointing at a
# line that looked fine. As a file it is plain shell, and it can be run locally.
set -euo pipefail

best=""
best_v=""

for app in /Applications/Xcode*.app; do
  [ -e "$app" ] || continue
  v="$(/usr/bin/defaults read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "")"
  [ -n "$v" ] || continue

  major="${v%%.*}"
  case "$major" in
    ''|*[!0-9]*) continue ;;
  esac
  [ "$major" -ge 26 ] || continue

  # Keep it if it is the first candidate, or sorts newer than the current best.
  if [ -z "$best_v" ] || [ "$(printf '%s\n%s\n' "$best_v" "$v" | sort -V | tail -1)" = "$v" ]; then
    best="$app"
    best_v="$v"
  fi
done

if [ -z "$best" ]; then
  echo "::error::No Xcode 26+ on this runner. Available:"
  for app in /Applications/Xcode*.app; do
    [ -e "$app" ] || continue
    echo "  $app $(/usr/bin/defaults read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo '?')"
  done
  exit 1
fi

echo "selected $best ($best_v)"

# CI needs the switch; a local run just reports what it would pick.
if [ "${CI:-}" = "true" ]; then
  sudo xcode-select -s "$best/Contents/Developer"
fi

xcodebuild -version
xcodebuild -showsdks | grep -iE "iphoneos|iphonesimulator" || true

# The SDK and the installed runtimes are the two facts that explain an actool
# failure, so print them together.
echo "installed iOS simulator runtimes:"
xcrun simctl list runtimes 2>/dev/null | grep -i "^iOS" || echo "  (none)"
