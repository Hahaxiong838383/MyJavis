/**
 * music-orchestrator 薄封装。
 * 所有调用必须容错：超时/网络错误不抛，统一返回 null 或明确错误结构。
 * 不能拖垮主对话链路。
 */

import { config } from '../config.js';

export interface MusicTrack {
  id: string;
  source: string;
  title: string;
  artist?: string;
  duration_sec?: number;
  score?: number;
  stream_url?: string;
}

export interface MusicSearchResult {
  results: MusicTrack[];
}

export interface MusicPlayResult {
  status: 'playing' | 'ambiguous' | 'not_found';
  track?: MusicTrack;
  stream_url?: string;
  alternatives?: MusicTrack[];
  candidates?: MusicTrack[];
}

export interface MusicControlResult {
  status: string;
  current_state?: unknown;
}

export interface MusicQueueResult {
  queue: unknown[];
}

export interface MusicStatusResult {
  playing: boolean;
  current_track?: MusicTrack;
  queue?: unknown[];
  position_sec?: number;
}

const DEFAULT_TIMEOUT = 4500;

/**
 * 测试 / Gate2 数据脚本专用 stub 开关（默认关，生产行为不变）：项目铁律「测试中不许真调
 * B 站/音乐 orchestrator 搜索」（见 IMPL-音乐意图AI化-PROMPT.md §4.4）。只影响 FC 控制路径
 * 实际会触发网络调用的 musicPlay/musicPlayById（next/prev 换歌），其余函数不受影响。
 */
const STUB = process.env.MUSIC_ORCHESTRATOR_STUB === '1';

function stubPlayResult(query: string, track?: { id: string; source: string; title?: string }): MusicPlayResult {
  return {
    status: 'playing',
    track: {
      id: track?.id ?? `stub-${query}`,
      source: track?.source ?? 'stub',
      // 裸标题不带《》：调用方（shortTitle/handlePlayResult/buildMusicContextNote）自己按需加书名号，
      // 这里带了会被套两层（真机曾出现"《《夜曲》》"污染 contextNote 的问题）。
      title: track?.title ?? query,
      artist: 'Stub Artist',
    },
    stream_url: '/stub/stream.mp3',
  };
}

function getHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.music.apiKey) h['X-Music-Key'] = config.music.apiKey;
  return h;
}

async function postJson<T>(path: string, body: unknown): Promise<T | null> {
  const base = config.music.baseUrl;
  if (!base) return null;
  const url = `${base.replace(/\/$/, '')}${path}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.log(`[music] orchestrator ${path} http ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    console.log(`[music] orchestrator ${path} error: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function getJson<T>(path: string): Promise<T | null> {
  const base = config.music.baseUrl;
  if (!base) return null;
  const url = `${base.replace(/\/$/, '')}${path}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: getHeaders(),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.log(`[music] orchestrator ${path} http ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    console.log(`[music] orchestrator ${path} error: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function musicSearch(query: string, sessionId: string, limit = 5): Promise<MusicSearchResult | null> {
  return postJson<MusicSearchResult>('/tools/music_search', { query, limit, session_id: sessionId });
}

export async function musicPlay(
  query: string,
  sessionId: string,
  excludeIds?: string[],
): Promise<MusicPlayResult | null> {
  if (STUB) return stubPlayResult(query);
  return postJson<MusicPlayResult>('/tools/music_play', {
    query,
    mode: 'track',
    session_id: sessionId,
    ...(excludeIds && excludeIds.length > 0 ? { exclude_ids: excludeIds } : {}),
  });
}

/** 直接按曲目 id 播（ambiguous 反问后用户选中某候选）：orchestrator 跳过搜索直接签名。 */
export async function musicPlayById(
  track: { id: string; source: string; title?: string },
  sessionId: string,
): Promise<MusicPlayResult | null> {
  if (STUB) return stubPlayResult(track.title ?? track.id, track);
  return postJson<MusicPlayResult>('/tools/music_play', {
    query: track.title ?? track.id,
    mode: 'track',
    session_id: sessionId,
    track_id: track.id,
    track_source: track.source,
    track_title: track.title,
  });
}

export async function musicControl(
  action: string,
  value: unknown,
  sessionId: string,
): Promise<MusicControlResult | null> {
  return postJson<MusicControlResult>('/tools/music_control', { action, value, session_id: sessionId });
}

export async function musicQueue(action: string, item: unknown, sessionId: string): Promise<MusicQueueResult | null> {
  return postJson<MusicQueueResult>('/tools/music_queue', { action, item, session_id: sessionId });
}

export async function musicStatus(sessionId: string): Promise<MusicStatusResult | null> {
  const qs = `?session_id=${encodeURIComponent(sessionId)}`;
  return getJson<MusicStatusResult>(`/tools/music_status${qs}`);
}
