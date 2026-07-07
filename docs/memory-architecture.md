# MyJavis 记忆架构定稿：App 内隐私 Vault + 云端长线层（同构双部署）

> 2026-07-07 定稿（v2，经三轮讨论收敛）。背景：川哥要求记忆架构分两层——隐私记忆存本机、云端建稍重的跨 session/跨时间/多租户长线记忆，选型须有逻辑、有源码级证据、有链接。
> 裁决链：初版本机层部署位 Mini → 川哥追问"能否与 App 打包"→ 改为 **App 内 vault（多租户视角下唯一产品级正确解**：每个内测用户的隐私在自己电脑上，Mini 方案只对川哥单人成立）→ 川哥追问"能否集成短/中/长期、情景、语义分层"→ 确认分层本体是 schema+规则+批处理、唯一卡点是提炼 LLM → 川哥拍板：**Ollama 本地提炼不做（内测用户机器没装），只保留 server 代理 + 规则降级两档**。
> 调研方法：GitHub 盘点 12 个候选（star/活跃度/license 全核）→ 浅 clone 6 个头部仓源码解读（腾讯 AgentMemory、mem0 由 cc 亲读；graphiti、hindsight、memU、OpenViking 由 3 个子代理并行深读）。行号基于 2026-07-07 各仓 HEAD 的 shallow clone。

---

## 0. 结论速览

```
[内测用户电脑: Tauri App]                      [HK ECS: MyJavis server (Node)]
 ├─ WebView(React)                              ├─ 通用记忆（云端 SQLite）
 │   ├─ 共享包 @myjavis/memory-core             │   ├─ 检索三件套(jieba+BM25+salience, 后加向量RRF)
 │   │  分层schema/检索打分/晋升规则 ←同一套代码→│   ├─ bi-temporal 四时间戳
 │   └─ 隐私 vault（tauri-plugin-sql,           │   ├─ mem0 V3 式单次 LLM 写入决策
 │      SQLite 单文件, FileVault+0600）         │   └─ 异步巩固（画像重算/过期清理）
 │                                              │
 └─ Rust 壳：定时器（免 WebView 节流）+ tray    ├─ 隐私路由：分类命中→内存 hold→App 拉走即焚
                                                ├─ 提炼代理：App 批次→LLM→结果回本机，云端零落盘
[Mini] 降为 vault 加密备份目标（非主库）        └─ contextNote 内存注入（通话时 App 上行）
```

| 层 | 选型结论 | 一句话理由 |
|---|---|---|
| **本机隐私 vault**（App 内） | **方案 A 自研**：前端 TS（jieba-wasm 分词 + BM25 + salience）+ tauri-plugin-sql 存储，检索/分层逻辑与云端共享 `@myjavis/memory-core` 包；**带完整记忆分层**（working/episodic/semantic/profile） | 调研池零现成可打包方案（全是 Python/Node 服务或库）；分层本体=schema+规则+批处理，本机全量可做；App 增重 ~0 |
| **提炼（LLM 步骤）** | **两档**：默认 server 代理转发 LLM（内容不落云盘）；失败/离线时规则式降级（现有 admission/pref_summary 模式） | 隐私边界=存储位置而非传输路径（通话内容本来就实时过 DeepSeek/MiniMax），代理提炼不新增暴露面；Ollama 档剔除——内测用户机器不能假设 |
| **云端长线层·近期** | **自研底座升级**：同一共享包三件套 + graphiti 的 bi-temporal + mem0 V3 单次 LLM 决策 + 腾讯的异步批处理节奏 | 内测规模（个位数租户×几百条）下开源重方案全是超配，且会丢声纹 owner/admission/quarantine 三样领域定制 |
| **云端长线层·远期** | 指标 gate 后试点 **hindsight**（首选）/ OpenViking（备选） | hindsight：租户隔离教科书+recall 零 LLM+MIT；OpenViking：中文原生但 Alpha+AGPL-13 条 |

**Gate 指标**（触发远期方案任一即启动 POC）：租户 > 20；单租户记忆 > 1 万条；产品化需要"记忆演化历史可查/巩固层"。

