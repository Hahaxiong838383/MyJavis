//! 麦克风采集冒烟：cpal 打开默认输入设备采 3 秒，报告样本数与音量 RMS。
//! 验证"cpal 在本机能真实拿到麦克风数据"这一层（与 WebView 同时采麦由真机验收）。
//! 用法: cargo run --example kws_mic_smoke

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use std::sync::mpsc;

fn main() {
    let host = cpal::default_host();
    let device = host.default_input_device().expect("无默认输入设备");
    println!("device: {}", device.name().unwrap_or_default());
    let supported = device.default_input_config().expect("读输入配置失败");
    let cfg = supported.config();
    let channels = cfg.channels as usize;
    println!("format={:?} ch={} rate={}", supported.sample_format(), channels, cfg.sample_rate.0);

    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let err_fn = |e| eprintln!("stream error: {e:?}");
    let stream = match supported.sample_format() {
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
        other => panic!("unsupported: {other:?}"),
    };
    stream.play().expect("play失败");

    let mut total = 0usize;
    let mut sum_sq = 0f64;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        if let Ok(samples) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
            total += samples.len();
            sum_sq += samples.iter().map(|&s| (s as f64) * (s as f64)).sum::<f64>();
        }
    }
    let rms = if total > 0 { (sum_sq / total as f64).sqrt() } else { 0.0 };
    println!("3s 采集: samples={total} rms={rms:.6}");
    if total > 0 {
        println!("PASS (cpal 采集路径通)");
    } else {
        println!("FAIL (未收到任何样本)");
        std::process::exit(1);
    }
}
