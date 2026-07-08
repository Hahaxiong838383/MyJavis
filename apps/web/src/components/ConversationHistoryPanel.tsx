/**
 * 对话历史面板（R3.5 面板产品化 §4.3）：按房间分组展示 event_log 里的每一句话。
 *
 * 数据源 GET /api/governance/conversations（event_log 按 tenant_id 过滤，老对话
 * 未带 tenant_id 不返回，见 storage.ts listEventsByTenant 注释）。写入点是每句对话
 * 都会触发（appendUtterance），不适合像记忆活动那样接 sync 域 bump（太频繁）——
 * 本面板自己 15s 轮询 + 手动刷新按钮，effect 空依赖 + ref 桥接。
 */
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';

interface ConversationEventDto {
  id: string;
  roomId: string;
  sourceRole: 'user' | 'assistant' | 'tool';
  utteranceText: string;
  createdAt: number;
}

interface ConversationGroup {
  roomId: string;
  events: ConversationEventDto[];
  lastAt: number;
}

const POLL_MS = 15_000;

function isPrivacyPlaceholder(text: string): boolean {
  return text.startsWith('[隐私');
}

function groupByRoom(events: ConversationEventDto[]): ConversationGroup[] {
  const byRoom = new Map<string, ConversationEventDto[]>();
  for (const event of events) {
    const list = byRoom.get(event.roomId) ?? [];
    list.push(event);
    byRoom.set(event.roomId, list);
  }
  return [...byRoom.entries()]
    .map(([roomId, list]) => ({
      roomId,
      events: [...list].sort((a, b) => a.createdAt - b.createdAt), // 房间内部按时间正序，读起来像对话流
      lastAt: Math.max(...list.map((e) => e.createdAt)),
    }))
    .sort((a, b) => b.lastAt - a.lastAt); // 房间之间按最近活动倒序
}

function timeLabel(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

export function ConversationHistoryPanel() {
  const [groups, setGroups] = useState<ConversationGroup[]>([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async (): Promise<void> => {
    setLoading(true);
    try {
      const data = (await apiFetch('/api/governance/conversations?limit=50').then((res) => res.json())) as {
        ok: boolean;
        conversations?: ConversationEventDto[];
        error?: string;
      };
      if (!data.ok) throw new Error(data.error || '加载失败');
      setGroups(groupByRoom(data.conversations ?? []));
      setMessage('');
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    void loadRef.current();
    const timer = window.setInterval(() => void loadRef.current(), POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section style={styles.panel}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>对话历史</h2>
          <p style={styles.help}>按房间显示每一句对话；涉及隐私的话已转本机保存，这里只显示占位。</p>
        </div>
        <button style={styles.smallButton} disabled={loading} onClick={() => void load()}>
          {loading ? '加载中…' : '刷新'}
        </button>
      </div>

      <div style={styles.list}>
        {groups.length === 0 ? (
          <div style={styles.empty}>还没有对话。开始通话后这里按时间显示每一句。</div>
        ) : (
          groups.map((group) => (
            <div key={group.roomId} style={styles.room}>
              <div style={styles.roomHeader}>对话 · {timeLabel(group.events[0]!.createdAt)}</div>
              {group.events.map((event) => (
                <div key={event.id} style={styles.turn}>
                  {isPrivacyPlaceholder(event.utteranceText) ? (
                    <span style={styles.privacyLine}>🔒 一句涉及隐私的话（已转本机保存）</span>
                  ) : (
                    <>
                      <span style={event.sourceRole === 'user' ? styles.userTag : styles.assistantTag}>
                        {event.sourceRole === 'user' ? '我' : 'Javis'}
                      </span>
                      <span style={styles.turnText}>{event.utteranceText}</span>
                    </>
                  )}
                  <span style={styles.time}>{timeLabel(event.createdAt)}</span>
                </div>
              ))}
            </div>
          ))
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
  list: { display: 'grid', gap: 12, marginTop: 14, maxHeight: 320, overflow: 'auto' },
  empty: { color: '#64748b', fontSize: 13, padding: 14 },
  room: {
    border: '1px solid rgba(148,163,184,.1)',
    borderRadius: 14,
    padding: '10px 12px',
    background: 'rgba(2,6,23,.4)',
  },
  roomHeader: { fontSize: 11, color: '#64748b', marginBottom: 6 },
  turn: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '4px 0', flexWrap: 'wrap' },
  userTag: { flexShrink: 0, fontSize: 12, fontWeight: 700, color: '#93c5fd' },
  assistantTag: { flexShrink: 0, fontSize: 12, fontWeight: 700, color: '#e5e7eb' },
  turnText: { flex: 1, fontSize: 13, color: '#e2e8f0', lineHeight: 1.4 },
  privacyLine: { flex: 1, fontSize: 13, color: '#fdba74' },
  time: { flexShrink: 0, fontSize: 11, color: '#64748b' },
  message: { margin: '12px 2px 0', color: '#94a3b8', fontSize: 12 },
};
