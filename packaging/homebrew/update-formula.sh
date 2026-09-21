#!/usr/bin/env bash
# 发版后回填 Homebrew formula 的 version 与 sha256（tarball 直接来自 npm registry）。
# 用法：./packaging/homebrew/update-formula.sh 1.5.0
set -euo pipefail

VERSION="${1:?用法: $0 <version>}"
FORMULA="$(cd "$(dirname "$0")" && pwd)/Formula/token-watcher.rb"

URL="https://registry.npmjs.org/token-watcher/-/token-watcher-${VERSION}.tgz"
SHA="$(curl -fsSL "$URL" | shasum -a 256 | cut -d' ' -f1)"

# BSD sed -i 需要备份后缀参数；macOS 与 GNU 通用的写法
sed -i.bak -E \
  -e "s#url \"https://registry.npmjs.org/token-watcher/-/token-watcher-[^\"]+\\.tgz\"#url \"${URL}\"#" \
  -e "s#sha256 \"[0-9a-f]{64}.*\"#sha256 \"${SHA}\"#" \
  "$FORMULA"
rm -f "$FORMULA.bak"

echo "已更新 $FORMULA"
grep -E 'url|sha256' "$FORMULA"
