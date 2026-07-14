//! Vision 探针进程管理（0.16.0 胶水版，2026-07-14）。
//!
//! 通话生命周期绑定：前端进房成功 invoke vision_start、挂断 invoke vision_stop——
//! 摄像头只在通话中开（隐私红线：摄像头生命周期=通话生命周期）。App 退出兜底 kill 防僵尸。
//!
//! 拉起目标是 tools/vision-probe 的 venv 探针（仅装了探针的机器生效；其他机器路径
//! 不存在 → Err，前端静默降级，通话不受任何影响）。协作仓正式 sidecar（单二进制）
//! 交付后，把 resolve_probe() 换成 externalBin 路径即可，前端与 server 零改动。

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// 探针 stdout/stderr → ~/Library/Logs/MyJavis/vision-probe.log（追加）。
/// GUI App 子进程的输出否则会被系统丢弃，探针死因（如摄像头授权失败）将不可排查。
fn probe_log() -> Stdio {
    let path = std::env::var("HOME")
        .map(|h| std::path::PathBuf::from(h).join("Library/Logs/MyJavis"))
        .ok();
    if let Some(dir) = path {
        if std::fs::create_dir_all(&dir).is_ok() {
            if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("vision-probe.log")) {
                return Stdio::from(f);
            }
        }
    }
    Stdio::null()
}

/// 默认探针目录（川哥开发机）；其他环境用 MYJAVIS_VISION_PROBE_DIR 覆盖。
const DEFAULT_PROBE_DIR: &str = "/Users/rayman.chen/mycc/2-Projects/MyJavis/tools/vision-probe";

#[derive(Default)]
pub struct VisionManager {
    inner: Mutex<Option<Child>>,
}

fn resolve_probe() -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let dir = std::path::PathBuf::from(
        std::env::var("MYJAVIS_VISION_PROBE_DIR").unwrap_or_else(|_| DEFAULT_PROBE_DIR.to_string()),
    );
    let python = dir.join(".venv/bin/python");
    let script = dir.join("probe.py");
    if !python.exists() || !script.exists() {
        return Err("probe-not-installed".into());
    }
    Ok((python, script))
}

#[tauri::command]
pub fn vision_start(state: tauri::State<'_, VisionManager>, key: String, server: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("no-key".into());
    }
    let (python, script) = resolve_probe()?;
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    // 幂等：已有存活进程直接复用；已退出的先收尸再重拉
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(None) => return Ok(()),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    let child = Command::new(&python)
        .arg("-u") // 无缓冲：进程被 kill 时日志不丢（python 输出到文件默认全缓冲）
        .arg(&script)
        .arg("--key")
        .arg(key.trim())
        .arg("--server")
        .arg(server.trim())
        .stdin(Stdio::null())
        .stdout(probe_log())
        .stderr(probe_log())
        .spawn()
        .map_err(|e| format!("spawn: {e}"))?;
    println!("[vision] probe started pid={}", child.id());
    *guard = Some(child);
    Ok(())
}

#[tauri::command]
pub fn vision_stop(state: tauri::State<'_, VisionManager>) {
    if let Ok(mut guard) = state.inner.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
            println!("[vision] probe stopped");
        }
    }
}

#[tauri::command]
pub fn vision_status(state: tauri::State<'_, VisionManager>) -> bool {
    if let Ok(mut guard) = state.inner.lock() {
        if let Some(child) = guard.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                return true;
            }
            // 已自行退出（如摄像头未授权 exit 2）：收尸清位，状态如实报未运行
            let _ = guard.take();
        }
    }
    false
}

/// App 退出兜底（tray 退出/系统关闭）：kill 探针防僵尸摄像头进程。
pub fn kill_on_exit(app: &tauri::AppHandle) {
    use tauri::Manager;
    vision_stop(app.state::<VisionManager>());
}
