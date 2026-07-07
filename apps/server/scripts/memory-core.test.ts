import assert from 'node:assert/strict';
import { tokenizeDoc, tokenizeQuery, warmupTokenizer } from '../src/memory-core/tokenize.js';
import { recencyBoost, scoreDocs } from '../src/memory-core/score.js';
import { mixRecall } from '../src/memory-core/recall-mix.js';
import type { RecallDoc } from '../src/memory-core/types.js';

warmupTokenizer();

const DAY = 24 * 3600_000;
// 固定"现在"：2026-07-07 12:00 UTC
const NOW = Date.UTC(2026, 6, 7, 12, 0, 0);

function doc(id: string, text: string, ageDays: number, confidenceWeight = 1.0): RecallDoc {
  return { id, text, createdAt: NOW - ageDays * DAY, confidenceWeight };
}

// —— tokenize：实词保留 ——
{
  const t = tokenizeDoc('女儿名字 朵朵 我女儿叫朵朵，下个月过五岁生日');
  assert.ok(t.includes('女儿'), '女儿应保留');
  assert.ok(t.includes('朵朵'), '朵朵应保留');
  assert.ok(t.includes('生日'), '生日应保留');
  assert.ok(!t.includes('我'), '代词应过滤');
  assert.ok(!t.includes('的'), '虚词应过滤');
}

// —— tokenize：英文数字整词保留、单字过滤 ——
{
  const t = tokenizeDoc('WiFi密码是 abc123，门牌 502');
  assert.ok(t.includes('abc123') || t.includes('abc') || t.includes('123'), '字母数字应保留');
  assert.ok(t.includes('502'), '数字串应保留');
  assert.ok(t.includes('密码'), '密码应保留');
}

// —— tokenize：纯语气/虚词句 → 空（退化信号的来源） ——
{
  assert.deepEqual(tokenizeQuery('嗯 好的 吧'), [], '纯语气词应为空');
  assert.deepEqual(tokenizeQuery('是吗？'), [], '疑问虚词应为空');
}

// —— tokenize：query 引导词过滤但保留实体 ——
{
  const t = tokenizeQuery('还记得我女儿叫什么名字吗');
  assert.ok(t.includes('女儿'), 'query 应保留"女儿"');
  assert.ok(!t.includes('名字'), '泛指名词应过滤');
}

// —— recencyBoost：半衰期与地板 ——
{
  assert.equal(recencyBoost(NOW, NOW, 30), 1, '当天=1');
  const half = recencyBoost(NOW - 30 * DAY, NOW, 30);
  assert.ok(Math.abs(half - 0.5) < 0.01, `30天≈0.5，实际 ${half}`);
  assert.equal(recencyBoost(NOW - 365 * DAY, NOW, 30), 0.2, '一年前=地板0.2');
}

// —— scoreDocs：IDF 区分度——稀有词得分高于常见词 ——
{
  const docs = [
    doc('a', '女儿 朵朵 生日', 1),
    doc('b', '女儿 上学 接送', 2),
    doc('c', '女儿 兴趣班 钢琴', 3),
    doc('d', '朵朵 五岁', 4),
  ];
  const scored = scoreDocs(['女儿', '朵朵'], docs, { now: NOW, halfLifeDays: 30 });
  const byId = new Map(scored.map((s) => [s.doc.id, s]));
  // "朵朵"(df=2) 比 "女儿"(df=3) 稀有，含朵朵的 a 应高于只含女儿的 b
  assert.ok(byId.get('a')!.keywordScore > byId.get('b')!.keywordScore, '双命中+稀有词应更高');
  assert.ok(byId.get('a')!.matched.includes('朵朵'), 'matched 应含朵朵');
  assert.ok(!byId.has('e'), '不存在的不该出现');
}

// —— scoreDocs：confidenceWeight 生效 ——
{
  const docs = [doc('committed', '朵朵 生日', 1, 1.0), doc('provisional', '朵朵 生日', 1, 0.7)];
  const scored = scoreDocs(['朵朵'], docs, { now: NOW, halfLifeDays: 30 });
  const byId = new Map(scored.map((s) => [s.doc.id, s.salience]));
  assert.ok(byId.get('committed')! > byId.get('provisional')!, 'committed 应压过 provisional');
}

