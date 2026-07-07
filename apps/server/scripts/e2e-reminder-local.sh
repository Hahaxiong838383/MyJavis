#!/bin/bash
# MyJavis reminder v1 + 声纹 S1/S2 本地 E2E（模拟火山 CustomLLM 回调全链路）
set -uo pipefail
cd "$(dirname "$0")/.."

DB=/tmp/myjavis-e2e-$$.db
PORT=3199
BASE="http://127.0.0.1:$PORT"
PASS=0; FAIL=0

ck() { # ck <名称> <实际输出> <期望子串>
  if echo "$2" | grep -q "$3"; then PASS=$((PASS+1)); echo "✅ $1"
  else FAIL=$((FAIL+1)); echo "❌ $1  期望含[$3] 实际: $(echo "$2" | head -c 200)"; fi
}

# 起 server（tick 2s 提速；无 JAVIS_API_KEY = admin 放行）
MYJAVIS_MEMORY_DB=$DB PORT=$PORT REMINDER_TICK_MS=2000 JAVIS_API_KEY=e2e-admin npx tsx src/index.ts > /tmp/e2e-reminder-server.log 2>&1 &
SRV=$!
for i in $(seq 1 30); do curl -sf $BASE/health > /dev/null 2>&1 && break; sleep 0.5; done
curl -sf $BASE/health > /dev/null || { echo "server 起不来"; cat /tmp/e2e-reminder-server.log | tail -5; exit 1; }

# 建租户
TN=$(curl -s -X POST $BASE/api/tenant -H 'X-Javis-Key: e2e-admin' -H 'Content-Type: application/json' -d '{"name":"e2e测试"}')
TID=$(echo "$TN" | python3 -c "import json,sys; print(json.load(sys.stdin)['tenant']['id'])")
TOKEN=$(echo "$TN" | python3 -c "import json,sys; print(json.load(sys.stdin)['tenant']['token'])")
echo "tenant=$TID"

say() { # say <房间> <文本> → SSE 全文
  curl -s -X POST "$BASE/v1/chat/completions?session=$1&tenant=$TID" \
    -H 'Content-Type: application/json' \
    -d "{\"messages\":[{\"role\":\"user\",\"content\":\"$2\"}]}"
}

R=e2e-room

# ── reminder：完整设置（时间+内容）→ 复述 ──
OUT=$(say $R "提醒我30秒后喝水")
ck "设置复述(相对时长)" "$OUT" "提醒你：喝水"
sleep 1.2  # 800ms 去抖提交

# ── 列表 API 看到 pending ──
OUT=$(curl -s $BASE/api/reminders -H "X-Javis-Key: $TOKEN")
ck "列表见 pending" "$OUT" '"content":"喝水"'

# ── 反问链：缺时间 → 问 → 答 → 复述 ──
OUT=$(say $R "提醒我买牛奶")
ck "缺时间反问" "$OUT" "什么时候"
OUT=$(say $R "十分钟后")
ck "反问后补时间复述" "$OUT" "提醒你：买牛奶"
sleep 1.2

# ── 反问链：缺内容 ──
OUT=$(say $R "明天早上八点提醒我")
ck "缺内容反问" "$OUT" "提醒你什么"
OUT=$(say $R "晨跑")
ck "反问后补内容复述" "$OUT" "提醒你：晨跑"
sleep 1.2

# ── 查询 ──
OUT=$(say $R "我有什么提醒")
ck "查询列表" "$OUT" "3 条提醒"

# ── 取消最近 ──
OUT=$(say $R "取消刚才的提醒")
ck "语音取消" "$OUT" "取消了"

# ── 宁漏勿误反例：不该命中 ──
OUT=$(say $R "我妈提醒我要吃饭")
ck "叙述句不触发(走LLM报错兜底)" "$OUT" "助手"  # 无 LLM 凭据环境会出错误话术=没走 canned 即正确

# ── 30秒提醒到期 → 无活跃房间(未 StartVoiceChat) → fired → due 可见 ──
echo "等提醒到期+调度(≤36s)…"
DUE=""
for i in $(seq 1 20); do
  sleep 2
  DUE=$(curl -s $BASE/api/reminders/due -H "X-Javis-Key: $TOKEN")
  echo "$DUE" | grep -q '"content":"喝水"' && break
