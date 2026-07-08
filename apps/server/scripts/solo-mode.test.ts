/**
 * R3.5 单人模式 + 引导闭环 + 对话历史迁移单测。
 * 跑法：npm run test:solo-mode
 */
process.env.MYJAVIS_MEMORY_DB = ':memory:'; // 必须在 import registry（→ memory storage 单例）之前

import assert from 'node:assert/strict';

const { memory, identity, eventLog, storage } = await import('../src/memory/index.js');
const { createTenant, updateTenantConfig } = await import('../src/tenant/registry.js');
const { tenantOwnsOwner, tenantForOwner, soloOwnerId } = await import('../src/voiceprint/registry.js');
const { listActivity, _resetActivity } = await import('../src/activity/feed.js');
const { markPendingGuidance, consumePendingGuidance, _resetGuidanceState, shouldGuideVoiceprintRegistration } =
  await import('../src/memory/guidance.js');

// ---------- solo owner 解析对照（§2.1 语义） ----------
{
  const tenant = createTenant('solo租户');
  assert.equal(tenant.soloMode, true, '新租户默认 solo=true');
  const owner = soloOwnerId(tenant.id);

  // solo=true：无论声纹识别与否，effectiveOwnerId=owner_tenant_<id>，soloStable=true → 落 committed（非 quarantine）
  const unverified = identity.resolve({ roomId: 'solo-room', voiceprintId: undefined });
  assert.equal(unverified.state, 'unverified');
  const soloResult = await memory.remember({
    roomId: 'solo-room',
    tenantId: tenant.id,
    ownerId: owner,
    identity: unverified,
    soloStable: true,
    utterance: '我喜欢喝乌龙茶',
    sourceRole: 'user',
    isFinal: true,
  });
  assert.equal(soloResult.status, 'stored', `solo 模式声纹未识别也应正常落库，实际 ${JSON.stringify(soloResult)}`);
  const stored = storage.getMemoryItem(soloResult.memoryId!);
  assert.equal(stored?.ownerId, owner);
  assert.notEqual(stored?.status, 'quarantine');

  // 对照：soloMode=false 完全等于现行为——同样未识别 → quarantine
  const familyTenant = createTenant('家庭租户');
  const setFamily = updateTenantConfig(familyTenant.id, { soloMode: false });
  assert.equal(setFamily?.soloMode, false);
  const familyUnverified = identity.resolve({ roomId: 'family-room', voiceprintId: undefined });
  const familyResult = await memory.remember({
    roomId: 'family-room',
    tenantId: familyTenant.id,
    ownerId: familyUnverified.ownerId,
    identity: familyUnverified,
    soloStable: false,
    utterance: '我喜欢喝乌龙茶',
    sourceRole: 'user',
    isFinal: true,
  });
  assert.equal(familyResult.status, 'quarantined', 'solo=false 声纹未识别应走原 quarantine 行为');
}
console.log('solo-owner-resolution.test ✅');

// ---------- tenantOwnsOwner 认默认 owner；tenantForOwner 反解 ----------
{
  const tenant = createTenant('归属校验租户');
  const owner = soloOwnerId(tenant.id);
  assert.equal(tenantOwnsOwner(tenant.id, owner), true, '默认 owner 应被本租户认领');
  assert.equal(tenantOwnsOwner('tn_other', owner), false, '默认 owner 不应被其他租户认领');
  assert.equal(tenantForOwner(owner), tenant.id, 'tenantForOwner 应反解出正确租户');
  assert.equal(tenantForOwner('owner_不存在'), undefined);
}
console.log('tenant-owns-owner.test ✅');

// ---------- 引导标记：unverified+有候选 → 房间标记置位 & 5 分钟幂等；solo=true 时绝不置位 ----------
{
  assert.equal(shouldGuideVoiceprintRegistration(true, 'unverified', 1), false, 'solo=true 时绝不触发引导判定');
  assert.equal(shouldGuideVoiceprintRegistration(false, 'active_stable', 1), false, '身份已稳定不触发');
  assert.equal(shouldGuideVoiceprintRegistration(false, 'unverified', 0), false, '无记忆候选不触发');
  assert.equal(shouldGuideVoiceprintRegistration(undefined, 'unverified', 1), false, '无租户上下文不触发');
  assert.equal(shouldGuideVoiceprintRegistration(false, 'unverified', 1), true, '家庭模式+未识别+有候选→触发');

  _resetGuidanceState();
  const room = 'room-guidance-test';
  const t0 = 1_000_000;
  assert.equal(consumePendingGuidance(room, t0), false, '未标记前不应消费到提醒');
  markPendingGuidance(room, t0);
  assert.equal(consumePendingGuidance(room, t0 + 1_000), true, '标记后下一轮应消费到提醒');
  assert.equal(consumePendingGuidance(room, t0 + 2_000), false, '一次性消费，不应重复');

  markPendingGuidance(room, t0 + 3_000); // 冷却窗口内再次 quarantine：不应重新标记
  assert.equal(consumePendingGuidance(room, t0 + 4_000), false, '5 分钟冷却期内不应重复提醒');

  markPendingGuidance(room, t0 + 5 * 60_000 + 1_000); // 冷却期已过：应可重新标记
  assert.equal(consumePendingGuidance(room, t0 + 5 * 60_000 + 2_000), true, '冷却期过后应能重新提醒');
}
console.log('guidance-marker.test ✅');

