import { useVoiceRtc } from './useVoiceRtc';
import { useAppStore } from './store';

const STATUS_LABEL: Record<string, string> = {
  idle: '未连接',
  listening: '在听…',
  thinking: '思考中…',
  speaking: '说话中…',
};

const STATUS_COLOR: Record<string, string> = {
  idle: '#6b7280',
  listening: '#22c55e',
  thinking: '#eab308',
  speaking: '#3b82f6',
};

const PHASE_LABEL: Record<string, string> = {
  starting: '起服务…',
  loading: '加载语音引擎…',
  joining: '进入房间…',
};

export default function App() {
  const { connected, connecting, connectPhase, error, needTapToPlay, start, stop, resumePlay } = useVoiceRtc();
  const voiceStatus = useAppStore((s) => s.voiceStatus);
  const subtitle = useAppStore((s) => s.subtitle);
  const userSubtitle = useAppStore((s) => s.userSubtitle);

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <h1 style={styles.title}>MyJavis</h1>
        <span style={styles.subtitle}>实时语音助手 · 火山 RTC 骨架</span>
      </header>

      <main style={styles.main}>
        <div
          style={{
            ...styles.orb,
            background: `radial-gradient(circle at 30% 30%, ${STATUS_COLOR[voiceStatus]}, #1f2937)`,
            boxShadow: connected ? `0 0 60px ${STATUS_COLOR[voiceStatus]}55` : 'none',
          }}
        >
          <span style={styles.orbText}>{connecting ? PHASE_LABEL[connectPhase] ?? '连接中…' : STATUS_LABEL[voiceStatus]}</span>
        </div>

        <div style={styles.captions}>
          {userSubtitle && (
            <p style={styles.userLine}>
              <b>你：</b>
              {userSubtitle}
            </p>
          )}
          {subtitle && (
            <p style={styles.botLine}>
              <b>Javis：</b>
              {subtitle}
            </p>
          )}
        </div>

        {error && <p style={styles.error}>⚠️ {error}</p>}

        {needTapToPlay && (
          <button style={styles.tapBtn} onClick={resumePlay}>
            点这里恢复声音
          </button>
        )}

        {!connected ? (
          <button style={{ ...styles.btn, ...styles.btnPrimary }} disabled={connecting} onClick={() => void start()}>
            {connecting ? '连接中…' : '开始对话'}
          </button>
        ) : (
          <button style={{ ...styles.btn, ...styles.btnStop }} onClick={() => void stop()}>
            结束对话
          </button>
        )}
      </main>

      <footer style={styles.footer}>
        需配置 <code>.env</code> 火山 RTC/ASR/TTS + LLM 真值后方可真机对话 · 记忆系统占位（待产品定义）
      </footer>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100dvh',
    display: 'flex',
    flexDirection: 'column',
    background: '#0b0f17',
    color: '#e5e7eb',
    fontFamily: 'system-ui, -apple-system, "PingFang SC", sans-serif',
  },
  header: { padding: '24px', textAlign: 'center' },
  title: { margin: 0, fontSize: 28, letterSpacing: 1 },
  subtitle: { fontSize: 13, color: '#9ca3af' },
  main: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 28, padding: 24 },
  orb: {
    width: 200,
    height: 200,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'box-shadow .4s',
  },
  orbText: { fontSize: 16, fontWeight: 600 },
  captions: { minHeight: 64, maxWidth: 520, textAlign: 'center' },
  userLine: { margin: '6px 0', color: '#93c5fd', fontSize: 15 },
  botLine: { margin: '6px 0', color: '#e5e7eb', fontSize: 17 },
  error: { color: '#f87171', fontSize: 14 },
  tapBtn: { padding: '10px 20px', borderRadius: 999, border: 'none', background: '#f59e0b', color: '#111', fontWeight: 600, cursor: 'pointer' },
  btn: { padding: '14px 40px', borderRadius: 999, border: 'none', fontSize: 16, fontWeight: 700, cursor: 'pointer' },
  btnPrimary: { background: '#22c55e', color: '#04210f' },
  btnStop: { background: '#ef4444', color: '#fff' },
  footer: { padding: '16px', textAlign: 'center', fontSize: 12, color: '#6b7280' },
};
