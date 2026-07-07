mod kws;

use tauri::Manager;

/// R2 隐私 vault 文件权限加固：vault.db 收到 0600（App 数据目录默认 644）。
/// 建库后由前端调用；文件不存在/失败静默（FileVault 全盘加密兜底）。
#[tauri::command]
fn vault_harden(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    for name in ["vault.db", "vault.db-wal", "vault.db-shm"] {
        let p = dir.join(name);
        if p.exists() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
            }
        }
    }
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// R2 tray 常驻：菜单栏图标（显示/退出菜单 + 左键点击显窗）+ 关窗 hide 不退出。
/// 意义：隐私记忆拉取与 reminder 触达档2 都依赖 App 活着——tray 把覆盖时间拉满。
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "显示 MyJavis", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("MyJavis")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(kws::KwsManager::default())
        .invoke_handler(tauri::generate_handler![kws::kws_start, kws::kws_stop, kws::kws_feed, vault_harden])
        .setup(|app| {
            setup_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗 = hide 不退出（tray 常驻）；真正退出走 tray 菜单「退出」
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building MyJavis")
        .run(|app, event| {
            // macOS 点 Dock 图标重开：恢复窗口
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main_window(app);
            }
        });
}
