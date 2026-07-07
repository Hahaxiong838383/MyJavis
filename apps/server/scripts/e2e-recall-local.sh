#!/bin/bash
# R1 召回相关性化 HTTP 冒烟 E2E：/v1 真回调写入 → 提问 → telemetry 验证注入与命中词。
# memory 层深度对照见 recall-integration.test.ts；本脚本只验 HTTP+telemetry 管线。
set -uo pipefail
cd "$(dirname "$0")/.."

DB=/tmp/myjavis-recall-e2e-$$.db
TELDIR=/tmp/myjavis-recall-tel-$$
PORT=3198
BASE="http://127.0.0.1:$PORT"
PASS=0; FAIL=0

ck() {
  if echo "$2" | grep -q "$3"; then PASS=$((PASS+1)); echo "✅ $1"
  else FAIL=$((FAIL+1)); echo "❌ $1  期望含[$3] 实际: $(echo "$2" | head -c 300)"; fi
}

mkdir -p "$TELDIR"

# 预灌种子记忆（目标 safety + 10 条挤窗 event；为何预灌见 e2e-seed-recall.ts 头注释）
MYJAVIS_MEMORY_DB=$DB npx tsx scripts/e2e-seed-recall.ts vp_recall_e2e || { echo "seed 失败"; exit 1; }

MYJAVIS_MEMORY_DB=$DB MYJAVIS_TELEMETRY_PATH=$TELDIR/turns.ndjson PORT=$PORT JAVIS_API_KEY=e2e-admin \
  npx tsx src/index.ts > /tmp/e2e-recall-server.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -f $DB ${DB}-wal ${DB}-shm' EXIT
for i in $(seq 1 30); do curl -sf $BASE/health > /dev/null 2>&1 && break; sleep 0.5; done
curl -sf $BASE/health > /dev/null || { echo "server 起不来"; tail -5 /tmp/e2e-recall-server.log; exit 1; }

TN=$(curl -s -X POST $BASE/api/tenant -H 'X-Javis-Key: e2e-admin' -H 'Content-Type: application/json' -d '{"name":"召回e2e"}')
TID=$(echo "$TN" | python3 -c "import json,sys; print(json.load(sys.stdin)['tenant']['id'])")
echo "tenant=$TID"

say() { # say <文本> → 带 mock 声纹身份（score 0.9 = stable）的 /v1 回调
  curl -s -m 25 -X POST "$BASE/v1/chat/completions?session=recall-room&tenant=$TID&user=vp_recall_e2e" \
    -H 'Content-Type: application/json' \
    -d "{\"messages\":[{\"role\":\"user\",\"content\":\"$1\"}]}"
}

# 1) 提问触发召回（种子已含目标记忆 + 10 条挤窗 event）
say "我的航班是几点来着" > /dev/null
sleep 1

# 2) telemetry 断言：最后一轮 turn 记录
LAST=$(grep '"kind":"turn"' "$TELDIR/turns.ndjson" 2>/dev/null | tail -1)
[ -z "$LAST" ] && LAST=$(tail -1 "$TELDIR/turns.ndjson" 2>/dev/null || echo "")
ck "telemetry 有 turn 记录" "$LAST" '"kind":"turn"'
ck "matchedKeywords 命中「航班」" "$LAST" '航班'
ck "relevantCount ≥1" "$LAST" '"relevantCount":[1-9]'
ck "有注入记忆" "$LAST" '"injectedMemoryIds":\["'
# 目标记忆 id 真的在注入列表里（挤窗后仍召回，HTTP 层复核集成测试结论）
TARGET_ID=$(sqlite3 "$DB" "SELECT id FROM memory_item WHERE json_extract(content_structured_json,'\$.key') LIKE 'event.flight%' OR source_span LIKE '%航班%' ORDER BY created_at LIMIT 1" 2>/dev/null || echo "")
if [ -n "$TARGET_ID" ]; then
  ck "目标记忆在注入列表" "$LAST" "$TARGET_ID"
fi

# 5) 退化路径：纯语气 query 不带 matchedKeywords（且不报错）
say "嗯嗯好的" > /dev/null
sleep 1
LAST2=$(grep '"kind":"turn"' "$TELDIR/turns.ndjson" | tail -1)
if echo "$LAST2" | grep -q 'matchedKeywords'; then
  FAIL=$((FAIL+1)); echo "❌ 退化轮不应有 matchedKeywords"
else
  PASS=$((PASS+1)); echo "✅ 退化轮无 matchedKeywords（走旧路径）"
fi

# 6) 治理面板召回预览端点（R1.1）：命中/退化两态
OWNER=$(sqlite3 "$DB" "SELECT owner_id FROM memory_item ORDER BY created_at LIMIT 1" 2>/dev/null || echo "")
if [ -n "$OWNER" ]; then
  PV=$(curl -s "$BASE/api/governance/recall-preview?owner=$OWNER&q=$(python3 -c "import urllib.parse; print(urllib.parse.quote('我的航班是几点来着'))")" -H "X-Javis-Key: e2e-admin")
  ck "预览命中态 degraded=false" "$PV" '"degraded":false'
  ck "预览命中关键词" "$PV" '航班'
  ck "预览含 relevant 来源" "$PV" '"source":"relevant"'
  ck "预览含 recent 保底" "$PV" '"source":"recent"'
  PV2=$(curl -s "$BASE/api/governance/recall-preview?owner=$OWNER&q=$(python3 -c "import urllib.parse; print(urllib.parse.quote('嗯嗯好的'))")" -H "X-Javis-Key: e2e-admin")
  ck "预览退化态标注原因" "$PV2" '"degradedReason":"empty_query_tokens"'
  ck "预览退化态给旧路径列表" "$PV2" '"source":"fallback_hot"'
else
  FAIL=$((FAIL+1)); echo "❌ 找不到 owner 无法测预览"
fi

# 7) server 日志无未捕获异常
ERRS=$(grep -c -iE "uncaught|unhandled" /tmp/e2e-recall-server.log || true)
if [ "$ERRS" = "0" ]; then PASS=$((PASS+1)); echo "✅ server 无未捕获异常"; else FAIL=$((FAIL+1)); echo "❌ server 有异常: $ERRS 处"; fi

echo "—— recall E2E: PASS=$PASS FAIL=$FAIL ——"
[ "$FAIL" = "0" ]
