/**
 * 本机隐私记忆面板（R2）：只存在于这台电脑的记忆——列表/删除。
 * 数据源是本机 vault.db（纯本地查询，不走云端）；拉取链路每落一批广播
 * VAULT_CHANGED_EVENT，本面板订阅刷新（UI 同步原则的本地版）。
 * 非 Tauri 环境（浏览器 dev）显示降级说明。
 */
import { useEffect, useRef, useState } from 'react';
import { VAULT_CHANGED_EVENT } from '../usePrivacyVault';
import { deleteVaultMemory, listVaultMemories, type VaultMemory } from '../vault';

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const TYPE_LABEL: Record<string, string> = {
  safety: '安全/健康',
  location: '位置',
  relationship: '关系',
  profile_fact: '个人信息',
  event: '事件',
  preference: '偏好',
};

export function PrivacyVaultPanel() {
  const [memories, setMemories] = useState<VaultMemory[]>([]);
  const [message, setMessage] = useState(isTauri() ? '' : '浏览器预览环境无本机 vault（App 内可用）。');
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = async () => {
    if (!isTauri()) return;
    try {
      setMemories(await listVaultMemories());
    } catch (error) {
      setMessage((error as Error).message);
    }
  };
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    void loadRef.current();
    const onChange = () => void loadRef.current();
    window.addEventListener(VAULT_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(VAULT_CHANGED_EVENT, onChange);
  }, []);

  const remove = async (id: string) => {
    if (confirmId !== id) {
      setConfirmId(id);
      setMessage('再点一次「删除」确认（不可恢复）');
      return;
    }
    setConfirmId(null);
    await deleteVaultMemory(id);
    setMessage('已从本机删除');
    await load();
  };

  return (
    <section style={styles.panel}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>本机隐私记忆</h2>
          <p style={styles.help}>
            健康、位置、家人关系等敏感记忆只存在这台电脑（云端零留存）；通话时临时提供给 Javis，用完即弃。
          </p>
        </div>
        <button style={styles.smallButton} onClick={() => void load()}>
          刷新
        </button>
      </div>

      <div style={styles.list}>
        {memories.length === 0 ? (
          <div style={styles.empty}>
            {isTauri() ? '还没有隐私记忆。通话中聊到健康/住址/家人时会自动收进来。' : '（App 内可见）'}
          </div>
        ) : (
          memories.map((item) => (
            <div key={item.id} style={styles.item}>
              <span style={styles.itemTop}>
                <b>{TYPE_LABEL[item.type] ?? item.type}</b>
                <button style={styles.deleteBtn} onClick={() => void remove(item.id)}>
                  {confirmId === item.id ? '确认删除' : '删除'}
                </button>
              </span>
              <span style={styles.itemValue}>{item.value}</span>
              <span style={styles.itemMeta}>
                {item.key} · {new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}
              </span>
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
  list: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: 10,
    marginTop: 14,
    maxHeight: 280,
    overflow: 'auto',
  },
  empty: { color: '#64748b', fontSize: 13, padding: 14 },
  item: {
    textAlign: 'left',
    border: '1px solid rgba(148,163,184,.14)',
    borderRadius: 16,
    padding: 12,
    background: 'rgba(2,6,23,.46)',
    color: '#e2e8f0',
  },
  itemTop: { display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, color: '#a5f3fc' },
  deleteBtn: {
    border: '1px solid rgba(248,113,113,.4)',
    borderRadius: 999,
    padding: '1px 10px',
    color: '#fca5a5',
    background: 'transparent',
    fontSize: 11,
    cursor: 'pointer',
  },
  itemValue: { display: 'block', marginTop: 8, fontSize: 14, lineHeight: 1.45 },
  itemMeta: { display: 'block', marginTop: 8, fontSize: 11, color: '#64748b' },
  message: { margin: '12px 2px 0', color: '#94a3b8', fontSize: 12 },
};