done
ck "到期进 due(fired)" "$DUE" '"content":"喝水"'
RID=$(echo "$DUE" | python3 -c "import json,sys; print(json.load(sys.stdin)['items'][0]['id'])" 2>/dev/null)

# ── ack → delivered → due 清空该条 ──
OUT=$(curl -s -X POST $BASE/api/reminders/$RID/ack -H "X-Javis-Key: $TOKEN")
ck "ack 回执" "$OUT" '"ok":true'
OUT=$(curl -s $BASE/api/reminders/due -H "X-Javis-Key: $TOKEN")
if echo "$OUT" | grep -q "$RID"; then FAIL=$((FAIL+1)); echo "❌ ack 后仍在 due"; else PASS=$((PASS+1)); echo "✅ ack 后 due 干净"; fi

# ── 跨租户隔离：另一个租户看不到 ──
TN2=$(curl -s -X POST $BASE/api/tenant -H 'X-Javis-Key: e2e-admin' -H 'Content-Type: application/json' -d '{"name":"e2e乙"}')
TOKEN2=$(echo "$TN2" | python3 -c "import json,sys; print(json.load(sys.stdin)['tenant']['token'])")
OUT=$(curl -s $BASE/api/reminders -H "X-Javis-Key: $TOKEN2")
if echo "$OUT" | grep -q "买牛奶\|晨跑\|喝水"; then FAIL=$((FAIL+1)); echo "❌ 跨租户泄漏"; else PASS=$((PASS+1)); echo "✅ 跨租户隔离"; fi

# ── 声纹 S1：无名注册 → 反问名字 → 裸名字 → 确认 → 开录 ──
R2=e2e-s1
OUT=$(say $R2 "记住我的声音")
ck "S1 反问名字" "$OUT" "怎么称呼"
OUT=$(say $R2 "唱歌")
ck "S1 裸名字复述确认(事故防线)" "$OUT" "「唱歌」，对吗"
OUT=$(say $R2 "不对")
ck "S1 否认回到问名" "$OUT" "没听清名字"
OUT=$(say $R2 "我叫川哥")
ck "S1 带前缀直接开录" "$OUT" "川哥"
OUT=$(say $R2 "算了不弄了")
ck "S1 中止" "$OUT" "先不记"

# ── 声纹 S1：裸名确认"对" → 开录 ──
R3=e2e-s1b
say $R3 "记住我的声音" > /dev/null
say $R3 "小美" > /dev/null
OUT=$(say $R3 "对")
ck "S1 确认后开录引导" "$OUT" "小美"
say $R3 "算了" > /dev/null

# ── 声纹 S2：忘掉未注册的人 → notFound ──
OUT=$(say $R "忘掉川哥的声音")
ck "S2 未注册 notFound" "$OUT" "谁的声音都没记过"

# ── 声纹 S2：seed 后确认链（无火山凭据，确认后走"没删成"分支=确认链已通） ──
sqlite3 $DB "INSERT INTO voiceprint (voiceprint_id, tenant_id, audio_name, display_name, owner_id, meta_info, created_at, updated_at) VALUES ('vp_e2e', '$TID', 'jv_e2e', '测试人', 'owner_e2e', NULL, 1, 1)"
OUT=$(say $R "忘掉测试人的声音")
ck "S2 确认话术" "$OUT" "确定要我忘掉「测试人」"
OUT=$(say $R "确定")
ck "S2 确认后执行(无凭据走fail分支)" "$OUT" "没删成"
OUT=$(say $R "忘掉测试人的声音")
ck "S2 fail后记录保留可重试" "$OUT" "确定要我忘掉「测试人」"
OUT=$(say $R "不对")
ck "S2 否认中止" "$OUT" "那就还记着"

kill $SRV 2>/dev/null
rm -f $DB ${DB}-wal ${DB}-shm
echo ""
echo "===== E2E 结果: PASS=$PASS FAIL=$FAIL ====="
[ $FAIL -eq 0 ]
