import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MyJavisMemory } from '../src/memory/index.js';
import { VolcIdentityProvider } from '../src/memory/identity/index.js';
import { SQLiteMemoryStorage } from '../src/memory/storage.js';
import { EventLog } from '../src/session/event-log.js';
import { classifyPrivacy } from '../src/memory-core/privacy.js';
import { _resetPrivacyHold, ackPrivacyItems, holdPrivacyItem, listPendingPrivacy } from '../src/privacy/hold-store.js';
import { _resetSessionContext, clearSessionContext, getSessionContextForOwner, setSessionContext } from '../src/privacy/session-context.js';
import type { MemoryItem } from '../src/memory/types.js';

// —— classifyPrivacy：type 锚点 ——
assert.equal(classifyPrivacy({ type: 'safety', key: 'safety.allergy', value: '青霉素' }).isPrivate, true);
assert.equal(classifyPrivacy({ type: 'safety', key: 'safety.allergy', value: '青霉素' }).reason, 'type');
assert.equal(classifyPrivacy({ type: 'location', key: 'x', value: 'y' }).isPrivate, true);
assert.equal(classifyPrivacy({ type: 'relationship', key: 'x', value: 'y' }).isPrivate, true);

// —— key 锚点 ——
{
  const r = classifyPrivacy({ type: 'profile_fact', key: 'profile.address', value: '上海静安区' });
  assert.equal(r.isPrivate, true);
  assert.equal(r.reason, 'key');
  assert.equal(classifyPrivacy({ type: 'profile_fact', key: 'profile.phone', value: '138xxx' }).isPrivate, true);
  // profile.name 刻意不私有（称呼一致性）
  assert.equal(classifyPrivacy({ type: 'profile_fact', key: 'profile.name', value: '老陈' }).isPrivate, false);
}

// —— 词表兜底 ——
{
  const r = classifyPrivacy({ type: 'event', key: 'event.med', value: '下周复查', sourceSpan: '下周去医院复查记得提醒' });
  assert.equal(r.isPrivate, true);
  assert.equal(r.reason, 'keyword');
  assert.equal(classifyPrivacy({ type: 'preference', key: 'preference.drink', value: '冰美式' }).isPrivate, false, '普通偏好不误伤');
  assert.equal(classifyPrivacy({ type: 'event', key: 'event.flight', value: '明早六点航班' }).isPrivate, false, '普通行程不误伤');
}

// —— hold-store：hold/pending/ack/cap ——
{
  _resetPrivacyHold();
  const mk = (id: string): MemoryItem => ({
    id, ownerId: 'o1', namespace: 'private:o1', type: 'safety',
    content: { kind: 'safety', key: 'safety.allergy', value: 'x', source: 'user_said' },
    sourceRole: 'user', sourceSpan: '', confidence: 1, status: 'committed', createdAt: Date.now(),
    provenance: {}, acl: {},
  });
  holdPrivacyItem('tn1', mk('m1'), { isPrivate: true, reason: 'type', hit: 'safety' });
  holdPrivacyItem('tn1', mk('m2'), { isPrivate: true, reason: 'type', hit: 'safety' });
  holdPrivacyItem('tn2', mk('m3'), { isPrivate: true, reason: 'type', hit: 'safety' });
  assert.equal(listPendingPrivacy('tn1').length, 2, '按租户分桶');
  assert.equal(listPendingPrivacy('tn2').length, 1);
  assert.equal(listPendingPrivacy('tn1').length, 2, '拉取不删除');
  assert.equal(ackPrivacyItems('tn1', ['m1']), 1, 'ack 焚 1 条');
  assert.equal(listPendingPrivacy('tn1').length, 1);
  assert.equal(ackPrivacyItems('tn1', ['m1']), 0, '重复 ack 幂等');
  // cap 淘汰最旧
  _resetPrivacyHold();
  for (let i = 0; i < 205; i++) holdPrivacyItem('tn1', mk(`c${i}`), { isPrivate: true });
  const pending = listPendingPrivacy('tn1');
  assert.equal(pending.length, 200, 'cap=200');
  assert.equal(pending[0]!.item.id, 'c5', '最旧的 5 条被淘汰');
}

// —— session-context：owner 过滤（分人红线）/replace/clear ——
{
  _resetSessionContext();
  setSessionContext('tn1', 'room1', [
    { id: 'v1', ownerId: 'ownerA', text: '女儿 朵朵 疫苗', type: 'relationship', createdAt: 1 },
    { id: 'v2', ownerId: 'ownerB', text: '工资 保密', type: 'profile_fact', createdAt: 2 },
  ]);
  assert.equal(getSessionContextForOwner('room1', 'ownerA').length, 1, 'ownerA 只见自己的');
  assert.equal(getSessionContextForOwner('room1', 'ownerA')[0]!.id, 'v1');
  assert.equal(getSessionContextForOwner('room1', 'ownerB').length, 1);
  assert.equal(getSessionContextForOwner('room1', 'ownerC').length, 0, '陌生 owner 零可见');
  assert.equal(getSessionContextForOwner('room-none', 'ownerA').length, 0);
  setSessionContext('tn1', 'room1', [{ id: 'v3', ownerId: 'ownerA', text: 'x', type: 'safety', createdAt: 3 }]);
  assert.equal(getSessionContextForOwner('room1', 'ownerA').length, 1, '整房间替换语义');
  assert.equal(getSessionContextForOwner('room1', 'ownerA')[0]!.id, 'v3');
  assert.equal(clearSessionContext('tn-wrong', 'room1'), false, '跨租户不可清');
  assert.equal(clearSessionContext('tn1', 'room1'), true);
  assert.equal(getSessionContextForOwner('room1', 'ownerA').length, 0);
}

