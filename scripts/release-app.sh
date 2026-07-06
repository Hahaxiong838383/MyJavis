#!/usr/bin/env bash
# MyJavis App 一键发版（批次C）：
#   分发构建（自动摘除 VITE_JAVIS_API_KEY，绝不把 admin key 编进用户包）
#   → updater minisign 签名（私钥 ~/.tauri/myjavis-updater.key，丢失=无法再推更新）
#   → 上传 47.239 /opt/myjavis/updates/（DMG 首装包 + app.tar.gz 更新包 + latest.json 清单）
# 用法: scripts/release-app.sh "更新说明一句话"
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json; print(json.load(open('apps/web/package.json'))['version'])")
NOTES="${1:-}"
KEY="$HOME/.tauri/myjavis-updater.key"
SSH_KEY="$HOME/.ssh/id_ed25519"
HOST="root@47.239.204.68"
BASE_URL="https://javis.chenchuan.cc/updates"

[ -f "$KEY" ] || { echo "❌ 缺 updater 签名私钥 $KEY"; exit 1; }

echo "==> 构建 v$VERSION 分发包（去 dev key）"
cd apps/web
cp .env.local .env.local.release-bak
trap 'mv .env.local.release-bak .env.local 2>/dev/null || true' EXIT
sed -i '' 's/^VITE_JAVIS_API_KEY=/#VITE_JAVIS_API_KEY=/' .env.local

TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" pnpm tauri:build

BUNDLE=src-tauri/target/release/bundle
TARGZ="$BUNDLE/macos/MyJavis.app.tar.gz"
SIGFILE="$BUNDLE/macos/MyJavis.app.tar.gz.sig"
DMG="$BUNDLE/dmg/MyJavis_${VERSION}_aarch64.dmg"
for f in "$TARGZ" "$SIGFILE" "$DMG"; do [ -f "$f" ] || { echo "❌ 缺产物 $f"; exit 1; }; done

echo "==> 生成 latest.json"
SIGFILE="$SIGFILE" VERSION="$VERSION" NOTES="$NOTES" BASE_URL="$BASE_URL" python3 - << 'PYEOF'
import json, os, datetime
sig = open(os.environ['SIGFILE']).read().strip()
v = os.environ['VERSION']
json.dump({
    'version': v,
    'notes': os.environ['NOTES'],
    'pub_date': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'platforms': {
        'darwin-aarch64': {
            'signature': sig,
            'url': f"{os.environ['BASE_URL']}/MyJavis_{v}_aarch64.app.tar.gz",
        }
    },
}, open('/tmp/myjavis-latest.json', 'w'), ensure_ascii=False, indent=2)
print('latest.json ok')
PYEOF

echo "==> 上传 47.239"
ssh -i "$SSH_KEY" "$HOST" 'mkdir -p /opt/myjavis/updates'
scp -q -i "$SSH_KEY" "$TARGZ" "$HOST:/opt/myjavis/updates/MyJavis_${VERSION}_aarch64.app.tar.gz"
scp -q -i "$SSH_KEY" "$DMG" "$HOST:/opt/myjavis/updates/"
scp -q -i "$SSH_KEY" /tmp/myjavis-latest.json "$HOST:/opt/myjavis/updates/latest.json"

echo "==> 验证"
curl -s "$BASE_URL/latest.json" | python3 -c "import json,sys; d=json.load(sys.stdin); print('线上清单版本:', d['version'])"
echo "✅ v$VERSION 发布完成"
echo "   首装 DMG: $BASE_URL/MyJavis_${VERSION}_aarch64.dmg"
echo "   已装用户: 下次启动 App 自动弹更新横幅"
