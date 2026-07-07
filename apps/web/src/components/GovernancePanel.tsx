import { useMemo, useState } from 'react';
import { apiFetch } from '../api';

interface MemoryItemDto {
  id: string;
  ownerId: string;
  type: string;
  status: string;
  suspended?: boolean;
  confidence: number;
  content: { key: string; value: string; source: string };
  createdAt: number;
}

interface ListResponse {
  ok: boolean;
  ownerId?: string;
  memories?: MemoryItemDto[];
  error?: string;
}

interface RecallPreviewItem {
  memory: MemoryItemDto;
  source: 'relevant' | 'recent' | 'fallback_hot';
  matched: string[];
  salience: number;
}

interface RecallPreviewResponse {
  ok: boolean;
  degraded?: boolean;
  degradedReason?: 'empty_query_tokens' | 'no_match';
  matchedKeywords?: string[];
  items?: RecallPreviewItem[];
  error?: string;
}

const SOURCE_LABEL: Record<RecallPreviewItem['source'], { text: string; color: string }> = {
  relevant: { text: '相关命中', color: '#67e8f9' },
  recent: { text: '最近保底', color: '#a5b4fc' },
  fallback_hot: { text: '最近注入（无关键词命中）', color: '#94a3b8' },
};

export function GovernancePanel() {
  const [ownerId, setOwnerId] = useState('');
  const [targetOwnerId, setTargetOwnerId] = useState('');
  const [memories, setMemories] = useState<MemoryItemDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState('输入 ownerId 后查看自己的记忆。');
  const [loading, setLoading] = useState(false);
  const [previewQuery, setPreviewQuery] = useState('');
  const [preview, setPreview] = useState<RecallPreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const selected = useMemo(() => memories.find((item) => item.id === selectedId), [memories, selectedId]);
  const canAct = ownerId.trim().length > 0 && Boolean(selected);

  const load = async () => {
    const owner = ownerId.trim();
    if (!owner) {
      setMessage('ownerId 必填');
      return;
    }
    setLoading(true);
    try {
      const data = (await apiFetch(`/api/governance?owner=${encodeURIComponent(owner)}`).then((res) => res.json())) as ListResponse;
      if (!data.ok) throw new Error(data.error || '加载失败');
      setMemories(data.memories ?? []);
      setSelectedId(null);
      setMessage(`已加载 ${data.memories?.length ?? 0} 条记忆`);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const act = async (action: 'suspend' | 'resume' | 'delete' | 'reassign' | 'export') => {
    const owner = ownerId.trim();
    if (!owner) return setMessage('ownerId 必填');
    setLoading(true);
    try {
      if (action === 'export') {
        const data = await apiFetch(`/api/governance/export?owner=${encodeURIComponent(owner)}`).then((res) => res.json());
        downloadJson(`myjavis-memory-${owner}.json`, data.export ?? data);
        setMessage('已导出当前 owner 的记忆 JSON');
        return;
      }
      if (!selected) {
        setMessage('先选择一条记忆');
        return;
      }
      const path = action === 'delete' ? `/api/governance/${encodeURIComponent(selected.id)}?owner=${encodeURIComponent(owner)}` : `/api/governance/${action}`;
      const response = await apiFetch(path, {
        method: action === 'delete' ? 'DELETE' : 'POST',
        headers: action === 'delete' ? undefined : { 'Content-Type': 'application/json' },
        body:
          action === 'delete'
            ? undefined
            : JSON.stringify({
                ownerId: owner,
                memoryId: selected.id,
                ...(action === 'reassign' ? { targetOwnerId: targetOwnerId.trim() } : {}),
              }),
      });
      const data = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || `${action} 失败`);
      setMessage(`${actionLabel(action)}成功`);
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const runPreview = async () => {
    const owner = ownerId.trim();
    const q = previewQuery.trim();
    if (!owner) return setMessage('先填 ownerId 再试召回预览');
    if (!q) return setMessage('输一句话再试召回预览');
    setPreviewLoading(true);
    try {
      const data = (await apiFetch(
        `/api/governance/recall-preview?owner=${encodeURIComponent(owner)}&q=${encodeURIComponent(q)}`,
      ).then((res) => res.json())) as RecallPreviewResponse;
      if (!data.ok) throw new Error(data.error || '预览失败');
      setPreview(data);
    } catch (error) {
      setMessage((error as Error).message);
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  return (
    <section style={styles.panel}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>记忆治理</h2>
          <p style={styles.help}>查看 / 暂停 / 删除 / 重归属 / 导出，只作用于当前 owner。</p>
        </div>
        <button style={styles.smallButton} disabled={loading} onClick={() => void load()}>
          {loading ? '处理中…' : '刷新'}
        </button>
      </div>

      <div style={styles.controls}>
        <input style={styles.input} value={ownerId} placeholder="ownerId" onChange={(event) => setOwnerId(event.target.value)} />
        <input
          style={styles.input}
          value={targetOwnerId}
          placeholder="重归属 targetOwnerId"
          onChange={(event) => setTargetOwnerId(event.target.value)}
        />
      </div>

      <div style={styles.actions}>
        <button style={styles.actionButton} disabled={!canAct || selected?.suspended || loading} onClick={() => void act('suspend')}>
          暂停
        </button>
        <button style={styles.actionButton} disabled={!canAct || !selected?.suspended || loading} onClick={() => void act('resume')}>
          恢复
        </button>
        <button style={styles.actionButton} disabled={!canAct || loading} onClick={() => void act('delete')}>
          删除
        </button>
        <button style={styles.actionButton} disabled={!canAct || !targetOwnerId.trim() || loading} onClick={() => void act('reassign')}>
          重归属
        </button>
        <button style={styles.actionButton} disabled={!ownerId.trim() || loading} onClick={() => void act('export')}>
          导出
        </button>
      </div>

      <div style={styles.previewBox}>
        <div style={styles.previewHead}>
          <b style={{ fontSize: 13 }}>召回预览</b>
          <span style={styles.help}>输一句话，看 Javis 会想起哪些记忆、为什么（与真实通话同一套召回逻辑，只读）。</span>
        </div>
        <div style={styles.previewControls}>
          <input
            style={{ ...styles.input, flex: 1 }}
            value={previewQuery}
            placeholder="例如：我对什么过敏来着"
            onChange={(event) => setPreviewQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void runPreview();
            }}
          />
          <button style={styles.smallButton} disabled={previewLoading} onClick={() => void runPreview()}>
            {previewLoading ? '想想…' : '试试'}
          </button>
        </div>
        {preview && (
          <div style={styles.previewResult}>
            {preview.degraded ? (
              <div style={styles.previewNotice}>
                {preview.degradedReason === 'empty_query_tokens'
                  ? '这句话没有可检索的关键词——将按旧路径注入「最近的记忆」，如下：'
                  : '没有记忆命中这句话的关键词——将按旧路径注入「最近的记忆」，如下：'}
              </div>
            ) : (
              <div style={styles.previewNotice}>
                命中关键词：
                {(preview.matchedKeywords ?? []).map((kw) => (
                  <span key={kw} style={styles.kwChip}>
                    {kw}
                  </span>
                ))}
              </div>
            )}
            {(preview.items ?? []).length === 0 ? (
              <div style={styles.empty}>什么都想不起来（该 owner 暂无可注入记忆）。</div>
            ) : (
              (preview.items ?? []).map((item) => (
                <div key={item.memory.id} style={styles.previewItem}>
                  <span style={{ ...styles.srcTag, color: SOURCE_LABEL[item.source].color, borderColor: SOURCE_LABEL[item.source].color }}>
                    {SOURCE_LABEL[item.source].text}
                  </span>
                  <span style={styles.previewValue}>{item.memory.content?.value ?? item.memory.id}</span>
                  <span style={styles.itemMeta}>
                    {item.memory.content?.key}
                    {item.source === 'relevant' && item.matched.length > 0 && <> · 命中 {item.matched.join('、')} · 分 {item.salience.toFixed(2)}</>}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <div style={styles.list}>
        {memories.length === 0 ? (
          <div style={styles.empty}>暂无记忆或尚未查询。</div>
        ) : (
          memories.map((item) => (
            <button
              key={item.id}
              style={{
                ...styles.item,
                ...(item.id === selectedId ? styles.itemSelected : {}),
                ...(item.suspended ? styles.itemSuspended : {}),
              }}
              onClick={() => setSelectedId(item.id)}
            >
              <span style={styles.itemTop}>
                <b>{item.type}</b>
                <span>{item.suspended ? '已暂停' : item.status}</span>
              </span>
              <span style={styles.itemValue}>{item.content?.value ?? item.id}</span>
              <span style={styles.itemMeta}>
                {item.content?.key} · conf {item.confidence.toFixed(2)}
              </span>
            </button>
          ))
        )}
      </div>

      <p style={styles.message}>{message}</p>
    </section>
  );
}

function actionLabel(action: string): string {
  return { suspend: '暂停', resume: '恢复', delete: '删除', reassign: '重归属' }[action] ?? action;
}

function downloadJson(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
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
  controls: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, marginTop: 14 },
  input: {
    border: '1px solid rgba(148,163,184,.18)',
    borderRadius: 14,
    padding: '10px 12px',
    color: '#e5e7eb',
    background: 'rgba(2,6,23,.72)',
    outline: 'none',
  },
  actions: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  smallButton: {
    border: 'none',
    borderRadius: 999,
    padding: '9px 14px',
    color: '#082f49',
    background: '#67e8f9',
    fontWeight: 700,
    cursor: 'pointer',
  },
  actionButton: {
    border: '1px solid rgba(103,232,249,.24)',
    borderRadius: 999,
    padding: '8px 13px',
    color: '#cffafe',
    background: 'rgba(8,145,178,.12)',
    cursor: 'pointer',
  },
  list: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: 10,
    marginTop: 14,
    maxHeight: 280,
    overflow: 'auto',
  },
  empty: { color: '#64748b', fontSize: 13, padding: 14 },
  previewBox: {
    marginTop: 14,
    border: '1px solid rgba(148,163,184,.14)',
    borderRadius: 16,
    padding: 12,
    background: 'rgba(2,6,23,.35)',
  },
  previewHead: { display: 'flex', flexDirection: 'column', gap: 4 },
  previewControls: { display: 'flex', gap: 8, marginTop: 10 },
  previewResult: { marginTop: 10, display: 'grid', gap: 8 },
  previewNotice: { fontSize: 12, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  kwChip: {
    border: '1px solid rgba(103,232,249,.4)',
    borderRadius: 999,
    padding: '1px 8px',
    color: '#a5f3fc',
    fontSize: 11,
  },
  previewItem: {
    border: '1px solid rgba(148,163,184,.12)',
    borderRadius: 12,
    padding: 10,
    background: 'rgba(2,6,23,.46)',
  },
  srcTag: {
    display: 'inline-block',
    border: '1px solid',
    borderRadius: 999,
    padding: '1px 8px',
    fontSize: 11,
  },
  previewValue: { display: 'block', marginTop: 6, fontSize: 13, lineHeight: 1.45, color: '#e2e8f0' },
  item: {
    textAlign: 'left',
    border: '1px solid rgba(148,163,184,.14)',
    borderRadius: 16,
    padding: 12,
    background: 'rgba(2,6,23,.46)',
    color: '#e2e8f0',
    cursor: 'pointer',
  },
  itemSelected: { borderColor: 'rgba(103,232,249,.65)', boxShadow: '0 0 0 1px rgba(103,232,249,.2)' },
  itemSuspended: { opacity: 0.62 },
  itemTop: { display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, color: '#a5f3fc' },
  itemValue: { display: 'block', marginTop: 8, fontSize: 14, lineHeight: 1.45 },
  itemMeta: { display: 'block', marginTop: 8, fontSize: 11, color: '#64748b' },
  message: { margin: '12px 2px 0', color: '#94a3b8', fontSize: 12 },
};
