# MyJavis 温路径记忆智能 MVP 实施进展

> 更新：2026-06-30 · 分支 `feat/myjavis-memory-mvp`

## 1. 本批完成

- **显式触发器**：新增 `apps/server/src/memory/candidates.ts`，识别“记住 / 以后 / 我喜欢 / 我不喜欢 / 提醒我 / 我的X是Y / 我对X过敏 / 航班会议 / 我住在”等确定性触发；闲聊不进长期记忆。
- **确定性 admit**：新增 `apps/server/src/memory/admission.ts`，按 `salience + novelty + conflict` 产出 `Decision{action,type,confidence,conflicts,rationale}`；LLM 升级保留 stub，默认不参与准入。
- **typed 生命周期**：升级 `apps/server/src/memory/index.ts`，按类型决定状态与 TTL：`event/safety` 一次直通 `committed`，`preference/reminder` 先 `provisional`，`ephemeral_context` 短 TTL。
- **audit 回放**：所有准入/隔离/纠正决策写入 `audit`，rationale 可回放。
- **冲突收敛**：维护 `pref_summary`，同 dimension 活跃条件硬上限 5；热读使用摘要，不扫全量 preference 碎片。
- **显式纠正子集**：支持 `delete/update/reattribute/lower_confidence` 的确定性入口；纠正必须关联 recent memory，跨 owner 拒绝。
- **Phase0 语义评测**：扩充 `apps/server/eval/replay-samples.ndjson`，覆盖一次性事实、闲聊分流、串账隔离、注入隔离、纠正恢复、冲突收敛。

## 2. typed 策略表

| type | 当前实现 |
|---|---|
| `event` | 显著时间事实一次写入 `committed`，带 `validUntil/ttl` 占位 |
| `safety` | 过敏/医疗类一次写入 `committed`，不设置 TTL |
| `profile_fact` | 普通 profile 直写，手机号/地址等高风险先 `provisional` |
| `preference` | 先 `provisional`，重复强化可 promote；写后更新 `pref_summary` |
| `reminder` | 作为 task 层占位写入 `provisional`，完整任务系统后续接 |
| `ephemeral_context` | 仅显式“记住”但无法归类时短 TTL，不让闲聊长期化 |

## 3. 验证结果

```bash
pnpm --filter @myjavis/server typecheck
pnpm --filter @myjavis/server test:candidates
pnpm --filter @myjavis/server test:lifecycle
pnpm --filter @myjavis/server test:conflict
pnpm --filter @myjavis/server test:correction
pnpm --filter @myjavis/server test:storage
pnpm --filter @myjavis/server test:identity
pnpm --filter @myjavis/server test:prompt-injection
pnpm --filter @myjavis/server smoke:memory
pnpm --filter @myjavis/server eval:phase0
```

全部通过。Phase0 语义指标：

```json
{
  "sampleCount": 16,
  "crossAccountRate": 0,
  "oneShotRetentionRate": 1,
  "idleLongTermWriteRate": 0,
  "promptInjectionResistanceRate": 1,
  "ownerIsolationLeakRate": 0,
  "correctionRecoveryTimeMs": 1,
  "correctionSuccessRate": 1,
  "conflictConvergenceRate": 1,
  "latencyP95Ms": 0,
  "latencyP99Ms": 0,
  "rememberedCount": 4
}
```

## 4. 留给下一批

- 接真实火山 speaker payload、字幕 span、ASR confidence/n-best。
- 把“确认后 committed”补成真实确认流，尤其是手机号、地址、健康、金额。
- 接完整 task/reminder 层和 calendar 解析，替换当前 placeholder。
- 做治理 UI：查看、忘掉、重归属、暂停、导出。
- 补关键词检索和 hot cache，继续不做向量/L2/人格/反思，直到指标证明需要。
- 接真实 telemetry p95/p99 汇总；当前 eval 延迟字段仍为脚手架。
