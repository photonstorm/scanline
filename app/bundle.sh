#!/bin/sh
# Builds Scanline.app: the app, its command line, CEF's framework and the helper apps
# Chromium starts its other processes from (each the same executable, hard-linked).
#
#   app/bundle.sh             a debug build at app/target/Scanline.app
#   RELEASE=1 app/bundle.sh   a release build
#
# The first build needs CEF in app/target/cef (downloaded there by the build, 135 MB) and
# cmake and ninja to compile CEF's C++ wrapper: on the PATH, or in app/target/tools
# (python3 -m venv app/target/tools, then the cmake and ninja wheels). See app/README.md.

set -e
cd "$(dirname "$0")"
here=$(pwd)
root=$(cd .. && pwd)

export PATH="$here/target/tools/bin:$root/prototypes/app/target/tools/bin:$HOME/.cargo/bin:$PATH"
export CEF_PATH="$here/target/cef"

# CEF from the prototype, if it has it, rather than a second download.
if [ ! -d "$CEF_PATH" ] && [ -d "$root/prototypes/app/target/cef" ]; then
    mkdir -p target
    cp -R "$root/prototypes/app/target/cef" "$CEF_PATH"
fi

if [ -n "$RELEASE" ]; then
    profile=release
    flag=--release
else
    profile=debug
    flag=
fi

cargo build $flag
(cd "$root" && cargo build $flag -p scanline)

cef=$(ls -d "$CEF_PATH"/*/cef_macos_aarch64 | head -1)
app="$here/target/Scanline.app"
contents="$app/Contents"
frameworks="$contents/Frameworks"
version=$(grep '^version' "$root/Cargo.toml" | head -1 | sed 's/.*"\(.*\)".*/\1/')

plist () {
    # name, executable, identifier, helper (1 or empty), file
    cat > "$5" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>$1</string>
    <key>CFBundleDisplayName</key><string>$1</string>
    <key>CFBundleExecutable</key><string>$2</string>
    <key>CFBundleIdentifier</key><string>$3</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>$version</string>
    <key>CFBundleVersion</key><string>$version</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>LSMinimumSystemVersion</key><string>12.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
    <key>LSEnvironment</key><dict><key>MallocNanoZone</key><string>0</string></dict>
$( [ -n "$4" ] && echo "    <key>LSUIElement</key><string>1</string>" )
$( [ -z "$4" ] && cat <<'TYPES'
    <key>CFBundleDocumentTypes</key>
    <array>
        <dict>
            <key>CFBundleTypeName</key><string>Scanline capture</string>
            <key>CFBundleTypeRole</key><string>Viewer</string>
            <key>LSHandlerRank</key><string>Owner</string>
            <key>LSItemContentTypes</key><array><string>org.scanline.capture</string></array>
        </dict>
    </array>
    <key>UTExportedTypeDeclarations</key>
    <array>
        <dict>
            <key>UTTypeIdentifier</key><string>org.scanline.capture</string>
            <key>UTTypeDescription</key><string>Scanline capture</string>
            <key>UTTypeConformsTo</key><array><string>public.data</string></array>
            <key>UTTypeTagSpecification</key>
            <dict><key>public.filename-extension</key><array><string>scanline</string></array></dict>
        </dict>
    </array>
TYPES
)
</dict>
</plist>
PLIST
}

mkdir -p "$contents/MacOS" "$frameworks" "$contents/Resources"

# Removed first, so a copy that is running keeps its own file.
rm -f "$contents/MacOS/Scanline" "$contents/MacOS/scanline-cli"
cp "target/$profile/Scanline" "$contents/MacOS/Scanline"
# Not "scanline": file names on a Mac ignore case, and the app is "Scanline".
cp "$root/target/$profile/scanline" "$contents/MacOS/scanline-cli"
plist "Scanline" "Scanline" "org.scanline.app" "" "$contents/Info.plist"
cp resources/start.html "$contents/Resources/start.html"
[ -f resources/AppIcon.icns ] && cp resources/AppIcon.icns "$contents/Resources/AppIcon.icns"

# The framework is large and does not change between builds: copied once.
if [ ! -d "$frameworks/Chromium Embedded Framework.framework" ]; then
    cp -R "$cef/Chromium Embedded Framework.framework" "$frameworks/"
fi

for kind in "" " (GPU)" " (Renderer)" " (Plugin)" " (Alerts)"; do
    name="Scanline Helper$kind"
    helper="$frameworks/$name.app/Contents"
    id=$(echo "org.scanline.app.helper$kind" | tr -d ' ()' | tr 'A-Z' 'a-z')

    mkdir -p "$helper/MacOS"
    rm -f "$helper/MacOS/$name"
    ln "$contents/MacOS/Scanline" "$helper/MacOS/$name"
    plist "$name" "$name" "$id" 1 "$helper/Info.plist"
done

echo "Built $app"
