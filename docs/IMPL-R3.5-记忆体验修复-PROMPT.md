# R3.5 实施任务：记忆体验断裂修复（引导闭环 + 单人模式 + 面板产品化）

> 你是本任务的执行工程师。本文档自包含：按顺序读完再动手。产出 = 代码 + 测试 + 本地验收全绿 + 验收报告（部署发版是人工卡点，见 §5 Gate 4）。
>
> **⚠️ 工作区：你在 git worktree 里干活，不在主仓**
> - 你的工作目录：`/Users/rayman.chen/mycc/2-Projects/MyJavis-r35`（分支 `feat/r35-memory-ux`，已从 main 切出、依赖已装好）
> - 主仓 `/Users/rayman.chen/mycc/2-Projects/MyJavis`（main，当前稳定版 v0.14.0）**绝对不碰**——不进它的目录、不改它的文件、不在它里面跑命令
> - commit 全部提交到你的 worktree 分支；**不 merge 到 main、不 push**（人工验收后由川哥/cc 合并）
> - preview 浏览器验证：用 launch.json 里的 `myjavis-web-r35` 配置（已指向你的 worktree）
> - E2E 端口：主仓脚本用 3197-3199，你的临时 server 一律用 **3290-3299** 段并在结束时清理（lsof -ti :端口 拿 PID kill，别用 pkill -f 匹配 env 变量——匹配不到）
> 接手前置阅读（15 分钟，按序）：本文件 → `HANDOFF.md` 顶部版本段 → `docs/memory-architecture.md` §0/§3 → `04-决策记录.md` 最后 5 条。

---

## 0. 背景与根因（为什么做）

MyJavis 是个人 Jarvis 式实时语音助手（火山 RTC 全双工 + 声纹认人 + 分人记忆），当前 v0.14.0（App+server），≤10 人邀请制内测。

**生产实锤的体验断裂**（2026-07-08 排查）：记忆系统一切以"声纹认人"为前提（声纹 → owner → 记忆落库/隐私路由/活动事件）。用户（含川哥本人）租户声纹数=0 时：101 轮对话 100% `owner=- state=unverified`，说的话要么进隔离区要么跳过，**云端记忆零落库、本机隐私 vault 永远空、活动面板无事件**——且产品全程不告诉用户"没声纹=记忆不工作"。另两个独立问题：治理面板要手填 ownerId（用户不可知）；对话历史功能无 UI。

**川哥已拍板的方案**（三件全做，一次发版）：
- **A 引导闭环**：不动设计，把"记忆未激活"状态处处可见可引导
- **B 单人模式**：租户开关（默认开）——无声纹也让记忆开箱即用
- **C 面板产品化**：owner 点选、新增对话历史面板、空态文案

---

## 1. 代码地图（你会动的文件）

```
apps/server/src/
  routes/custom-llm.ts     # /v1 回调大脑：意图短路链、remember/recall 调用点、contextNote 组装
  memory/index.ts          # MyJavisMemory：remember(admission+隐私路由+活动事件)/recall
  memory/types.ts          # 全部类型
  memory/storage.ts        # SQLite 层（迁移模式：ensureXxxColumn try/ALTER+duplicate 容错）
  session/event-log.ts     # 对话事件溯源（appendUtterance）
  tenant/registry.ts       # 租户 CRUD（getTenant/effectiveTenant 所在）
  voiceprint/registry.ts   # 声纹表（listActiveVoiceprints/tenantForOwner）
  voiceprint/enroll-session.ts  # 声纹注册状态机（引导话术在此，可参考复用其文案风格）
  activity/feed.ts         # 活动流 ring buffer（pushActivity）
  routes/governance.ts     # 治理 API（/activity、/recall-preview 已有）
  sync/versions.ts         # UI 同步域（voiceprint|reminder|privacy|memory）
apps/web/src/
  App.tsx                  # MainApp：hooks 挂载 + 面板列表
  components/GovernancePanel.tsx / MemoryActivityPanel.tsx / PrivacyVaultPanel.tsx  # 面板范式参考
  useSyncVersions.ts       # useSyncRefresh(domain, reload) 订阅机制
  api.ts                   # apiFetch（自动带 X-Javis-Key）
apps/server/scripts/       # 测试全在这（tsx 脚本 + node:assert 风格）+ e2e-*.sh
```

