import { useEffect, useState } from 'react';
import { useVoiceSession } from './useVoiceSession';
import { startVisionProbe } from './vision-bridge';
import { useVoiceprintEnroll } from './useVoiceprintEnroll';
import { useMusicGuard } from './useMusicGuard';
import { useReminderDelivery } from './useReminders';
import { useSyncVersions } from './useSyncVersions';
import { useMemoryGuidanceBanner } from './useMemoryGuidance';
import { useAppStore } from './store';
import { currentApiKey } from './api';
import { PulseOrb } from './components/PulseOrb';
import { GovernancePanel } from './components/GovernancePanel';
import { VoiceprintPanel } from './components/VoiceprintPanel';
import { ReminderPanel } from './components/ReminderPanel';
import { PrivacyVaultPanel } from './components/PrivacyVaultPanel';
import { MemoryActivityPanel } from './components/MemoryActivityPanel';
import { ConversationHistoryPanel } from './components/ConversationHistoryPanel';
import { usePrivacyVaultSync, useSessionContextPush } from './usePrivacyVault';
import { useMemoryRefineConsumer } from './useMemoryRefine';
import { MusicPlayer } from './components/MusicPlayer';
import { ActivationGate } from './components/ActivationGate';
import { SettingsPanel } from './components/SettingsPanel';
import { UpdateBanner } from './components/UpdateBanner';

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
  // 激活门（批次B）：无鉴权 key（分发版首启）→ 邀请码激活页；dev 带 VITE key 直进主界面。
  // UpdateBanner 在门外（顶层）：未激活的用户也要能收到更新。
  const [activated, setActivated] = useState(() => Boolean(currentApiKey()));
  return (
    <>
      <UpdateBanner />
      {activated ? <MainApp /> : <ActivationGate onActivated={() => setActivated(true)} />}
    </>
  );
}

