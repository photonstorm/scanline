#!/bin/sh
# Packs the Scanline app into a disk image: dist/Scanline-<version>-macos-arm64.dmg, holding
# Scanline.app and a link to /Applications to drag it to. A release build first.
#
#   sh app/package.sh
#
# Unsigned: signing and notarising are the owner's (docs/BY-HAND.md, "Yours to decide").
# Signing comes before packing: sign Frameworks/*, then the helpers, then the app, with the
# hardened runtime and Chromium's entitlements, and notarise the image.

set -e
cd "$(dirname "$0")"
root=$(cd .. && pwd)
version=$(grep '^version' "$root/Cargo.toml" | head -1 | sed 's/.*"\(.*\)".*/\1/')

RELEASE=1 sh bundle.sh

staging=$(mktemp -d)
mkdir -p "$staging/Scanline"
cp -R target/Scanline.app "$staging/Scanline/Scanline.app"
ln -s /Applications "$staging/Scanline/Applications"

mkdir -p "$root/dist"
image="$root/dist/Scanline-$version-macos-arm64.dmg"

hdiutil create -volname Scanline -srcfolder "$staging/Scanline" -ov -format UDZO "$image" >/dev/null
rm -r "$staging"

echo "Packed $image ($(du -h "$image" | cut -f1))"
