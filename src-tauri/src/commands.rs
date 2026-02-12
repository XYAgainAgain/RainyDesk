// All #[tauri::command] functions and their private helpers.

use std::fs;
use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager};

use crate::platform::*;
use crate::rainscape::*;
use crate::types::*;
use crate::window_mgmt::*;
use crate::{RAIN_PAUSED, PAUSE_MENU_ITEM, RAINSCAPER_VISIBLE, OVERLAY_HEALTH, BACKGROUND_HEALTH};

#[tauri::command]
pub fn log_message(message: String) {
    log::info!("[Renderer] {}", message);
}

#[tauri::command]
pub fn get_config(state: tauri::State<AppState>) -> Result<serde_json::Value, String> {
    let config = state.config.lock().map_err(|e| format!("Config lock poisoned: {}", e))?;
    Ok(config.clone())
}

#[tauri::command]
pub fn set_rainscape(name: String) {
    log::info!("Current rainscape: {}", name);
}

#[tauri::command]
pub fn set_ignore_mouse_events(window: tauri::Window, ignore: bool) {
    if let Err(e) = window.set_ignore_cursor_events(ignore) {
        log::error!("Failed to set cursor events: {}", e);
    }
}

#[tauri::command]
pub fn save_rainscape(app: tauri::AppHandle, filename: String, data: serde_json::Value) -> Result<serde_json::Value, String> {
    let rainscapes_dir = get_rainscapes_dir(&app)?;

    let filename = if filename.ends_with(".rain") {
        filename
    } else if filename.ends_with(".json") {
        filename.replace(".json", ".rain")
    } else {
        format!("{}.rain", filename)
    };

    let file_path = if filename == "Autosave.rain" || filename == "Default.rain" {
        rainscapes_dir.join(&filename)
    } else {
        rainscapes_dir.join("Custom Rainscapes").join(&filename)
    };

    let json_str = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize: {}", e))?;

    fs::write(&file_path, json_str)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    log::info!("Saved rainscape: {:?}", file_path);
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub fn autosave_rainscape(app: tauri::AppHandle, data: serde_json::Value) -> Result<serde_json::Value, String> {
    let rainscapes_dir = get_rainscapes_dir(&app)?;
    let autosave_path = rainscapes_dir.join("Autosave.rain");

    let json_str = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize: {}", e))?;

    fs::write(&autosave_path, json_str)
        .map_err(|e| format!("Failed to write Autosave.rain: {}", e))?;

    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub fn get_startup_rainscape_cmd(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let (filename, data) = get_startup_rainscape(&app)?;
    Ok(serde_json::json!({
        "filename": filename,
        "data": data
    }))
}

fn list_rain_files(dir: &std::path::Path) -> Result<Vec<String>, String> {
    fs::read_dir(dir)
        .map_err(|e| format!("Failed to read dir: {}", e))
        .map(|entries| {
            entries
                .filter_map(|entry| {
                    let entry = entry.ok()?;
                    let path = entry.path();
                    if path.is_file() && path.extension().map(|ext| ext == "rain").unwrap_or(false) {
                        path.file_name()?.to_str().map(String::from)
                    } else {
                        None
                    }
                })
                .collect()
        })
}

#[tauri::command]
pub fn load_rainscapes(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let rainscapes_dir = get_rainscapes_dir(&app)?;
    let custom_dir = rainscapes_dir.join("Custom Rainscapes");

    let root_files = list_rain_files(&rainscapes_dir)?;
    let custom_files = if custom_dir.exists() {
        list_rain_files(&custom_dir)?
    } else {
        Vec::new()
    };

    log::info!("Found {} root + {} custom rainscape files", root_files.len(), custom_files.len());

    Ok(serde_json::json!({
        "root": root_files,
        "custom": custom_files
    }))
}

#[tauri::command]
pub fn read_rainscape(app: tauri::AppHandle, filename: String) -> Result<serde_json::Value, String> {
    let rainscapes_dir = get_rainscapes_dir(&app)?;

    let filename = if filename.ends_with(".rain") {
        filename
    } else if filename.ends_with(".json") {
        filename.replace(".json", ".rain")
    } else {
        format!("{}.rain", filename)
    };

    let root_path = rainscapes_dir.join(&filename);
    let custom_path = rainscapes_dir.join("Custom Rainscapes").join(&filename);

    let file_path = if root_path.exists() {
        root_path
    } else if custom_path.exists() {
        custom_path
    } else {
        return Err(format!("Rainscape not found: {}", filename));
    };

    let content = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let data: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse rainscape: {}", e))?;

    log::info!("Read rainscape: {:?}", file_path);
    Ok(data)
}

#[tauri::command]
pub fn update_rainscape_param(path: String, value: serde_json::Value, app: tauri::AppHandle) {
    if path == "system.paused" {
        if let Some(paused) = value.as_bool() {
            RAIN_PAUSED.store(paused, Ordering::Relaxed);
            if let Ok(guard) = PAUSE_MENU_ITEM.lock() {
                if let Some(ref item) = *guard {
                    let _ = item.set_text(if paused { "Resume" } else { "Pause" });
                }
            }
            log::info!("[ParamSync] Pause state synced from panel: {}", paused);
        }
    }

    if let Err(e) = app.emit("update-rainscape-param", serde_json::json!({ "path": path, "value": value })) {
        log::error!("[ParamSync] Failed to emit {}: {}", path, e);
    }
}

#[tauri::command]
pub fn trigger_audio_start(app: tauri::AppHandle) {
    let _ = app.emit("start-audio", ());
}

#[tauri::command]
pub fn heartbeat(window: tauri::Window) {
    let label = window.label();
    let health_mutex = match label {
        "overlay" => &OVERLAY_HEALTH,
        "background" => &BACKGROUND_HEALTH,
        _ => return,
    };

    let mut guard = health_mutex.lock().unwrap();
    if let Some(health) = guard.as_mut() {
        let now = std::time::Instant::now();
        if !health.init_complete {
            health.init_complete = true;
            health.crash_count = 0;
            log::info!("[Health] {} initialized (took {:.1}s)", label, health.created_at.elapsed().as_secs_f64());
        }
        health.last_heartbeat = Some(now);
    }
}

#[tauri::command]
pub fn show_rainscaper(app: tauri::AppHandle, tray_x: i32, tray_y: i32) -> Result<(), String> {
    log::info!("[Rainscaper] Show requested at tray position ({}, {})", tray_x, tray_y);

    let (panel_w, panel_h) = app.get_webview_window("rainscaper")
        .and_then(|w| {
            let size = w.outer_size().ok()?;
            let s = w.current_monitor().ok()??.scale_factor();
            Some(((size.width as f64 / s) as i32, (size.height as f64 / s) as i32))
        })
        .unwrap_or((400, 500));

    let (x, y) = load_panel_config(&app)
        .and_then(|c| c.x.zip(c.y))
        .map(|(sx, sy)| clamp_panel_to_work_area(&app, sx, sy, panel_w, panel_h))
        .unwrap_or_else(|| calculate_rainscaper_position(&app, tray_x, tray_y));

    let window_exists = app.get_webview_window("rainscaper").is_some();
    log::info!("[Rainscaper] Window exists: {}", window_exists);

    if let Some(window) = app.get_webview_window("rainscaper") {
        log::info!("[Rainscaper] Reusing existing window");
        log::info!("[Rainscaper] Positioning to ({}, {})", x, y);
        window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x as f64, y as f64)))
            .map_err(|e| format!("Failed to position window: {}", e))?;
        log::info!("[Rainscaper] Calling unminimize()");
        window.unminimize().ok();
        log::info!("[Rainscaper] Calling window.show()");
        window.show().map_err(|e| format!("Failed to show window: {}", e))?;
        window.set_ignore_cursor_events(false).ok();
        window.set_always_on_top(true).ok();
        window.set_focus().map_err(|e| format!("Failed to focus window: {}", e))?;
        RAINSCAPER_VISIBLE.store(true, Ordering::SeqCst);
        update_rainscaper_menu_text("Close Rainscaper");
        log::info!("[Rainscaper] Shown successfully at ({}, {})", x, y);
    } else {
        log::info!("[Rainscaper] Window not found, creating new one at ({}, {})", x, y);
        create_rainscaper_window_at(&app, x, y, true)?;
    }

    Ok(())
}