function MainApp() {
  const { connected, connecting, connectPhase, error, needTapToPlay, roomId, start, stop, resumePlay, getAudioTrack, setMicMuted, engine } =
    useVoiceSession();
  const enroll = useVoiceprintEnroll({ connected, roomId, getAudioTrack });
  const { guardState, wake, waking, kwsStatus } = useMusicGuard({ connected, roomId, setMicMuted });
  useReminderDelivery(); // 提醒触达档2：独立于通话的轮询（通知+念出）
  useSyncVersions(); // UI 同步：语音/调度器改了数据 → 面板 ≤5s 自动刷新
  usePrivacyVaultSync(); // R2 隐私 vault：拉取云端 hold → 本机落库 → server 即焚
  useSessionContextPush(connected, roomId); // R2 通话注入：vault 上行 server 内存，挂断即弃
  useMemoryRefineConsumer(); // R4 提炼代理：通话结束 5min 静默后本机 vault 批次→server→写回
  // 视觉常开（0.17.2 川哥拍板）：App 启动即拉起探针，不再随通话启停（App 退出/开关关才停）
  useEffect(() => {
    void startVisionProbe();
  }, []);
  const memoryGuidance = useMemoryGuidanceBanner(); // 零声纹引导：家庭模式=⚠️记忆未激活警示 / 单人模式=💡温和引导
  const voiceStatus = useAppStore((s) => s.voiceStatus);
  const subtitle = useAppStore((s) => s.subtitle);
  const userSubtitle = useAppStore((s) => s.userSubtitle);
  const speakerName = useAppStore((s) => s.speakerName);

  // 守护态标签按 KWS 可用性区分：桌面 App KWS 正常=喊贾维斯/直接说控制词；异常/浏览器=点球兜底
  const guardedLabel =
    kwsStatus === 'active' ? '听歌中 · 喊"贾维斯贾维斯"唤醒，说"下一首"换歌' : '听歌中 · 点我唤醒 Javis';
  const orbLabel = connecting
    ? PHASE_LABEL[connectPhase] ?? '连接中…'
    : waking
      ? '唤醒中…'
      : guardState === 'guarded'
        ? guardedLabel
        : STATUS_LABEL[voiceStatus];

  return (
    <div style={styles.page}>
      {/* 设置入口（0.15.1）：面板藏在滚动流里被川哥实测找不到——固定右上角一键直达。
          smooth 后 350ms 没接近目标就 instant 兜底（视口异常时 smooth 会静默不滚）。 */}
      <button
        style={styles.settingsFab}
        title="设置"
        aria-label="打开设置"
        onClick={() => {
          const el = document.getElementById('settings-panel');
          if (!el) return;
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          window.setTimeout(() => {
            if (Math.abs(el.getBoundingClientRect().top) > 120) el.scrollIntoView({ block: 'start' });
          }, 350);
        }}
      >
        ⚙️
      </button>
      <div
        style={{ ...styles.orbZone, cursor: guardState === 'guarded' ? 'pointer' : 'default' }}
        onClick={() => {
          if (guardState === 'guarded') wake();
        }}
      >
        <PulseOrb phase={voiceStatus} label={orbLabel} getAudioTrack={getAudioTrack} />
      </div>

      {memoryGuidance === 'family' && (
        <div style={styles.guidanceBanner}>⚠️ 记忆功能未激活：还没有注册声纹。通话中说"我是XX，记住我的声音"</div>
      )}
      {memoryGuidance === 'solo' && (
        <div style={styles.guidanceBannerSoft}>
          💡 还没注册声纹——通话中说"我是XX，记住我的声音"，Javis 就能听声认人、用名字称呼你
        </div>
      )}

      {/* 播放条紧贴脉冲球下方、无边框融背景（2026-07-06 川哥拍板）；audio 元素也在组件内 */}
      <MusicPlayer roomId={roomId} connected={connected} />

      <main style={styles.main}>
        {enroll && (enroll.state === 'recording' || enroll.state === 'uploading') && (
          <div style={styles.enrollBar}>
            {enroll.state === 'recording' ? (
              <>
                正在记住 {enroll.displayName} 的声音 · {Math.min(enroll.effectiveSec, enroll.targetSec).toFixed(0)}/
                {enroll.targetSec}s
                <span style={styles.enrollTrack}>
                  <span
                    style={{
                      ...styles.enrollFill,
                      width: `${Math.min(100, (enroll.effectiveSec / enroll.targetSec) * 100)}%`,
                    }}
                  />
                </span>
              </>
            ) : (
              <>正在记录 {enroll.displayName} 的声纹…</>
            )}
          </div>
        )}

        <div style={styles.captions}>
          {userSubtitle && (
            <p style={styles.userLine}>
              <b>{speakerName || '你'}：</b>
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

        <SettingsPanel />
        <MemoryActivityPanel />
        <ConversationHistoryPanel />
        <ReminderPanel />
        <VoiceprintPanel />
        <PrivacyVaultPanel />
        <GovernancePanel />
      </main>

      <footer style={styles.footer}>
        Pulse 由 RTC 双向真实声音驱动（我说话=麦克风轨 · Javis 说话=TTS 轨 · 音量/音调/停顿实时映射）
        <span style={styles.version}>
          MyJavis v{__APP_VERSION__} · 链路：{engine === 'indie' ? '自研' : 'benchmark'}
        </span>
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
  guidanceBanner: {
    alignSelf: 'center',
    maxWidth: 520,
    margin: '0 24px 14px',
    padding: '10px 16px',
    borderRadius: 14,
    background: 'rgba(251,191,36,0.12)',
    border: '1px solid rgba(251,191,36,0.35)',
    color: '#fbbf24',
    fontSize: 13,
    textAlign: 'center',
  },
  // solo 版引导：温和提示（记忆本身已工作，只是推荐注册声纹），低调不抢戏
  guidanceBannerSoft: {
    alignSelf: 'center',
    maxWidth: 520,
    margin: '0 24px 14px',
    padding: '9px 16px',
    borderRadius: 14,
    background: 'rgba(103,232,249,0.08)',
    border: '1px solid rgba(103,232,249,0.22)',
    color: '#a5f3fc',
    fontSize: 12.5,
    textAlign: 'center',
  },
  // 右上角固定设置入口：半透明圆钮浮在律动球上方，不参与滚动流
  settingsFab: {
    position: 'fixed',
    top: 14,
    right: 16,
    zIndex: 50,
    width: 40,
    height: 40,
    borderRadius: 999,
    border: '1px solid rgba(148,163,184,.22)',
    background: 'rgba(15,23,42,.55)',
    color: '#e5e7eb',
    fontSize: 18,
    lineHeight: 1,
    cursor: 'pointer',
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
  },
  captions: { minHeight: 64, maxWidth: 520, textAlign: 'center' },
  userLine: { margin: '6px 0', color: '#93c5fd', fontSize: 15 },
  botLine: { margin: '6px 0', color: '#e5e7eb', fontSize: 17 },
  error: { color: '#f87171', fontSize: 14 },
  enrollBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 16px',
    borderRadius: 999,
    background: 'rgba(34,197,94,0.12)',
    border: '1px solid rgba(34,197,94,0.35)',
    color: '#86efac',
    fontSize: 13,
  },
  enrollTrack: {
    display: 'inline-block',
    width: 90,
    height: 4,
    borderRadius: 2,
    background: 'rgba(134,239,172,0.2)',
    overflow: 'hidden',
  },
  enrollFill: { display: 'block', height: '100%', background: '#22c55e', transition: 'width 0.3s' },
  tapBtn: { padding: '10px 20px', borderRadius: 999, border: 'none', background: '#f59e0b', color: '#111', fontWeight: 600, cursor: 'pointer' },
  btn: { padding: '14px 40px', borderRadius: 999, border: 'none', fontSize: 16, fontWeight: 700, cursor: 'pointer' },
  btnPrimary: { background: '#22c55e', color: '#04210f' },
  btnStop: { background: '#ef4444', color: '#fff' },
  footer: {
    padding: '16px',
    textAlign: 'center',
    fontSize: 12,
    color: '#6b7280',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  version: { color: '#4b5563', fontSize: 11, letterSpacing: 0.5 },
};
