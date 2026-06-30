import { useState } from 'react';
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
  const { connected, connecting, connectPhase, error, needTapToPlay, start, stop, resumePlay } = useVoiceRtc();
  const voiceStatus = useAppStore((s) => s.voiceStatus);
  const subtitle = useAppStore((s) => s.subtitle);
  const userSubtitle = useAppStore((s) => s.userSubtitle);

  // [临时·mic-test] 验证 WKWebView 是否放行 getUserMedia（无需火山凭据）。命门验完即可删。
  const [micResult, setMicResult] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [micErr, setMicErr] = useState('');
  const testMic = async () => {
    setMicResult('testing');
    setMicErr('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop()); // 停掉测试流，PulseOrb 自己会再开
      setMicResult('ok');
    } catch (e) {
      setMicResult('fail');
      setMicErr(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  };
  // 测麦克风成功后把律动球顶成 listening，直观看它是否随说话起伏。
  const orbPhase = micResult === 'ok' && voiceStatus === 'idle' ? 'listening' : voiceStatus;

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <h1 style={styles.title}>MyJavis</h1>
        <span style={styles.subtitle}>实时语音助手 · 火山 RTC 骨架</span>
      </header>

      <main style={styles.main}>
        <PulseOrb phase={orbPhase} label={connecting ? PHASE_LABEL[connectPhase] ?? '连接中…' : STATUS_LABEL[orbPhase]} />

        {/* [临时·mic-test] 验 WKWebView getUserMedia 命门，验完删此块 */}
        <div style={styles.micTest}>
          <button style={{ ...styles.btn, ...styles.btnMic }} disabled={micResult === 'testing'} onClick={() => void testMic()}>
            🎤 {micResult === 'testing' ? '请求麦克风中…' : '测麦克风 (getUserMedia)'}
          </button>
          {micResult === 'ok' && <p style={styles.micOk}>✅ getUserMedia 成功，麦克风已授权。对着说话，律动球应随声起伏。</p>}
          {micResult === 'fail' && <p style={styles.micFail}>❌ getUserMedia 失败：{micErr}（WKWebView 拒绝媒体捕获，需补 webview 权限处理）</p>}
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

        <GovernancePanel />
      </main>

      <footer style={styles.footer}>
        需配置 <code>.env</code> 火山 RTC/ASR/TTS 后方可真机对话 · Pulse 本批使用本地麦克风电平占位
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
  captions: { minHeight: 64, maxWidth: 520, textAlign: 'center' },
  userLine: { margin: '6px 0', color: '#93c5fd', fontSize: 15 },
  botLine: { margin: '6px 0', color: '#e5e7eb', fontSize: 17 },
  error: { color: '#f87171', fontSize: 14 },
  tapBtn: { padding: '10px 20px', borderRadius: 999, border: 'none', background: '#f59e0b', color: '#111', fontWeight: 600, cursor: 'pointer' },
  btn: { padding: '14px 40px', borderRadius: 999, border: 'none', fontSize: 16, fontWeight: 700, cursor: 'pointer' },
  btnPrimary: { background: '#22c55e', color: '#04210f' },
  btnStop: { background: '#ef4444', color: '#fff' },
  micTest: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, maxWidth: 520, textAlign: 'center' },
  btnMic: { background: '#38bdf8', color: '#04210f', padding: '12px 28px', fontSize: 15 },
  micOk: { color: '#4ade80', fontSize: 14, margin: 0 },
  micFail: { color: '#f87171', fontSize: 14, margin: 0 },
  footer: { padding: '16px', textAlign: 'center', fontSize: 12, color: '#6b7280' },
};