**必须内化的项目铁律**（违反=返工）：
1. 面板数据变化必须接 UI 同步机制（server 写入点 `bumpSyncVersion(tenantId, domain)` + 前端 `useSyncRefresh(domain, reload)`）——这是川哥定的原则。
2. React 轮询/长活 effect 依赖必须空数组 + ref 桥接（项目里 useReminders.ts / MemoryActivityPanel.tsx 是范本），否则 effect 反复拆建掐掉轮询。
3. 隐私红线：任何日志/审计/活动事件摘要零隐私内容（活动事件只说"1 条敏感记忆已转移"不带内容）；event_log 中隐私轮已是脱敏占位文本，直接展示即可。
4. 测试 = `apps/server/scripts/*.test.ts`（tsx + node:assert/strict，参考 privacy.test.ts），加 package.json `test:<name>` script。
5. 本地 E2E 坑：remember 挂在 LLM 流 onDone——本地 server 不带 .env（无 LLM key）时写入永不触发，写入类 E2E 用 DB 预灌（参考 scripts/e2e-seed-recall.ts 头注释）；本地带 .env 起 server 后 /v1 有 Bearer 门，模拟回调必须带 `Authorization: Bearer $CUSTOM_LLM_API_KEY`。
6. 意图短路链在 custom-llm.ts 有固定顺序（enroll → forget → reminder → music），新增的引导话术不是新意图，是在 remember 结果上的反馈，别插进短路链。
7. 别动的东西：KWS/音乐/提醒/声纹链路本体、`memory-core/` 检索内核、CLAUDE.md/规则文件。不做本任务外的"顺手重构"。

---

## 2. 方案 B：单人模式（先做——A/C 依赖它的语义）

### 2.1 语义定义（已拍板，照做不重新设计）
- 租户新字段 `soloMode`（默认 **true**）。
- **solo=true**：该租户全部记忆归**租户默认 owner** `owner_tenant_<tenantId>`——无论声纹是否识别、是否 unverified。声纹此时仅用于"称呼"（speakerName 逻辑不动）。语义=整个邀请码一个记忆池，开箱即用。
- **solo=false**（家庭模式）：完全恢复现状（声纹 stable → 声纹 owner；unverified → quarantine）。
- 切换开关不迁移历史数据（v1 明示：切换后旧记忆留在原 owner 名下，面板 owner 点选仍可见）。

### 2.2 实施点
1. **tenant 存储**：tenant 表加 `solo_mode INTEGER NOT NULL DEFAULT 1` 列（沿用 storage.ts 的 ensureXxx 容错迁移模式；tenant 表若在 tenant/registry.ts 自管 db，则在该文件加迁移）。`getTenant` 返回值带 `soloMode: boolean`。
2. **owner 解析统一收口**：在 custom-llm.ts 现有 `identityResolution` 之后加一层解析（新建小函数，放 custom-llm.ts 内或 memory/identity）：
   ```ts
   // solo 模式：租户默认 owner 兜底（声纹识别与否都归它）；家庭模式走原声纹 owner
   const effectiveOwnerId = tenant?.soloMode ? `owner_tenant_${tenant.id}` : identityResolution.ownerId;
   const effectiveStable = tenant?.soloMode ? true : identityResolution.state === 'active_stable';
   ```
   下游三处使用：`memory.recall({ ownerId: effectiveOwnerId, ... })`、`memory.remember({ ownerId: effectiveOwnerId, ... })`、以及 remember 内部 `identityStable` 判断——**注意** remember 内部有自己的 `identityStable` 计算（`input.identity?.state === 'active_stable' && Boolean(input.ownerId)`），需要给 `RememberInput` 加可选 `soloStable?: boolean`，remember 里 `const identityStable = input.soloStable === true || (原判断)`。别直接改 identity 层（声纹证据链保持纯净）。
3. **归属校验联动**：`voiceprint/registry.ts` 的 `tenantOwnsOwner(tenantId, ownerId)` 加一条：`ownerId === 'owner_tenant_' + tenantId` 直接返回 true（否则治理面板查不了默认 owner）。`tenantForOwner` 同理支持反解。
4. **/api/me/config** 的 GET/PUT 支持读写 soloMode（前端设置面板加开关，文案："单人模式（默认开）：所有对话记忆归这个邀请码本人；家里多人共用才需要关闭并各自注册声纹"）。PUT 后 `bumpSyncVersion(tenant.id, 'memory')`。
5. **session-context / 隐私路由 / recall / 活动事件**全部自动随 effectiveOwnerId 成立，无需单独改——但要在测试里验证（见 §5）。

---

## 3. 方案 A：引导闭环