#[tauri::command]
pub fn hide_rainscaper(app: tauri::AppHandle) -> Result<(), String> {
    log::info!("[Rainscaper] Hide requested");
    if let Some(window) = app.get_webview_window("rainscaper") {
        if let Ok(pos) = window.outer_position() {
            let scale = window.current_monitor()
                .ok().flatten()
                .map(|m| m.scale_factor())
                .unwrap_or(1.0);
            let mut config = load_panel_config(&app).unwrap_or_default();
            config.x = Some((pos.x as f64 / scale) as i32);
            config.y = Some((pos.y as f64 / scale) as i32);
            save_panel_config(&app, &config);
            log::info!("[Rainscaper] Saved logical position ({}, {})", config.x.unwrap(), config.y.unwrap());
        }
        window.set_ignore_cursor_events(true).ok();
        log::info!("[Rainscaper] Calling window.hide()");
        window.hide().map_err(|e| format!("Failed to hide window: {}", e))?;
        RAINSCAPER_VISIBLE.store(false, Ordering::SeqCst);
        update_rainscaper_menu_text("Open Rainscaper");
        log::info!("[Rainscaper] Hidden successfully, VISIBLE=false");
    } else {
        log::warn!("[Rainscaper] Hide called but window not found");
    }
    Ok(())
}

