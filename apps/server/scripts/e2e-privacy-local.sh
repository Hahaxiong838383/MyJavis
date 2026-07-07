#!/bin/bash
# R2 隐私链路 HTTP E2E：pending/ack 鉴权面 + session-context 推送→recall 注入→清理即弃。
# remember 路由/零落盘/脱敏的深度断言见 privacy.test.ts（tsx 集成）；本脚本验 HTTP 管线。
set -uo pipefail
cd "$(dirname "$0")/.."

DB=/tmp/myjavis-privacy-e2e-$$.db
TELDIR=/tmp/myjavis-privacy-tel-$$
PORT=3197
BASE="http://127.0.0.1:$PORT"
PASS=0; FAIL=0

ck() {
  if echo "$2" | grep -q "$3"; then PASS=$((PASS+1)); echo "✅ $1"
  else FAIL=$((FAIL+1)); echo "❌ $1  期望含[$3] 实际: $(echo "$2" | head -c 300)"; fi
}

mkdir -p "$TELDIR"
MYJAVIS_MEMORY_DB=$DB MYJAVIS_TELEMETRY_PATH=$TELDIR/turns.ndjson PORT=$PORT JAVIS_API_KEY=e2e-admin \
  npx tsx src/index.ts > /tmp/e2e-privacy-server.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -f $DB ${DB}-wal ${DB}-shm' EXIT
for i in $(seq 1 30); do curl -sf $BASE/health > /dev/null 2>&1 && break; sleep 0.5; done
curl -sf $BASE/health > /dev/null || { echo "server 起不来"; tail -5 /tmp/e2e-privacy-server.log; exit 1; }

TN=$(curl -s -X POST $BASE/api/tenant -H 'X-Javis-Key: e2e-admin' -H 'Content-Type: application/json' -d '{"name":"隐私e2e"}')
TID=$(echo "$TN" | python3 -c "import json,sys; print(json.load(sys.stdin)['tenant']['id'])")
TOKEN=$(echo "$TN" | python3 -c "import json,sys; print(json.load(sys.stdin)['tenant']['token'])")
echo "tenant=$TID"

# owner 与 mock 声纹一致（recall 分人过滤）
say() {
  curl -s -m 25 -X POST "$BASE/v1/chat/completions?session=priv-room&tenant=$TID&user=vp_privacy_e2e" \
    -H 'Content-Type: application/json' \
    -d "{\"messages\":[{\"role\":\"user\",\"content\":\"$1\"}]}"
}

# owner 与 mock 声纹一致（recall 分人过滤）：先 say 一轮建立身份，从 DB owner 表取真值
say "你好" > /dev/null
sleep 0.5
OWNER=$(sqlite3 "$DB" "SELECT memory_owner_id FROM owner LIMIT 1" 2>/dev/null || echo "")
[ -z "$OWNER" ] && { echo "owner 推导失败"; sqlite3 "$DB" ".tables"; exit 1; }
echo "owner=$OWNER"

# 1) pending 空态 + 鉴权
OUT=$(curl -s $BASE/api/privacy/pending -H "X-Javis-Key: $TOKEN")
ck "pending 空态" "$OUT" '"items":\[\]'
CODE=$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/privacy/pending)
ck "无 key 401" "$CODE" '401'

# 2) ack 空参 400
OUT=$(curl -s -X POST $BASE/api/privacy/ack -H "X-Javis-Key: $TOKEN" -H 'Content-Type: application/json' -d '{}')
ck "ack 空参 400" "$OUT" 'ids 必填'

# 3) session-context 推送 → recall 注入 vault 记忆
OUT=$(curl -s -X POST $BASE/api/privacy/session-context -H "X-Javis-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"roomId\":\"priv-room\",\"items\":[{\"id\":\"vault-e2e-1\",\"ownerId\":\"$OWNER\",\"text\":\"安全 过敏 青霉素 我对青霉素过敏\",\"type\":\"safety\",\"createdAt\":$(date +%s)000}]}")
ck "session-context 推送" "$OUT" '"accepted":1'

say "我对什么过敏来着" > /dev/null
sleep 1
LAST=$(grep '"kind":"turn"' "$TELDIR/turns.ndjson" | tail -1)
ck "vault 记忆注入（telemetry 含 vault id）" "$LAST" 'vault-e2e-1'
ck "命中关键词过敏" "$LAST" '过敏'

# 4) 清理即弃：DELETE 后同问不再注入
curl -s -X DELETE $BASE/api/privacy/session-context/priv-room -H "X-Javis-Key: $TOKEN" > /dev/null
say "我对什么过敏来着" > /dev/null
sleep 1
LAST2=$(grep '"kind":"turn"' "$TELDIR/turns.ndjson" | tail -1)
if echo "$LAST2" | grep -q 'vault-e2e-1'; then
  FAIL=$((FAIL+1)); echo "❌ 清理后不应再注入 vault 记忆"
else
  PASS=$((PASS+1)); echo "✅ 清理后 vault 记忆即弃"
fi

# 5) 云端零残留：DB 全文（含 event_log/audit）grep 不到隐私内容
STRINGS=$(sqlite3 "$DB" ".dump" 2>/dev/null | grep -c "青霉素" || true)
if [ "$STRINGS" = "0" ]; then PASS=$((PASS+1)); echo "✅ 云端 DB 全 dump 零隐私内容残留"; else FAIL=$((FAIL+1)); echo "❌ DB 有 $STRINGS 处残留"; fi

# 6) server 日志零内容（只允许条数日志）
LOGLEAK=$(grep -c "青霉素" /tmp/e2e-privacy-server.log || true)
if [ "$LOGLEAK" = "0" ]; then PASS=$((PASS+1)); echo "✅ server 日志零隐私内容"; else FAIL=$((FAIL+1)); echo "❌ 日志泄露 $LOGLEAK 处"; fi

echo "—— privacy E2E: PASS=$PASS FAIL=$FAIL ——"
[ "$FAIL" = "0" ]