1. **通话内口头引导**（custom-llm.ts）：`solo=false` 且本轮 remember 返回 `status==='quarantined'` 且 reason 含 `identity_unstable` 时，在**下一轮** contextNote 里追加一条（复用 speakerNote/makeupNote 的拼接位）："[系统提示] 刚才那句话因为还没认出说话人，暂存未记住。请自然地告诉用户：说"我是XX，记住我的声音"完成声纹注册后，Javis 就能记住 TA 的事。"——注意 remember 是 fire-and-forget（onDone 里 void），拿不到本轮结果 → 实现方式：remember 前先同步判 `!tenant.soloMode && identityResolution.state !== 'active_stable' && extractMemoryCandidates(userText).length > 0`（direct import candidates 的导出函数）为 true 时设置房间级一次性标记（内存 Map<roomId, ts>，参考 stickySpeakers 模式，TTL 5 分钟内只提醒一次防唠叨），下一轮组装 contextNote 时消费。
2. **App 状态条**（web）：MainApp 顶部（PulseOrb 下方）加条件横幅——`solo=false && 声纹数===0` 时显示："⚠️ 记忆功能未激活：还没有注册声纹。通话中说"我是XX，记住我的声音""。声纹数从现有 VoiceprintPanel 同款 API 取（或直接在 App.tsx 里 apiFetch 声纹列表），接 `useSyncRefresh('voiceprint')` 保持实时。solo=true 时不显示（记忆本来就工作）。
3. **活动面板补隔离事件**：memory/index.ts 的 identity_unstable quarantine 分支加 `pushActivity(input.tenantId, { kind: 'write', summary: '有一句话暂存了（还没认出说话人，注册声纹后我才能记住）' })`——kind 复用 'write'（前端 KIND_META 不用扩）或新增 'quarantine' 并在 MemoryActivityPanel 的 KIND_META 加一行（icon 📥 color '#fbbf24'），后者更清晰，选后者。注意零内容红线：摘要不带原话。

---

## 4. 方案 C：面板产品化

1. **owners 列表 API**：`GET /api/governance/owners`（governance.ts，归属中间件里加 `/owners` 到 tenant 级豁免清单，与 `/activity` 同款处理）。返回本租户可查的 owner 列表：
   ```ts
   // solo 默认 owner（恒在首位，displayName 用租户称呼或"我"）+ 该租户声纹表全部 owner（displayName=声纹名）
   { ok: true, owners: [{ ownerId, displayName, source: 'solo'|'voiceprint', memoryCount }] }
   ```
   memoryCount 用一条 `SELECT COUNT(*) FROM hot_readable_memories WHERE owner_id=?`（storage 加方法）。
2. **治理面板改造**（GovernancePanel.tsx）：ownerId 手填输入框改为「owner 下拉/点选 chips」（加载 /owners，点选即查询；保留高级模式手填入口给 admin 调试——一个"手动输入"小链接切换即可）。选中 owner 后现有列表/操作/召回预览全部照旧。
3. **对话历史面板**（新组件 ConversationHistoryPanel.tsx）：
   - **server**：event_log 表加 `tenant_id TEXT` 列（容错迁移，老行 NULL）；`appendUtterance` 加可选 tenantId 参数；custom-llm.ts 两处 appendUtterance 调用（user 轮 + assistant 轮）传 `tenant?.id`。新 API `GET /api/governance/conversations?limit=50`（tenant 级豁免同上）：按 created_at DESC 返回该租户 event_log（roomId/sourceRole/utteranceText/createdAt），老行（tenant_id NULL）不返回——文档注释明示"只对升级后的新对话生效"。
   - **web**：面板按房间分组展示对话流（我说的/Javis 说的左右或颜色区分），隐私脱敏占位行（文本以 `[隐私` 开头）显示成"🔒 一句涉及隐私的话（已转本机保存）"样式。接 `useSyncRefresh('memory', reload)`（对话写入点不 bump 也行——加一个：appendUtterance 后 bump 'memory'？**不要**，每轮两次 bump 太频；改为面板自身 15s 轮询 + 手动刷新按钮，effect 空依赖+ref 桥接）。
   - App.tsx 挂载：放 MemoryActivityPanel 之后。
4. **空态文案**统一过一遍：记忆活动（"开始通话后这里会实时滚动…"已有✅）、本机隐私（已有✅）、治理面板（改成"选择上面的人后显示 TA 的记忆"）、对话历史（"还没有对话。开始通话后这里按时间显示每一句"）。

---

## 5. 验收方案（全绿才算完成；执行顺序=开发顺序）

