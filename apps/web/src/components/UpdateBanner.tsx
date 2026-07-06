import { useEffect, useState } from 'react';

/**
 * 自动更新横幅（批次C，仅 Tauri 壳内生效）：启动静默检查 47.239 的 latest.json，
 * 有新版显示顶部横幅 → 点击下载安装 → 自动重启。浏览器环境（无 Tauri API）整组件空渲染。
 * 更新包由 minisign 私钥签名，公钥编在 App 内，防更新链路被篡改。
 */
type UpdateState =
  | { phase: 'idle' }
  | { phase: 'available'; version: string; notes: string }
  | { phase: 'downloading'; percent: number }
  | { phase: 'restarting' }
  | { phase: 'error'; message: string };

const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ phase: 'idle' });

  useEffect(() => {
    if (!inTauri) return;
    void (async () => {
      try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const update = await check();
        if (update) {
          setState({ phase: 'available', version: update.version, notes: update.body ?? '' });
        }
      } catch (err) {
        console.log('[updater] check failed:', (err as Error).message); // 静默：网络差不打扰用户
      }
    })();
  }, []);

  const install = async () => {
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (!update) return setState({ phase: 'idle' });
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') total = event.data.contentLength ?? 0;
        else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          setState({ phase: 'downloading', percent: total ? Math.round((downloaded / total) * 100) : 0 });
        }
      });
      setState({ phase: 'restarting' });
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (err) {
      setState({ phase: 'error', message: (err as Error).message });
    }
  };

  if (!inTauri || state.phase === 'idle') return null;

  return (
    <div style={styles.banner}>
      {state.phase === 'available' && (
        <>
          <span>
            发现新版本 v{state.version}
            {state.notes ? ` · ${state.notes.slice(0, 40)}` : ''}
          </span>
          <button style={styles.btn} onClick={() => void install()}>
            立即更新
          </button>
          <button style={styles.dismiss} onClick={() => setState({ phase: 'idle' })}>
            稍后
          </button>
        </>
      )}
      {state.phase === 'downloading' && <span>正在下载更新… {state.percent}%</span>}
      {state.phase === 'restarting' && <span>更新完成，正在重启…</span>}
      {state.phase === 'error' && (
        <>
          <span>更新失败：{state.message.slice(0, 60)}</span>
          <button style={styles.dismiss} onClick={() => setState({ phase: 'idle' })}>
            关闭
          </button>
        </>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  banner: {
    position: 'fixed',
    top: 12,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 50,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 18px',
    borderRadius: 999,
    border: '1px solid rgba(103,232,249,.35)',
    background: 'rgba(8,47,73,.92)',
    color: '#cffafe',
    fontSize: 13,
    boxShadow: '0 10px 40px rgba(0,0,0,.4)',
  },
  btn: {
    border: 'none',
    borderRadius: 999,
    padding: '7px 14px',
    background: '#22c55e',
    color: '#04210f',
    fontWeight: 700,
    cursor: 'pointer',
    fontSize: 13,
  },
  dismiss: {
    border: '1px solid rgba(148,163,184,.3)',
    borderRadius: 999,
    padding: '6px 12px',
    background: 'transparent',
    color: '#94a3b8',
    cursor: 'pointer',
    fontSize: 12,
  },
};
