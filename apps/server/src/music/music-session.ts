/**
 * 每房间的音乐上下文（为"换一首/下一首"提供 last query + 已放过的曲目 id）。
 * 内存态，重启即丢——个人自用可接受（同 session_state 简化）。
 */

interface MusicSessionState {
  lastQuery: string;
  playedIds: string[]; // 已放过的曲目 id，"换一首"时排除
}

const sessions = new Map<string, MusicSessionState>();

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
