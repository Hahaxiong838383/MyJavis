//! 贾维斯唤醒词检测（KWS）——共存设计 §8 步 3。
//!
//! sherpa-onnx 官方 Rust API（v1.13.3，官方 crate，社区 sherpa-rs 已于 2026-06 弃用），
//! cpal 采麦为官方 rust-api-examples/streaming_zipformer_microphone.rs 同款姿势
//! （设备原生采样率直喂 accept_waveform、sherpa 内部重采样、多声道下混 mono f32）。
//!
//! 生命周期：前端 useMusicGuard 在 guarded（听歌守护态）进入时 invoke kws_start、
//! 退出时 invoke kws_stop——惰性运行省 CPU，且守护态无 TTS，天然免"助手自己说出
//! 唤醒词自触发"（codex 第一轮评审点）。命中 emit "kws-wake" 事件给前端，走
//! useMusicGuard.wake() 与点球 PTT 同一入口。
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
pub fn kws_start(app: AppHandle, state: tauri::State<'_, KwsManager>) -> Result<(), String> {
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
    });
    println!("[kws] started");
    Ok(())
}

#[tauri::command]
pub fn kws_stop(state: tauri::State<'_, KwsManager>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(mut h) = guard.take() {
        h.running.store(false, Ordering::SeqCst);
        if let Some(t) = h.thread.take() {
            let _ = t.join();
        }
        println!("[kws] stopped");
    }
    Ok(())
}

/// KWS 主循环（专属线程内：建 cpal stream + 消费样本 + 解码；线程退出时 stream 一并 drop）。
fn run_kws(
    app: &AppHandle,
    running: Arc<AtomicBool>,
    encoder: String,
    decoder: String,
    joiner: String,
    tokens: String,
    keywords: String,
) -> Result<(), String> {
    // —— sherpa KWS 引擎（官方示例同款配置）——
    let mut config = KeywordSpotterConfig::default();
    config.model_config.transducer.encoder = Some(encoder);
    config.model_config.transducer.decoder = Some(decoder);
    config.model_config.transducer.joiner = Some(joiner);
    config.model_config.tokens = Some(tokens);
    config.model_config.provider = Some("cpu".into());
    config.model_config.num_threads = 1;
    config.keywords_file = Some(keywords);

    let kws = KeywordSpotter::create(&config).ok_or("KeywordSpotter 创建失败（模型/keywords 检查日志）")?;
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
                while kws.is_ready(&stream) {
                    kws.decode(&stream);
                    if let Some(result) = kws.get_result(&stream) {
                        if !result.keyword.is_empty() {
                            println!("[kws] detected: {}", result.keyword);
                            let _ = app.emit(
                                "kws-wake",
                                WakePayload {
                                    keyword: result.keyword.clone(),
                                },
                            );
                            kws.reset(&stream);
                        }
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    // audio_stream 随线程退出 drop（cpal Stream !Send，必须在本线程销毁）
    drop(audio_stream);
    Ok(())
}
