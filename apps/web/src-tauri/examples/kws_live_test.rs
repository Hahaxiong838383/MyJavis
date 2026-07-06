//! KWS 声学链路 live 验收：真麦克风监听 N 秒，期间外部（afplay）播放唤醒词音频，
//! 验证"扬声器→空气→麦克风→cpal→sherpa KWS"完整声学回路。
//!
//! 用法: cargo run --release --example kws_live_test -- [秒数,默认10]
//! 命中即打印 DETECTED 并以 0 退出；超时未命中以 1 退出。

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use sherpa_onnx::{KeywordSpotter, KeywordSpotterConfig};
use std::sync::mpsc;

fn main() {
    let secs: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(10);
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/kws");
    let p = |n: &str| dir.join(n).to_string_lossy().into_owned();

    let mut config = KeywordSpotterConfig::default();
    config.model_config.transducer.encoder = Some(p("encoder.int8.onnx"));
    config.model_config.transducer.decoder = Some(p("decoder.onnx"));
    config.model_config.transducer.joiner = Some(p("joiner.int8.onnx"));
    config.model_config.tokens = Some(p("tokens.txt"));
    config.model_config.provider = Some("cpu".into());
    config.model_config.num_threads = 1;
    config.keywords_file = Some(p("keywords.txt"));
    let kws = KeywordSpotter::create(&config).expect("KWS 创建失败");
    let stream_s = kws.create_stream();

    let host = cpal::default_host();
    let device = host.default_input_device().expect("无输入设备");
    let supported = device.default_input_config().expect("读配置失败");
    let cfg = supported.config();
    let channels = cfg.channels as usize;
    let rate = cfg.sample_rate.0 as i32;
    println!("listening {}s on {} ({}Hz)...", secs, device.name().unwrap_or_default(), rate);

    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let err_fn = |e| eprintln!("stream err: {e:?}");
    let audio = match supported.sample_format() {
        SampleFormat::F32 => device
            .build_input_stream(
                &cfg,
                move |data: &[f32], _| {
                    let mono: Vec<f32> = data
                        .chunks(channels)
                        .map(|f| f.iter().copied().sum::<f32>() / channels as f32)
                        .collect();
                    let _ = tx.send(mono);
                },
                err_fn,
                None,
            )
            .expect("建流失败"),
        other => panic!("unsupported {other:?}"),
    };
    audio.play().expect("play失败");

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    while std::time::Instant::now() < deadline {
        if let Ok(samples) = rx.recv_timeout(std::time::Duration::from_millis(100)) {
            stream_s.accept_waveform(rate, &samples);
            while kws.is_ready(&stream_s) {
                kws.decode(&stream_s);
                if let Some(r) = kws.get_result(&stream_s) {
                    if !r.keyword.is_empty() {
                        println!("DETECTED: {}", r.keyword);
                        std::process::exit(0);
                    }
                }
            }
        }
    }
    println!("TIMEOUT (no keyword detected in {secs}s)");
    std::process::exit(1);
}
