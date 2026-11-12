#!/bin/sh
# Builds the prototype and wraps it as a macOS app: the executable, CEF's framework, and the
# helper apps Chromium starts its other processes from (each is the same executable).
#
#   prototypes/app/bundle.sh            then open "prototypes/app/target/Scanline Prototype.app"
#   BUNDLE_DIR=target/other prototypes/app/bundle.sh      builds a second copy elsewhere
#
# Needs CEF in target/cef and cmake and ninja in target/tools (see README.md).

set -e
cd "$(dirname "$0")"

export PATH="$PWD/target/tools/bin:$HOME/.cargo/bin:$PATH"
export CEF_PATH="$PWD/target/cef"

cargo build

exe=scanline-prototype
built="target/debug/$exe"
cef=$(ls -d target/cef/*/cef_macos_aarch64 | head -1)
app="${BUNDLE_DIR:-target}/Scanline Prototype.app"
frameworks="$app/Contents/Frameworks"

plist () {
    # name, executable, identifier, helper (1 or empty), file
    cat > "$5" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>$1</string>
    <key>CFBundleDisplayName</key><string>$1</string>
    <key>CFBundleExecutable</key><string>$2</string>
    <key>CFBundleIdentifier</key><string>$3</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.0.0</string>
    <key>CFBundleVersion</key><string>0.0.0</string>
    <key>LSMinimumSystemVersion</key><string>12.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
    <key>LSEnvironment</key><dict><key>MallocNanoZone</key><string>0</string></dict>
$( [ -n "$4" ] && echo "    <key>LSUIElement</key><string>1</string>" )
</dict>
</plist>
EOF
}

mkdir -p "$app/Contents/MacOS" "$frameworks" "$app/Contents/Resources"
# Removed first, so a copy that is running keeps its own file.
rm -f "$app/Contents/MacOS/$exe"
cp "$built" "$app/Contents/MacOS/$exe"
plist "Scanline Prototype" "$exe" "org.scanline.prototype" "" "$app/Contents/Info.plist"

# The framework is large and does not change between builds: copied once.
if [ ! -d "$frameworks/Chromium Embedded Framework.framework" ]; then
    cp -R "$cef/Chromium Embedded Framework.framework" "$frameworks/"
fi

for kind in "" " (GPU)" " (Renderer)" " (Plugin)" " (Alerts)"; do
    name="$exe Helper$kind"
    contents="$frameworks/$name.app/Contents"
    id=$(echo "org.scanline.prototype.helper$kind" | tr -d ' ()' | tr 'A-Z' 'a-z')

    mkdir -p "$contents/MacOS"
    rm -f "$contents/MacOS/$name"
    cp "$built" "$contents/MacOS/$name"
    plist "$name" "$name" "$id" 1 "$contents/Info.plist"
done

echo "Built $app"