#[tauri::command]
pub fn toggle_rainscaper(app: tauri::AppHandle, tray_x: i32, tray_y: i32) -> Result<(), String> {
    let visible = RAINSCAPER_VISIBLE.load(Ordering::SeqCst);
    if visible {
        hide_rainscaper(app)
    } else {
        show_rainscaper(app, tray_x, tray_y)
    }
}

#[tauri::command]
pub fn resize_rainscaper(app: tauri::AppHandle, width: f64, height: f64) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("rainscaper") {
        use tauri::{LogicalSize, PhysicalPosition};

        window.set_resizable(true).ok();
        window.set_size(LogicalSize::new(width, height))
            .map_err(|e| format!("Failed to resize: {}", e))?;
        window.set_resizable(false).ok();

        if let (Ok(pos), Some(monitor)) = (window.outer_position(), window.current_monitor().ok().flatten()) {
            let scale = monitor.scale_factor();
            let mon_size = monitor.size();
            let mon_pos = monitor.position();

            let work_area = get_monitor_work_area(
                mon_pos.x, mon_pos.y, mon_size.width, mon_size.height
            );

            let phys_width = (width * scale) as i32;
            let phys_height = (height * scale) as i32;

            let mut new_x = pos.x;
            let mut new_y = pos.y;
            let mut moved = false;

            let work_bottom = work_area.y + work_area.height as i32;
            if new_y + phys_height > work_bottom {
                new_y = (work_bottom - phys_height).max(work_area.y);
                moved = true;
            }

            let work_right = work_area.x + work_area.width as i32;
            if new_x + phys_width > work_right {
                new_x = (work_right - phys_width).max(work_area.x);
                moved = true;
            }

            if moved {
                window.set_position(PhysicalPosition::new(new_x, new_y)).ok();
                log::info!("[Rainscaper] Repositioned to ({}, {}) to stay in work area", new_x, new_y);
            }
        }

        log::info!("[Rainscaper] Resized to {}x{}", width, height);
    }
    Ok(())
}

#[tauri::command]
pub fn get_windows_accent_color() -> String {
    get_accent_color_from_registry().unwrap_or_else(|| "#0078d4".to_string())
}

#[tauri::command]
pub fn show_help_window(app: tauri::AppHandle) -> Result<(), String> {
    log::info!("[Help] Show requested");

    if let Some(window) = app.get_webview_window("help") {
        window.unminimize().ok();
        window.show().map_err(|e| format!("Failed to show help: {}", e))?;
        window.set_focus().map_err(|e| format!("Failed to focus help: {}", e))?;
        log::info!("[Help] Shown existing window");
    } else {
        create_help_window(&app, true)?;
    }

    Ok(())
}

