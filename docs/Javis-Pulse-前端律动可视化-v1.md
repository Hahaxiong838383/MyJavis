# Javis 前端产品定义 — 律动可视化层 v1

> 对应实现:`javis-pulse-v1.html`(居中发光球 + 横向波浪线,实时响应音量/音调/律动)。
> 本文件是可集成规格:信号定义、视觉映射、对外接口、接入步骤都与该实现一一对应,可直接整合进项目。

---

## 0. 概述与边界

### 0.1 它是什么
Javis 的**说话状态可视化层**:一个抽象的、由语音实时驱动的发光律动体。它表现"Javis 在听 / 在想 / 在说"的状态与声学能量,**不是人脸、不绑定骨骼、无需任何素材或模型**。

### 0.2 边界(与后端解耦)
```
Agent ──(状态 phase + 音频流/电平)──▶ 律动可视化层
可视化层 ──(无)──▶ Agent          # 纯展示, 不读写任何业务/记忆数据
```
它只消费两样东西:**对话状态** 和 **一路音频**。其余一概不依赖。

### 0.3 设计原则
- **轻、纯前端、零素材**:Canvas 2D,无外部资源,Mac/任意浏览器即跑。
- **音频驱动**:所有动态来自实时声学量,不写死动画。
- **可作底座**:即便日后上点云脸,这个律动体也可作为 idle/listening 状态或脸周围的能量场复用。

---

## 1. 视觉规格(来自 v1 实现)

| 元素 | 规格 |
|---|---|
| **主体** | 屏幕**正中央**一颗发光球,边界由多频正弦叠加 → 有机起伏(非死圆) |
| **横向波浪线** | 穿过球心、横贯画面的流动波浪线(随音量起伏) |
| **涟漪环** | 每次起音从球心向外扩散的环,逐渐淡出 |
| **核心高光** | 球心放射状高光,音量/律动峰值时转白热 |
| **环境辉光** | 球周围淡淡的径向光晕 |
| **配色** | 深色底(`#04060c`),冷色系青(色相随音调在冷色内微移),峰值转白 |
| **质感** | 清晰描边 + 加法混合(`lighter`)+ 轻微运动拖尾(persistence) |
| **居中** | 球心 = 视口正中 `(W/2, H/2)`,波浪线与涟漪同心 |

---

## 2. 三个声学信号(定义与计算)

可视化层内部维护三个归一化标量(0..1),平滑后驱动画面。Web Audio `AnalyserNode`(`fftSize=2048`)即可全部得到。

| 信号 | 含义 | 计算 | 平滑 |
|---|---|---|---|
| **volume 音量** | 响度 | 时域 RMS × 3.4,clamp 0..1 | 快起慢落:`v += (t-v)*(t>v?0.4:0.12)` |
| **pitch 音调** | 音高/音色 | 频域**谱质心**归一 × 2.2,clamp | `p += (t-p)*0.08` |
| **rhythm 律动** | 音节冲击 | **起音检测**:`vol>0.18 && Δvol>0.06 && 距上次>0.12s` → 触发 | 触发后 `*=0.92` 衰减 |

> 注:v1 用谱质心作"音调"代理(便宜稳定)。若你的 TTS 能给基频/音素,可替换为更准的 pitch,不影响下游映射。

---

## 3. 信号 → 视觉映射(与 v1 数值一致)

| 信号 | 视觉反馈 | 实现量 |
|---|---|---|
| **volume** | 球体胀大 + 波幅变大 + 整体变亮 | 半径 `×(1+vol*0.55)`;波幅 `6+vol*70`;亮度随 vol |
| **pitch** | 冷色系内色相微移 + 波瓣疏密 | 色相 `200 - pitch*55`;波瓣数 `3 + round(pitch*8)` |
| **rhythm(起音)** | 向外扩散涟漪 + 核心白热闪动 | 生成 ripple;`flash = vol*0.7 + rhythm*0.6` → 核心变白 |
| 静默 | 轻微呼吸,不死 | 半径叠加 `sin(t*0.9)*R*0.03` |

---

## 4. 视觉状态机

可视化层对外暴露一个 `phase`,内部据此选择驱动源与基调。

```
   ┌────────┐  vad/唤醒   ┌───────────┐
   │  IDLE  │ ─────────▶ │ LISTENING │
   │ 呼吸    │ ◀──超时──  │ 麦克风驱动  │
   └────────┘            └─────┬─────┘
       ▲                       │ 用户说完
       │ 说完/打断               ▼
   ┌───┴────┐ 首token/TTS  ┌──────────┐
   │SPEAKING│ ◀────────── │ THINKING │
   │ TTS驱动 │             │ 低能量起伏 │
   └────────┘             └──────────┘
```

