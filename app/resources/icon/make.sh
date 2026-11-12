#!/bin/sh
# Remakes AppIcon.icns from draw.swift.
set -e
cd "$(dirname "$0")"
swift draw.swift icon-1024.png
rm -rf AppIcon.iconset && mkdir AppIcon.iconset
for size in 16 32 128 256 512; do
    sips -z $size $size icon-1024.png --out AppIcon.iconset/icon_${size}x${size}.png >/dev/null
    sips -z $((size * 2)) $((size * 2)) icon-1024.png --out AppIcon.iconset/icon_${size}x${size}@2x.png >/dev/null
done
iconutil -c icns AppIcon.iconset -o ../AppIcon.icns
rm -rf AppIcon.iconset
