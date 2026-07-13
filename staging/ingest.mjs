// MyJavis staging 哑端点(契约 §4.3):收下、校验、打日志。零依赖。
// 鉴权 Bearer key(keys.json 热加载)+ 每日配额 + JSONL 用量日志。
// 融合逻辑上线后本服务被真实内核替换,实习生侧无需任何改动。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || 3002);
const KEYS_FILE = process.env.KEYS_FILE || '/opt/myjavis-staging/keys.json';
const LOG_DIR = process.env.LOG_DIR || '/opt/myjavis-staging/logs';
const CONTRACT_VERSION = '0.2.0';

const REQUIRED = ['v', 'type', 'seq', 'session_id', 'ts_mono_ms', 'ts_wall_ms', 'payload'];
const TYPES = new Set(['hello', 'heartbeat', 'event', 'semantic']);

// keys.json: { "<key>": { "name": "…", "daily_limit": 5000 } } —— 改文件即生效(mtime 热加载),吊销=删行
let keysCache = { mtime: 0, data: {} };
function loadKeys() {
  try {
    const st = fs.statSync(KEYS_FILE);
    if (st.mtimeMs !== keysCache.mtime) {
      keysCache = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')) };
    }
  } catch {
    keysCache = { mtime: 0, data: {} };
  }
  return keysCache.data;
}

const usage = new Map(); // key -> { day, count }(内存计数,重启清零;精确计量以 JSONL 为准)
function underQuota(key, limit) {
  const day = new Date().toISOString().slice(0, 10);
  const u = usage.get(key);
  if (!u || u.day !== day) { usage.set(key, { day, count: 1 }); return true; }
  if (u.count >= limit) return false;
  u.count += 1;
  return true;
}

function audit(entry) {
  try {
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    fs.appendFileSync(path.join(LOG_DIR, `ingest-${day}.jsonl`), JSON.stringify(entry) + '\n');
  } catch (e) { console.error('[audit-fail]', e.message); }
}

function reply(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const startedAt = Date.now();
http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return reply(res, 200, { ok: true, contract_version: CONTRACT_VERSION, uptime_s: Math.round((Date.now() - startedAt) / 1000) });
  }
  if (req.method !== 'POST' || req.url !== '/perception/ingest') return reply(res, 404, { ok: false, error: 'not found' });

  const auth = req.headers.authorization || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const keyInfo = loadKeys()[key];
  if (!keyInfo) return reply(res, 401, { ok: false, error: 'invalid or missing api key' });
  if (!underQuota(key, keyInfo.daily_limit ?? 5000)) return reply(res, 429, { ok: false, error: 'daily quota exceeded' });

  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(body); } catch { return reply(res, 400, { ok: false, error: 'invalid json' }); }
    const missing = REQUIRED.filter((k) => !(k in msg));
    if (missing.length) return reply(res, 400, { ok: false, error: 'missing: ' + missing.join(',') });
    if (!TYPES.has(msg.type)) return reply(res, 400, { ok: false, error: 'bad type: ' + msg.type });
    const major = String(msg.v).split('.')[0];
    if (major !== CONTRACT_VERSION.split('.')[0]) {
      return reply(res, 400, { ok: false, error: `contract major mismatch: got ${msg.v}, server ${CONTRACT_VERSION}` });
    }
    audit({ t: Date.now(), who: keyInfo.name, type: msg.type, seq: msg.seq, session: msg.session_id });
    console.log(`[ok] ${keyInfo.name} #${msg.seq} ${msg.type}`);
    reply(res, 200, { ok: true });
  });
}).listen(PORT, '127.0.0.1', () => console.log(`staging ingest on 127.0.0.1:${PORT} (contract ${CONTRACT_VERSION})`));
