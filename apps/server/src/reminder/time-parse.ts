/**
 * 确定性中文时间表达解析（reminder v1 核心，设计红线：不让 LLM 猜时间）。
 *
 * 支持面刻意窄而准（ROADMAP §2.4）：相对时长（N秒/分钟/小时后、半小时、一个半小时）、
 * 今天/明天/后天/大后天 + 段位词（早上/上午/中午/下午/傍晚/晚上/夜里/凌晨）+ N点(半/一刻/三刻/N分)、
 * HH:MM 直写。周N/具体日期 v1 不做——解析不出交给对话反问兜底，复述确认永远是最后防线。
 *
 * 时区：全部按 server 本地时区（生产 HK ECS = UTC+8，与用户一致）。
 */

export interface ParsedTime {
  dueAt: number; // epoch ms
  /** 复述用的人话（"今天 15:00" / "明天 08:30"），日期跨天时带月日。 */
  display: string;
  /** 命中的原文片段（从句子里剥内容用）。 */
  matched: string;
}

/** 有日期没时刻（"明天提醒我交报告"）：返回 dateOffset 供反问后继承。 */
export interface PartialDate {
  dateOffset: number; // 0=今天 1=明天 2=后天 3=大后天
  matched: string;
}

const CN_NUM: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** 中文数字 → 整数（支持 一~五十九：十五/二十/二十一/两……）；解析不出返回 null。 */
export function cnNumber(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (s.length === 1) return CN_NUM[s] ?? null;
  // X十Y / 十Y / X十
  const m = /^([一二两三四五]?)十([一二三四五六七八九]?)$/.exec(s);
  if (m) {
    const tens = m[1] ? CN_NUM[m[1]]! : 1;
    const ones = m[2] ? CN_NUM[m[2]]! : 0;
    return tens * 10 + ones;
  }
  return null;
}

const NUM_PART = '(?:\\d{1,2}|[一二两三四五六七八九十]{1,3})';

// —— 相对时长：「N秒/分钟/小时后」「半小时后」「一个半小时后」「N分半后」 ——
const REL_RE = new RegExp(
  `(?:过)?(半|${NUM_PART})\\s*个?\\s*(半)?\\s*(秒钟?|分钟|分|小时|钟头)(半)?[之以]?后`,
);

// —— 绝对时刻：[日期][段位] N点[分] 或 [日期][段位] HH:MM ——
const DATE_PART = '(今天|今晚|明天|明晚|后天|大后天)?';
const PERIOD_PART = '(早上|早晨|上午|中午|下午|傍晚|晚上|夜里|半夜|凌晨)?';
const ABS_RE = new RegExp(
  `${DATE_PART}\\s*${PERIOD_PART}\\s*(?:(${NUM_PART})\\s*[点时]\\s*(半|一刻|三刻|${NUM_PART}分?)?|(\\d{1,2}):(\\d{2}))`,
);
// 纯日期（无时刻）：单独匹配用于 partial（"明天提醒我交报告"）
const DATE_ONLY_RE = /(明天|明晚|今晚|后天|大后天)/;

const PERIOD_DEFAULT_HOUR: Record<string, number> = {
  早上: 8, 早晨: 8, 上午: 10, 中午: 12, 下午: 15, 傍晚: 18, 晚上: 20, 夜里: 22, 半夜: 23, 凌晨: 6,
};

function dateOffsetOf(word: string | undefined): number {
  if (!word) return 0;
  if (word === '明天' || word === '明晚') return 1;
  if (word === '后天') return 2;
  if (word === '大后天') return 3;
  return 0; // 今天/今晚
}

/** 段位词把 1-12 的钟点归一到 24h：下午3→15、晚上8→20、中午12→12、凌晨2→2。 */
function applyPeriod(hour: number, period: string | undefined, dateWord: string | undefined): number {
  const p = period ?? (dateWord === '今晚' || dateWord === '明晚' ? '晚上' : undefined);
  if (!p) return hour;
  if (p === '凌晨' || p === '早上' || p === '早晨' || p === '上午') return hour === 12 ? 0 : hour;
  if (p === '中午') return hour <= 2 ? hour + 12 : hour; // 中午12点/中午1点=13
  // 下午/傍晚/晚上/夜里/半夜：1-11 点 +12
  return hour >= 1 && hour <= 11 ? hour + 12 : hour;
}

function fmt(due: Date, now: Date): string {
  const hh = String(due.getHours()).padStart(2, '0');
  const mm = String(due.getMinutes()).padStart(2, '0');
  const sameDay = due.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime() + 86400_000).toDateString() === due.toDateString();
  if (sameDay) return `今天 ${hh}:${mm}`;
  if (tomorrow) return `明天 ${hh}:${mm}`;
  return `${due.getMonth() + 1}月${due.getDate()}日 ${hh}:${mm}`;
}

/** dueAt(ms) → 复述/播报用人话（"今天 15:00"）。 */
export function formatDue(dueAtMs: number, now: Date = new Date()): string {
  return fmt(new Date(dueAtMs), now);
}

