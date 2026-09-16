#!/usr/bin/env bash
# 构建菜单栏胶囊为 universal（arm64 + x86_64）app bundle。
#
# 随包发布预编译产物，是因为要求终端用户装 Xcode Command Line Tools（数 GB）
# 才能用一个菜单栏胶囊，代价过高。产物只有 ~336KB。
#
# 由 `npm run build-bar` 与 prepack 调用。非 macOS 直接跳过（该产物本就是 macOS 专属），
# 否则在 Linux 上 npm pack 会平白失败。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/bin/token-watcher.app"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "[build-bar] 非 macOS，跳过菜单栏 App 构建"
  exit 0
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "[build-bar] 找不到 swiftc。请先安装 Xcode Command Line Tools：xcode-select --install" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 分别构建再 lipo 合并：Intel Mac 上单 arm64 产物无法运行
swiftc -O -target arm64-apple-macos13.0  -o "$TMP/arm64"  "$ROOT/menubar/main.swift"
swiftc -O -target x86_64-apple-macos13.0 -o "$TMP/x86_64" "$ROOT/menubar/main.swift"

mkdir -p "$APP/Contents/MacOS"
lipo -create -output "$APP/Contents/MacOS/token-watcher" "$TMP/arm64" "$TMP/x86_64"
cp "$ROOT/menubar/Info.plist" "$APP/Contents/Info.plist"

echo "[build-bar] $APP  ($(lipo -archs "$APP/Contents/MacOS/token-watcher"), $(du -h "$APP/Contents/MacOS/token-watcher" | cut -f1))"
