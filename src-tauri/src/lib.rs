use tauri::{
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::fs;
use std::path::PathBuf;

mod window_detector;

// Global pause state
static RAIN_PAUSED: AtomicBool = AtomicBool::new(false);

/// Get the rainscapes directory, creating it if needed
fn get_rainscapes_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let rainscapes_dir = app_data.join("rainscapes");

    if !rainscapes_dir.exists() {
        fs::create_dir_all(&rainscapes_dir)
            .map_err(|e| format!("Failed to create rainscapes dir: {}", e))?;
        log::info!("Created rainscapes directory: {:?}", rainscapes_dir);
    }

    Ok(rainscapes_dir)
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

    // Ensure filename has .json extension
    let filename = if filename.ends_with(".json") {
        filename
    } else {
        format!("{}.json", filename)
    };

    let file_path = rainscapes_dir.join(&filename);

    // Write JSON with pretty formatting
    let json_str = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize: {}", e))?;

    fs::write(&file_path, json_str)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    log::info!("Saved rainscape: {:?}", file_path);
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
fn load_rainscapes(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let rainscapes_dir = get_rainscapes_dir(&app)?;

    let files: Vec<String> = fs::read_dir(&rainscapes_dir)
        .map_err(|e| format!("Failed to read dir: {}", e))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.extension().map(|ext| ext == "json").unwrap_or(false) {
                path.file_name()?.to_str().map(String::from)
            } else {
                None
            }
        })
        .collect();

    log::info!("Found {} rainscape files", files.len());
    Ok(files)
}

#[tauri::command]
fn read_rainscape(app: tauri::AppHandle, filename: String) -> Result<serde_json::Value, String> {
    let rainscapes_dir = get_rainscapes_dir(&app)?;
    let file_path = rainscapes_dir.join(&filename);

    let content = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let data: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse JSON: {}", e))?;

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

        log::info!(
            "[get_display_info] Monitor {}: {}x{} at ({}, {})",
            index, size.width, size.height, pos.x, pos.y
        );

        Ok(DisplayInfo {
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
                height: size.height - 48, // Approximate taskbar height, TODO: get actual work area
            },
            scale_factor: scale,
            refresh_rate: 60,
        })
    } else {
        Err("Could not get monitor info".to_string())
    }
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
            set_rainscape,
            set_ignore_mouse_events,
            save_rainscape,
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

            // Start window detection polling (250ms interval like Electron)
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(250));

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
            let menu = Menu::with_items(app, &[&pause_item, &rainscaper_item, &quit_item])?;

            // Load theme-aware icon (white for dark theme, black for light theme)
            let icon = load_theme_icon();

            let pause_item_clone = pause_item.clone();
            let _tray = TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("RainyDesk")
                .on_menu_event(move |app, event| {
                    match event.id.as_ref() {
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
                        _ => {}
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
