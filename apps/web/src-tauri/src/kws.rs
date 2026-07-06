//! 贾维斯唤醒词检测（KWS）——共存设计 §8 步 3。
//!
//! sherpa-onnx 官方 Rust API（v1.13.3，官方 crate，社区 sherpa-rs 已于 2026-06 弃用）。
//!
//! 两种采音模式（2026-07-06 数字混合实验后重构）：
//!  - fed（首选）：WebView 侧 getUserMedia({echoCancellation:true}) 采麦，经 kws_feed
//!    IPC 喂样本。AEC 把 App 自播的音乐从 mic 信号里消掉——离线混合实验实锤：音乐叠加
//!    超过人声 ~0.2x 时 KWS 全灭（threshold 0.04 都救不回），纯调参是死路；AEC 才是
//!    智能音箱的正解（realtime-voice-agent 免 KWS 靠的就是同款浏览器 AEC，有真机先例）。
//!  - cpal（降级）：Rust 直采麦克风（无 AEC）。WebView 采麦失败时的兜底，音乐外放下
//!    命中率低，安静环境可用。
//!
//! 生命周期：前端 useMusicGuard 在 guarded（听歌守护态）进入时 invoke kws_start、
//! 退出时 invoke kws_stop——惰性运行省 CPU，且守护态无 TTS，天然免"助手自己说出
//! 唤醒词自触发"（codex 第一轮评审点）。命中 emit "kws-wake" 事件给前端，
//! useMusicGuard 分流：唤醒词走 wake()（与点球 PTT 同一入口）、控制词本地直控播放器。
//!
//! cpal Stream 在 macOS 上 !Send：stream 的创建与销毁都圈在专属线程内，
//! 线程间只传 AtomicBool 停止旗标与音频样本（mpsc）。

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use serde::Serialize;
use sherpa_onnx::{KeywordSpotter, KeywordSpotterConfig};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct KwsManager {
    inner: Mutex<Option<KwsHandle>>,
}

struct KwsHandle {
    running: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    /// fed 模式下前端样本入口（cpal 模式为 None）
    feed: Option<FeedChannel>,
}

struct FeedChannel {
    tx: mpsc::Sender<Vec<f32>>,
}

#[derive(Clone, Serialize)]
struct WakePayload {
    keyword: String,
}

/// 解析打包进 .app 的模型资源目录（dev 模式下解析到 src-tauri/resources/kws）。
fn resolve_model_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .resolve("resources/kws", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("解析 KWS 资源目录失败: {e}"))
}

#[tauri::command]
pub fn kws_start(
    app: AppHandle,
    state: tauri::State<'_, KwsManager>,
    mode: Option<String>,
    sample_rate: Option<i32>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(()); // 幂等：已在跑
    }

    let dir = resolve_model_dir(&app)?;
    let p = |name: &str| -> Result<String, String> {
        let full = dir.join(name);
        if !full.exists() {
            return Err(format!("KWS 资源缺失: {}", full.display()));
        }
        Ok(full.to_string_lossy().into_owned())
    };
    let encoder = p("encoder.int8.onnx")?;
    let decoder = p("decoder.onnx")?;
    let joiner = p("joiner.int8.onnx")?;
    let tokens = p("tokens.txt")?;
    let keywords = p("keywords.txt")?;

    let running = Arc::new(AtomicBool::new(true));
    let running_thread = running.clone();
    let fed = mode.as_deref() == Some("fed");
    let rate = sample_rate.unwrap_or(16000);

    // fed 模式：样本从前端 IPC 来（WebView AEC 采麦）；cpal 模式：线程内自建 mic stream
    let feed = if fed {
        let (tx, rx) = mpsc::channel::<Vec<f32>>();
        let thread = std::thread::Builder::new()
            .name("kws-fed".into())
            .spawn(move || {
                if let Err(e) = run_kws_fed(&app, running_thread.clone(), rx, rate, encoder, decoder, joiner, tokens, keywords) {
                    eprintln!("[kws] runtime error: {e}");
                    let _ = app.emit("kws-error", e);
                }
                running_thread.store(false, Ordering::SeqCst);
            })
            .map_err(|e| format!("KWS 线程启动失败: {e}"))?;
        *guard = Some(KwsHandle {
            running,
            thread: Some(thread),
            feed: Some(FeedChannel { tx }),
        });
        println!("[kws] started (fed mode, rate={rate})");
        return Ok(());
    } else {
        None
    };

    let thread = std::thread::Builder::new()
        .name("kws".into())
        .spawn(move || {
            if let Err(e) = run_kws(&app, running_thread.clone(), encoder, decoder, joiner, tokens, keywords) {
                eprintln!("[kws] runtime error: {e}");
                let _ = app.emit("kws-error", e);
            }
            running_thread.store(false, Ordering::SeqCst);
        })
        .map_err(|e| format!("KWS 线程启动失败: {e}"))?;

    *guard = Some(KwsHandle {
        running,
        thread: Some(thread),
        feed,
    });
    println!("[kws] started (cpal mode)");
    Ok(())
}

