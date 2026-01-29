use tauri::{
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
    menu::{Menu, MenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::fs;
use std::path::PathBuf;

mod window_detector;

#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::RECT,
    Graphics::Gdi::{MonitorFromPoint, GetMonitorInfoW, MONITORINFO, MONITOR_DEFAULTTONEAREST},
};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::POINT;

// Global pause state
static RAIN_PAUSED: AtomicBool = AtomicBool::new(false);

/// Get the rainscapes directory, creating structure if needed:
/// rainscapes/
/// ├── Autosave.rain      ← Always loaded first, overwritten on changes
/// ├── Default.rain       ← Fallback if no Autosave exists
/// └── Custom/            ← User-created presets
fn get_rainscapes_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let rainscapes_dir = app_data.join("rainscapes");
    let custom_dir = rainscapes_dir.join("Custom");

    // Create directories if they don't exist
    if !rainscapes_dir.exists() {
        fs::create_dir_all(&rainscapes_dir)
            .map_err(|e| format!("Failed to create rainscapes dir: {}", e))?;
        log::info!("Created rainscapes directory: {:?}", rainscapes_dir);
    }

    if !custom_dir.exists() {
        fs::create_dir_all(&custom_dir)
            .map_err(|e| format!("Failed to create custom dir: {}", e))?;
        log::info!("Created custom rainscapes directory: {:?}", custom_dir);
    }

    // Create Default.rain if it doesn't exist
    let default_path = rainscapes_dir.join("Default.rain");
    if !default_path.exists() {
        let default_rainscape = create_default_rainscape();
        let json_str = serde_json::to_string_pretty(&default_rainscape)
            .map_err(|e| format!("Failed to serialize default: {}", e))?;
        fs::write(&default_path, json_str)
            .map_err(|e| format!("Failed to write Default.rain: {}", e))?;
        log::info!("Created Default.rain");
    }

    Ok(rainscapes_dir)
}

/// Create the default rainscape configuration
fn create_default_rainscape() -> serde_json::Value {
    serde_json::json!({
        "name": "Default",
        "version": "1.0.0",
        "rain": {
            "intensity": 50,
            "wind": 0,
            "turbulence": 0.3
        },
        "audio": {
            "masterVolume": 50,
            "sheetVolume": 0.6,
            "impactVolume": 0.8
        }
    })
}

/// Get the startup rainscape (Autosave.rain if exists, else Default.rain)
fn get_startup_rainscape(app: &tauri::AppHandle) -> Result<(String, serde_json::Value), String> {
    let rainscapes_dir = get_rainscapes_dir(app)?;

    // Try Autosave.rain first
    let autosave_path = rainscapes_dir.join("Autosave.rain");
    if autosave_path.exists() {
        let content = fs::read_to_string(&autosave_path)
            .map_err(|e| format!("Failed to read Autosave.rain: {}", e))?;
        let data: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse Autosave.rain: {}", e))?;
        log::info!("Loading Autosave.rain");
        return Ok(("Autosave.rain".to_string(), data));
    }

    // Fall back to Default.rain
    let default_path = rainscapes_dir.join("Default.rain");
    let content = fs::read_to_string(&default_path)
        .map_err(|e| format!("Failed to read Default.rain: {}", e))?;
    let data: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse Default.rain: {}", e))?;
    log::info!("Loading Default.rain (no autosave found)");
    Ok(("Default.rain".to_string(), data))
}

// Load theme-aware tray icon (white for dark theme, black for light theme)
fn load_theme_icon() -> tauri::image::Image<'static> {
    let is_dark = is_dark_theme();
    let icon_bytes: &[u8] = if is_dark {
        include_bytes!("../../assets/icons/RainyDeskIconWhite.png")
    } else {
        include_bytes!("../../assets/icons/RainyDeskIconBlack.png")
    };

    // Decode PNG to RGBA
    let img = image::load_from_memory(icon_bytes).expect("valid icon PNG");
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    tauri::image::Image::new_owned(rgba.into_raw(), width, height)
}

