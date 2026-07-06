/**
 * 每房间的音乐上下文（为"换一首/下一首"提供 last query + 已放过的曲目 id）。
 * 内存态，重启即丢——个人自用可接受（同 session_state 简化）。
 */

export interface CandidateTrack {
  id: string;
  source: string;
  title: string;
  artist?: string;
}

interface MusicSessionState {
  lastQuery: string;
  playedIds: string[]; // 已放过的曲目 id，"换一首"时排除
  /** ambiguous 反问后缓存的候选（60s TTL）——用户下一句"第一个/周杰伦的夜曲"要能接住 */
  awaitingChoice?: { candidates: CandidateTrack[]; ts: number };
}

const sessions = new Map<string, MusicSessionState>();
const CHOICE_TTL_MS = 60_000;

/** 播放成功后记录 query + 该曲目 id（供后续"换一首"用）。 */
export function recordPlay(roomId: string, query: string, trackId: string): void {
  const s = sessions.get(roomId) ?? { lastQuery: query, playedIds: [] };
  s.lastQuery = query;
  if (trackId && !s.playedIds.includes(trackId)) {
    s.playedIds.push(trackId);
    // 上限保护：只保留最近 20 首，防无界增长
    if (s.playedIds.length > 20) s.playedIds = s.playedIds.slice(-20);
  }
  sessions.set(roomId, s);
}

/** 取该房间的音乐上下文（"换一首"用）；无则 undefined。 */
export function getMusicSession(roomId: string): MusicSessionState | undefined {
  return sessions.get(roomId);
}

/** 停止/清空该房间音乐上下文（"停止"时可调，非必须）。 */
export function clearMusicSession(roomId: string): void {
  sessions.delete(roomId);
}

/** ambiguous 反问时缓存候选（用户下一句选择/补全要能接住）。 */
export function setAwaitingChoice(roomId: string, query: string, candidates: CandidateTrack[]): void {
  const s = sessions.get(roomId) ?? { lastQuery: query, playedIds: [] };
  s.lastQuery = query;
  s.awaitingChoice = { candidates, ts: Date.now() };
  sessions.set(roomId, s);
}

/** 取活跃的候选等待态（过期自动清）；无则 null。 */
export function getAwaitingChoice(roomId: string): CandidateTrack[] | null {
  const s = sessions.get(roomId);
  if (!s?.awaitingChoice) return null;
  if (Date.now() - s.awaitingChoice.ts > CHOICE_TTL_MS) {
    s.awaitingChoice = undefined;
    return null;
  }
  return s.awaitingChoice.candidates;
}

/** 消费候选等待态（选中/放弃后调用）。 */
export function clearAwaitingChoice(roomId: string): void {
  const s = sessions.get(roomId);
  if (s) s.awaitingChoice = undefined;
}