// ---------- solo 0 声纹引导（2026-07-08 川哥拍板）：solo=true+声纹0 → 每租户 24h 一次口头引导 ----------
{
  const { shouldGuideSoloVoiceprintOnboarding, markSoloGuidanceSent } = await import('../src/memory/guidance.js');
  _resetGuidanceState();
  const tn = 'tn_solo_guidance_test';
  const t0 = 2_000_000;

  assert.equal(shouldGuideSoloVoiceprintOnboarding(true, 0, tn, t0), true, 'solo+0声纹+首次→引导');
  assert.equal(shouldGuideSoloVoiceprintOnboarding(true, 1, tn, t0), false, '已有声纹不引导');
  assert.equal(shouldGuideSoloVoiceprintOnboarding(false, 0, tn, t0), false, '家庭模式走 quarantine 引导，不走此分支');
  assert.equal(shouldGuideSoloVoiceprintOnboarding(undefined, 0, tn, t0), false, '无租户配置不引导');
  assert.equal(shouldGuideSoloVoiceprintOnboarding(true, 0, undefined, t0), false, '无 tenantId 不引导');

  // 判定本身不落账（interim 弃用轮不消耗配额）：连续判定仍为 true
  assert.equal(shouldGuideSoloVoiceprintOnboarding(true, 0, tn, t0 + 1_000), true, '未落账前重复判定仍触发');
  markSoloGuidanceSent(tn, t0 + 1_000); // 流正常完成（onDone 未弃播）才落账
  assert.equal(shouldGuideSoloVoiceprintOnboarding(true, 0, tn, t0 + 2_000), false, '落账后 24h 冷却内不重复');
  assert.equal(
    shouldGuideSoloVoiceprintOnboarding(true, 0, tn, t0 + 24 * 3600_000 + 1_000),
    true,
    '24h 冷却过后声纹仍为 0 → 再次引导',
  );
  assert.equal(shouldGuideSoloVoiceprintOnboarding(true, 0, 'tn_other_tenant', t0 + 2_000), true, '冷却按租户隔离');

  _resetGuidanceState();
  assert.equal(shouldGuideSoloVoiceprintOnboarding(true, 0, tn, t0 + 2_000), true, 'reset 后重新可引导');
}
console.log('solo-guidance.test ✅');

// ---------- 活动流 quarantine 事件零内容断言 ----------
{
  _resetActivity();
  const tenantId = 'tn_quarantine_activity_test';
  // 用非隐私候选（preference，非 safety/location/relationship）——確保走纯 quarantine 分支
  // 而非 privacy_routed（隐私路由零内容已由 privacy.test.ts 覆盖，这里只验 quarantine 事件本身）。
  const plainText = '我喜欢喝拿铁';
  const unverified = identity.resolve({ roomId: 'r-quarantine-activity', voiceprintId: undefined });
  const result = await memory.remember({
    roomId: 'r-quarantine-activity',
    tenantId,
    ownerId: unverified.ownerId,
    identity: unverified,
    utterance: plainText,
    sourceRole: 'user',
    isFinal: true,
  });
  assert.equal(result.status, 'quarantined');
  const events = listActivity(tenantId);
  const quarantineEvent = events.find((e) => e.kind === 'quarantine');
  assert.ok(quarantineEvent, '应产生 quarantine 活动事件');
  const blob = JSON.stringify(quarantineEvent);
  assert.equal(blob.includes('拿铁'), false, '活动事件不得包含原话内容');
  assert.equal(blob.includes('喝'), false, '活动事件不得包含原话内容');
}
console.log('quarantine-activity-zero-content.test ✅');

// ---------- event_log tenant_id 迁移幂等 + appendUtterance 带租户落列 ----------
{
  storage.migrate();
  storage.migrate(); // 重复 migrate 不炸（ensureEventLogTenantColumn 的 duplicate column 容错）

  const ev = eventLog.appendUtterance({
    roomId: 'r-tenant-evt',
    tenantId: 'tn_evt_test',
    isFinal: true,
    sourceRole: 'user',
    utteranceText: '测试对话历史迁移',
  });
  const fetched = storage.getEvent(ev.id);
  assert.equal(fetched?.tenantId, 'tn_evt_test');

  const listed = storage.listEventsByTenant('tn_evt_test', 10);
  assert.ok(listed.some((e) => e.id === ev.id), '按租户查询应包含刚写入的事件');

  // 老行（无 tenantId）不应出现在按租户查询结果里
  const legacyEvent = eventLog.appendUtterance({
    roomId: 'r-legacy',
    isFinal: true,
    sourceRole: 'user',
    utteranceText: '升级前的老对话',
  });
  assert.equal(storage.getEvent(legacyEvent.id)?.tenantId, undefined);
  assert.equal(
    storage.listEventsByTenant('tn_evt_test', 50).some((e) => e.id === legacyEvent.id),
    false,
    '老行不应出现在任何租户的对话历史里',
  );
}
console.log('event-log-tenant-migration.test ✅');

storage.close();
console.log('solo-mode.test ✅ 全部通过');