// —— remember 集成：隐私句零落盘 + event 脱敏 + hold + 审计无内容 ——
{
  _resetPrivacyHold();
  const storage = new SQLiteMemoryStorage(join(mkdtempSync(join(tmpdir(), 'myjavis-priv-')), 'memory.db'));
  const memory = new MyJavisMemory(storage, new EventLog(storage));
  const identity = new VolcIdentityProvider(storage);
  const resolved = identity.resolve({ roomId: 'privroom', voiceprintId: 'vp_priv', score: 0.95 });
  const ownerId = resolved.ownerId!;

  const result = await memory.remember({
    roomId: 'privroom',
    ownerId,
    tenantId: 'tn-priv',
    identity: resolved,
    utterance: '我对青霉素过敏',
    sourceRole: 'user',
    isFinal: true,
  });
  assert.equal(result.status, 'privacy_routed');

  // 云端零持久化：memory_item 无 safety 行
  const items = storage.listOwnerMemories(ownerId, 50);
  assert.ok(!items.some((item) => item.type === 'safety'), 'memory_item 不得有 safety 行');
  // event_log 原话已脱敏
  const event = storage.getEvent(result.eventId)!;
  assert.ok(!event.utteranceText.includes('青霉素'), `event 原话须脱敏，实际: ${event.utteranceText}`);
  assert.ok(event.utteranceText.includes('隐私路由'), '脱敏占位标记');
  // hold 队列有完整条目
  const pending = listPendingPrivacy('tn-priv');
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.item.content.value, '青霉素');
  assert.equal(pending[0]!.item.type, 'safety');

  // 无 tenant → 丢弃（宁丢勿泄），同样零落盘+脱敏
  const r2 = await memory.remember({
    roomId: 'privroom', ownerId, identity: resolved,
    utterance: '我对花粉过敏', sourceRole: 'user', isFinal: true,
  });
  assert.equal(r2.status, 'privacy_routed');
  assert.equal(r2.reason, 'privacy_dropped_no_tenant');
  assert.ok(!storage.listOwnerMemories(ownerId, 50).some((item) => item.type === 'safety'));

  // 普通记忆不受影响（照常落库）
  const r3 = await memory.remember({
    roomId: 'privroom', ownerId, tenantId: 'tn-priv', identity: resolved,
    utterance: '记住我喜欢冰美式', sourceRole: 'user', isFinal: true,
  });
  assert.ok(r3.status === 'stored' || r3.status === 'updated', `普通偏好照常: ${r3.status}`);

  // recall 合并 session-context：隐私记忆经上行内存注入且分人隔离
  _resetSessionContext();
  setSessionContext('tn-priv', 'privroom', [
    { id: 'vault-1', ownerId, text: '安全 过敏 青霉素 我对青霉素过敏', type: 'safety', createdAt: Date.now() },
    { id: 'vault-other', ownerId: 'owner_stranger', text: '别人 过敏 芒果', type: 'safety', createdAt: Date.now() },
  ]);
  const recall = await memory.recall({ ownerId, roomId: 'privroom', query: '我对什么过敏来着', limit: 8 });
  assert.ok(recall.memories.some((m) => m.id === 'vault-1'), 'vault 记忆经 session-context 注入');
  assert.ok(!recall.memories.some((m) => m.id === 'vault-other'), '他人 vault 记忆绝不可见');
  assert.ok(recall.matchedKeywords?.includes('过敏'));
  // 房间清理后即弃
  clearSessionContext('tn-priv', 'privroom');
  const recall2 = await memory.recall({ ownerId, roomId: 'privroom', query: '我对什么过敏来着', limit: 8 });
  assert.ok(!recall2.memories.some((m) => m.id === 'vault-1'), '清理后不再注入');

  // 审计不含内容：全表任何 audit 行都不得出现"青霉素/花粉"
  const db = storage as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } };
  const auditRows = db.db.prepare('SELECT * FROM audit').all() as Array<Record<string, unknown>>;
  const auditBlob = JSON.stringify(auditRows);
  assert.ok(!auditBlob.includes('青霉素') && !auditBlob.includes('花粉'), '审计零内容残留');

  storage.close();
}

console.log('✅ privacy.test.ts 全部通过（零落盘/脱敏/分人红线/hold-ack 全断言）');