#[tauri::command]
pub fn hide_help_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("help") {
        window.hide().map_err(|e| format!("Failed to hide help: {}", e))?;
        log::info!("[Help] Hidden");
    }
    app.emit("help-window-hidden", ()).ok();
    Ok(())
}

#[tauri::command]
pub fn resize_help_window(app: tauri::AppHandle, width: f64, height: f64) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("help") {
        window.set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| format!("Failed to resize help: {}", e))?;
        log::info!("[Help] Resized to {}x{}", width, height);
    }
    Ok(())
}

#[tauri::command]
pub fn center_help_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("help")
        .ok_or_else(|| "Help window not found".to_string())?;

    let win_size = window.outer_size()
        .map_err(|e| format!("Failed to get help size: {}", e))?;

    let monitors: Vec<tauri::Monitor> = app
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .collect();

    if monitors.is_empty() {
        return Ok(());
    }

    let idx = get_primary_monitor_index(&monitors);
    let mon = &monitors[idx];
    let mon_pos = mon.position();
    let mon_size = mon.size();
    let work = get_monitor_work_area(
        mon_pos.x, mon_pos.y, mon_size.width, mon_size.height,
    );
    let scale = mon.scale_factor();

    let work_w = work.width as f64 / scale;
    let work_h = work.height as f64 / scale;
    let work_x = work.x as f64 / scale;
    let work_y = work.y as f64 / scale;

    let mut win_w = win_size.width as f64 / scale;
    let mut win_h = win_size.height as f64 / scale;

    const MARGIN: f64 = 16.0;
    let max_w = (work_w - MARGIN * 2.0).max(200.0);
    let max_h = (work_h - MARGIN * 2.0).max(150.0);
    let needs_resize = win_w > max_w || win_h > max_h;
    if needs_resize {
        win_w = win_w.min(max_w);
        win_h = win_h.min(max_h);
        window.set_size(tauri::LogicalSize::new(win_w, win_h))
            .map_err(|e| format!("Failed to clamp help size: {}", e))?;
    }

    let pos_x = work_x + (work_w - win_w) / 2.0;
    let pos_y = work_y + (work_h - win_h) / 2.0;

    window.set_position(tauri::LogicalPosition::new(pos_x, pos_y))
        .map_err(|e| format!("Failed to position help: {}", e))?;

    log::info!("[Help] Centered on primary monitor: ({:.0}, {:.0}), size {:.0}x{:.0}{}",
        pos_x, pos_y, win_w, win_h, if needs_resize { " (clamped)" } else { "" });
    Ok(())
}

#[tauri::command]
pub fn toggle_maximize_help_window(app: tauri::AppHandle) -> Result<bool, String> {
    let window = app.get_webview_window("help")
        .ok_or_else(|| "Help window not found".to_string())?;
    let is_maximized = window.is_maximized()
        .map_err(|e| format!("Failed to check maximized state: {}", e))?;
    if is_maximized {
        window.unmaximize().map_err(|e| format!("Failed to unmaximize: {}", e))?;
    } else {
        window.maximize().map_err(|e| format!("Failed to maximize: {}", e))?;
    }
    Ok(!is_maximized)
}

#[tauri::command]
pub fn open_rainscapes_folder() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let docs_dir = dirs::document_dir()
            .ok_or_else(|| "Failed to get Documents directory".to_string())?;
        let folder = docs_dir.join("RainyDesk");
        log::info!("[OpenFolder] Opening rainscapes: {}", folder.display());
        std::process::Command::new("explorer")
            .arg(folder.as_os_str())
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_logs_folder() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let local_app_data = std::env::var("LOCALAPPDATA")
            .map_err(|e| format!("Failed to read LOCALAPPDATA: {}", e))?;
        let folder = std::path::Path::new(&local_app_data).join("com.rainydesk.app").join("logs");
        log::info!("[OpenFolder] Opening logs: {}", folder.display());
        std::process::Command::new("explorer")
            .arg(folder.as_os_str())
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    Ok(())
}