| phase | 驱动源 | v1 现状 |
|---|---|---|
| idle | 无(呼吸) | ✅ 已有 |
| listening | 麦克风 RMS | ✅ 已有(mic 模式) |
| speaking | TTS 音频 RMS | ✅ 引擎已有(现由合成包络驱动,接 TTS 即可) |
| thinking | 低能量 + 轻扰动 | ⬜ 待加(可在 idle 基础上加一档"思考"运动) |

> v1 已实现 idle / 由音频驱动(speaking/listening)两态;`thinking` 是集成时建议补的一个轻量变体。

---

## 5. 集成接口(对外契约)

把 v1 的 IIFE 重构成一个可挂载组件,建议接口:

```ts
interface JavisPulse {
  mount(canvas: HTMLCanvasElement): void;          // 挂到你的画布
  setPhase(p: 'idle'|'listening'|'thinking'|'speaking'): void;

  // 接入音频 —— 二选一:
  // A) 给一路音频源, 组件自己做分析(推荐, 内部已有 AnalyserNode 逻辑)
  connectAudio(src: MediaStream | MediaStreamAudioSourceNode | HTMLAudioElement): void;
  disconnectAudio(): void;
  // B) 你在别处已经算好信号, 直接喂(组件不再自己分析)
  pushSignals(s: { volume:number; pitch:number; onset?:boolean }): void;

  setTheme(t: Partial<Theme>): void;               // 调色/手感
  destroy(): void;                                  // 卸载, 释放 rAF/音频
}
```

数据契约(从 Agent 订阅,纯消费):
```ts
type AgentSignal =
  | { type:'phase'; value:'idle'|'listening'|'thinking'|'speaking' }
  | { type:'audio'; source: MediaStream }   // 说话时=TTS输出; 聆听时=麦克风
```
即:**Agent 只需告诉它"现在什么状态"和"给哪一路音频"**,其余可视化层自理。

---

## 6. 接真实音频(把合成换成 TTS / 麦克风)

v1 里 `mode='speak'` 用的是合成语音包络 `synth(t)`;集成时换成真实音频即可,**下游映射一律不动**:

- **Javis 说话**:把 TTS 播放的音频接进 `AnalyserNode`
  ```js
  const src = audioCtx.createMediaElementSource(ttsAudioEl); // 或 MediaStreamSource
  src.connect(analyser); src.connect(audioCtx.destination);
  ```
  然后 `micRead()` 那段同样的 RMS + 谱质心逻辑直接复用,驱动 volume/pitch/rhythm。
- **用户说话(聆听)**:沿用 v1 的麦克风路径(`getUserMedia` → AnalyserNode)。
- **A/V 对齐**:用同一个 `AudioContext`,可视化读取的就是正在播放的那一路,天然同步。

---

## 7. 渲染与性能

- **Canvas 2D**,`requestAnimationFrame` 60fps;`devicePixelRatio` 封顶 2。
- 合成方式:`globalCompositeOperation='lighter'`(加法发光)+ 每帧 `rgba(void,0.30)` 暗色叠加做**运动拖尾**。
- 单帧绘制量很小(两层球路径 + 一条波浪 + 少量涟漪环),CPU/GPU 压力极低,Mac 上随便跑。
- 尊重 `prefers-reduced-motion`(可降低呼吸/拖尾幅度)。

---

## 8. 可调参数(主题与手感旋钮)

集成时建议把这些抽成 `Theme` 配置,方便调:

| 参数 | v1 默认 | 作用 |
|---|---|---|
| 底色 | `#04060c` | 背景 |
| 基色相 | `200 - pitch*55` | 冷色系起点与音调跨度 |
| 球基准半径 | `min(W,H)*0.16` | 球大小 |
| 半径增益 | `*(1+vol*0.55)` | 音量对胀大的影响 |
| 波幅 | `6 + vol*70` | 边界起伏强度 |
| 波瓣数 | `3 + round(pitch*8)` | 音调对疏密的影响 |
| 拖尾 | `0.30` | 越小越"拖"、越雾 |
| 描边 | `lineWidth 1.4` | 线条清晰度(这版是清晰描边,无模糊) |
| 起音阈值 | `vol>0.18, Δ>0.06, 0.12s` | 律动灵敏度 |

---

## 9. 集成步骤

