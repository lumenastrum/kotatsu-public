#!/usr/bin/env bash
# Builds the Kotatsu APK on a Linux box (WSL Ubuntu on the dev PC), the same pipeline as
# .github/workflows/android.yml: Node from the official release (checksum-verified) cross-compiled with the NDK as
# libnode.so for arm64 (phones) and x86_64 (the emulator), the server payload, then the APK.
#
#   bash android/tools/build-local.sh                 # everything; reuses a libnode already built for this version
#   NODE_VERSION=24.22.1 ARCHES="arm64" bash ...      # one arch
#
# Run from the repo root (a copy on the Linux filesystem builds far faster than /mnt/c). Toolchains go to
# $KOTATSU_ANDROID_HOME (default ~/kotatsu-android): NDK, JDK via apt, Android cmdline-tools, Gradle, a host Node for npm.
# The APK lands in android/out/. Release-signed when KOTATSU_KEYSTORE (+ KOTATSU_KEYSTORE_PASSWORD) is set, else debug.
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-24.22.1}"
ARCHES="${ARCHES:-arm64 x86_64}"
ANDROID_API=28
# Lowest Node each major may ship as (2026-10-21 security release); keep in step with android.yml FLOORS.
FLOORS="22=22.23.4 24=24.22.1 26=26.12.1"
NDK_VERSION=r27c
GRADLE_VERSION=8.10.2
HOME_DIR="${KOTATSU_ANDROID_HOME:-$HOME/kotatsu-android}"
REPO="$(pwd)"
mkdir -p "$HOME_DIR" "$REPO/android/out"

say() { printf '\n== %s\n' "$*"; }

say "version floor"
major="${NODE_VERSION%%.*}"; floor=""
for pair in $FLOORS; do [ "${pair%%=*}" = "$major" ] && floor="${pair#*=}"; done
[ -n "$floor" ] || { echo "Node $major is not a supported line ($FLOORS)"; exit 1; }
[ "$(printf '%s\n%s\n' "$floor" "$NODE_VERSION" | sort -V | head -1)" = "$floor" ] || { echo "Node $NODE_VERSION is below $floor"; exit 1; }
echo "Node $NODE_VERSION clears $floor"

say "toolchains"
SUDO=$([ "$(id -u)" = 0 ] && echo "" || echo sudo)
if ! command -v javac >/dev/null || ! command -v g++ >/dev/null; then
    $SUDO apt-get update -qq
    DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq build-essential python3 curl unzip xz-utils zip rsync git openjdk-17-jdk-headless
fi
# Node 24 wants gcc 12+ for the build's own tools; Ubuntu 22.04 ships 11, with 12 one package away.
HOST_GCC=gcc; HOST_GXX=g++
if [ "$(gcc -dumpversion | cut -d. -f1)" -lt 12 ]; then
    command -v g++-12 >/dev/null || DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq gcc-12 g++-12
    HOST_GCC=gcc-12; HOST_GXX=g++-12
fi
# Compile jobs: V8's heaviest sources take ~1.5 GB each with gcc, so memory, not cores, sets the ceiling.
MEM_GB=$(awk '/MemTotal/ {print int($2 / 1048576)}' /proc/meminfo)
JOBS=$(( MEM_GB * 2 / 3 )); CORES=$(( $(nproc) - 1 ))
[ "$JOBS" -gt "$CORES" ] && JOBS=$CORES
[ "$JOBS" -lt 2 ] && JOBS=2
echo "host compiler $HOST_GXX, $JOBS jobs (${MEM_GB} GB, $(nproc) cores)"
NDK="$HOME_DIR/android-ndk-$NDK_VERSION"
if [ ! -d "$NDK" ]; then
    curl -fsSL -o "$HOME_DIR/ndk.zip" "https://dl.google.com/android/repository/android-ndk-$NDK_VERSION-linux.zip"
    unzip -q "$HOME_DIR/ndk.zip" -d "$HOME_DIR" && rm "$HOME_DIR/ndk.zip"