#[cfg(target_os = "windows")]
fn is_dark_theme() -> bool {
    use windows::Win32::System::Registry::{
        RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, KEY_READ, REG_DWORD,
    };
    use windows::core::PCWSTR;

    unsafe {
        let mut hkey = std::mem::zeroed();
        let subkey: Vec<u16> = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\0"
            .encode_utf16().collect();

        if RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(subkey.as_ptr()), 0, KEY_READ, &mut hkey).is_ok() {
            let value_name: Vec<u16> = "AppsUseLightTheme\0".encode_utf16().collect();
            let mut data: u32 = 1;
            let mut data_size = std::mem::size_of::<u32>() as u32;
            let mut data_type = REG_DWORD;

            if RegQueryValueExW(
                hkey,
                PCWSTR(value_name.as_ptr()),
                None,
                Some(&mut data_type),
                Some(&mut data as *mut u32 as *mut u8),
                Some(&mut data_size),
            ).is_ok() {
                return data == 0; // 0 = dark theme, 1 = light theme
            }
        }
    }
    true // Default to dark theme
}

#[cfg(not(target_os = "windows"))]
fn is_dark_theme() -> bool {
    true // Default to dark theme on other platforms
}

/// Get the actual work area (excluding taskbar) for a monitor at given position
#[cfg(target_os = "windows")]
fn get_monitor_work_area(x: i32, y: i32, width: u32, height: u32) -> Bounds {
    unsafe {
        // Get monitor handle from center point of the monitor bounds
        let center_x = x + (width as i32 / 2);
        let center_y = y + (height as i32 / 2);
        let point = POINT { x: center_x, y: center_y };
        let hmonitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);

        // Query monitor info to get work area
        let mut monitor_info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };

        if GetMonitorInfoW(hmonitor, &mut monitor_info).is_ok() {
            let work = &monitor_info.rcWork;
            Bounds {
                x: work.left,
                y: work.top,
                width: (work.right - work.left) as u32,
                height: (work.bottom - work.top) as u32,
            }
        } else {
            // Fallback to approximate taskbar height
            Bounds {
                x,
                y,
                width,
                height: height.saturating_sub(48),
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn get_monitor_work_area(x: i32, y: i32, width: u32, height: u32) -> Bounds {
    // Fallback for non-Windows platforms
    Bounds {
        x,
        y,
        width,
        height: height.saturating_sub(48),
    }
}

// App state for configuration
struct AppState {
    config: Mutex<serde_json::Value>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DisplayInfo {
    index: usize,
    bounds: Bounds,
    work_area: Bounds,
    scale_factor: f64,
    refresh_rate: u32,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Bounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

// Tauri commands (invoked from renderer via window.__TAURI__.core.invoke)

#[tauri::command]
fn log_message(message: String) {
    log::info!("[Renderer] {}", message);
}

#[tauri::command]
fn get_config(state: tauri::State<AppState>) -> Result<serde_json::Value, String> {
    let config = state.config.lock().unwrap();
    Ok(config.clone())
}

#[tauri::command]
fn set_rainscape(name: String) {
    log::info!("Current rainscape: {}", name);
}

#[tauri::command]
fn set_ignore_mouse_events(window: tauri::Window, ignore: bool) {
    if let Err(e) = window.set_ignore_cursor_events(ignore) {
        log::error!("Failed to set cursor events: {}", e);
    }
}

#[tauri::command]
fn save_rainscape(app: tauri::AppHandle, filename: String, data: serde_json::Value) -> Result<serde_json::Value, String> {
    let rainscapes_dir = get_rainscapes_dir(&app)?;

    // Ensure filename has .rain extension
    let filename = if filename.ends_with(".rain") {
        filename
    } else if filename.ends_with(".json") {
        // Migrate old .json extension to .rain
        filename.replace(".json", ".rain")
    } else {
        format!("{}.rain", filename)
    };

    // Custom presets go in Custom/ subdirectory (except Autosave and Default)
    let file_path = if filename == "Autosave.rain" || filename == "Default.rain" {
        rainscapes_dir.join(&filename)
    } else {
        rainscapes_dir.join("Custom").join(&filename)
    };

    // Write JSON with pretty formatting
    let json_str = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize: {}", e))?;

    fs::write(&file_path, json_str)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    log::info!("Saved rainscape: {:?}", file_path);
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
fn autosave_rainscape(app: tauri::AppHandle, data: serde_json::Value) -> Result<serde_json::Value, String> {
    let rainscapes_dir = get_rainscapes_dir(&app)?;
    let autosave_path = rainscapes_dir.join("Autosave.rain");

    let json_str = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize: {}", e))?;

    fs::write(&autosave_path, json_str)
        .map_err(|e| format!("Failed to write Autosave.rain: {}", e))?;

    // Don't log every autosave to avoid log spam
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
fn get_startup_rainscape_cmd(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let (filename, data) = get_startup_rainscape(&app)?;
    Ok(serde_json::json!({
        "filename": filename,
        "data": data
    }))
}

#[tauri::command]
fn load_rainscapes(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let rainscapes_dir = get_rainscapes_dir(&app)?;
    let custom_dir = rainscapes_dir.join("Custom");

    // Collect root-level .rain files (Default.rain, Autosave.rain)
    let root_files: Vec<String> = fs::read_dir(&rainscapes_dir)
        .map_err(|e| format!("Failed to read dir: {}", e))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            // Only files with .rain extension, skip directories
            if path.is_file() && path.extension().map(|ext| ext == "rain").unwrap_or(false) {
                path.file_name()?.to_str().map(String::from)
            } else {
                None
            }
        })
        .collect();

    // Collect custom .rain files from Custom/ subdirectory
    let custom_files: Vec<String> = if custom_dir.exists() {
        fs::read_dir(&custom_dir)
            .map_err(|e| format!("Failed to read custom dir: {}", e))?
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
fn read_rainscape(app: tauri::AppHandle, filename: String) -> Result<serde_json::Value, String> {
    let rainscapes_dir = get_rainscapes_dir(&app)?;

    // Handle .rain extension
    let filename = if filename.ends_with(".rain") {
        filename
    } else if filename.ends_with(".json") {
        // Migration: try .rain first, fall back to .json
        filename.replace(".json", ".rain")
    } else {
        format!("{}.rain", filename)
    };

    // Check root first (Autosave.rain, Default.rain), then Custom/
    let root_path = rainscapes_dir.join(&filename);
    let custom_path = rainscapes_dir.join("Custom").join(&filename);

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
fn update_rainscape_param(path: String, value: serde_json::Value, app: tauri::AppHandle) {
    // Broadcast to all windows (overlay + background)
    if let Err(e) = app.emit("update-rainscape-param", serde_json::json!({ "path": path, "value": value })) {
        log::error!("[ParamSync] Failed to emit {}: {}", path, e);
    }
}

#[tauri::command]
fn trigger_audio_start(app: tauri::AppHandle) {
    let _ = app.emit("start-audio", ());
}

#[tauri::command]
fn get_display_info(window: tauri::Window) -> Result<DisplayInfo, String> {
    // Extract monitor index from window label (e.g., "overlay-0" or "background-0" -> 0)
    let label = window.label();
    let index: usize = label
        .strip_prefix("overlay-")
        .or_else(|| label.strip_prefix("background-"))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    // Get the monitor for this window
    if let Ok(Some(monitor)) = window.current_monitor() {
        let pos = monitor.position();
        let size = monitor.size();
        let scale = monitor.scale_factor();

        // Get actual work area using Windows API
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
            refresh_rate: 60,
        })
    } else {
        Err("Could not get monitor info".to_string())
    }
}

#[tauri::command]
fn get_all_displays(app: tauri::AppHandle) -> Result<Vec<DisplayInfo>, String> {
    // Get all available monitors
    let monitors = app
        .available_monitors()
        .map_err(|e| format!("Failed to get monitors: {}", e))?;

    let mut displays = Vec::new();
    for (index, monitor) in monitors.iter().enumerate() {
        let pos = monitor.position();
        let size = monitor.size();
        let scale = monitor.scale_factor();

        // Get actual work area using Windows API
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
            refresh_rate: 60,
        });
    }

    log::info!("[get_all_displays] Found {} monitors", displays.len());
    Ok(displays)
}

/// Create background rain window (desktop level - behind other windows)
#[cfg(target_os = "windows")]
fn create_background_window(
    app: &tauri::App,
    monitor: &tauri::Monitor,
    index: usize,
) -> Result<(), Box<dyn std::error::Error>> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE};

    let pos = monitor.position();
    let size = monitor.size();

    let label = format!("background-{}", index);

    log::info!(
        "Creating background window {}: {}x{} at ({}, {})",
        index, size.width, size.height, pos.x, pos.y
    );

    // Load separate background.html with minimal renderer
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("background.html".into()))
        .title("RainyDesk Background")
        .position(pos.x as f64, pos.y as f64)
        .inner_size(size.width as f64, size.height as f64)
        .transparent(true)
        .decorations(false)
        .always_on_top(false)  // Not on top - will be pushed to bottom
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .shadow(false)
        .build()?;

    // Enable click-through
    window.set_ignore_cursor_events(true)?;

    // Push window to bottom of z-order (just above desktop)
    let hwnd = window.hwnd()?;
    unsafe {
        let _ = SetWindowPos(
            HWND(hwnd.0),
            HWND_BOTTOM,
            0, 0, 0, 0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE
        );
    }

    log::info!("Background window {} created at desktop level", index);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn create_background_window(
    _app: &tauri::App,
    _monitor: &tauri::Monitor,
    _index: usize,
) -> Result<(), Box<dyn std::error::Error>> {
    // Background windows only supported on Windows for now
    Ok(())
}

/// Create overlay window (always on top - for physics rain)
fn create_overlay_window(
    app: &tauri::App,
    monitor: &tauri::Monitor,
    index: usize,
) -> Result<(), Box<dyn std::error::Error>> {
    let pos = monitor.position();
    let size = monitor.size();
    let scale = monitor.scale_factor();

    let label = format!("overlay-{}", index);

    log::info!(
        "Creating overlay {}: {}x{} at ({}, {}) scale={}",
        index, size.width, size.height, pos.x, pos.y, scale
    );

    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("RainyDesk")
        .position(pos.x as f64, pos.y as f64)
        .inner_size(size.width as f64, size.height as f64)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .shadow(false)
        .build()?;

    // Enable click-through
    window.set_ignore_cursor_events(true)?;

    // Open DevTools only for primary monitor (index 0) in dev mode
    #[cfg(debug_assertions)]
    if index == 0 {
        window.open_devtools();
    }

    // Prepare display info for renderer
    let display_info = DisplayInfo {
        index,
        bounds: Bounds {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
        },
        work_area: Bounds {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
        },
        scale_factor: scale,
        refresh_rate: 60, // TODO: Get actual refresh rate via platform API
    };

    // Emit display-info after a brief delay to let the page load
    // In Phase 5, we'll switch to a command-based approach for cleaner IPC
    let win = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        log::info!("Sending display-info to overlay {}", display_info.index);
        if let Err(e) = win.emit("display-info", &display_info) {
            log::error!("Failed to emit display-info: {}", e);
        }
    });

    log::info!("Overlay {} created successfully", index);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize app state
    let default_config = serde_json::json!({
        "rainEnabled": true,
        "intensity": 50,
        "volume": 50,
        "wind": 0
    });

    tauri::Builder::default()
        .manage(AppState {
            config: Mutex::new(default_config),
        })
        .invoke_handler(tauri::generate_handler![
            log_message,
            get_config,
            get_display_info,
            get_all_displays,
            set_rainscape,
            set_ignore_mouse_events,
            save_rainscape,
            autosave_rainscape,
            get_startup_rainscape_cmd,
            load_rainscapes,
            read_rainscape,
            update_rainscape_param,
            trigger_audio_start
        ])
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("overlay-0") {
                let _ = window.set_focus();
            }
            log::info!("Second instance blocked: RainyDesk is already running");
        }))
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
                ])
                .build(),
        )
        .setup(|app| {
            log::info!("RainyDesk Tauri starting...");

            let monitors = app.available_monitors()?;
            log::info!("Found {} monitor(s)", monitors.len());

            // Create background windows first (desktop level - for atmospheric rain)
            for (index, monitor) in monitors.iter().enumerate() {
                if let Err(e) = create_background_window(app, monitor, index) {
                    log::error!("Failed to create background window {}: {}", index, e);
                }
            }

            // Create overlay windows (always on top - for physics rain)
            for (index, monitor) in monitors.iter().enumerate() {
                if let Err(e) = create_overlay_window(app, monitor, index) {
                    log::error!("Failed to create overlay {}: {}", index, e);
                }
            }

            // Start window detection polling (100ms for responsive Pixi physics)
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(100));

                    match window_detector::get_visible_windows() {
                        Ok(window_data) => {
                            if let Err(e) = app_handle.emit("window-data", &window_data) {
                                log::error!("Failed to emit window-data: {}", e);
                            }
                        }
                        Err(e) => {
                            log::error!("Failed to get windows: {}", e);
                        }
                    }
                }
            });

            log::info!("Window detection polling started");

            // Set up system tray
            let quit_item = MenuItem::with_id(app, "quit", "Quit RainyDesk", true, None::<&str>)?;
            let pause_item = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
            let rainscaper_item = MenuItem::with_id(app, "rainscaper", "Open Rainscaper", true, None::<&str>)?;

            // Volume presets submenu
            let volume_submenu = Submenu::with_id_and_items(app, "volume", "Volume", true, &[
                &MenuItem::with_id(app, "vol_mute", "Mute", true, None::<&str>)?,
                &MenuItem::with_id(app, "vol_5", "5%", true, None::<&str>)?,
                &MenuItem::with_id(app, "vol_10", "10%", true, None::<&str>)?,
                &MenuItem::with_id(app, "vol_25", "25%", true, None::<&str>)?,
                &MenuItem::with_id(app, "vol_50", "50%", true, None::<&str>)?,
                &MenuItem::with_id(app, "vol_75", "75%", true, None::<&str>)?,
                &MenuItem::with_id(app, "vol_90", "90%", true, None::<&str>)?,
                &MenuItem::with_id(app, "vol_100", "100%", true, None::<&str>)?,
            ])?;

            // Load rainscape files for quick-select submenu
            let rainscapes_dir = get_rainscapes_dir(&app.handle())?;
            let custom_dir = rainscapes_dir.join("Custom");

            // Collect all .rain files (root + Custom/)
            let mut rainscape_files: Vec<String> = fs::read_dir(&rainscapes_dir)
                .map(|entries| {
                    entries.filter_map(|e| {
                        let entry = e.ok()?;
                        let path = entry.path();
                        // Only .rain files, skip Autosave (internal), skip directories
                        if path.is_file()
                            && path.extension().map(|ext| ext == "rain").unwrap_or(false)
                            && path.file_stem().map(|s| s != "Autosave").unwrap_or(true)
                        {
                            path.file_stem()?.to_str().map(String::from)
                        } else {
                            None
                        }
                    }).collect()
                })
                .unwrap_or_default();

            // Add custom rainscapes with "Custom/" prefix for display
            if custom_dir.exists() {
                let custom_files: Vec<String> = fs::read_dir(&custom_dir)
                    .map(|entries| {
                        entries.filter_map(|e| {
                            let entry = e.ok()?;
                            let path = entry.path();
                            if path.is_file() && path.extension().map(|ext| ext == "rain").unwrap_or(false) {
                                path.file_stem()?.to_str().map(String::from)
                            } else {
                                None
                            }
                        }).collect()
                    })
                    .unwrap_or_default();
                rainscape_files.extend(custom_files);
            }

            // Build rainscape submenu
            let rainscape_submenu = Submenu::with_id(app, "rainscapes", "Rainscapes", true)?;
            if rainscape_files.is_empty() {
                let placeholder = MenuItem::with_id(app, "rs_none", "(No saved rainscapes)", false, None::<&str>)?;
                rainscape_submenu.append(&placeholder)?;
            } else {
                for name in &rainscape_files {
                    let id = format!("rs_{}", name);
                    let item = MenuItem::with_id(app, &id, name, true, None::<&str>)?;
                    rainscape_submenu.append(&item)?;
                }
            }

            let menu = Menu::with_items(app, &[
                &pause_item,
                &rainscaper_item,
                &volume_submenu,
                &rainscape_submenu,
                &quit_item
            ])?;

            // Load theme-aware icon (white for dark theme, black for light theme)
            let icon = load_theme_icon();

            let pause_item_clone = pause_item.clone();
            let _tray = TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("RainyDesk")
                .on_menu_event(move |app, event| {
                    let id = event.id.as_ref();
                    match id {
                        "quit" => {
                            log::info!("Quit requested via tray");
                            app.exit(0);
                        }
                        "pause" => {
                            let paused = !RAIN_PAUSED.load(Ordering::Relaxed);
                            RAIN_PAUSED.store(paused, Ordering::Relaxed);
                            let _ = pause_item_clone.set_text(if paused { "Resume" } else { "Pause" });
                            let _ = app.emit("toggle-rain", !paused);
                            log::info!("Rain {}", if paused { "paused" } else { "resumed" });
                        }
                        "rainscaper" => {
                            let _ = app.emit("toggle-rainscaper", ());
                            log::info!("Open Rainscaper requested");
                        }
                        _ => {
                            // Volume presets (vol_<number>)
                            if let Some(vol_str) = id.strip_prefix("vol_") {
                                let volume = match vol_str {
                                    "mute" => 0,
                                    _ => vol_str.parse::<i32>().unwrap_or(50),
                                };
                                let _ = app.emit("set-volume", volume);
                            }
                            // Rainscape selection (rs_<name>)
                            else if let Some(name) = id.strip_prefix("rs_") {
                                let filename = format!("{}.rain", name);
                                let _ = app.emit("load-rainscape", filename);
                                log::info!("Rainscape selected: {}", name);
                            }
                        }
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        let app = tray.app_handle();
                        let _ = app.emit("toggle-rainscaper", ());
                    }
                })
                .build(app)?;

            log::info!("System tray initialized");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
