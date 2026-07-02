import { useVoiceRtc } from './useVoiceRtc';
import { useAppStore } from './store';
import { PulseOrb } from './components/PulseOrb';
import { GovernancePanel } from './components/GovernancePanel';

const STATUS_LABEL: Record<string, string> = {
  idle: '未连接',
  listening: '在听…',
  thinking: '思考中…',
  speaking: '说话中…',
};

const PHASE_LABEL: Record<string, string> = {
  starting: '起服务…',
  loading: '加载语音引擎…',
  joining: '进入房间…',
};

export default function App() {
  const { connected, connecting, connectPhase, error, needTapToPlay, start, stop, resumePlay, getAudioTrack } =
    useVoiceRtc();
  const voiceStatus = useAppStore((s) => s.voiceStatus);
  const subtitle = useAppStore((s) => s.subtitle);
  const userSubtitle = useAppStore((s) => s.userSubtitle);

  return (
    <div style={styles.page}>
      <div style={styles.orbZone}>
        <PulseOrb
          phase={voiceStatus}
          label={connecting ? PHASE_LABEL[connectPhase] ?? '连接中…' : STATUS_LABEL[voiceStatus]}
          getAudioTrack={getAudioTrack}
        />
      </div>

      <main style={styles.main}>

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

        <GovernancePanel />
      </main>

      <footer style={styles.footer}>
        Pulse 由 RTC 双向真实声音驱动（我说话=麦克风轨 · Javis 说话=TTS 轨 · 音量/音调/停顿实时映射）
      </footer>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100dvh',
    display: 'flex',
    flexDirection: 'column',
    // 与 PulseOrb 画布世界同色：脉冲区顶满边缘后整个 app 融为一体（连贯氛围）
    background: '#04060c',
    color: '#e5e7eb',
    fontFamily: 'system-ui, -apple-system, "PingFang SC", sans-serif',
  },
  // 脉冲区：顶部+两侧顶满 app 边缘，占上半屏
  orbZone: { width: '100%', height: 'min(58dvh, 560px)', flexShrink: 0 },
  main: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22, padding: '8px 24px 24px' },
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
