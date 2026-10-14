#!/bin/bash
# Builds and (with --install) installs the wosu! APK. No Gradle: aapt2 + zip + zipalign + apksigner.
#   android/build.sh [--probe] [--install] [--run]
#   --probe  ship android/probe.mjs as the entry point instead of the game host
# Native inputs (built separately, see android/README.md):
#   $AB/libnode.so            Node.js 26 for android-arm64 (--shared)
#   $AB/gpu/build/dawn.node   @kmamal/gpu's Dawn binding built with the NDK
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
AB="${WOSU_ANDROID_BUILD:-$ROOT/../android-build}"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
NDK="$SDK/ndk/28.2.13676358"
BT="$SDK/build-tools/36.0.0"
JAR="$SDK/platforms/android-36/android.jar"
TC="$NDK/toolchains/llvm/prebuilt/darwin-x86_64"
CXX="$TC/bin/aarch64-linux-android29-clang++"
CC="$TC/bin/aarch64-linux-android29-clang"
NODE_SRC="$AB/node-v26.12.0"
OUT="$HERE/out"
export JAVA_HOME="${JAVA_HOME:-$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home}"
export PATH="$JAVA_HOME/bin:$PATH"

PROBE=0 INSTALL=0 RUN=0
for a in "$@"; do
    case "$a" in
        --probe) PROBE=1 ;;
        --install) INSTALL=1 ;;
        --run) INSTALL=1 RUN=1 ;;
    esac
done

rm -rf "$OUT/stage" && mkdir -p "$OUT/stage/lib/arm64-v8a" "$OUT/stage/assets/app" "$OUT/obj"
LIBS="$OUT/stage/lib/arm64-v8a"
APP="$OUT/stage/assets/app"

echo "== native"
cp "$AB/libnode.so" "$LIBS/libnode.so"
cp "$TC/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so" "$LIBS/"
GLUE="$NDK/sources/android/native_app_glue"
"$CC" -c -O2 -fPIC -I"$GLUE" "$GLUE/android_native_app_glue.c" -o "$OUT/obj/glue.o"
"$CXX" -shared -fPIC -O2 -std=c++20 -Wall \
    -I"$GLUE" -I"$NODE_SRC/src" -I"$NODE_SRC/deps/v8/include" -I"$NODE_SRC/deps/uv/include" \
    "$HERE/native/main.cpp" "$OUT/obj/glue.o" \
    -L"$LIBS" -lnode -landroid -llog -static-libstdc++ \
    -u ANativeActivity_onCreate -Wl,-soname,libwosu.so \
    -o "$LIBS/libwosu.so"

# Node addons: loaded by path from the APK's lib dir (Android only extracts lib*.so);
# they resolve napi_* from libnode.so, so each one gets it as a dependency.
addon() { # <src .node> <lib name>
    cp "$1" "$LIBS/$2"
    chmod u+w "$LIBS/$2"
    patchelf --remove-needed libnode.so "$LIBS/$2" 2>/dev/null || true
    patchelf --add-needed libnode.so --set-soname "$2" "$LIBS/$2"
}
addon "$AB/gpu/build/dawn.node" libdawn_node.so
LINKS=("node_modules/@kmamal/gpu/dist/dawn.node -> libdawn_node.so")
if [ -f "$AB/canvas/skia.android-arm64.node" ]; then
    addon "$AB/canvas/skia.android-arm64.node" libskia_canvas.so
    LINKS+=("node_modules/@napi-rs/canvas/skia.android-arm64.node -> libskia_canvas.so")
fi
if [ -f "$AB/webaudio/node-web-audio-api.android-arm64.node" ]; then
    addon "$AB/webaudio/node-web-audio-api.android-arm64.node" libwebaudio.so
    LINKS+=("node_modules/node-web-audio-api/node-web-audio-api.android-arm64.node -> libwebaudio.so")
fi
"$TC/bin/llvm-strip" --strip-unneeded "$LIBS"/*.so

echo "== app files"
mkdir -p "$APP/android" "$APP/node_modules/@kmamal/gpu/src" "$APP/node_modules/@kmamal/gpu/dist"
cp "$ROOT/sdl/node_modules/@kmamal/gpu/package.json" "$APP/node_modules/@kmamal/gpu/"
cp "$ROOT/sdl/node_modules/@kmamal/gpu/src/index.js" "$APP/node_modules/@kmamal/gpu/src/"
if [ "$PROBE" = 1 ]; then
    cp "$HERE/probe.mjs" "$APP/android/host.mjs"
else
    cp "$HERE"/*.mjs "$APP/android/"
    cp -R "$ROOT/dist" "$APP/dist"
    mkdir -p "$APP/electron" "$APP/sdl"
    cp "$ROOT"/electron/*.cjs "$APP/electron/"
    cp "$ROOT"/sdl/*.mjs "$APP/sdl/"
    # The host's JS dependencies (native addons are linked from the lib dir above).
    rsync -a --exclude '*.node' --exclude '@kmamal' --exclude '@types' --exclude 'undici-types' \
        --exclude 'canvas-darwin-*' --exclude '*.d.ts' --exclude '*.map' --exclude 'README*' --exclude 'CHANGELOG*' \
        "$ROOT/sdl/node_modules/" "$APP/node_modules/"
    rsync -a "$ROOT/node_modules/fflate" "$APP/node_modules/"
    # node-web-audio-api has no Android case in its loader.
    sed -i '' "s#^switch (platform) {#switch (platform) {\n  case 'android':\n    nativeBinding = require('./node-web-audio-api.android-arm64.node');\n    break;#" \
        "$APP/node_modules/node-web-audio-api/load-native.js"
fi
(cd "$APP" && find . -type f | sed 's#^\./##' | sort) > "$OUT/stage/assets/app.list"
for l in "${LINKS[@]}"; do echo "$l" >> "$OUT/stage/assets/app.list"; done
date +%s > "$OUT/stage/assets/app.stamp"

echo "== apk"
"$BT/aapt2" compile --dir "$HERE/res" -o "$OUT/res.zip"
"$BT/aapt2" link -I "$JAR" --manifest "$HERE/AndroidManifest.xml" -A "$OUT/stage/assets" \
    "$OUT/res.zip" -o "$OUT/unaligned.apk" --min-sdk-version 29 --target-sdk-version 36
(cd "$OUT/stage" && zip -q -r -0 "$OUT/unaligned.apk" lib)
"$BT/zipalign" -f -P 16 4 "$OUT/unaligned.apk" "$OUT/aligned.apk"
KS="$HOME/.android/debug.keystore"
if [ ! -f "$KS" ]; then
    mkdir -p "$HOME/.android"
    keytool -genkeypair -keystore "$KS" -storepass android -keypass android -alias androiddebugkey \
        -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US" >/dev/null
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android --out "$OUT/wosu.apk" "$OUT/aligned.apk"
rm -f "$OUT/unaligned.apk" "$OUT/aligned.apk"
ls -la "$OUT/wosu.apk"

if [ "$INSTALL" = 1 ]; then
    adb install -r "$OUT/wosu.apk"
fi
if [ "$RUN" = 1 ]; then
    adb logcat -c
    adb shell am start -n dev.underweek.wosu/android.app.NativeActivity
fi
