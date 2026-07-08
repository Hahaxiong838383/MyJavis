#!/usr/bin/env bash
# 契约单向下发:core/contracts/<line>/ + CONTRACT_VERSION → 协作仓只读副本
# 用法: ./scripts/sync-contracts.sh vision [协作仓本地路径,默认 ~/myjavis-vision]
set -euo pipefail
LINE="${1:?用法: sync-contracts.sh <line> [dest]}"
CORE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${2:-$HOME/myjavis-$LINE}"
[ -d "$CORE_DIR/contracts/$LINE" ] || { echo "契约不存在: contracts/$LINE"; exit 1; }
[ -d "$DEST/.git" ] || { echo "协作仓不存在: $DEST"; exit 1; }
mkdir -p "$DEST/contracts"
rsync -av --delete "$CORE_DIR/contracts/$LINE/" "$DEST/contracts/$LINE/"
cp "$CORE_DIR/contracts/CONTRACT_VERSION" "$DEST/contracts/CONTRACT_VERSION"
cd "$DEST"
git add contracts
if git diff --cached --quiet; then echo "契约无变更"; exit 0; fi
VER=$(grep "^$LINE=" contracts/CONTRACT_VERSION | cut -d= -f2)
git commit -m "contracts: sync from core ($LINE v$VER)"
git push
echo "已下发 $LINE v$VER → $DEST"