### Gate 1 单测（新增 `scripts/solo-mode.test.ts` + 改动既有）
- solo owner 解析：soloMode=true 时 effectiveOwnerId=`owner_tenant_<id>`，remember 带 soloStable 落 committed/provisional（非 quarantine）；soloMode=false 完全等于现行为（对照断言）。
- `tenantOwnsOwner` 认默认 owner；`tenantForOwner` 反解。
- 引导标记：unverified+有候选 → 房间标记置位 & 5 分钟幂等；solo=true 时绝不置位。
- 活动流 quarantine 事件零内容断言（复用 privacy.test 的 auditBlob 式全量 grep）。
- event_log tenant_id 迁移幂等（两次 migrate 不炸）+ appendUtterance 带租户落列。
- **回归**：现有 16 套测试全过零破坏（`for t in refine privacy memory-core recall-integration storage identity candidates lifecycle conflict correction governance music prompt-injection voiceprint reminder voiceprint-s123; do pnpm test:$t; done`），server+web `tsc --noEmit` + build 过。

### Gate 2 本地 E2E（扩展 `scripts/e2e-recall-local.sh` 或新增 e2e-solo-local.sh）
- 起本地 server（JAVIS_API_KEY=e2e-admin，不带 .env）→ 建租户（默认 solo=true）→ mock 声纹缺省（不传 user 参数=无身份）say "记住我喜欢喝乌龙茶"——**注意本地无 LLM 时 remember 不触发**，此场景写入断言改用 DB 预灌 + 直调 memory 层的集成测试覆盖（solo-mode.test.ts 里做），E2E 只验 HTTP 面：/owners 返回含 solo 默认 owner、/conversations 返回结构正确、治理面板 owner 归属校验放行默认 owner。
- 隐私 E2E（e2e-privacy-local.sh）在 solo 语义下重跑全绿（session-context 的 ownerId 改用默认 owner 推导——脚本里 owner 取值逻辑改为 `owner_tenant_<TID>`）。

### Gate 3 preview 实证（浏览器验证 UI，用 `.claude/launch.json` 的 `myjavis-web-recall3002` 配置，起本地 server 于 3002）
- 治理面板：owner 点选 chips 渲染、点选后记忆列表出现（预灌数据）。
- 对话历史面板：预灌 event_log（带 tenant_id）后面板按房间分组显示；隐私占位行显示 🔒 样式。
- 状态条：solo=false+声纹 0 的租户显示黄条；solo=true 不显示。
- 零点击刷新：后台改数据 → 面板 ≤15s 自动更新。

### Gate 4 —— ⛔ 人工卡点：到这里停下，不部署、不发版、不合并
Gate 1-3 全绿后：版本四处同步 **0.15.0**（server/web package.json、tauri.conf.json、Cargo.toml，grep `0.14.0` 零残留）→ 全部 commit 到 worktree 分支 → **输出验收报告后结束任务**。报告必须含：
1. 三道门的证据（各测试/E2E 的 PASS 输出摘要、preview 验证结论）
2. 改动文件清单 + 分支名 + 最新 commit hash
3. **预写好的部署清单**（供川哥确认后由 cc/下个 session 执行）：合并 main → server 部署（⚠️ 生产=root@47.239.204.68 香港，绝不是 aliyun-kr；先 `cp -r dist dist.bak-v0.14.0` 备份再 rsync；部署前看 pm2 日志确认川哥不在通话）→ 生产 E2E（测试租户 tn_833edb45 说"记住我喜欢喝龙井"→ 断言落库 owner=`owner_tenant_tn_833edb45` + /owners/conversations/activity 三端点见数据）→ `release-app.sh` 发 App
4. **给川哥的真机验收脚本**：更新 App → 说"记住我周五要去取西装"→ 记忆活动面板 5s 内出 ✏️ 写入 → 治理面板点选"我"看到这条 → 对话历史看到这轮 → 换说法问"我周五要干嘛来着"答得上
5. 发现的 backlog（如有）

**绝对禁止**：merge/push 到 main、ssh 生产服务器做任何写操作、跑 release-app.sh。

### 交付物清单
代码 + 单测 + E2E 脚本更新 + `04-决策记录.md` 追加一条（含 solo 语义定义与"切换不迁移历史"的明示）+ `HANDOFF.md` 版本段刷新 + `docs/ROADMAP.md` 状态更新 + commit 到 worktree 分支（格式 `feat: v0.15.0 R3.5 记忆开箱即用——单人模式+引导闭环+对话历史/owner点选`，**不加 Co-Authored-By，不 push 不 merge**）+ 最终验收报告（中文，含川哥真机验收脚本，署名格式：`署名：<你的名字>（<引擎>）| 完成时间`）。

### 禁止事项
- 不改 memory-core 检索内核、KWS、音乐、提醒本体。
- 不做本文档之外的"顺手优化"（发现问题记 backlog 报告即可）。
- 隐私内容零日志零审计零活动摘要。
- 严格按 §2.1 语义实现 solo，不自行扩展（如自动迁移历史记忆——明确不做）。