1. 把 v1 `<script>` 里的逻辑抽成模块(`JavisPulse`),对外暴露 §5 接口。
2. 在你的 UI 里放一个 `<canvas>`,`mount()` 上去。
3. 对话引擎状态变化时调 `setPhase(...)`。
4. 说话时把 TTS 音频、聆听时把麦克风 `connectAudio(...)`;若你已有自己的信号分析,改用 `pushSignals(...)`。
5. 主题用 `setTheme(...)` 按品牌调;退出时 `destroy()`。

---

## 10. 非目标

- ✗ 不是人脸 / avatar / lipsync(那是后续可选方向,与本层解耦)。
- ✗ 不读写记忆或任何业务数据,只消费 phase + 音频。
- ✗ 不依赖任何外部素材、模型或服务。
- ✗ v1 不做模糊 bloom(本版是清晰描边质感;柔化版是另一个文件,按需切换)。

---

## 11. 路线图

- **v1(本版,已定):** 居中律动球 + 波浪线,音量/音调/律动实时反馈。接 TTS/mic、补 thinking 态即可上线。
- **v1.1:** 补 `thinking` 视觉、接真实 TTS 流、抽成可配置组件 + 主题。
- **v2(可选):** 与点云脸方向融合——脸为主体、律动球作为环绕能量场 / 非说话态表达。

---

## 12. 开放问题

- **thinking 态长什么样**:在 idle 基础上加何种轻扰动,需定。
- **音调信号精度**:用谱质心够不够,还是接 TTS 基频/音素。
- **主题**:最终配色(是否沿用青色、要不要随场景换色)。
- **多状态切换的过渡**:phase 切换时的缓动时长与方式。

---

### 一句话
v1 = **一颗居中的、由语音实时驱动的发光律动球**;集成只需做两件事:**告诉它 phase、给它一路音频**。下游所有视觉反馈(音量胀大、音调变色、律动涟漪)都已就绪,接上即用。

---

## 13. MyJavis × 火山 RTC 集成附注(cc 2026-06-30 · 已验证火山官方文档)

MyJavis 走火山 AIGC-RTC 全双工,音频 I/O 在火山 SDK,**无需自己 getUserMedia/AnalyserNode**——两个输入信号火山原生提供,走 §5 的 `pushSignals()` 路径即可:

**① phase —— 零成本,已就绪。** `useVoiceRtc` 已从火山二进制消息(`conv`)解析出 AI 状态机 listening/thinking/speaking(火山 `AGENT_BRIEF`),直接 `pulse.setPhase(voiceStatus)`。**连 §4 标"⬜待加"的 thinking 态,火山都给了状态**(只需补 thinking 的视觉变体)。

**② 三个声学信号 —— 火山音频属性报告原生提供(已验证·RTC 文档 `AudioPropertiesConfig`/`AudioPropertiesInfo`,页 2266/2439–2440):**

开 `enableAudioPropertiesReport({ interval: 100, enableSpectrum: true, enableVoicePitch: true })`,监听 `onLocalAudioPropertiesReport`(麦克风/聆听态)与 `onRemoteAudioPropertiesReport`(机器人 TTS/说话态):

| pulse 信号 | 火山字段 | 换算 |
|---|---|---|
| **volume** | `AudioPropertiesInfo.linearVolume` [0,255] | `volume = linearVolume/255` |
| **pitch** | `voicePitch`(开 enableVoicePitch,直接基频) 或 `spectrum`(float[] 频谱→算谱质心) | 归一到 0..1(比 §2 谱质心代理更准) |
| **rhythm** | 由 volume 帧间上升沿推(§2 onset 逻辑不变) | `pushSignals` 时给 `onset` 或 pulse 内部算 |

→ 按 phase 选音源:**speaking 用 remote(bot) 报告,listening 用 local(mic) 报告**,`pulse.pushSignals({ volume, pitch, onset })`。A/V 天然同步(读的就是火山正在播/采的那一路)。

**路径取舍**:火山音频属性报告(`pushSignals`)= 推荐(零额外音频管线、原生同步);§5 路径 A(`connectAudio` 自建 AnalyserNode 抽火山 remote/local `MediaStreamTrack`)= 备选,仅当要更细控制再用,需核实火山 Web SDK 取轨 API。

**解耦不变**:律动层仍只消费 phase + 信号,不碰记忆/声纹/业务数据(§0.2 / §10 红线照旧)。声纹身份(`voiceprintName`)、字幕等属另一套 UI,与律动球同层并列、互不依赖。

> 详见 [`ARCHITECTURE-v2.md`](ARCHITECTURE-v2.md) §11 前端表现层。