/// fed 模式的样本入口：WebView AEC 采麦 → AudioWorklet → 每 ~128ms 一包 f32。
/// stop 竞态期间静默丢包（引擎已停，无需报错）。
#[tauri::command]
pub fn kws_feed(state: tauri::State<'_, KwsManager>, samples: Vec<f32>) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(h) = guard.as_ref() {
        if let Some(f) = h.feed.as_ref() {
            let _ = f.tx.send(samples);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn kws_stop(state: tauri::State<'_, KwsManager>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(mut h) = guard.take() {
        h.running.store(false, Ordering::SeqCst);
        h.feed = None; // 断开 feed 通道（Sender drop → 循环 Disconnected 退出）
        if let Some(t) = h.thread.take() {
            let _ = t.join();
        }
        println!("[kws] stopped");
    }
    Ok(())
}

/// 引擎创建（fed/cpal 共用）。
fn create_engine(
    encoder: String,
    decoder: String,
    joiner: String,
    tokens: String,
    keywords: String,
) -> Result<KeywordSpotter, String> {
    let mut config = KeywordSpotterConfig::default();
    config.model_config.transducer.encoder = Some(encoder);
    config.model_config.transducer.decoder = Some(decoder);
    config.model_config.transducer.joiner = Some(joiner);
    config.model_config.tokens = Some(tokens);
    config.model_config.provider = Some("cpu".into());
    config.model_config.num_threads = 1;
    config.keywords_file = Some(keywords);
    // 灵敏度调优（2026-07-06）：漏检代价高（用户反复喊没反应）、误检代价低（误醒 =
    // duck 几秒 + 8s 无对话自动回守护），灵敏度优先。控制词/短词在 keywords.txt
    // 里用 #threshold 单独收紧防误触。
    config.keywords_score = 2.0;
    config.keywords_threshold = 0.15;
    KeywordSpotter::create(&config).ok_or_else(|| "KeywordSpotter 创建失败（模型/keywords 检查日志）".into())
}

/// decode + 命中上报（fed/cpal 共用）。
fn drain_decode(app: &AppHandle, kws: &KeywordSpotter, stream: &sherpa_onnx::OnlineStream) {
    while kws.is_ready(stream) {
        kws.decode(stream);
        if let Some(result) = kws.get_result(stream) {
            if !result.keyword.is_empty() {
                println!("[kws] detected: {}", result.keyword);
                let _ = app.emit(
                    "kws-wake",
                    WakePayload {
                        keyword: result.keyword.clone(),
                    },
                );
                kws.reset(stream);
            }
        }
    }
}

/// fed 模式主循环：消费前端喂来的 AEC 后样本。
#[allow(clippy::too_many_arguments)]
fn run_kws_fed(
    app: &AppHandle,
    running: Arc<AtomicBool>,
    rx: mpsc::Receiver<Vec<f32>>,
    sample_rate: i32,
    encoder: String,
    decoder: String,
    joiner: String,
    tokens: String,
    keywords: String,
) -> Result<(), String> {
    let kws = create_engine(encoder, decoder, joiner, tokens, keywords)?;
    let stream = kws.create_stream();
    while running.load(Ordering::SeqCst) {
        match rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(samples) => {
                stream.accept_waveform(sample_rate, &samples);
                drain_decode(app, &kws, &stream);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    Ok(())
}

/// cpal 直采主循环（降级路径：专属线程内建 cpal stream + 消费样本 + 解码；
/// 线程退出时 stream 一并 drop）。无 AEC——音乐外放下命中率低，安静环境可用。
fn run_kws(
    app: &AppHandle,
    running: Arc<AtomicBool>,
    encoder: String,
    decoder: String,
    joiner: String,
    tokens: String,
    keywords: String,
) -> Result<(), String> {
    let kws = create_engine(encoder, decoder, joiner, tokens, keywords)?;
    let stream = kws.create_stream();

    // —— cpal 采麦（官方 mic 示例姿势：默认设备原生配置，多声道下混 mono f32）——
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("无默认麦克风输入设备")?;
    let supported = device
        .default_input_config()
        .map_err(|e| format!("读取输入配置失败: {e}"))?;
    let cfg = supported.config();
    let sample_format = supported.sample_format();
    let channels = cfg.channels as usize;
    let device_rate = cfg.sample_rate.0 as i32;
    println!("[kws] mic: {:?} ch={} rate={}", sample_format, channels, device_rate);

    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let err_fn = |err| eprintln!("[kws] audio stream error: {err:?}");

    let audio_stream = match sample_format {
        SampleFormat::F32 => device
            .build_input_stream(
                &cfg,
                move |data: &[f32], _| {
                    if data.is_empty() {
                        return;
                    }
                    let mono: Vec<f32> = data
                        .chunks(channels)
                        .map(|f| f.iter().copied().sum::<f32>() / channels as f32)
                        .collect();
                    let _ = tx.send(mono);
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("建音频流失败: {e}"))?,
        SampleFormat::I16 => device
            .build_input_stream(
                &cfg,
                move |data: &[i16], _| {
                    if data.is_empty() {
                        return;
                    }
                    let mono: Vec<f32> = data
                        .chunks(channels)
                        .map(|f| f.iter().map(|&s| s as f32 / i16::MAX as f32).sum::<f32>() / channels as f32)
                        .collect();
                    let _ = tx.send(mono);
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("建音频流失败: {e}"))?,
        other => return Err(format!("不支持的采样格式: {other:?}")),
    };
    audio_stream.play().map_err(|e| format!("音频流启动失败: {e}"))?;

    // —— 消费循环：喂样本 → 解码 → 命中即 emit + reset ——
    while running.load(Ordering::SeqCst) {
        match rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(samples) => {
                stream.accept_waveform(device_rate, &samples);
                drain_decode(app, &kws, &stream);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    // audio_stream 随线程退出 drop（cpal Stream !Send，必须在本线程销毁）
    drop(audio_stream);
    Ok(())
}
