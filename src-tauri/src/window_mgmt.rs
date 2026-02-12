// Window creation (mega, panel, help) + positioning math + panel config persistence.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::platform::*;
use crate::types::*;
use crate::{RAINSCAPER_MENU_ITEM, RAINSCAPER_VISIBLE};

// Panel config persistence

pub(crate) fn get_panel_config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("panel-config.json"))
}

pub(crate) fn load_panel_config(app: &tauri::AppHandle) -> Option<PanelConfig> {
    let path = get_panel_config_path(app)?;
    std::fs::read_to_string(&path).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

pub(crate) fn save_panel_config(app: &tauri::AppHandle, config: &PanelConfig) {
    let Some(path) = get_panel_config_path(app) else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(config) {
        let _ = std::fs::write(&path, json);
    }
}

// Shared helper: update the tray menu item text for Rainscaper Open/Close
pub(crate) fn update_rainscaper_menu_text(text: &str) {
    if let Ok(guard) = RAINSCAPER_MENU_ITEM.lock() {
        if let Some(item) = guard.as_ref() {
            let _ = item.set_text(text);
        }
    }
}

// Positioning

/// Calculate panel position in LOGICAL coordinates.
/// Input tray_x/tray_y are physical (from tray click events).
pub(crate) fn calculate_rainscaper_position(app: &tauri::AppHandle, tray_x: i32, tray_y: i32) -> (i32, i32) {
    const PANEL_WIDTH: i32 = 400;
    const PANEL_HEIGHT: i32 = 500;
    const MARGIN: i32 = 8;

    let monitors: Vec<tauri::Monitor> = app
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .collect();

    let mut scale = 1.0_f64;
    let mut work_x = 0i32;
    let mut work_y = 0i32;
    let mut work_w = 1920i32;
    let mut work_h = 1080i32;
    let mut taskbar_at_top = false;

    for monitor in &monitors {
        let pos = monitor.position();
        let size = monitor.size();

        if tray_x >= pos.x && tray_x < pos.x + size.width as i32 &&
           tray_y >= pos.y && tray_y < pos.y + size.height as i32 {
            scale = monitor.scale_factor();
            let work = get_monitor_work_area(pos.x, pos.y, size.width, size.height);
            work_x = (work.x as f64 / scale) as i32;
            work_y = (work.y as f64 / scale) as i32;
            work_w = (work.width as f64 / scale) as i32;
            work_h = (work.height as f64 / scale) as i32;
            taskbar_at_top = tray_y < pos.y + 100;
            break;
        }
    }

    let tray_lx = (tray_x as f64 / scale) as i32;
    let tray_ly = (tray_y as f64 / scale) as i32;

    let mut x = tray_lx - (PANEL_WIDTH / 2);
    let mut y = if taskbar_at_top {
        tray_ly + (40.0 / scale) as i32 + MARGIN
    } else {
        tray_ly - PANEL_HEIGHT - MARGIN
    };

    let x_min = work_x + MARGIN;
    let y_min = work_y + MARGIN;
    x = x.max(x_min).min((work_x + work_w - PANEL_WIDTH - MARGIN).max(x_min));
    y = y.max(y_min).min((work_y + work_h - PANEL_HEIGHT - MARGIN).max(y_min));

    (x, y)
}

/// Clamp a saved panel position to the current work area so it doesn't overlap the taskbar.
pub(crate) fn clamp_panel_to_work_area(app: &tauri::AppHandle, x: i32, y: i32, panel_w: i32, panel_h: i32) -> (i32, i32) {
    const MARGIN: i32 = 8;

    let monitors: Vec<tauri::Monitor> = app
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .collect();

    for monitor in &monitors {
        let pos = monitor.position();
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let mon_lx = (pos.x as f64 / scale) as i32;
        let mon_ly = (pos.y as f64 / scale) as i32;
        let mon_lw = (size.width as f64 / scale) as i32;
        let mon_lh = (size.height as f64 / scale) as i32;

        if x >= mon_lx && x < mon_lx + mon_lw &&
           y >= mon_ly && y < mon_ly + mon_lh {
            let work = get_monitor_work_area(pos.x, pos.y, size.width, size.height);
            let work_x = (work.x as f64 / scale) as i32;
            let work_y = (work.y as f64 / scale) as i32;
            let work_w = (work.width as f64 / scale) as i32;
            let work_h = (work.height as f64 / scale) as i32;

            let x_min = work_x + MARGIN;
            let y_min = work_y + MARGIN;
            let x_max = (work_x + work_w - panel_w - MARGIN).max(x_min);
            let y_max = (work_y + work_h - panel_h - MARGIN).max(y_min);
            let cx = x.max(x_min).min(x_max);
            let cy = y.max(y_min).min(y_max);
            return (cx, cy);
        }
    }

    (x, y)
}

/// Reset panel position to bottom-right of the taskbar monitor's work area.
pub(crate) fn reset_panel_position(app: &tauri::AppHandle) {
    const PANEL_WIDTH: i32 = 400;
    const PANEL_HEIGHT: i32 = 500;
    const MARGIN: i32 = 12;

    let monitors: Vec<tauri::Monitor> = app
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .collect();

    if monitors.is_empty() { return; }

    let idx = get_primary_monitor_index(&monitors);
    let mon = &monitors[idx];
    let pos = mon.position();
    let size = mon.size();
    let scale = mon.scale_factor();
    let work = get_monitor_work_area(pos.x, pos.y, size.width, size.height);

    let work_x = (work.x as f64 / scale) as i32;
    let work_y = (work.y as f64 / scale) as i32;
    let work_w = (work.width as f64 / scale) as i32;
    let work_h = (work.height as f64 / scale) as i32;

    let x = work_x + work_w - PANEL_WIDTH - MARGIN;
    let y = work_y + work_h - PANEL_HEIGHT - MARGIN;

    let mut config = load_panel_config(app).unwrap_or_default();
    config.x = Some(x);
    config.y = Some(y);
    save_panel_config(app, &config);

    if let Some(window) = app.get_webview_window("rainscaper") {
        window.set_resizable(true).ok();
        window.set_size(tauri::LogicalSize::new(PANEL_WIDTH as f64, PANEL_HEIGHT as f64)).ok();
        window.set_resizable(false).ok();
        window.set_position(tauri::Position::Logical(
            tauri::LogicalPosition::new(x as f64, y as f64)
        )).ok();

        if !RAINSCAPER_VISIBLE.load(Ordering::SeqCst) {
            window.unminimize().ok();
            window.show().ok();
            window.set_ignore_cursor_events(false).ok();
            window.set_always_on_top(true).ok();
            window.set_focus().ok();
            RAINSCAPER_VISIBLE.store(true, Ordering::SeqCst);
            update_rainscaper_menu_text("Close Rainscaper");
        }
    }

    let _ = app.emit("update-rainscape-param", serde_json::json!({
        "path": "system.resetPanel",
        "value": true
    }));

    log::info!("[Rainscaper] Panel reset: position ({}, {}), UI scale 100%", x, y);
}

// Window creation

pub(crate) fn create_rainscaper_window_at(app: &tauri::AppHandle, x: i32, y: i32, visible: bool) -> Result<(), String> {
    log::info!("[Rainscaper] Creating window at ({}, {}), visible={}", x, y, visible);

    let window = WebviewWindowBuilder::new(
        app,
        "rainscaper",
        WebviewUrl::App("rainscaper.html".into())
    )
        .title("RainyDesk Rainscaper")
        .position(x as f64, y as f64)
        .inner_size(400.0, 500.0)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .focused(visible)
        .shadow(false)
        .visible(visible)
        .build()
        .map_err(|e| format!("Failed to create window: {}", e))?;

    if visible {
        window.set_ignore_cursor_events(false).ok();
    } else {
        window.set_ignore_cursor_events(true).ok();
    }

    #[cfg(debug_assertions)]
    {
        window.open_devtools();
    }

    RAINSCAPER_VISIBLE.store(visible, Ordering::SeqCst);
    update_rainscaper_menu_text(if visible { "Close Rainscaper" } else { "Open Rainscaper" });
    log::info!("[Rainscaper] Window created successfully (visible={})", visible);

    Ok(())
}

fn calculate_help_window_geometry(app: &tauri::AppHandle) -> (f64, f64, f64, f64) {
    let monitors: Vec<tauri::Monitor> = app
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .collect();

    if monitors.is_empty() {
        return (1120.0, 630.0, 100.0, 100.0);
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

    // Try 75% of work width at 16:9; if too tall, constrain by height
    let mut w = (work_w * 0.75).round();
    let mut h = (w * 9.0 / 16.0).round();
    if h > work_h * 0.85 {
        h = (work_h * 0.85).round();
        w = (h * 16.0 / 9.0).round();
    }

    (w, h, work_x + (work_w - w) / 2.0, work_y + (work_h - h) / 2.0)
}

pub(crate) fn create_help_window(app: &tauri::AppHandle, visible: bool) -> Result<(), String> {
    log::info!("[Help] Creating window, visible={}", visible);

    let (help_w, help_h, pos_x, pos_y) = calculate_help_window_geometry(app);

    let window = WebviewWindowBuilder::new(
        app,
        "help",
        WebviewUrl::App("help.html".into())
    )
        .title("RainyDesk Help")
        .inner_size(help_w, help_h)
        .position(pos_x, pos_y)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(false)
        .resizable(true)
        .focused(visible)
        .shadow(false)
        .visible(visible)
        .build()
        .map_err(|e| format!("Failed to create help window: {}", e))?;

    #[cfg(debug_assertions)]
    {
        window.open_devtools();
    }

    let _ = window;
    log::info!("[Help] Window created (visible={})", visible);
    Ok(())
}

#[cfg(target_os = "windows")]
pub(crate) fn create_mega_background(
    app: &tauri::AppHandle,
    desktop: &VirtualDesktop,
) -> Result<(), Box<dyn std::error::Error>> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE};

    log::info!(
        "Creating mega-background: {}x{} at ({}, {})",
        desktop.width, desktop.height, desktop.origin_x, desktop.origin_y
    );

    let window = WebviewWindowBuilder::new(app, "background", WebviewUrl::App("background.html".into()))
        .title("RainyDesk Background")
        .position(desktop.origin_x as f64, desktop.origin_y as f64)
        .inner_size(desktop.width as f64, desktop.height as f64)
        .transparent(true)
        .decorations(false)
        .always_on_top(false)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .shadow(false)
        .build()?;

    window.set_ignore_cursor_events(true)?;

    let hwnd = window.hwnd()?;
    unsafe {
        let _ = SetWindowPos(
            HWND(hwnd.0),
            HWND_BOTTOM,
            0, 0, 0, 0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE
        );
    }

    log::info!("Mega-background created successfully");
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn create_mega_background(
    _app: &tauri::AppHandle,
    _desktop: &VirtualDesktop,
) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

pub(crate) fn create_mega_overlay(
    app: &tauri::AppHandle,
    desktop: &VirtualDesktop,
) -> Result<(), Box<dyn std::error::Error>> {
    log::info!(
        "Creating mega-overlay: {}x{} at ({}, {})",
        desktop.width, desktop.height, desktop.origin_x, desktop.origin_y
    );

    let window = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("index.html".into()))
        .title("RainyDesk")
        .position(desktop.origin_x as f64, desktop.origin_y as f64)
        .inner_size(desktop.width as f64, desktop.height as f64)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .shadow(false)
        .build()?;

    window.set_ignore_cursor_events(true)?;

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongW, SetWindowLongW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
        };
        let hwnd = window.hwnd()?;
        unsafe {
            let style = GetWindowLongW(HWND(hwnd.0), GWL_EXSTYLE);
            SetWindowLongW(HWND(hwnd.0), GWL_EXSTYLE, style | WS_EX_NOACTIVATE.0 as i32);
        }
        log::info!("Added WS_EX_NOACTIVATE to overlay window");
    }

    #[cfg(debug_assertions)]
    {
        window.open_devtools();
    }

    log::info!("Mega-overlay created successfully");
    Ok(())
}