// Open URL via ShellExecuteW (cmd.exe is injection-prone with untrusted strings)
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Only http/https URLs are allowed".to_string());
    }

    log::info!("[OpenURL] Opening: {}", url);

    #[cfg(target_os = "windows")]
    {
        use windows::core::HSTRING;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let url_wide = HSTRING::from(url.as_str());
        let operation = HSTRING::from("open");

        unsafe {
            ShellExecuteW(
                None,
                &operation,
                &url_wide,
                None,
                None,
                SW_SHOWNORMAL,
            );
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }

    Ok(())
}

// Custom theme persistence (UserThemes.json in Documents\RainyDesk\)
#[tauri::command]
pub fn load_user_themes(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let rainscapes_dir = get_rainscapes_dir(&app)?;
    let themes_path = rainscapes_dir.join("UserThemes.json");

    if !themes_path.exists() {
        return Ok(serde_json::json!({ "version": 1, "themes": [] }));
    }

    let content = fs::read_to_string(&themes_path)
        .map_err(|e| format!("Failed to read UserThemes.json: {}", e))?;

    let data: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| {
            log::warn!("Invalid UserThemes.json, returning empty: {}", e);
            format!("Failed to parse UserThemes.json: {}", e)
        })
        .unwrap_or_else(|_| serde_json::json!({ "version": 1, "themes": [] }));

    log::info!("Loaded UserThemes.json ({} themes)", data["themes"].as_array().map(|a| a.len()).unwrap_or(0));
    Ok(data)
}

#[tauri::command]
pub fn save_user_themes(app: tauri::AppHandle, data: serde_json::Value) -> Result<(), String> {
    let rainscapes_dir = get_rainscapes_dir(&app)?;
    let themes_path = rainscapes_dir.join("UserThemes.json");

    let json_str = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize UserThemes.json: {}", e))?;

    fs::write(&themes_path, json_str)
        .map_err(|e| format!("Failed to write UserThemes.json: {}", e))?;

    log::info!("Saved UserThemes.json ({} themes)", data["themes"].as_array().map(|a| a.len()).unwrap_or(0));
    Ok(())
}

#[tauri::command]
pub fn get_display_info(window: tauri::Window) -> Result<DisplayInfo, String> {
    let label = window.label();
    let index: usize = label
        .strip_prefix("overlay-")
        .or_else(|| label.strip_prefix("background-"))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    if let Ok(Some(monitor)) = window.current_monitor() {
        let pos = monitor.position();
        let size = monitor.size();
        let scale = monitor.scale_factor();

        let work_area = get_monitor_work_area(pos.x, pos.y, size.width, size.height);

        log::info!(
            "[get_display_info] Monitor {}: {}x{} at ({}, {}) work_area_height={}",
            index, size.width, size.height, pos.x, pos.y, work_area.height
        );

        Ok(DisplayInfo {
            index,
            bounds: Bounds {
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
            },
            work_area,
            scale_factor: scale,
            refresh_rate: get_monitor_refresh_rate(pos.x, pos.y, size.width, size.height),
        })
    } else {
        Err("Could not get monitor info".to_string())
    }
}

#[tauri::command]
pub fn get_all_displays(app: tauri::AppHandle) -> Result<Vec<DisplayInfo>, String> {
    let monitors = app
        .available_monitors()
        .map_err(|e| format!("Failed to get monitors: {}", e))?;

    let mut displays = Vec::new();
    for (index, monitor) in monitors.iter().enumerate() {
        let pos = monitor.position();
        let size = monitor.size();
        let scale = monitor.scale_factor();

        let work_area = get_monitor_work_area(pos.x, pos.y, size.width, size.height);

        displays.push(DisplayInfo {
            index,
            bounds: Bounds {
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
            },
            work_area,
            scale_factor: scale,
            refresh_rate: get_monitor_refresh_rate(pos.x, pos.y, size.width, size.height),
        });
    }

    log::info!("[get_all_displays] Found {} monitors", displays.len());
    Ok(displays)
}

#[tauri::command]
pub fn get_system_specs(state: tauri::State<'_, AppState>) -> SystemSpecs {
    state.system_specs.clone()
}