fi
SDK="$HOME_DIR/sdk"
if [ ! -d "$SDK/platforms/android-34" ]; then
    mkdir -p "$SDK/cmdline-tools"
    curl -fsSL -o "$HOME_DIR/clt.zip" "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
    unzip -q "$HOME_DIR/clt.zip" -d "$SDK/cmdline-tools" && mv "$SDK/cmdline-tools/cmdline-tools" "$SDK/cmdline-tools/latest" && rm "$HOME_DIR/clt.zip"
    # `yes` dies of a broken pipe once sdkmanager has its answers; under pipefail that would end the script.
    yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" --licenses >/dev/null || true
    "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" "platforms;android-34" "build-tools;34.0.0" "platform-tools" >/dev/null
fi
GRADLE="$HOME_DIR/gradle-$GRADLE_VERSION/bin/gradle"
if [ ! -x "$GRADLE" ]; then
    curl -fsSL -o "$HOME_DIR/gradle.zip" "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip"
    unzip -q "$HOME_DIR/gradle.zip" -d "$HOME_DIR" && rm "$HOME_DIR/gradle.zip"
fi
HOSTNODE="$HOME_DIR/node-v$NODE_VERSION-linux-x64"
if [ ! -d "$HOSTNODE" ]; then
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" | tar -xJ -C "$HOME_DIR"
fi

say "Node source"
SRC_TAR="$HOME_DIR/node-v$NODE_VERSION.tar.xz"
if [ ! -f "$SRC_TAR" ]; then
    curl -fsSL -o "$SRC_TAR" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION.tar.xz"
fi
(cd "$HOME_DIR" && curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " node-v$NODE_VERSION.tar.xz\$" | sha256sum -c -)

for arch in $ARCHES; do
    case "$arch" in
        arm64) abi=arm64-v8a; triple=aarch64-linux-android ;;
        x86_64) abi=x86_64; triple=x86_64-linux-android ;;
        *) echo "unknown arch $arch"; exit 1 ;;
    esac
    out="$HOME_DIR/libnode/$NODE_VERSION/$abi"
    if [ -f "$out/libnode.so" ]; then echo "libnode $NODE_VERSION $abi: reusing $out"; continue; fi
    say "Node $NODE_VERSION for $abi"
    build="$HOME_DIR/build-$arch"
    # RESUME=1 keeps an earlier tree (and its objects) and only re-runs make after the patches below.
    if [ "${RESUME:-0}" != 1 ] || [ ! -d "$build/node-v$NODE_VERSION" ]; then
        rm -rf "$build" && mkdir -p "$build"
        tar -xJf "$SRC_TAR" -C "$build"
    fi
    cd "$build/node-v$NODE_VERSION"
    # V8's WebAssembly trap handler is off on Android, but the build machine's own V8 (the one that writes the
    # snapshot, an arm64 simulator for arm64) still compiled as if it were on, and mksnapshot failed to link
    # (TryHandleSignal, v8_internal_simulator_ProbeMemory). Termux ships Node for Android with the trap handler
    # switched off everywhere (packages/nodejs-lts/deps-v8-src-trap-handler-trap-handler.h.patch); so do we.
    perl -0pi -e 's{// X64 on Linux, Windows, MacOS, FreeBSD\..*?\n#else\n#define V8_TRAP_HANDLER_SUPPORTED false\n#endif\n}{#define V8_TRAP_HANDLER_SUPPORTED false\n}s' deps/v8/src/trap-handler/trap-handler.h
    grep -c 'define V8_TRAP_HANDLER_SUPPORTED' deps/v8/src/trap-handler/trap-handler.h | grep -qx 1 || { echo "trap-handler.h did not take the patch"; exit 1; }
    if [ "$arch" = arm64 ] && ! grep -q 'ARMV8_OS_LINUX' zlib-android.h 2>/dev/null; then
        # The bundled zlib asks the NDK's cpufeatures helper on Android, and nothing links it; Bionic has getauxval.
        printf '%s\n' '#if defined(ARMV8_OS_ANDROID) && defined(__aarch64__)' '#undef ARMV8_OS_ANDROID' '#define ARMV8_OS_LINUX' '#endif' > zlib-android.h
        sed -i '/#include "zutil.h"/r zlib-android.h' deps/zlib/cpu_features.c
    fi
    # The build's own tools (torque, mksnapshot) run here: the host compiler, not the NDK's.
    export CC_host="$HOST_GCC" CXX_host="$HOST_GXX" LINK_host="$HOST_GXX" AR_host=ar
    ./android-configure patch
    ./android-configure "$NDK" "$ANDROID_API" "$arch"
    make -j"$JOBS"
    mkdir -p "$out"
    llvm="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
    "$llvm/llvm-strip" -o "$out/libnode.so" out/Release/node
    if "$llvm/llvm-readelf" -d "$out/libnode.so" | grep -q 'libc++_shared.so'; then
        cp "$NDK/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/$triple/libc++_shared.so" "$out/"
    fi
    "$llvm/llvm-readelf" -d "$out/libnode.so" | grep -E 'NEEDED|RUNPATH' || true
    cd "$REPO"
