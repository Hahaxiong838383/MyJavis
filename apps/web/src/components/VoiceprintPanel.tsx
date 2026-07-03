import { useEffect, useState } from 'react';
import { apiFetch } from '../api';

/**
 * 声纹管理面板（调试区）：列表 + 改名 + 删除。
 * - 改名只动本地 registry（识别称呼即时生效；本局字幕署名下次连接生效）。
 * - 删除 = 火山侧不可逆删除 + 本地删（二次确认防误触）。
 */

interface VoiceprintDto {
  voiceprintId: string;
  audioName: string;
  displayName: string;
  ownerId: string;
  createdAt: number;
}

export function VoiceprintPanel() {
  const [voiceprints, setVoiceprints] = useState<VoiceprintDto[]>([]);
  const [message, setMessage] = useState('说"我是某某，记住我的声音"即可注册（最多 3 人）。');
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = (await apiFetch('/api/voiceprint/list').then((res) => res.json())) as {
        ok: boolean;
        voiceprints?: VoiceprintDto[];
        error?: string;
      };
      if (!data.ok) throw new Error(data.error || '加载失败');
      setVoiceprints(data.voiceprints ?? []);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const rename = async (voiceprintId: string) => {
    const name = editName.trim();
    if (!name) return setMessage('新名字不能为空');
    setLoading(true);
    try {
      const res = await apiFetch('/api/voiceprint/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceprintId, displayName: name }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || '改名失败');
      setMessage(`已改名为"${name}"（Javis 的称呼即时生效）`);
      setEditingId(null);
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const remove = async (voiceprintId: string) => {
    if (confirmDeleteId !== voiceprintId) {
      setConfirmDeleteId(voiceprintId);
      setMessage('再点一次"确认删除"（火山侧删除不可恢复）');
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch(`/api/voiceprint/${encodeURIComponent(voiceprintId)}`, { method: 'DELETE' });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || '删除失败');
      setMessage('已删除，下次通话生效');
      setConfirmDeleteId(null);
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section style={styles.panel}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>声纹管理</h2>
          <p style={styles.help}>已注册 {voiceprints.length}/3 人 · 改名即时生效 · 删除不可恢复</p>
        </div>
        <button style={styles.smallButton} disabled={loading} onClick={() => void load()}>
          {loading ? '处理中…' : '刷新'}
        </button>
      </div>

      <div style={styles.list}>
        {voiceprints.length === 0 ? (
          <div style={styles.empty}>还没有声纹。通话中说"我是某某，记住我的声音"即可注册。</div>
        ) : (
          voiceprints.map((vp) => (
            <div key={vp.voiceprintId} style={styles.item}>
              {editingId === vp.voiceprintId ? (
                <div style={styles.editRow}>
                  <input
                    style={styles.input}
                    value={editName}
                    maxLength={16}
                    placeholder="新名字"
                    autoFocus
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void rename(vp.voiceprintId)}
                  />
                  <button style={styles.actionButton} disabled={loading} onClick={() => void rename(vp.voiceprintId)}>
                    确定
                  </button>
                  <button style={styles.actionButton} onClick={() => setEditingId(null)}>
                    取消
                  </button>
                </div>
              ) : (
                <>
                  <div>
                    <span style={styles.name}>{vp.displayName}</span>
                    <span style={styles.meta}>{new Date(vp.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 注册</span>
                  </div>
                  <div style={styles.rowActions}>
                    <button
                      style={styles.actionButton}
                      disabled={loading}
                      onClick={() => {
                        setEditingId(vp.voiceprintId);
                        setEditName(vp.displayName);
                        setConfirmDeleteId(null);
                      }}
                    >
                      改名
                    </button>
                    <button
                      style={confirmDeleteId === vp.voiceprintId ? styles.dangerButtonActive : styles.dangerButton}
                      disabled={loading}
                      onClick={() => void remove(vp.voiceprintId)}
                    >
                      {confirmDeleteId === vp.voiceprintId ? '确认删除' : '删除'}
                    </button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>

      <p style={styles.message}>{message}</p>
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
  list: { display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 },
  empty: { color: '#64748b', fontSize: 13, padding: 14 },
  item: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    border: '1px solid rgba(148,163,184,.14)',
    borderRadius: 16,
    padding: '12px 14px',
    background: 'rgba(2,6,23,.46)',
    color: '#e2e8f0',
  },
  name: { fontSize: 15, fontWeight: 700 },
  meta: { marginLeft: 10, fontSize: 11, color: '#64748b' },
  rowActions: { display: 'flex', gap: 8 },
  editRow: { display: 'flex', gap: 8, width: '100%', alignItems: 'center' },
  input: {
    flex: 1,
    border: '1px solid rgba(148,163,184,.18)',
    borderRadius: 14,
    padding: '9px 12px',
    color: '#e5e7eb',
    background: 'rgba(2,6,23,.72)',
    outline: 'none',
  },
  actionButton: {
    border: '1px solid rgba(103,232,249,.24)',
    borderRadius: 999,
    padding: '8px 13px',
    color: '#cffafe',
    background: 'rgba(8,145,178,.12)',
    cursor: 'pointer',
  },
  dangerButton: {
    border: '1px solid rgba(248,113,113,.28)',
    borderRadius: 999,
    padding: '8px 13px',
    color: '#fecaca',
    background: 'rgba(153,27,27,.14)',
    cursor: 'pointer',
  },
  dangerButtonActive: {
    border: '1px solid rgba(248,113,113,.7)',
    borderRadius: 999,
    padding: '8px 13px',
    color: '#fff',
    background: 'rgba(220,38,38,.55)',
    fontWeight: 700,
    cursor: 'pointer',
  },
  message: { margin: '12px 2px 0', color: '#94a3b8', fontSize: 12 },
};