// Collect hardware specs once at startup (CPU, GPU, RAM)
pub fn collect_system_specs() -> SystemSpecs {
    use sysinfo::System;

    let sys = System::new_all();

    let cpu_model = sys.cpus().first()
        .map(|c| c.brand().trim().to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    let total_ram_gb = sys.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0);

    let gpu_model = get_gpu_name().unwrap_or_else(|| "Unknown".to_string());
    let gpu_vram_gb = get_gpu_vram_gb();

    SystemSpecs {
        cpu_model,
        gpu_model,
        gpu_vram_gb,
        total_ram_gb: (total_ram_gb * 10.0).round() / 10.0,
    }
}

#[tauri::command]
pub fn get_virtual_desktop(app: tauri::AppHandle) -> Result<VirtualDesktop, String> {
    let monitors: Vec<tauri::Monitor> = app
        .available_monitors()
        .map_err(|e| format!("Failed to get monitors: {}", e))?
        .into_iter()
        .collect();

    if monitors.is_empty() {
        return Err("No monitors found".to_string());
    }

    let mut x_min = i32::MAX;
    let mut y_min = i32::MAX;
    let mut x_max = i32::MIN;
    let mut y_max = i32::MIN;

    for monitor in &monitors {
        let pos = monitor.position();
        let size = monitor.size();

        x_min = x_min.min(pos.x);
        y_min = y_min.min(pos.y);
        x_max = x_max.max(pos.x + size.width as i32);
        y_max = y_max.max(pos.y + size.height as i32);
    }

    let primary_index = get_primary_monitor_index(&monitors);
    let primary_scale = monitors[primary_index].scale_factor();

    let to_logical = |v: i32| -> i32 { (v as f64 / primary_scale).round() as i32 };
    let to_logical_u = |v: u32| -> u32 { (v as f64 / primary_scale).round() as u32 };

    let logical_x_min = to_logical(x_min);
    let logical_y_min = to_logical(y_min);
    let logical_x_max = to_logical(x_max);
    let logical_y_max = to_logical(y_max);
    let total_width = (logical_x_max - logical_x_min) as u32;
    let total_height = (logical_y_max - logical_y_min) as u32;

    log::info!(
        "[VirtualDesktop] Physical bbox: ({}, {})-->({}, {}), scale={}, logical bbox: ({}, {}) {}x{}",
        x_min, y_min, x_max, y_max, primary_scale,
        logical_x_min, logical_y_min, total_width, total_height
    );

    let mut regions = Vec::new();
    for (index, monitor) in monitors.iter().enumerate() {
        let pos = monitor.position();
        let size = monitor.size();
        let scale = monitor.scale_factor();

        let work_area = get_monitor_work_area(pos.x, pos.y, size.width, size.height);

        let rel_x = (to_logical(pos.x) - logical_x_min) as u32;
        let rel_y = (to_logical(pos.y) - logical_y_min) as u32;
        let rel_work_x = (to_logical(work_area.x) - logical_x_min) as u32;
        let rel_work_y = (to_logical(work_area.y) - logical_y_min) as u32;

        regions.push(MonitorRegion {
            index,
            x: rel_x,
            y: rel_y,
            width: to_logical_u(size.width),
            height: to_logical_u(size.height),
            work_x: rel_work_x,
            work_y: rel_work_y,
            work_width: to_logical_u(work_area.width),
            work_height: to_logical_u(work_area.height),
            scale_factor: scale,
            refresh_rate: get_monitor_refresh_rate(pos.x, pos.y, size.width, size.height),
        });

        log::info!(
            "[VirtualDesktop] Monitor {}{}: rel({}, {}) {}x{} work_height={} (logical)",
            index,
            if index == primary_index { " (primary)" } else { "" },
            rel_x, rel_y, to_logical_u(size.width), to_logical_u(size.height),
            to_logical_u(work_area.height)
        );
    }

    Ok(VirtualDesktop {
        origin_x: logical_x_min,
        origin_y: logical_y_min,
        width: total_width,
        height: total_height,
        monitors: regions,
        primary_index,
        primary_scale_factor: primary_scale,
    })
}
