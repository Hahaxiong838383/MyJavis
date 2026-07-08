#!/bin/bash
# R3.5 单人模式 HTTP 冒烟 E2E：新租户默认 solo=true → /owners 含默认 owner、
# /conversations 结构正确、治理面板归属校验放行默认 owner。
# memory 层 solo 语义深度对照（effectiveOwnerId/soloStable/quarantine 对照）见 solo-mode.test.ts；
# 本脚本只验 HTTP 面——本地无 LLM key 时 remember 挂在 onDone 里不触发（见 e2e-seed-recall.ts 头注释），
# 故不断言写入结果，只验端点结构与鉴权放行。worktree 临时 server 用 3290-3299 段。
set -uo pipefail
cd "$(dirname "$0")/.."

DB=/tmp/myjavis-solo-e2e-$$.db
PORT=3291
BASE="http://127.0.0.1:$PORT"
PASS=0; FAIL=0

ck() {
  if echo "$2" | grep -q "$3"; then PASS=$((PASS+1)); echo "✅ $1"
  else FAIL=$((FAIL+1)); echo "❌ $1  期望含[$3] 实际: $(echo "$2" | head -c 300)"; fi
}
ck_not() {
  if echo "$2" | grep -q "$3"; then FAIL=$((FAIL+1)); echo "❌ $1  不应含[$3] 实际: $(echo "$2" | head -c 300)"
  else PASS=$((PASS+1)); echo "✅ $1"; fi
}

MYJAVIS_MEMORY_DB=$DB PORT=$PORT JAVIS_API_KEY=e2e-admin \
  npx tsx src/index.ts > /tmp/e2e-solo-server.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -f $DB ${DB}-wal ${DB}-shm' EXIT
for i in $(seq 1 30); do curl -sf $BASE/health > /dev/null 2>&1 && break; sleep 0.5; done
curl -sf $BASE/health > /dev/null || { echo "server 起不来"; tail -5 /tmp/e2e-solo-server.log; exit 1; }

TN=$(curl -s -X POST $BASE/api/tenant -H 'X-Javis-Key: e2e-admin' -H 'Content-Type: application/json' -d '{"name":"单人模式e2e"}')
TID=$(echo "$TN" | python3 -c "import json,sys; print(json.load(sys.stdin)['tenant']['id'])")
TOKEN=$(echo "$TN" | python3 -c "import json,sys; print(json.load(sys.stdin)['tenant']['token'])")
SOLO_OWNER="owner_tenant_${TID}"
echo "tenant=$TID solo_owner=$SOLO_OWNER"

# 1) 新租户默认 solo=true
CFG=$(curl -s $BASE/api/me/config -H "X-Javis-Key: $TOKEN")
ck "新租户默认 soloMode=true" "$CFG" '"soloMode":true'

# 2) mock 声纹缺省（不传 user= 参数=无身份）说话——只验端点不崩，不断言写入结果
#    （本地无 LLM key，remember 挂在 onDone 里不触发，写入闭环由 solo-mode.test.ts 覆盖）
SAY=$(curl -s -m 25 -X POST "$BASE/v1/chat/completions?session=solo-room&tenant=$TID" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"记住我喜欢喝乌龙茶"}]}')
ck "无声纹场景下 /v1 正常返回 SSE" "$SAY" 'data:'

# 3) /owners 返回含 solo 默认 owner（恒在首位）
OWNERS=$(curl -s $BASE/api/governance/owners -H "X-Javis-Key: $TOKEN")
ck "owners 端点 ok" "$OWNERS" '"ok":true'
ck "owners 含 solo 默认 owner id" "$OWNERS" "$SOLO_OWNER"
ck "owners 标注 source=solo" "$OWNERS" '"source":"solo"'

# 4) /conversations 返回结构正确（老 event_log 行/本地无 LLM 未写入时应为空数组，非报错）
CONV=$(curl -s "$BASE/api/governance/conversations?limit=50" -H "X-Javis-Key: $TOKEN")
ck "conversations 端点 ok" "$CONV" '"ok":true'
ck "conversations 字段是数组" "$CONV" '"conversations":\['

# 5) 治理面板归属校验：solo 默认 owner 应被放行（非 admin，用租户自己的 token）
GOV=$(curl -s "$BASE/api/governance?owner=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$SOLO_OWNER'))")" -H "X-Javis-Key: $TOKEN")
ck "治理面板放行 solo 默认 owner" "$GOV" '"ok":true'
ck_not "治理面板未误拒 solo 默认 owner" "$GOV" 'owner 不属于当前账号'

# 6) 负例对照：别的租户的 owner 不应被放行（证明 3 不是"来者不拒"）
OTHER_OWNER="owner_tenant_tn_not_mine"
GOV_REJECT=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/governance?owner=$OTHER_OWNER" -H "X-Javis-Key: $TOKEN")
ck "非本租户 owner 应 403" "$GOV_REJECT" '403'

# 7) server 日志无未捕获异常
ERRS=$(grep -c -iE "uncaught|unhandled" /tmp/e2e-solo-server.log || true)
if [ "$ERRS" = "0" ]; then PASS=$((PASS+1)); echo "✅ server 无未捕获异常"; else FAIL=$((FAIL+1)); echo "❌ server 有异常: $ERRS 处"; fi

echo "—— solo-mode E2E: PASS=$PASS FAIL=$FAIL ——"
[ "$FAIL" = "0" ]
