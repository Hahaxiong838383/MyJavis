//! R4 提炼调度器（docs/memory-architecture.md §4.4）：通话结束 5 分钟静默后触发一次
//! 本机 vault 提炼批处理，规避 WKWebView 窗口隐藏/后台时 JS `setTimeout` 被系统节流
//! （前端 `useVoiceRtc.stop()` 挂断即调 `refine_schedule`；本模块用独立 OS 线程计时，
//! 不依赖 WebView 事件循环）。
//!
//! 防抖设计：每次 `refine_schedule` 调用把 generation 计数器 +1 并起一条新的睡眠线程；
//! 线程醒来时若 generation 已被后续调用推进（说明又有新通话结束/被别的调用重置），
//! 静默退出不 emit——只有"最后一次调用"的线程会在 5 分钟静默后真正触发
//! `refine-due` 事件。等价于"重复 schedule 重置计时器"，且不需要显式取消/join 旧线程。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// 通话结束到真正触发提炼的静默窗口。测试/运维可通过 MYJAVIS_REFINE_DELAY_SECS 覆盖
/// （默认 300s=5min，与 docs/memory-architecture.md §4.4 描述一致）。
fn refine_delay() -> Duration {
    let secs = std::env::var("MYJAVIS_REFINE_DELAY_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(300);
    Duration::from_secs(secs)
}

#[derive(Default)]
pub struct RefineScheduler {
    generation: Arc<AtomicU64>,
}

#[tauri::command]
pub fn refine_schedule(app: AppHandle, state: tauri::State<'_, RefineScheduler>) {
    let my_gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let generation = state.generation.clone();
    let delay = refine_delay();
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        if generation.load(Ordering::SeqCst) == my_gen {
            println!("[refine] {}s idle reached, emitting refine-due", delay.as_secs());
            let _ = app.emit("refine-due", ());
        }
        // 代数已变：期间又有更晚的 refine_schedule 调用（防抖），本线程静默退出。
    });
}
