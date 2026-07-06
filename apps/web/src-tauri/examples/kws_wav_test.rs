//! KWS 离线验收：wav 直喂 KeywordSpotter，验证三条唤醒词命中/负例不误触发。
//!
//! 用法: cargo run --example kws_wav_test -- <wav文件> [期望命中|"NONE"]
//! 退出码: 0=符合期望, 1=不符合（CI/脚本可直接断言）。
//!
//! 绕开声学路径（扬声器→麦克风），只验证"引擎+模型+keywords.txt 配置"这一层的
//! 正确性——真机声学链路由川哥最终验收。

use sherpa_onnx::{KeywordSpotter, KeywordSpotterConfig, Wave};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("用法: kws_wav_test <wav> [期望命中关键词|NONE]");
        std::process::exit(2);
    }
    let wav_path = &args[1];
    let expect = args.get(2).map(String::as_str);

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
    // 与生产 kws.rs 同款灵敏度参数（音乐外放低 SNR 场景）——测试配置必须与生产一致；
    // env 可覆盖（KWS_SCORE/KWS_THRESHOLD）用于调参 A/B 对照实验
    config.keywords_score = std::env::var("KWS_SCORE").ok().and_then(|v| v.parse().ok()).unwrap_or(2.0);
    config.keywords_threshold = std::env::var("KWS_THRESHOLD").ok().and_then(|v| v.parse().ok()).unwrap_or(0.15);

    let kws = KeywordSpotter::create(&config).expect("KeywordSpotter 创建失败");
    let wave = Wave::read(wav_path).expect("读 wav 失败");

    let stream = kws.create_stream();
    let tail = vec![0.0f32; (wave.sample_rate() / 2) as usize];
    stream.accept_waveform(wave.sample_rate(), wave.samples());
    stream.accept_waveform(wave.sample_rate(), &tail);
    stream.input_finished();

    let mut detected: Vec<String> = Vec::new();
    while kws.is_ready(&stream) {
        kws.decode(&stream);
        if let Some(result) = kws.get_result(&stream) {
            if !result.keyword.is_empty() {
                detected.push(result.keyword.clone());
                kws.reset(&stream);
            }
        }
    }

    println!("wav={} detected={:?}", wav_path, detected);

    match expect {
        Some("NONE") => {
            if detected.is_empty() {
                println!("PASS (无误触发)");
            } else {
                println!("FAIL (期望无命中，实际命中 {detected:?})");
                std::process::exit(1);
            }
        }
        Some(kw) => {
            if detected.iter().any(|d| d == kw) {
                println!("PASS (命中 {kw})");
            } else {
                println!("FAIL (期望命中 {kw}，实际 {detected:?})");
                std::process::exit(1);
            }
        }
        None => {}
    }
}