/**
 * 解析句中的时间表达。规则要点：
 * - 相对时长直接偏移；
 * - 绝对时刻无日期词且 ≤12 点：取"最近的未来"（今天该点 → 今天+12h → 明天该点）；
 * - 有日期词但时刻已过（"今天3点"现在4点）：如实返回过去?否——今天已过视为无效→返回 null 交反问
 *   （用户口误概率高于真想设过去，反问最稳）；明天/后天不存在已过问题。
 */
export function parseTimeExpr(text: string, now: Date = new Date()): ParsedTime | null {
  const rel = REL_RE.exec(text);
  if (rel) {
    const [matched, numRaw, halfAfterNum, unit, halfAfterUnit] = rel;
    let amount: number;
    if (numRaw === '半') {
      amount = 0.5;
    } else {
      const n = cnNumber(numRaw!);
      if (n === null || n <= 0) return null;
      amount = n + (halfAfterNum || halfAfterUnit ? 0.5 : 0);
    }
    const unitMs = unit!.startsWith('秒') ? 1000 : unit === '小时' || unit === '钟头' ? 3600_000 : 60_000;
    // "半秒后"这类无意义组合拒掉；相对时长上限 7 天防误解析
    const ms = Math.round(amount * unitMs);
    if (ms < 5_000 || ms > 7 * 86400_000) return null;
    const due = new Date(now.getTime() + ms);
    return { dueAt: due.getTime(), display: fmt(due, now), matched: matched!.trim() };
  }

  const abs = ABS_RE.exec(text);
  if (abs) {
    const [matched, dateWord, period, hourRaw, minuteRaw, hhDigit, mmDigit] = abs;
    let hour: number;
    let minute = 0;
    if (hhDigit != null) {
      hour = Number(hhDigit);
      minute = Number(mmDigit);
      if (hour > 23 || minute > 59) return null;
      hour = applyPeriod(hour, period, dateWord);
    } else {
      const h = cnNumber(hourRaw!);
      if (h === null || h < 0 || h > 23) return null;
      if (minuteRaw === '半') minute = 30;
      else if (minuteRaw === '一刻') minute = 15;
      else if (minuteRaw === '三刻') minute = 45;
      else if (minuteRaw) {
        const m = cnNumber(minuteRaw.replace(/分$/, ''));
        if (m === null || m > 59) return null;
        minute = m;
      }
      hour = applyPeriod(h, period, dateWord);
    }
    if (hour > 23) return null;

    const offset = dateOffsetOf(dateWord);
    const base = new Date(now);
    base.setHours(hour, minute, 0, 0);
    let due = new Date(base.getTime() + offset * 86400_000);

    if (!dateWord && !period && due.getTime() <= now.getTime() && hour >= 1 && hour <= 12) {
      // 无日期无段位的 1-12 点："最近的未来"——先试 +12h，再试明天
      const plus12 = new Date(due.getTime() + 12 * 3600_000);
      due = plus12.getTime() > now.getTime() ? plus12 : new Date(due.getTime() + 86400_000);
    } else if (!dateWord && due.getTime() <= now.getTime()) {
      // 带段位但今天已过（"晚上8点"现在9点）→ 明天
      due = new Date(due.getTime() + 86400_000);
    } else if (dateWord && offset === 0 && due.getTime() <= now.getTime()) {
      return null; // 显式说"今天X点"却已过 → 交反问
    }
    return { dueAt: due.getTime(), display: fmt(due, now), matched: matched!.trim() };
  }

  return null;
}

/** 只说了日期没说时刻（"明天提醒我交报告"）。今天不算 partial（等同没说）。 */
export function parseDateOnly(text: string): PartialDate | null {
  if (ABS_RE.test(text) || REL_RE.test(text)) return null; // 有完整时刻就不是 partial
  const m = DATE_ONLY_RE.exec(text);
  if (!m) return null;
  return { dateOffset: dateOffsetOf(m[1]), matched: m[1]! };
}

/** 反问"几点"后的回答：无日期上下文继承 pending 的 dateOffset。 */
export function parseTimeWithDateOffset(text: string, dateOffset: number, now: Date = new Date()): ParsedTime | null {
  const parsed = parseTimeExpr(text, now);
  if (!parsed) return null;
  // 回答里自带日期词（"还是后天吧下午3点"）→ 以回答为准；否则平移到 pending 日期
  if (DATE_ONLY_RE.test(text) || dateOffset === 0) return parsed;
  const sameDayDue = new Date(parsed.dueAt);
  const nowDay = new Date(now);
  nowDay.setHours(0, 0, 0, 0);
  const dueDay = new Date(sameDayDue);
  dueDay.setHours(0, 0, 0, 0);
  const alreadyOffset = Math.round((dueDay.getTime() - nowDay.getTime()) / 86400_000);
  const shift = dateOffset - alreadyOffset;
  if (shift <= 0) return parsed;
  const due = new Date(parsed.dueAt + shift * 86400_000);
  return { dueAt: due.getTime(), display: fmt(due, now), matched: parsed.matched };
}
