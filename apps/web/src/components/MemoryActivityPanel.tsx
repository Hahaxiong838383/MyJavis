/**
 * 记忆活动面板（R3，川哥点名：运行机制和状态要在 App 界面真实实时显示）。
 *
 * 数据源 GET /api/governance/activity（server 内存环形缓冲，最近 50 条）；
 * 订阅 sync 'memory' 域——server 每个记忆动作（召回/写入/隐私转移/失效/精修）
 * push 事件即 bump，本面板 ≤5s 自动刷新，通话中每轮动作实时可见。
 */
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';
import { useSyncRefresh } from '../useSyncVersions';

interface ActivityEventDto {
  ts: number;
  kind: 'recall' | 'write' | 'privacy_route' | 'invalidate' | 'refine' | 'correction' | 'quarantine' | 'consolidation';
  summary: string;
  detail?: Record<string, unknown>;
}

const KIND_META: Record<ActivityEventDto['kind'], { icon: string; label: string; color: string }> = {
  recall: { icon: '🔍', label: '召回', color: '#67e8f9' },
  write: { icon: '✏️', label: '写入', color: '#86efac' },
  privacy_route: { icon: '🔒', label: '隐私', color: '#fdba74' },
  invalidate: { icon: '♻️', label: '更新', color: '#94a3b8' },
  refine: { icon: '🧠', label: '精修', color: '#c4b5fd' },
  correction: { icon: '✍️', label: '纠正', color: '#f9a8d4' },
  quarantine: { icon: '📥', label: '暂存', color: '#fbbf24' },
  // R4 夜间巩固（ephemeral 清理/dormant 冷藏/画像重算）活动事件，见 memory/consolidation.ts。
  consolidation: { icon: '🌙', label: '巩固', color: '#7dd3fc' },
};

function timeLabel(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

export function MemoryActivityPanel() {
  const [events, setEvents] = useState<ActivityEventDto[]>([]);
  const [message, setMessage] = useState('');

  const load = async () => {
    try {
      const data = (await apiFetch('/api/governance/activity').then((res) => res.json())) as {
        ok: boolean;
        events?: ActivityEventDto[];
        error?: string;
      };
      if (!data.ok) throw new Error(data.error || '加载失败');
      setEvents(data.events ?? []);
      setMessage('');
    } catch (error) {
      setMessage((error as Error).message);
    }
  };
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    void loadRef.current();
  }, []);
  useSyncRefresh('memory', () => void loadRef.current());

  return (
    <section style={styles.panel}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>记忆活动</h2>
          <p style={styles.help}>记忆系统的每个动作实时显示：想起了什么、记住了什么、哪些转去了本机、哪些被新说法取代。</p>
        </div>
        <button style={styles.smallButton} onClick={() => void load()}>
          刷新
        </button>
      </div>

      <div style={styles.feed}>
        {events.length === 0 ? (
          <div style={styles.empty}>还没有活动。开始通话后，这里会实时滚动记忆系统的运行状态。</div>
        ) : (
          events.map((event, i) => {
            const meta = KIND_META[event.kind] ?? { icon: '·', label: event.kind, color: '#94a3b8' };
            return (
              <div key={`${event.ts}-${i}`} style={styles.row}>
                <span style={styles.icon}>{meta.icon}</span>
                <span style={{ ...styles.kindTag, color: meta.color, borderColor: meta.color }}>{meta.label}</span>
                <span style={styles.summary}>{event.summary}</span>
                <span style={styles.time}>{timeLabel(event.ts)}</span>
              </div>
            );
          })
        )}
      </div>

      {message && <p style={styles.message}>{message}</p>}
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
  feed: { display: 'grid', gap: 6, marginTop: 14, maxHeight: 260, overflow: 'auto' },
  empty: { color: '#64748b', fontSize: 13, padding: 14 },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    border: '1px solid rgba(148,163,184,.1)',
    borderRadius: 12,
    padding: '8px 10px',
    background: 'rgba(2,6,23,.4)',
  },
  icon: { fontSize: 14 },
  kindTag: {
    flexShrink: 0,
    border: '1px solid',
    borderRadius: 999,
    padding: '0 8px',
    fontSize: 11,
  },
  summary: { flex: 1, fontSize: 13, color: '#e2e8f0', lineHeight: 1.4 },
  time: { flexShrink: 0, fontSize: 11, color: '#64748b' },
  message: { margin: '12px 2px 0', color: '#94a3b8', fontSize: 12 },
};
