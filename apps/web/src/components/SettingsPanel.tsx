import { useEffect, useState } from 'react';
import { apiFetch, clearInviteToken, getInviteToken } from '../api';

/**
 * 账号设置面板（批次B）：人设 prompt（叠加在锁定基座上）+ Javis 对我的称呼 + 退出激活。
 * 配置存 server 端（跟着邀请码走，换电脑不丢）。
 */
const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function SettingsPanel() {
  const [name, setName] = useState('');
  const [autostart, setAutostart] = useState<boolean | null>(null); // null=不可用(浏览器)
  const [userTitle, setUserTitle] = useState('');
  const [personaExtra, setPersonaExtra] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    void import('@tauri-apps/plugin-autostart')
      .then(async (m) => setAutostart(await m.isEnabled()))
      .catch(() => setAutostart(null));
  }, []);

  const toggleAutostart = async () => {
    if (autostart === null) return;
    try {
      const m = await import('@tauri-apps/plugin-autostart');
      if (autostart) await m.disable();
      else await m.enable();
      setAutostart(await m.isEnabled());
    } catch (error) {
      setMessage(`登录自启设置失败：${(error as Error).message}`);
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const data = (await apiFetch('/api/me/config').then((r) => r.json())) as {
          ok: boolean;
          me?: { name: string; personaExtra: string; userTitle: string };
        };
        if (data.ok && data.me) {
          setName(data.me.name);
          setUserTitle(data.me.userTitle);
          setPersonaExtra(data.me.personaExtra);
        }
      } catch {
        setMessage('配置加载失败');
      }
    })();
  }, []);

  const save = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/me/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personaExtra, userTitle }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || '保存失败');
      setMessage('已保存，下一句对话即生效');
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    clearInviteToken();
    window.location.reload();
  };

  return (
    <section style={styles.panel}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>我的设置{userTitle || name ? ` · ${userTitle || name}` : ''}</h2>
          <p style={styles.help}>人设与称呼存在云端，跟着邀请码走；安全与语音输出规范不可更改。</p>
        </div>
        <button style={styles.smallButton} disabled={loading} onClick={() => void save()}>
          {loading ? '保存中…' : '保存'}
        </button>
      </div>

      <label style={styles.label}>
        Javis 平时怎么称呼我
        <input
          style={styles.input}
          value={userTitle}
          maxLength={16}
          placeholder="比如：老板 / 瞅瞅 / 小姐姐"
          onChange={(e) => setUserTitle(e.target.value)}
        />
        <span style={styles.hint}>注册过声纹的人被听出来时，优先用「声纹管理」里那个名字——想统一就把两处都改成一样的。</span>
      </label>

      <label style={styles.label}>
        个性化人设（语气 / 背景 / 偏好，叠加在 Javis 基础人设上）
        <textarea
          style={styles.textarea}
          value={personaExtra}
          maxLength={2000}
          rows={4}
          placeholder={'比如：说话幽默一点，多用短句；我是程序员，聊技术可以直接上术语；周末别提工作。'}
          onChange={(e) => setPersonaExtra(e.target.value)}
        />
      </label>

      {autostart !== null && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13, color: '#cbd5e1', cursor: 'pointer' }}>
          <input type="checkbox" checked={autostart} onChange={() => void toggleAutostart()} />
          登录时自动启动（App 常驻菜单栏，提醒与本机隐私记忆不断线）
        </label>
      )}
      <div style={styles.footerRow}>
        <span style={styles.message}>{message}</span>
        {getInviteToken() && (
          <button style={styles.logoutBtn} onClick={logout}>
            退出激活
          </button>
        )}
      </div>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 'min(92vw, 760px)',
    border: '1px solid rgba(148,163,184,.16)',
    borderRadius: 24,
    background: 'rgba(15,23,42,.62)',
    padding: 18,
    boxShadow: '0 18px 60px rgba(0,0,0,.24)',
  },
  header: { display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' },
  title: { margin: 0, fontSize: 18 },
  help: { margin: '6px 0 0', color: '#94a3b8', fontSize: 12 },
  smallButton: {
    border: 'none',
    borderRadius: 999,
    padding: '9px 14px',
    color: '#082f49',
    background: '#67e8f9',
    fontWeight: 700,
    cursor: 'pointer',
  },
  label: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 14, fontSize: 13, color: '#cbd5e1' },
  hint: { fontSize: 11, color: '#64748b' },
  input: {
    border: '1px solid rgba(148,163,184,.18)',
    borderRadius: 14,
    padding: '10px 12px',
    color: '#e5e7eb',
    background: 'rgba(2,6,23,.72)',
    outline: 'none',
  },
  textarea: {
    border: '1px solid rgba(148,163,184,.18)',
    borderRadius: 14,
    padding: '10px 12px',
    color: '#e5e7eb',
    background: 'rgba(2,6,23,.72)',
    outline: 'none',
    resize: 'vertical',
    fontFamily: 'inherit',
    fontSize: 14,
    lineHeight: 1.5,
  },
  footerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 },
  message: { color: '#94a3b8', fontSize: 12 },
  logoutBtn: {
    border: '1px solid rgba(248,113,113,.28)',
    borderRadius: 999,
    padding: '7px 12px',
    color: '#fecaca',
    background: 'rgba(153,27,27,.14)',
    cursor: 'pointer',
    fontSize: 12,
  },
};
