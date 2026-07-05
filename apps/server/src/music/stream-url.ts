/** 拼公网播放 URL（前端 <audio> 用）。orchestrator 返回的 stream_url 是相对路径（含签名 token）。 */

import { config } from '../config.js';

export function buildStreamUrl(rel: string): string {
  if (!rel) return '';
  if (!config.music.streamPublicBase) return rel;
  const base = config.music.streamPublicBase.replace(/\/$/, '');
  const path = rel.startsWith('/') ? rel : `/${rel}`;
  return `${base}${path}`;
}
