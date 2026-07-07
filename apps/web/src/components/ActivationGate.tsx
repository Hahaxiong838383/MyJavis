import { useState } from 'react';
import { API_BASE, setInviteToken } from '../api';

/**
 * 首启激活页（批次B）：输入邀请码 → 服务端校验（GET /api/me/config）→ 存 localStorage 进主界面。
 * 分发版 bundle 不带任何 key，激活是唯一入口；码可被 server 侧单独吊销。
 */
export function ActivationGate({ onActivated }: { onActivated: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const activate = async () => {
    const token = code.trim();
    if (!token) return setError('请输入邀请码');
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/me/config`, { headers: { 'X-Javis-Key': token } });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; me?: { name: string } } | null;
      if (!res.ok || !data?.ok) {
        setError(res.status === 401 ? '邀请码无效或已停用' : `激活失败（${res.status}），稍后再试`);
        return;
      }
      setInviteToken(token);
      onActivated();
    } catch (err) {
      // 细化网络错误（2026-07-07 内测报障"连不上服务器"太笼统难定位）：带原始错误 + 一步自检指引
      const msg = err instanceof Error && err.message ? err.message : '网络错误';
      setError(`连不上服务器（${msg}）。试试换个网络（如手机热点）；或在浏览器打开 javis.chenchuan.cc/health，能看到文字说明网络通、看不到就是当前网络连不到服务器。`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.brand}>J A V I S</div>
        <h1 style={styles.title}>欢迎使用 MyJavis</h1>
        <p style={styles.sub}>内测阶段需要邀请码激活，向分发者索取。</p>
        <input
          style={styles.input}
          value={code}
          placeholder="jv-xxxxx-xxxxx"
          autoFocus
          spellCheck={false}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void activate()}
        />
        {error && <p style={styles.error}>{error}</p>}
        <button style={styles.btn} disabled={busy} onClick={() => void activate()}>
          {busy ? '验证中…' : '激活'}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100dvh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#04060c',
    color: '#e5e7eb',
    fontFamily: 'system-ui, -apple-system, "PingFang SC", sans-serif',
  },
  card: {
    width: 'min(88vw, 380px)',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    padding: '36px 30px',
    borderRadius: 24,
    border: '1px solid rgba(148,163,184,.16)',
    background: 'rgba(15,23,42,.62)',
    boxShadow: '0 18px 60px rgba(0,0,0,.3)',
    textAlign: 'center',
  },
  brand: { letterSpacing: 8, fontSize: 13, color: '#67e8f9', opacity: 0.85 },
  title: { margin: 0, fontSize: 20 },
  sub: { margin: 0, fontSize: 13, color: '#94a3b8' },
  input: {
    border: '1px solid rgba(148,163,184,.22)',
    borderRadius: 14,
    padding: '12px 14px',
    fontSize: 16,
    textAlign: 'center',
    letterSpacing: 1,
    color: '#e5e7eb',
    background: 'rgba(2,6,23,.72)',
    outline: 'none',
  },
  error: { margin: 0, color: '#f87171', fontSize: 13 },
  btn: {
    padding: '12px 0',
    borderRadius: 999,
    border: 'none',
    fontSize: 15,
    fontWeight: 700,
    background: '#22c55e',
    color: '#04210f',
    cursor: 'pointer',
  },
};