done

say "payload"
export PATH="$HOSTNODE/bin:$PATH"
stage="$HOME_DIR/payload"
rm -rf "$stage" && mkdir -p "$stage/app"
git -C "$REPO" archive --format=tar HEAD | tar -x -C "$stage/app"
(cd "$stage/app" && npm ci --no-audit --no-fund --loglevel=error && npm run build:lib --silent && npm prune --omit=dev --no-audit --no-fund --loglevel=error)
rm -rf "$stage/app"/{.github,android,tests,docs} "$stage/app/dist/.webpack-cache"
find "$stage/app/node_modules" -name '*.node' -print | sed 's/^/native addon left: /' || true
rm -f "$stage/kotatsu.zip"
(cd "$stage/app" && zip -qr -9 ../kotatsu.zip .)
echo "payload: $(du -h "$stage/kotatsu.zip" | cut -f1) (unpacked $(du -sh "$stage/app" | cut -f1))"

say "APK"
app="$REPO/android/app/src/main"
rm -rf "$app/jniLibs" && mkdir -p "$app/jniLibs" "$app/assets"
for arch in $ARCHES; do
    abi=$([ "$arch" = arm64 ] && echo arm64-v8a || echo x86_64)
    cp -r "$HOME_DIR/libnode/$NODE_VERSION/$abi" "$app/jniLibs/"
done
cp "$stage/kotatsu.zip" "$app/assets/kotatsu.zip"
version="$(node -p "require('$REPO/package.json').kotatsu.version")"
export ANDROID_HOME="$SDK"
if [ -n "${KOTATSU_KEYSTORE:-}" ]; then
    # A release: signed with the release key, versionCode from the version (0.8.0 -> 800, 1.2.3 -> 10203) so every
    # release installs over the last one.
    code="$(node -p "const [a,b,c]='$version'.split('.').map(Number); a*10000+b*100+c")"
    "$GRADLE" -q -p "$REPO/android" assembleRelease -PkotatsuVersionName="$version" -PkotatsuVersionCode="$code"
    apk="$REPO/android/out/kotatsu-$version-android.apk"
    mv "$REPO/android/app/build/outputs/apk/release/app-release.apk" "$apk"
else
    "$GRADLE" -q -p "$REPO/android" assembleDebug -PkotatsuVersionName="$version-android-local" -PkotatsuVersionCode=1
    apk="$REPO/android/out/kotatsu-$version-android-local.apk"
    mv "$REPO/android/app/build/outputs/apk/debug/app-debug.apk" "$apk"
fi
echo "APK: $apk ($(du -h "$apk" | cut -f1))"
