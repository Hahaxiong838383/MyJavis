import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import type { ReminderDto } from '../useReminders';

/**
 * 提醒管理面板（调试区，仿 VoiceprintPanel）：待办提醒列表 + 取消。
 * 设置走语音（"提醒我下午三点开会"），面板只做查看/兜底删除。
 */

function fmtDue(dueAt: number): string {
  const d = new Date(dueAt);
  const now = new Date();
  const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hh}`;
  if (new Date(now.getTime() + 86400_000).toDateString() === d.toDateString()) return `明天 ${hh}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}`;
}

export function ReminderPanel() {
  const [items, setItems] = useState<ReminderDto[]>([]);
  const [message, setMessage] = useState('说"提醒我下午三点开会"这样即可设置。');
  const [loading, setLoading] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = (await apiFetch('/api/reminders').then((r) => r.json())) as {
        ok: boolean;
        items?: ReminderDto[];
        error?: string;
      };
      if (!data.ok) throw new Error(data.error || '加载失败');
      setItems(data.items ?? []);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000); // 低频对齐（语音设置后面板迟早看到）
    return () => clearInterval(t);
  }, []);

  const remove = async (id: string) => {
    if (confirmId !== id) {
      setConfirmId(id);
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch(`/api/reminders/${id}`, { method: 'DELETE' });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || '取消失败');
      setMessage('已取消该提醒。');
      setConfirmId(null);
      await load();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section style={styles.panel}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>提醒</h2>
          <p style={styles.help}>{message}</p>
        </div>
        <button style={styles.smallButton} disabled={loading} onClick={() => void load()}>
          {loading ? '处理中…' : '刷新'}
        </button>
      </div>
      <div style={styles.list}>
        {items.length === 0 ? (
          <div style={styles.empty}>没有待办提醒。通话中说"提醒我十分钟后关火"试试。</div>
        ) : (
          items.map((r) => (
            <div key={r.id} style={styles.item}>
              <div>
                <span style={styles.name}>{r.content}</span>
                <span style={styles.meta}>
                  {fmtDue(r.dueAt)}
                  {r.speakerName ? ` · ${r.speakerName}` : ''}
                </span>
              </div>
              <button
                style={confirmId === r.id ? styles.dangerButtonActive : styles.dangerButton}
                disabled={loading}
                onClick={() => void remove(r.id)}
              >
                {confirmId === r.id ? '确认取消' : '取消'}
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    marginTop: 16,
    padding: '14px 16px',
    borderRadius: 12,
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.08)',
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  title: { margin: 0, fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.85)' },
  help: { margin: '4px 0 0', fontSize: 12, color: 'rgba(255,255,255,0.45)' },
  smallButton: {
    padding: '4px 10px',
    fontSize: 12,
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,0.15)',
    background: 'transparent',
    color: 'rgba(255,255,255,0.7)',
    cursor: 'pointer',
    flexShrink: 0,
  },
  list: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 },
  empty: { fontSize: 12, color: 'rgba(255,255,255,0.4)', padding: '6px 0' },
  item: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    padding: '8px 10px',
    borderRadius: 10,
    background: 'rgba(255,255,255,0.04)',
  },
  name: { fontSize: 13, color: 'rgba(255,255,255,0.85)' },
  meta: { marginLeft: 10, fontSize: 12, color: 'rgba(255,255,255,0.45)' },
  dangerButton: {
    padding: '4px 10px',
    fontSize: 12,
    borderRadius: 8,
    border: '1px solid rgba(255,120,120,0.35)',
    background: 'transparent',
    color: 'rgba(255,140,140,0.85)',
    cursor: 'pointer',
    flexShrink: 0,
  },
  dangerButtonActive: {
    padding: '4px 10px',
    fontSize: 12,
    borderRadius: 8,
    border: '1px solid rgba(255,90,90,0.8)',
    background: 'rgba(255,90,90,0.15)',
    color: '#ff8080',
    cursor: 'pointer',
    flexShrink: 0,
  },
};
