import assert from 'node:assert/strict';
import { cnNumber, formatDue, parseDateOnly, parseTimeExpr, parseTimeWithDateOffset } from '../src/reminder/time-parse.js';
import { detectReminderIntent } from '../src/reminder/intent.js';
import { ReminderStore } from '../src/reminder/store.js';

// 固定"现在"：2026-07-07 周二 10:00:00 本地时区
const NOW = new Date(2026, 6, 7, 10, 0, 0, 0);
const H = 3600_000;
const M = 60_000;

// —— cnNumber ——
assert.equal(cnNumber('三'), 3);
assert.equal(cnNumber('两'), 2);
assert.equal(cnNumber('十'), 10);
assert.equal(cnNumber('十五'), 15);
assert.equal(cnNumber('二十'), 20);
assert.equal(cnNumber('二十一'), 21);
assert.equal(cnNumber('45'), 45);
assert.equal(cnNumber('随便'), null);

// —— 相对时长 ——
let p = parseTimeExpr('10分钟后提醒我', NOW);
assert.ok(p && p.dueAt === NOW.getTime() + 10 * M, '10分钟后');
p = parseTimeExpr('提醒我三分钟后关火', NOW);
assert.ok(p && p.dueAt === NOW.getTime() + 3 * M, '三分钟后');
p = parseTimeExpr('半小时后提醒我', NOW);
assert.ok(p && p.dueAt === NOW.getTime() + 30 * M, '半小时后');
p = parseTimeExpr('一个半小时后提醒我', NOW);
assert.ok(p && p.dueAt === NOW.getTime() + 90 * M, '一个半小时后');
p = parseTimeExpr('两小时后提醒我', NOW);
assert.ok(p && p.dueAt === NOW.getTime() + 2 * H, '两小时后');
p = parseTimeExpr('30秒后提醒我', NOW);
assert.ok(p && p.dueAt === NOW.getTime() + 30_000, '30秒后');
assert.equal(parseTimeExpr('半秒后提醒我', NOW), null, '过短拒绝');

// —— 绝对时刻 ——
p = parseTimeExpr('下午三点提醒我开会', NOW);
assert.ok(p, '下午三点解析');
assert.equal(new Date(p!.dueAt).getHours(), 15);
assert.equal(p!.display, '今天 15:00');
p = parseTimeExpr('晚上8点半提醒我', NOW);
assert.equal(new Date(p!.dueAt).getHours(), 20);
assert.equal(new Date(p!.dueAt).getMinutes(), 30);
p = parseTimeExpr('明天早上八点提醒我晨跑', NOW);
assert.equal(p!.display, '明天 08:00');
p = parseTimeExpr('明天15:30提醒我', NOW);
assert.equal(p!.display, '明天 15:30');
p = parseTimeExpr('中午12点提醒我吃饭', NOW);
assert.equal(new Date(p!.dueAt).getHours(), 12);
p = parseTimeExpr('凌晨2点提醒我', NOW);
assert.equal(new Date(p!.dueAt).getHours(), 2); // 今天2点已过 → 明天2点
assert.equal(new Date(p!.dueAt).getDate(), 8);
p = parseTimeExpr('三点一刻提醒我', NOW);
assert.equal(new Date(p!.dueAt).getMinutes(), 15);
// 无段位"最近未来"：现在10点，"3点"→今天15点（10<15 via +12h）
p = parseTimeExpr('3点提醒我取快递', NOW);
assert.equal(new Date(p!.dueAt).getHours(), 15);
assert.equal(new Date(p!.dueAt).getDate(), 7);
// "11点"→今天11点（未过）
p = parseTimeExpr('11点提醒我', NOW);
assert.equal(new Date(p!.dueAt).getHours(), 11);
assert.equal(new Date(p!.dueAt).getDate(), 7);
// "9点"→9<10 已过 → +12 → 今天21点
p = parseTimeExpr('9点提醒我', NOW);
assert.equal(new Date(p!.dueAt).getHours(), 21);
// 带段位已过 → 明天："早上8点"（现在10点）
p = parseTimeExpr('早上8点提醒我', NOW);
assert.equal(new Date(p!.dueAt).getHours(), 8);
assert.equal(new Date(p!.dueAt).getDate(), 8);
// 显式"今天"已过 → null（交反问）
assert.equal(parseTimeExpr('今天早上8点提醒我', NOW), null);
// 今晚→晚上语义
p = parseTimeExpr('今晚8点提醒我', NOW);
assert.equal(new Date(p!.dueAt).getHours(), 20);
assert.equal(new Date(p!.dueAt).getDate(), 7);
// 解析不出
assert.equal(parseTimeExpr('提醒我买牛奶', NOW), null);

