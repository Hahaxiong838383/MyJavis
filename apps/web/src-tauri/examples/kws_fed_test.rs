//! fed 模式链路验收：wav 按 2048 样本分包喂引擎（模拟 WebView AudioWorklet →
//! kws_feed IPC 的到达节奏），验证流式分包下命中不受影响。
//!
//! 用法: cargo run --example kws_fed_test -- <wav文件> [期望命中|"NONE"]

use sherpa_onnx::{KeywordSpotter, KeywordSpotterConfig, Wave};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("用法: kws_fed_test <wav> [期望命中关键词|NONE]");
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
    config.keywords_score = 2.0;
    config.keywords_threshold = 0.15;

    let kws = KeywordSpotter::create(&config).expect("KeywordSpotter 创建失败");
    let wave = Wave::read(wav_path).expect("读 wav 失败");

    let stream = kws.create_stream();
    let mut detected: Vec<String> = Vec::new();
    let samples = wave.samples();
    // 分包喂 + 每包后即时 decode（与 run_kws_fed 循环同款节奏）
    for chunk in samples.chunks(2048) {
        stream.accept_waveform(wave.sample_rate(), chunk);
        while kws.is_ready(&stream) {
            kws.decode(&stream);
            if let Some(result) = kws.get_result(&stream) {
                if !result.keyword.is_empty() {
                    detected.push(result.keyword.clone());
                    kws.reset(&stream);
                }
            }
        }
    }
    // 尾静音冲刷缓冲
    let tail = vec![0.0f32; (wave.sample_rate() / 2) as usize];
    stream.accept_waveform(wave.sample_rate(), &tail);
    stream.input_finished();
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
                println!("FAIL (期望无命中，实际 {detected:?})");
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
