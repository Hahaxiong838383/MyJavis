# MyJavis 记忆系统地基实施进展

> 更新：2026-06-30 · 分支 `feat/myjavis-infra`

## 1. 本批完成

- **Telemetry**：新增 `apps/server/src/telemetry.ts`，按轮落 NDJSON，拆分 `networkRttMs / memoryReadMs / promptAssemblyMs / llmTtftMs / totalMs`，并记录 speaker evidence、读取/注入 memory id、降级原因、provisional 使用。
- **SQLite 存储**：新增 `apps/server/src/memory/storage.ts`，使用 `node:sqlite` + WAL，建 `event_log / speaker_evidence / owner / memory_item / pref_summary / audit`。
- **视图隔离**：新增 `hot_readable_memories` 与 `quarantined_memories`，热路径只读 committed/provisional，不读 quarantine。
- **身份证据层**：新增 `apps/server/src/memory/identity/index.ts`，将火山 payload 归一为 `SpeakerEvidence`，实现 `unverified → registering → active_low → active_stable → revoked`，仅 `active_stable` 输出 `memory_owner_id`。
- **事件溯源**：新增 `apps/server/src/session/event-log.ts`，append-only event log，包含 `asr_segment_id / is_final / source_role / interrupted_at / heard_by_user`，ID 由 deterministic hash 生成。
- **Memory 门面**：升级 `apps/server/src/memory/index.ts`，暴露 `Memory.recall/remember` 与 `Identity.resolve` 接缝；`remember` 只从 finalized user utterance 写入，assistant 不入用户事实。
- **Data 化注入**：升级 `apps/server/src/prompt/orchestrator.ts`，以 `UserPreference(key=value, source, confidence, owner, memory_id)` 结构化渲染，并声明记忆不可覆盖系统规则。
- **CustomLLM 接入**：升级 `apps/server/src/routes/custom-llm.ts`，接入身份解析、事件日志、记忆 recall/remember、遥测落盘。
- **RTC 声纹配置占位**：升级 `apps/server/src/routes/rtc.ts`，支持 `voiceMode=identify|denoise`、`voiceprintIds`、`VoicePrint Mode=2/1`、FarfieldConfig；不接真实注册。
- **Phase0 Eval**：新增 `apps/server/eval/`，包含回放样例、runner、metrics，输出串账率、一次性事实保留率、prompt injection 抵抗率等基础指标。

## 2. Schema 摘要

| 表/视图 | 用途 |
|---|---|
| `speaker_evidence` | 火山声纹每轮证据，保留 raw payload、score、mode、state |
| `owner` | 系统确认的长期记忆主体，业务只认 `memory_owner_id` |
| `event_log` | append-only 事件溯源，记录 user/assistant/tool、final 状态和打断信息 |
| `memory_item` | MVP typed 单表，字段含 owner、namespace、type、structured content、source_role、confidence、status、ttl、provenance、acl |
| `pref_summary` | 后续热路径偏好摘要入口，本批建表不实现智能收敛 |
| `audit` | 后续准入/纠正/重归属审计入口 |
| `hot_readable_memories` | 热路径只读 committed/provisional |
| `quarantined_memories` | 身份不稳或注入内容隔离区 |

## 3. 红线落实

- `voiceprintId` 不做 `memory_item` 主键，只映射为 `memory_owner_id`；非 `active_stable` 写入 `quarantine`。
- `assistant` 文本只进 `event_log`，不写用户事实型 `memory_item`。
- 记忆以结构化 data 注入，不把原文自然语言拼进 system prompt。
- 检测到“忽略安全规则/越权/绕过权限”等注入内容时，写入 quarantine，不进入 `hot_readable_memories`。
- 热路径无 LLM、无图遍历；`recall` 只走 SQLite view + limit，占位后续 hot cache/单路检索。

## 4. 验证结果

```bash
pnpm --filter @myjavis/server typecheck
pnpm --filter @myjavis/server test:storage
pnpm --filter @myjavis/server test:identity
pnpm --filter @myjavis/server test:prompt-injection
pnpm --filter @myjavis/server smoke:memory
pnpm --filter @myjavis/server eval:phase0
```

全部通过。Phase0 样例指标：

```json
{
  "sampleCount": 6,
  "crossAccountRate": 0,
  "oneShotRetentionRate": 1,
  "promptInjectionResistanceRate": 1,
  "correctionRecoveryTimeMs": 0,
  "latencyP95Ms": 0,
  "latencyP99Ms": 0,
  "rememberedCount": 3
}
```

## 5. 留给下一批

- 接真实火山字幕/声纹 payload，补契约回放测试。
- 将 `active_stable` 判定阈值和 `VoicePrint Score` 策略参数化。
- 实现显式记忆触发器、typed lifecycle commit 策略、确认流和高风险实体复述。
- 实现治理入口：查看、忘掉、重归属、暂停、导出。
- 实现真正 hot cache、关键词/结构化检索和 pref_summary 收敛。
- 接入真实 telemetry 汇总，补 p95/p99 延迟统计。
- 暂缓：向量召回、L2 通用三元组、人格 disposition、反思内核、三路并行召回、重型夜间 reconcile。