// —— partial 日期 ——
let d = parseDateOnly('明天提醒我交报告');
assert.equal(d?.dateOffset, 1);
assert.equal(parseDateOnly('明天早上八点提醒我'), null, '有完整时刻不算 partial');
assert.equal(parseDateOnly('提醒我开会'), null);

// —— dateOffset 继承（反问"几点"后答"早上八点"，继承"明天"） ——
p = parseTimeWithDateOffset('早上八点', 1, NOW);
assert.equal(p!.display, '明天 08:00');
p = parseTimeWithDateOffset('后天早上八点', 1, NOW); // 回答自带日期 → 以回答为准
assert.equal(new Date(p!.dueAt).getDate(), 9);

// —— formatDue ——
assert.equal(formatDue(NOW.getTime() + 2 * H, NOW), '今天 12:00');
assert.equal(formatDue(NOW.getTime() + 26 * H, NOW), '明天 12:00');
assert.equal(formatDue(new Date(2026, 6, 15, 9, 30).getTime(), NOW), '7月15日 09:30');

// —— 意图：SET 命中 ——
let it = detectReminderIntent('提醒我下午三点开会');
assert.equal(it?.kind, 'set');
assert.ok((it as { time: unknown }).time, 'set 带时间');
assert.equal((it as { content: string }).content, '开会');
it = detectReminderIntent('下午三点提醒我开会');
assert.equal(it?.kind, 'set');
assert.equal((it as { content: string }).content, '开会');
it = detectReminderIntent('帮我提醒一下我十分钟后关火');
assert.equal(it?.kind, 'set');
it = detectReminderIntent('提醒我买牛奶'); // 无时间 → set + time=null（走反问）
assert.equal(it?.kind, 'set');
assert.equal((it as { time: unknown }).time, null);
assert.equal((it as { content: string }).content, '买牛奶');
it = detectReminderIntent('明天提醒我交报告'); // partial 日期
assert.equal(it?.kind, 'set');
assert.equal((it as { dateOffset: number | null }).dateOffset, 1);
assert.equal((it as { content: string }).content, '交报告');

// —— 意图：反例（宁漏勿误） ——
assert.equal(detectReminderIntent('我妈提醒我要吃饭'), null, '叙述句不命中');
assert.equal(detectReminderIntent('你能提醒我吗'), null, '疑问句不命中');
assert.equal(detectReminderIntent('他上次提醒我的那件事挺重要'), null);
assert.equal(detectReminderIntent('今天天气不错'), null);

// —— 意图：取消/查询 ——
assert.equal(detectReminderIntent('取消刚才的提醒')?.kind, 'cancel');
assert.equal(detectReminderIntent('别提醒我了')?.kind, 'cancel');
assert.equal(detectReminderIntent('我有什么提醒')?.kind, 'query');
assert.equal(detectReminderIntent('看看提醒')?.kind, 'query');

// —— store 状态机（内存库） ——
const store = new ReminderStore(':memory:');
const r1 = store.create({ tenantId: 'tn_a', content: '开会', dueAt: NOW.getTime() + M, speakerName: '川哥' });
assert.equal(r1.status, 'pending');
// 未到期不触发
assert.equal(store.duePending(NOW.getTime()).length, 0);
// 到期触发
assert.equal(store.duePending(NOW.getTime() + 2 * M).length, 1);
store.markFired(r1.id);
assert.equal(store.get(r1.id)!.status, 'fired');
assert.equal(store.firedForTenant('tn_a').length, 1);
assert.equal(store.firedForTenant('tn_b').length, 0, '租户隔离');
// ack → delivered
assert.equal(store.markDelivered(r1.id, 'app'), true);
assert.equal(store.get(r1.id)!.status, 'delivered');
assert.equal(store.markDelivered(r1.id, 'app'), false, '幂等：已 delivered 不重复转');
// fired 超时 → missed（fired_at 是 store 内部真实 Date.now()，超时基准也用真实时钟）
const r2 = store.create({ tenantId: 'tn_a', content: '吃药', dueAt: NOW.getTime() });
store.markFired(r2.id);
const expired = store.expireFired(30 * M, Date.now() + 31 * M);
assert.equal(expired >= 1, true);
assert.equal(store.get(r2.id)!.status, 'missed');
assert.equal(store.missedForTenant('tn_a').length, 1);
store.markDelivered(r2.id, 'makeup');
assert.equal(store.missedForTenant('tn_a').length, 0, '补报后消耗');
// cancelLatest
const r3 = store.create({ tenantId: 'tn_a', content: '交报告', dueAt: NOW.getTime() + H });
const cancelled = store.cancelLatest('tn_a');
assert.equal(cancelled?.id, r3.id);
assert.equal(store.get(r3.id)!.status, 'cancelled');
assert.equal(store.cancelLatest('tn_b'), undefined);

console.log('reminder.test ok');