// —— mixRecall：核心对照场景——老记忆被 19 条新闲聊挤出"最近窗"后仍被召回 ——
{
  const docs: RecallDoc[] = [doc('target', '女儿名字 朵朵 我女儿叫朵朵', 21)];
  for (let i = 0; i < 19; i++) docs.push(doc(`chat${i}`, `咖啡偏好 美式不加糖 今天天气聊天记录${i}`, i * 0.1));

  // 旧逻辑（最近 8 条）必挂：target 按时间排第 20，进不了前 8
  const byRecency = [...docs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 8);
  assert.ok(!byRecency.some((d) => d.id === 'target'), '【对照】旧"最近8条"逻辑必不含 target');

  // 新逻辑必过
  const mix = mixRecall('还记得我女儿叫什么名字吗', docs, { now: NOW });
  assert.ok(mix.picked, '应走相关性召回');
  assert.ok(mix.picked!.some((d) => d.id === 'target'), '【核心】新逻辑必须召回 target');
  assert.equal(mix.picked![0].id, 'target', 'target 应排第一（唯一强命中）');
  assert.ok(mix.matchedKeywords.includes('女儿'), 'matchedKeywords 应含女儿');
  assert.ok(mix.picked!.length <= 8, '不超 cap');
}

// —— mixRecall：recency 保底——相关位之外补最近 ——
{
  const docs: RecallDoc[] = [
    doc('rel', '朵朵 幼儿园', 10),
    doc('new1', '晚饭 红烧肉', 0.1),
    doc('new2', '快递 到货', 0.2),
    doc('new3', '天气 下雨', 0.3),
  ];
  const mix = mixRecall('朵朵在哪个幼儿园', docs, { now: NOW });
  assert.ok(mix.picked && mix.picked[0].id === 'rel', '相关位第一');
  assert.equal(mix.relevantCount, 1, '相关位=1');
  const ids = new Set(mix.picked!.map((d) => d.id));
  assert.ok(ids.has('new1') && ids.has('new2') && ids.has('new3'), '最近3条应保底进入');
  // details 可解释明细：与 picked 一一对应、来源正确、相关位带命中词
  assert.equal(mix.details.length, mix.picked!.length, 'details 与 picked 等长');
  assert.deepEqual(mix.details.map((d) => d.id), mix.picked!.map((d) => d.id), 'details 顺序一致');
  assert.equal(mix.details[0].source, 'relevant');
  assert.ok(mix.details[0].matched.includes('朵朵'), '相关位 detail 带命中词');
  assert.ok(mix.details[0].salience > 0);
  assert.equal(mix.details[1].source, 'recent');
  assert.deepEqual(mix.details[1].matched, [], '保底位无命中词');
}

// —— mixRecall：去重——相关位与保底位重叠不重复 ——
{
  const docs: RecallDoc[] = [doc('both', '朵朵 今天 疫苗', 0.1), doc('x', '外卖 备注', 0.2)];
  const mix = mixRecall('朵朵疫苗打了吗', docs, { now: NOW });
  const ids = mix.picked!.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length, '无重复');
}

// —— mixRecall：退化信号——纯语气 query / 零命中 → picked=null ——
{
  const docs = [doc('a', '女儿 朵朵', 1)];
  assert.equal(mixRecall('嗯嗯好的吧', docs, { now: NOW }).picked, null, '无有效token退化');
  assert.equal(mixRecall('股票行情怎么样', docs, { now: NOW }).picked, null, '零命中退化');
  assert.equal(mixRecall('随便聊聊', [], { now: NOW }).picked, null, '空集退化');
}

// —— mixRecall：recency 打破平分——同分时新记忆在前 ——
{
  const docs = [doc('old', '朵朵 身高', 60), doc('new', '朵朵 体重', 1)];
  const mix = mixRecall('朵朵最近怎么样', docs, { now: NOW });
  assert.ok(mix.picked, '应命中');
  assert.equal(mix.picked![0].id, 'new', '同词命中时新记忆 salience 更高');
}

// —— 性能哨兵：2000 条打分 < 150ms（热路径预算） ——
{
  const docs: RecallDoc[] = [];
  for (let i = 0; i < 2000; i++) docs.push(doc(`p${i}`, `记录${i} 内容片段 场景${i % 50} 关键词${i % 100}`, i % 90));
  const t0 = performance.now();
  mixRecall('关键词37的场景记录', docs, { now: NOW });
  const ms = performance.now() - t0;
  assert.ok(ms < 150, `2000条打分应<150ms，实际 ${ms.toFixed(1)}ms`);
  console.log(`[perf] 2000 docs mixRecall: ${ms.toFixed(1)}ms`);
}

console.log('✅ memory-core.test.ts 全部通过');