---

## 1. 候选池盘点（2026-07-07）

| 仓 | stars | 语言 | license | 活跃 | 初筛判决 |
|---|---|---|---|---|---|
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | 60.3k | Python | Apache-2.0 | 当日 push | 深读 ✅（cc 亲读） |
| [getzep/graphiti](https://github.com/getzep/graphiti) | 28.5k | Python | Apache-2.0 | 当日 push | 深读 ✅（子代理） |
| [topoteretes/cognee](https://github.com/topoteretes/cognee) | 27.3k | Python | Apache-2.0 | 当日 push | 不深读——有一手实战阴影：no-prune 内存跨题无界累积 OOM + ollama 串行慢（memory: cognee_noprune_oom） |
| [volcengine/OpenViking](https://github.com/volcengine/OpenViking) | 26.4k | Py+Rust+C++ | **AGPL-3.0** | 当日 push | 深读 ✅（子代理） |
| [letta-ai/letta](https://github.com/letta-ai/letta) | 23.7k | Python | Apache-2.0 | 近日 push | 不深读——是 agent 运行时平台而非可嵌记忆层，引入=换框架 |
| [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight) | 18.1k | Python | MIT | 当日 push | 深读 ✅（子代理） |
| [NevaMind-AI/memU](https://github.com/NevaMind-AI/memU) | 14.0k | Python | Apache-2.0 | 当日 push | 深读 ✅（子代理） |
| [MemTensor/MemOS](https://github.com/MemTensor/MemOS) | 10.1k | TS | Apache-2.0 | 当日 push | 未深读（时间盒），候补 |
| [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) | 7.0k | **TS** | other(自定义) | 6-26 push | 深读 ✅（cc 亲读） |
| memodb-io/memobase | 2.8k | Python | Apache-2.0 | **2026-01 停更** | 剔除（半年不动） |
| BAI-LAB/MemoryOS | 1.5k | Python | Apache-2.0 | 4 月 | 研究向，不深读 |
| langchain-ai/langmem | 1.5k | Python | MIT | 6 月 | 绑 langgraph store 生态，不适配 |

**"能否直接打包进 Tauri App"专项结论：全部不能。** memU 要捆 Python≥3.13 运行时；腾讯/mem0-ts 要 Node 运行时（Bun sidecar 单二进制可行但 App 增重 50–90MB，判为备选路线 C）；其余全是常驻服务。故本机层自研，从候选中移植已验证模式。

---

## 2. 六仓源码解读精华（证据层）

### 2.1 腾讯 TencentDB-Agent-Memory —— 检索三件套与管线节奏的「同栈实证」⭐

对 MyJavis 价值最大的发现：**它就跑在 `node:sqlite`（Node 22+）上**，与 MyJavis server 存储栈完全同宿主。

- 宿主与扩展加载：`src/core/store/sqlite.ts:14`（"Dependencies: Node.js built-in `node:sqlite` (Node 22+) + `sqlite-vec`"）、`:454-456`（`require("sqlite-vec"); sqliteVec.load(this.db)`）
- 存储 schema：`l1_records` 关系表 + `l1_vec` vec0 向量虚表（`sqlite.ts:561/595`）+ `l0_conversations`/`l0_vec`（`:648/676`）——L0 原始对话与 L1 结构化事实分表，各带向量
- **FTS5 优雅降级**（关键，因为实测 Node 22.14 的 node:sqlite 没编 FTS5）：`sqlite.ts:743`（"best-effort — gracefully degrade if fts5 is not compiled in"）、`:824-835`（try/catch 置 `ftsAvailable` 标志，全部 FTS 调用点判飞）
- **中文方案**：FTS 存入前先 jieba 分词（v2 schema：`content`=分词后文本索引、`content_original` UNINDEXED 存原文，`sqlite.ts:744-747`）；另有一条零 FTS5 依赖的纯 TS BM25 稀疏向量路（`src/core/store/bm25-local.ts:5-13`，jieba-wasm + 预训练 zh 参数）——**本机 vault 的关键词检索直接走这条路线**
- **混合检索融合**：标准 RRF k=60（`src/core/store/search-utils.ts:15-45` `rrfMerge`），FTS 与向量两路合并；检索路径零 LLM 调用
- **异步管线节奏**（工程经验直接可抄）：每 5 轮对话或闲置 600s 触发 L1 抽取、每 50 条新记忆触发 L3 画像重算、recall 5s 超时跳过注入不阻塞对话（README_CN.md 配置表）
- 分层理念：L0 Conversation → L1 Atom → L2 Scenario(MD) → L3 Persona 语义金字塔，"低层保留证据，高层保留结构"，每条摘要沿"高层符号→中层索引→底层原文"可完美溯源（README_CN.md §渐进式披露）
- 依赖表干净：`sqlite-vec / @node-rs/jieba / @tencentdb-agent-memory/tcvdb-text / ai / zod` 等 11 项，核心 32,108 行 TS
- 判决：形态是 OpenClaw 插件（管线为 coding agent 对话设计），整包嵌入会与自研 typed memory 语义打架 → **不引入包，移植模式**（三件套 + 管线节奏 + 溯源理念）

### 2.2 mem0 —— 写入决策管线的「省 token 范式」

- **V3 写入管线**（`mem0/memory/main.py:831-940` `_add_to_vector_store`）：Phase1 先向量搜 top-10 相似旧记忆 → **UUID→整数映射防幻觉**（`:885-889`，与我们 `uuid_misroute` 教训完全互证）→ Phase2 **单次 LLM 调用**同时完成"抽取新事实+对旧记忆的 ADD/UPDATE/DELETE 决策"（`ADDITIVE_EXTRACTION_PROMPT`）。全部候选中写入 LLM 成本最低（对照：graphiti 3-8 次/条、memU 3-4 次、OpenViking 每 commit 多轮 ReAct）
- `infer=False` 短路（`:832-866`）：跳过 LLM 直存原文——确定性写入通道并存，适配现有规则式 admission
- 多租户：`user_id/agent_id/run_id` 三轴硬校验（`main.py:1409-1414`），本质是 payload filter 非物理隔离
- 形态判决：mem0-ts 无 SQLite/嵌入式 vector store（`mem0-ts/src/oss/src/vector_stores/` 17 个全是服务端）；self-hosted server 要 Postgres+pgvector（`server/docker-compose.yaml:33`）；OpenMemory 已官宣 sunset → **不引入，移植 V3 单次决策模式（本机提炼与云端写入共用此 prompt 设计）**

### 2.3 graphiti —— bi-temporal 时序设计的「借鉴源」

- **四时间戳 bi-temporal**：`graphiti_core/edges.py:271-282`——事件时间轴（`valid_at`/`invalid_at`：事实何时为真/失效）与系统时间轴（`created_at`/`expired_at`：何时摄入/被作废）分离；矛盾边失效是纯时间区间比较的确定性操作零 LLM（`edge_operations.py:539-573`）
- 写入贵：一条对话 3-8 次 LLM 调用，官方自己建议放后台队列（`graphiti.py:1056-1059`）
- 检索：简版 `search()`（RRF 配方）零 LLM，但向量是**全表暴力 cosine 无 ANN 索引**（`driver/neo4j/operations/search_ops.py:149-165`）
- 隐性外呼：LLM/embedding 不传就静默默认 OpenAI（`graphiti.py:216-227`）、posthog 遥测默认开（`telemetry/telemetry.py:36-38`）
- 判决：纯 Python 36.5K 行 + Neo4j/FalkorDB 容器 + 无 TS SDK = 栈错配 → **不引入，把 bi-temporal 四时间戳移植进 memory_item**

### 2.4 hindsight —— 云端长线层的「远期首选」

- 多租户全场最强：**bank（业务隔离，每表 `bank_id`，`hindsight_api/models.py:110`）+ tenant（物理隔离，PG schema-per-tenant，`extensions/tenant.py:20-31`）双层**，另有 Supabase JWT→私有 bank 现成范式（`extensions/builtin/supabase_tenant.py:89`）
- **recall 路径零 LLM**：语义+BM25 单 SQL 合并（`engine/search/retrieval.py:95`，pgvector HNSW 真 ANN）→ 图扩散 → 时序（**dateparser 规则而非 LLM**，且有专门中文时间规则集 `engine/chinese_temporal_periods.py`）→ RRF（`fusion.py:29`）→ 本地 CPU cross-encoder 重排（`config.py:763-764`）→ `CE × recency × temporal × proof_count` 组合打分（`reranking.py:58`）
- 记忆分层带演化：`world/experience/observation` 三类 fact_type（`models.py:102-174`），observation 由后台 consolidation LLM 自动巩固、带 `proof_count` 与 history（`engine/consolidation/consolidator.py:1-16`）；**双时间轴 `occurred_* vs mentioned_at`**（本方案分层 schema 的直接来源）；失效记忆移冷表使热路径永不扫到
- LLM 解耦彻底：retain/reflect/consolidation 三阶段可各配 base_url（`config.py:255/277/288`），火山 provider 现成；embedding 默认本地 bge CPU
- 坑：写入条条过 LLM+写后巩固 LLM；**中文 BM25 默认瘸腿**（PG `to_tsquery` english，`engine/sql/postgresql.py:50`，要 ParadeDB 换 jieba/lindera）；54 个强制依赖、核心 96K 行 Python
- 成熟度全场最佳：测试:代码 ≈ 1:1、4 语言客户端（含 TS）、helm/MCP/observability 全套
- 判决：**远期 gate 触发后的首选**——external-pg、bank-per-租户 + JWT、LLM 指现网关、retain 异步；**上前必须 POC 中文 BM25（ParadeDB）**

### 2.5 memU —— salience 公式与嵌入式下限的「实证」

- 全场唯一真嵌入式：Python 库 + SQLite 单文件 + numpy 暴力余弦（`src/memu/vector.py:65-97`），零服务零基建，Apache-2.0
- 检索可全本地：关掉 `route_intention`/`sufficiency_check` 两开关（`settings.py:413-428`）后路径只剩 1 次 query embedding → 纯 numpy topk——**证明个人量级（万条内）暴力打分毫秒级，本机 vault 的性能下限有据**
- **salience 公式直接抄**：`similarity × reinforcement × recency`（`vector.py:26-62`），配 `reinforcement_count`（命中重复内容加权而非新增，`settings.py:475-478`）
- 两层结构：Entry（原子记忆）→ File/分类（LLM 维护 400 字滚动摘要）→ Segment（检索切片）；分类 taxonomy 自适应生长不预设
- 坑：**Python≥3.13** + 无 HTTP server 无 TS SDK + 多租户是"打标列+自觉过滤" + Beta
- 判决：设计合格但栈错配 → **借鉴 schema 与 salience 公式**，自研到 TS 共享包

### 2.6 OpenViking —— 云端远期的「中文系备选」

- "context 即文件系统"：一切记忆是虚拟 FS 节点（`viking://user/{uid}/memories/...`），每节点 L0 abstract/L1 overview/L2 detail 三级 + 向量（`openviking/core/context.py:34-58`）；预置 `memories/{preferences,entities,events,cases}` 目录树（`core/directories.py:39-80`）
- self-evolving 实体：**LLM ReAct 循环读旧记忆后原地 upsert/update/delete**（`session/memory/extract_loop.py:82-98`）+ 目录摘要自底向上重算 + **hotness 生命周期** `sigmoid(log1p(active_count)) × exp(-λ·age)` 7 天半衰期（`retrieve/memory_lifecycle.py:19-65`）——**dormant 冷藏设计的参考**
- `find()` 快路径无 LLM，`search()` 带 LLM 意图分析必然秒级（`retrieve/intent_analyzer.py:87`）——语音场景只能用 find()
- **中文原生**：默认本地 embedding 就是 `bge-small-zh-v1.5-f16` GGUF（`embedding_config.py:657-671`）；火山组件全部可选默认——生态契合是"半个真优势"，不构成锁定
- 真多租户强隔离：`account_id:user_id` 双层 + URI 化记忆空间 + API key/OAuth + 目录级 access 检查
- 坑：**Alpha** × 30.7 万行三语言（Py 162K+Rust 83K+C++ 13K）运维面；写入 ReAct token 成本；**AGPL-3.0 第 13 条**——个人自用零义务（已读全文 661 行无附加条款），但多租户产品化若改源码须向用户开源，法务预案先行
- 判决：远期备选，试点姿势=Docker 单容器 + find() 快路径 + 实测 ReAct 写入成本再定去留

---

## 3. 记忆本体论：分层模型（两层共享的核心设计）

**设计原则：type（内容语义）× layer（生命周期）正交。** 现有 8 类 typed memory 不推倒，加一个 layer 维度与晋升规则：

| layer | 定义 | 现有 type 映射 | 保留/衰减 |
|---|---|---|---|
| **working 短期** | 会话轮窗口 + 当日上下文 | `ephemeral_context` | 当日过期，不晋升即弃 |
| **episodic 中期·情景** | 具体事件，带双时间轴，支持"上周说的/昨天提到的"中文时间查询 | `event`、`reminder`(独立表保持) | 时间衰减进 salience；反复提及触发晋升 |
| **semantic 长期·语义** | 稳定事实与偏好 | `preference` / `profile_fact` / `relationship` / `location` / `safety` | 低 salience 进 dormant 冷藏（不删，检索不扫——hindsight 冷表模式） |
| **profile 画像** | 聚合层 | `pref_summary`（现有规则式重算即此层 v0） | 每 50 条新记忆触发重算（腾讯节奏） |

**统一 schema 增量**（`@myjavis/memory-core` 共享类型，云端 memory_item 与本机 vault 同构）：
- 双时间轴：`occurred_at`（事实发生时间，来自时间解析或 LLM 提炼）vs 既有 `created_at`（提及/摄入时间）——hindsight `occurred_* / mentioned_at` 模式
- bi-temporal：`valid_at / invalid_at / expired_at`（graphiti 模式；本机 schema 预留、云端 R3 启用逻辑）
- salience 素材：`reinforcement_count / last_reinforced_at / last_recalled_at`（memU 模式）
- 本机独有：`sensitivity`（分类器标签 + 人工改判字段）

**统一检索**（共享包实现，两端同代码）：jieba 分词（Node 侧 `@node-rs/jieba`、WebView 侧 jieba-wasm，同源 jieba-rs）→ BM25/命中打分 → salience（`similarity × reinforcement × recency`）→ layer 加权（working 直注、episodic 时间过滤、semantic 主检索池、profile 全量前置）→ 云端加向量后与关键词路 RRF k=60 融合。检索路径零 LLM，5s 超时跳过注入不阻塞对话（腾讯 recall.timeoutMs 模式）。

**晋升与巩固**：
- working→episodic/semantic：写入时由 admission（近期）/ mem0 V3 单次决策（R3 起）判定
- episodic→semantic：reinforcement_count 达阈值（同一事实反复提及）时提炼沉淀
- semantic→profile：批处理聚合（规则式起步=现有 `recomputePrefSummary`，LLM 画像后置）
- 全部巩固动作**异步批处理**，绝不在通话热路径

---

## 4. 本机隐私 Vault（App 内，方案 A）

### 4.1 技术底盘

- **存储**：tauri-plugin-sql（SQLite 单文件），路径 App 数据目录，权限 0600；静态加密 v1 依赖 macOS FileVault，SQLCipher 后置加固
- **检索**：WebView 内跑共享包 `@myjavis/memory-core`（jieba-wasm 分词 + BM25 + salience + 分层规则）；几百~几千条全量载入打分毫秒级（memU 实证下限）
- **向量**：v1 不做（隐私记忆查询天然是实体词命中，关键词是主力）；后置路径=Rust 侧 sqlite-vec crate + fastembed，schema 向量列预留
- **App 增重 ~0**；备选路线留档：B=Rust 原生 store（rusqlite+jieba-rs+sqlite-vec crate）、C=Bun sidecar 单二进制（+50-90MB，复用度最高）

### 4.2 隐私路由（写入）

- 锚点一：type ∈ {safety, location, relationship} 全量 + profile_fact 敏感子集
- 锚点二：关键词分类器（健康/病症/金额/证件/家人实名等词表，规则式，宁多勿漏）
- 命中 → 云端**不落盘**（内存 hold 队列）→ App 在线时轮询拉走（与 reminder due 轮询同构）→ 落本机 vault → server 即焚
- 取舍明示：App 离线期间 server 崩溃丢该批隐私记忆——**宁丢勿泄**；丢失窗口由 **tray 常驻**（与 R2 捆绑交付）压到最小
- 治理面板留"改判去向"入口（分类器召回率不可能 100%，配合既有 UI 同步机制）

### 4.3 隐私使用（读取）

- 通话必然发生在 App 内 → App 从本机 vault 检索相关子集 → 经现有 **contextNote 通道**上行注入（先例：reminder makeup 补报、speakerNote）→ server 内存拼 prompt 用完即弃，审计日志脱敏（只记条数不记内容）
- 论证基石（川哥已认可）：**隐私边界 = 存储位置，不是传输路径**——通话内容本来就实时过 DeepSeek/MiniMax，注入不新增暴露面；本方案的承诺是"云端零持久化"

### 4.4 提炼（两档，无 Ollama）

- **默认档·server 代理**：App 攒批（通话结束后 5min 事件驱动，Rust 侧 tokio 定时器发 Tauri event 唤醒前端——规避 WKWebView 窗口隐藏时 JS 定时器节流）→ `POST /api/memory/refine` → server 转发现有 LLM 通道（DeepSeek/MiniMax 赛马复用）→ 结构化结果（mem0 V3 式单次决策 prompt：抽取+ADD/UPDATE/DELETE，整数 id 防幻觉）→ App 落本机 → server 全程内存零落盘
- **降级档·规则式**：LLM 失败批次保留重试；持续失败走现有 admission 规则兜底——短期/中期/情景层完全不受影响（本就是纯规则），语义层退化为规则聚合=不坏于今天
- ~~Ollama 本地档~~：**已裁决不做**（内测用户机器不能假设）；将来若做发烧友选项，检测到本机 Ollama 自动升档即可，架构无需预留改动

### 4.5 备份

- Mini 从"vault 主库"降为**加密备份目标**：App 定期把 vault 加密快照推 Mini（或 Mini 限权拉，复用 forced-command 模式）；**绝不回流云端**
- 内测用户无 Mini：v1 提示用户 vault 文件路径自行 Time Machine；产品化再谈 E2E 加密云备份

---

## 5. 云端长线层

### 5.1 为什么底座保留自研——三个不可替代物

1. **声纹 owner 绑定**：记忆归属由声纹身份证据决定（`active_stable` 才落 owner），全部候选的 user_id 都假设"调用方自报身份"
2. **admission/quarantine + prompt injection 防护 + 纠错意图**：语音 ASR 噪音场景的写入防线
3. **8 类 typed 体系**（`memory/types.ts:3-11`）已与 reminder/声纹/pref_summary 业务打通

### 5.2 近期升级（在现有 Node 进程内，零新服务）

1. **检索三件套**：共享包接入 server `recall()`——替换"最近 8 条"（`memory/index.ts:95` 现实现未用 query 参数，调用方零改动）；sqlite-vec 向量路视 embedding 选型进度加入，先上关键词+salience 也已质变
2. **bi-temporal 四时间戳** + 矛盾失效（graphiti 式确定性时间区间比较）
3. **写入决策升级**：规则式 admission 之上加 mem0 V3 单次 LLM 决策；批处理节奏抄腾讯（每 5 轮或闲置 10min），不在通话热路径
4. **异步巩固**（= ROADMAP P3 Autodreaming 轻量版落地）：夜间对账 + profile 重算（每 50 条触发）+ dormant 冷藏 + ephemeral 清理
5. 多租户维持 tenant_id + X-Javis-Key，量级不需要物理隔离

### 5.3 远期（gate 触发后）

- Gate：租户 > 20 / 单租户 > 1 万条 / 巩固层产品化
- 首选 **hindsight**：external-pg + bank-per-租户 + JWT tenant 扩展 + LLM base_url 指现网关 + retain 异步；前置 POC：ParadeDB 中文 BM25 + recall 实测 <200ms
- 备选 **OpenViking**：Docker 单容器 + find() 快路径；前置实测 ReAct 写入 token 成本；产品化过 AGPL-13 条法务检查
- graphiti 不选（栈错配+写入贵+无 ANN），其 bi-temporal 已在近期方案吸收

---

## 6. 实施切片（定稿）

| 切片 | 内容 | 规模 | 依赖 |
|---|---|---|---|
| **R1 云端检索相关性化 + 共享包抽取** | `@myjavis/memory-core` 建包（分层 schema 类型 + jieba/BM25/salience 检索）→ server recall() 接入替换"最近 8 条" + telemetry 记 matchedKeywords | ~2 天 | 无，可先发版 |
| **R2 本机隐私 vault MVP** | 分层 schema 落 tauri-plugin-sql + 隐私路由分类器 + hold/拉/焚链路 + contextNote 注入 + 提炼代理端点 + **tray 常驻捆绑**（P3 提前） | ~4 天 | R1（共享包） |
| **R3 云端写入升级** | bi-temporal 四时间戳 + 矛盾失效 + mem0 V3 单次决策 + 批处理节奏 | ~1.5 天 | R1 |
| **R4 云端异步巩固** | 夜间对账/profile 重算/dormant 冷藏/过期清理 | ~1 天 | R3 |

顺序：R1 → R2 ∥ R3 → R4，合计 ~8.5 天。R1 单独发版即见效（原"记忆召回相关性化"的升级交付）。

**验收口径**（BRO-PDCA）：
- R1：召回对照 E2E（写入"女儿叫朵朵"→闲聊 10 轮挤出最近窗→提问必召回；旧逻辑必挂新逻辑必过）+ 意图反例单测 + 10 套既有回归零破坏
- R2：分类器正反例单测；拉焚链路 E2E（拉走后 server DB/日志 grep 零内容残留）;通话注入真机验证；窗口隐藏下批处理仍触发（节流规避验证）；vault 文件权限 0600 断言
- R3：bi-temporal 状态机单测（矛盾失效区间用例）+ 决策 prompt 金测（ADD/UPDATE/DELETE/NONE 四路）
- R4：巩固幂等单测 + 生产夜跑一轮人工抽查

## 7. 风险与开放问题

1. **R1 前 30min 探针×3**（no-guessing，全部动手前实测）：tauri-plugin-sql 打包 SQLite 的特性面；jieba-wasm 在 WKWebView 加载（Node 侧腾讯已验，WebView 侧高置信未实测）；`@node-rs/jieba` 与 jieba-wasm 分词结果一致性（两端打分可比性）
2. **云端 embedding 选型**（只影响云端向量路，本机 v1 无关）：豆包 API / SiliconFlow bge-m3 / ECS 本地 GGUF——R1 可先上关键词+salience，向量路推迟到选型定
3. sqlite-vec vec0 虚表无 ON CONFLICT（腾讯 `sqlite.ts:19`：upsert=delete+insert）——云端写入封装注意
4. 提炼代理端点是新的攻击面：批次大小限额 + 租户鉴权 + 内容零日志，安全 checklist 过一遍
5. 隐私分类器词表需持续运营：真机误判/漏判案例回流词表（治理面板改判数据就是训练集）
6. MemOS（TS，10.1k stars）本轮未深读；若 R1-R4 推进中自研成本超预期，回头补读
