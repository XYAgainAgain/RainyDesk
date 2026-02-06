use tauri::{
    Emitter, Listener, Manager, WebviewUrl, WebviewWindowBuilder,
    menu::{Menu, MenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::fs;
use std::path::PathBuf;
use chrono::Local;

mod window_detector;

/// Clean up old log files, keeping only the N most recent.
/// Returns the path to the new log file for this session.
fn setup_session_log(log_dir: &PathBuf, max_logs: usize, max_size_bytes: u64) -> PathBuf {
    // Create log directory if it doesn't exist
    if !log_dir.exists() {
        let _ = fs::create_dir_all(log_dir);
    }

    // Generate timestamped filename for this session
    let timestamp = Local::now().format("%Y-%m-%d_%H-%M-%S");
    let log_filename = format!("RainyDesk_{}.log", timestamp);
    let new_log_path = log_dir.join(&log_filename);

    // Get all existing log files (RainyDesk_*.log pattern)
    let mut log_files: Vec<_> = fs::read_dir(log_dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("RainyDesk_")
                && e.file_name()
                    .to_string_lossy()
                    .ends_with(".log")
        })
        .collect();

    // Sort by modification time (oldest first)
    log_files.sort_by(|a, b| {
        let a_time = a.metadata().and_then(|m| m.modified()).ok();
        let b_time = b.metadata().and_then(|m| m.modified()).ok();
        a_time.cmp(&b_time)
    });

    // Delete old logs, keeping only (max_logs - 1) to make room for the new one
    while log_files.len() >= max_logs {
        if let Some(oldest) = log_files.first() {
            let _ = fs::remove_file(oldest.path());
            log_files.remove(0);
        }
    }

    // Also delete any logs that exceed max size (cleanup from previous runs)
    for log_file in &log_files {
        if let Ok(metadata) = log_file.metadata() {
            if metadata.len() > max_size_bytes {
                let _ = fs::remove_file(log_file.path());
            }
        }
    }

    // Delete the legacy single log file if it exists
    let legacy_log = log_dir.join("RainyDesk.log");
    if legacy_log.exists() {
        let _ = fs::remove_file(&legacy_log);
    }

    new_log_path
}

#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::{MonitorFromPoint, GetMonitorInfoW, MONITORINFO, MONITOR_DEFAULTTONEAREST};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::POINT;

// Global pause state
static RAIN_PAUSED: AtomicBool = AtomicBool::new(false);

// Global reference to pause menu item for sync between panel and tray
static PAUSE_MENU_ITEM: Mutex<Option<MenuItem<tauri::Wry>>> = Mutex::new(None);

// Rainscaper panel visibility state
static RAINSCAPER_VISIBLE: AtomicBool = AtomicBool::new(false);

// Fade-in coordination: both windows must be ready before synchronized fade
static OVERLAY_READY: AtomicBool = AtomicBool::new(false);
static BACKGROUND_READY: AtomicBool = AtomicBool::new(false);

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

/// Create the default rainscape configuration (v2.0 schema)
fn create_default_rainscape() -> serde_json::Value {
    serde_json::json!({
        "name": "Default",
        "version": "2.0.0",
        "description": "Balanced rain soundscape with gentle wind",
        "author": "RainyDesk",
        "tags": ["default", "ambient", "relaxing"],

        "rain": {
            "intensity": 50,
            "wind": 15,
            "turbulence": 0.3,
            "dropSize": {
                "min": 1.5,
                "max": 4.0
            },
            "splashEnabled": true
        },

        "audio": {
            "masterVolume": -6,

            "impact": {
                "enabled": true,
                "noiseType": "pink",
                "attack": 0.001,
                "decayMin": 0.03,
                "decayMax": 0.08,
                "filterFreqMin": 2000,
                "filterFreqMax": 8000,
                "filterQ": 1,
                "gain": 0,
                "poolSize": 12
            },

            "bubble": {
                "enabled": true,
                "oscillatorType": "sine",
                "attack": 0.005,
                "decayMin": 0.05,
                "decayMax": 0.15,
                "chirpAmount": 0.1,
                "chirpTime": 0.1,
                "freqMin": 500,
                "freqMax": 4000,
                "probability": 0,
                "gain": -3,
                "poolSize": 8
            },

            "sheet": {
                "noiseType": "pink",
                "filterType": "lowpass",
                "filterFreq": 2000,
                "filterQ": 1,
                "minVolume": -60,
                "maxVolume": -12,
                "maxParticleCount": 500,
                "rampTime": 0.1
            },

            "wind": {
                "masterGain": -12,
                "bed": {
                    "enabled": true,
                    "noiseType": "pink",
                    "baseGain": -24,
                    "lpfFreq": 800,
                    "hpfFreq": 80,
                    "lfoRate": 0.15,
                    "lfoDepth": 0.3
                },
                "interaction": {
                    "enabled": false,
                    "cornerWhistleGain": -30,
                    "eaveDripGain": -36,
                    "rattleGain": -40
                },
                "gust": {
                    "enabled": true,
                    "minInterval": 8,
                    "maxInterval": 25,
                    "riseTime": 1.5,
                    "fallTime": 3,
                    "intensityRange": [0.3, 0.8]
                },
                "aeolian": {
                    "enabled": false,
                    "strouhalNumber": 0.2,
                    "wireDiameter": 4,
                    "baseFreq": 400,
                    "harmonics": [1, 2, 3],
                    "gain": -30
                },
                "singing": {
                    "enabled": false,
                    "mode": "aeolian",
                    "rootNote": "A3",
                    "vowelFormants": {
                        "f1": 730,
                        "f2": 1090,
                        "f3": 2440,
                        "f4": 3400,
                        "f5": 4500
                    },
                    "gain": -28
                },
                "katabatic": {
                    "enabled": false,
                    "lowFreqBoost": 6,
                    "surgeRate": 0.08,
                    "gain": -30
                }
            },

            "thunder": {
                "masterGain": -6,
                "minInterval": 30,
                "maxInterval": 120,
                "distanceRange": [1, 15],
                "sidechainEnabled": true,
                "sidechainRatio": 4,
                "sidechainAttack": 0.01,
                "sidechainRelease": 0.5,
                "tearing": {
                    "enabled": true,
                    "noiseType": "white",
                    "hpfFreq": 4000,
                    "attackTime": 0.005,
                    "decayTime": 0.15,
                    "gain": -12
                },
                "crack": {
                    "enabled": true,
                    "frequency": 80,
                    "harmonics": 6,
                    "attackTime": 0.002,
                    "decayTime": 0.3,
                    "gain": -6
                },
                "body": {
                    "enabled": true,
                    "noiseType": "brown",
                    "lpfFreq": 400,
                    "reverbDecay": 4,
                    "gain": -8
                },
                "rumble": {
                    "enabled": true,
                    "frequency": 35,
                    "lfoRate": 0.3,
                    "duration": 8,
                    "gain": -10
                }
            },

            "matrix": {
                "masterGain": -12,
                "drop": {
                    "enabled": false,
                    "carrierFreq": 800,
                    "modulatorRatio": 2,
                    "modulationIndex": 5,
                    "glideTime": 0.15,
                    "attackTime": 0.005,
                    "decayTime": 0.2,
                    "gain": -12
                },
                "drone": {
                    "enabled": false,
                    "baseFreq": 60,
                    "beatFreq": 4,
                    "phaserRate": 0.2,
                    "phaserDepth": 0.5,
                    "gain": -24
                },
                "glitch": {
                    "enabled": false,
                    "bitDepth": 8,
                    "sampleRateReduction": 4,
                    "probability": 0.1,
                    "gain": -18
                }
            },

            "sfx": {
                "rainBus": {
                    "gain": 0,
                    "mute": false,
                    "solo": false,
                    "pan": 0,
                    "eqLow": 0,
                    "eqMid": 0,
                    "eqHigh": 0,
                    "compressorEnabled": true,
                    "compressorThreshold": -18,
                    "compressorRatio": 3,
                    "reverbSend": 0.3,
                    "delaySend": 0
                },
                "windBus": {
                    "gain": -6,
                    "mute": false,
                    "solo": false,
                    "pan": 0,
                    "eqLow": 0,
                    "eqMid": 0,
                    "eqHigh": 0,
                    "compressorEnabled": false,
                    "compressorThreshold": -24,
                    "compressorRatio": 4,
                    "reverbSend": 0.2,
                    "delaySend": 0
                },
                "thunderBus": {
                    "gain": 0,
                    "mute": false,
                    "solo": false,
                    "pan": 0,
                    "eqLow": 0,
                    "eqMid": 0,
                    "eqHigh": 0,
                    "compressorEnabled": false,
                    "compressorThreshold": -24,
                    "compressorRatio": 4,
                    "reverbSend": 0.4,
                    "delaySend": 0
                },
                "matrixBus": {
                    "gain": -12,
                    "mute": false,
                    "solo": false,
                    "pan": 0,
                    "eqLow": 0,
                    "eqMid": 0,
                    "eqHigh": 0,
                    "compressorEnabled": false,
                    "compressorThreshold": -24,
                    "compressorRatio": 4,
                    "reverbSend": 0.5,
                    "delaySend": 0.3
                },
                "masterBus": {
                    "gain": -6,
                    "limiterEnabled": true,
                    "limiterThreshold": -1
                }
            }
        },

        "visual": {
            "pixelScale": 0.25,
            "colorTint": "#7799ff",
            "trailLength": 0.8,
            "splashOpacity": 0.7
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

/// Get Windows accent color from registry
#[cfg(target_os = "windows")]
fn get_accent_color_from_registry() -> Option<String> {
    use windows::Win32::System::Registry::{
        RegOpenKeyExW, RegQueryValueExW, RegCloseKey, HKEY_CURRENT_USER, KEY_READ, REG_DWORD,
    };
    use windows::core::PCWSTR;

    unsafe {
        let mut hkey = std::mem::zeroed();
        let subkey: Vec<u16> = "SOFTWARE\\Microsoft\\Windows\\DWM\0"
            .encode_utf16().collect();

        if RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(subkey.as_ptr()), 0, KEY_READ, &mut hkey).is_ok() {
            let value_name: Vec<u16> = "AccentColor\0".encode_utf16().collect();
            let mut data: u32 = 0;
            let mut data_size = std::mem::size_of::<u32>() as u32;
            let mut data_type = REG_DWORD;

            let result = RegQueryValueExW(
                hkey,
                PCWSTR(value_name.as_ptr()),
                None,
                Some(&mut data_type),
                Some(&mut data as *mut u32 as *mut u8),
                Some(&mut data_size),
            );

            let _ = RegCloseKey(hkey);

            if result.is_ok() {
                // AccentColor is in ABGR format, convert to #RRGGBB
                let r = (data >> 0) & 0xFF;
                let g = (data >> 8) & 0xFF;
                let b = (data >> 16) & 0xFF;
                return Some(format!("#{:02x}{:02x}{:02x}", r, g, b));
            }
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn get_accent_color_from_registry() -> Option<String> {
    None
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

        if GetMonitorInfoW(hmonitor, &mut monitor_info).as_bool() {
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

/// Find which monitor is the primary (contains point 0,0)
#[cfg(target_os = "windows")]
fn get_primary_monitor_index(monitors: &[tauri::Monitor]) -> usize {
    use windows::Win32::Graphics::Gdi::{
        MonitorFromPoint, GetMonitorInfoW, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
    };

    unsafe {
        // Primary monitor contains point (0, 0)
        let primary = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);

        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };

        if GetMonitorInfoW(primary, &mut info).as_bool() {
            let primary_x = info.rcMonitor.left;
            let primary_y = info.rcMonitor.top;

            // Find matching monitor in our list
            for (i, monitor) in monitors.iter().enumerate() {
                let pos = monitor.position();
                if pos.x == primary_x && pos.y == primary_y {
                    return i;
                }
            }
        }
    }
    0 // Default to first monitor
}

#[cfg(not(target_os = "windows"))]
fn get_primary_monitor_index(_monitors: &[tauri::Monitor]) -> usize {
    0 // Default to first monitor on non-Windows platforms
}

// App state for configuration
struct AppState {
    config: Mutex<serde_json::Value>,
}

/// Panel position and UI config persistence
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct PanelConfig {
    x: Option<i32>,
    y: Option<i32>,
    ui_scale: Option<f32>,
}

fn get_panel_config_path(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap().join("panel-config.json")
}

fn load_panel_config(app: &tauri::AppHandle) -> Option<PanelConfig> {
    let path = get_panel_config_path(app);
    std::fs::read_to_string(&path).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn save_panel_config(app: &tauri::AppHandle, config: &PanelConfig) {
    let path = get_panel_config_path(app);
    if let Ok(json) = serde_json::to_string_pretty(config) {
        let _ = std::fs::write(&path, json);
    }
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

/// Virtual desktop info: bounding box of all monitors + individual regions
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct VirtualDesktop {
    /// Bounding box origin (may be negative if monitor extends left of primary)
    origin_x: i32,
    origin_y: i32,
    /// Total bounding box dimensions
    width: u32,
    height: u32,
    /// Individual monitor regions with coordinates relative to bounding box
    monitors: Vec<MonitorRegion>,
    /// Index of the primary monitor (for Rainscaper UI positioning)
    primary_index: usize,
}

/// Single monitor region within the virtual desktop
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MonitorRegion {
    index: usize,
    /// Position relative to virtual desktop origin (always >= 0)
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    /// Work area (excluding taskbar) relative to virtual desktop origin
    work_x: u32,
    work_y: u32,
    work_width: u32,
    work_height: u32,
    scale_factor: f64,
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
    // Sync pause state to tray menu when panel toggles pause
    if path == "system.paused" {
        if let Some(paused) = value.as_bool() {
            RAIN_PAUSED.store(paused, Ordering::Relaxed);
            // Update tray menu text to match
            if let Ok(guard) = PAUSE_MENU_ITEM.lock() {
                if let Some(ref item) = *guard {
                    let _ = item.set_text(if paused { "Resume" } else { "Pause" });
                }
            }
            log::info!("[ParamSync] Pause state synced from panel: {}", paused);
        }
    }

    // Broadcast to all windows (overlay + background)
    if let Err(e) = app.emit("update-rainscape-param", serde_json::json!({ "path": path, "value": value })) {
        log::error!("[ParamSync] Failed to emit {}: {}", path, e);
    }
}

#[tauri::command]
fn trigger_audio_start(app: tauri::AppHandle) {
    let _ = app.emit("start-audio", ());
}

/// Check if both windows are ready and broadcast fade-in signal
fn check_both_ready(app: &tauri::AppHandle) {
    if OVERLAY_READY.load(Ordering::SeqCst) && BACKGROUND_READY.load(Ordering::SeqCst) {
        log::info!("[FadeIn] Both windows ready, broadcasting start-fade-in");
        if let Err(e) = app.emit("start-fade-in", ()) {
            log::error!("[FadeIn] Failed to emit start-fade-in: {}", e);
        }
        // Reset flags after broadcast so hot reload can coordinate fresh
        OVERLAY_READY.store(false, Ordering::SeqCst);
        BACKGROUND_READY.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
fn renderer_ready(app: tauri::AppHandle) {
    log::info!("[FadeIn] Overlay renderer ready");
    OVERLAY_READY.store(true, Ordering::SeqCst);
    check_both_ready(&app);
}

#[tauri::command]
fn background_ready(app: tauri::AppHandle) {
    log::info!("[FadeIn] Background renderer ready");
    BACKGROUND_READY.store(true, Ordering::SeqCst);
    check_both_ready(&app);
}

/// Show the Rainscaper window at the specified tray position
#[tauri::command]
fn show_rainscaper(app: tauri::AppHandle, tray_x: i32, tray_y: i32) -> Result<(), String> {
    log::info!("[Rainscaper] Show requested at tray position ({}, {})", tray_x, tray_y);

    // Try saved position first, fallback to tray-relative calculation
    let (x, y) = load_panel_config(&app)
        .and_then(|c| c.x.zip(c.y))
        .unwrap_or_else(|| calculate_rainscaper_position(&app, tray_x, tray_y));

    // Check if window exists
    let window_exists = app.get_webview_window("rainscaper").is_some();
    log::info!("[Rainscaper] Window exists: {}", window_exists);

    if let Some(window) = app.get_webview_window("rainscaper") {
        // Window exists, just show and position it
        log::info!("[Rainscaper] Reusing existing window");
        log::info!("[Rainscaper] Positioning to ({}, {})", x, y);
        window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)))
            .map_err(|e| format!("Failed to position window: {}", e))?;
        // Unminimize first in case hide() minimized it
        log::info!("[Rainscaper] Calling unminimize()");
        window.unminimize().ok();
        // Call show()
        log::info!("[Rainscaper] Calling window.show()");
        window.show().map_err(|e| format!("Failed to show window: {}", e))?;
        // Re-enable mouse events AFTER showing so panel is clickable
        window.set_ignore_cursor_events(false).ok();
        // Re-apply always on top
        window.set_always_on_top(true).ok();
        window.set_focus().map_err(|e| format!("Failed to focus window: {}", e))?;
        RAINSCAPER_VISIBLE.store(true, Ordering::SeqCst);
        log::info!("[Rainscaper] Shown successfully at ({}, {})", x, y);
    } else {
        // Create the window at saved/calculated position
        log::info!("[Rainscaper] Window not found, creating new one at ({}, {})", x, y);
        create_rainscaper_window_at(&app, x, y)?;
    }

    Ok(())
}

/// Hide the Rainscaper window
#[tauri::command]
fn hide_rainscaper(app: tauri::AppHandle) -> Result<(), String> {
    log::info!("[Rainscaper] Hide requested");
    if let Some(window) = app.get_webview_window("rainscaper") {
        // Save position before hiding
        if let Ok(pos) = window.outer_position() {
            let mut config = load_panel_config(&app).unwrap_or_default();
            config.x = Some(pos.x);
            config.y = Some(pos.y);
            save_panel_config(&app, &config);
            log::info!("[Rainscaper] Saved position ({}, {})", pos.x, pos.y);
        }
        // Set click-through BEFORE hiding so rain doesn't puddle on invisible window
        window.set_ignore_cursor_events(true).ok();
        log::info!("[Rainscaper] Calling window.hide()");
        window.hide().map_err(|e| format!("Failed to hide window: {}", e))?;
        RAINSCAPER_VISIBLE.store(false, Ordering::SeqCst);
        log::info!("[Rainscaper] Hidden successfully, VISIBLE=false");
    } else {
        log::warn!("[Rainscaper] Hide called but window not found");
    }
    Ok(())
}

/// Toggle Rainscaper visibility
#[tauri::command]
fn toggle_rainscaper(app: tauri::AppHandle, tray_x: i32, tray_y: i32) -> Result<(), String> {
    let visible = RAINSCAPER_VISIBLE.load(Ordering::SeqCst);
    if visible {
        hide_rainscaper(app)
    } else {
        show_rainscaper(app, tray_x, tray_y)
    }
}

/// Resize the Rainscaper panel window and keep it in work area
#[tauri::command]
fn resize_rainscaper(app: tauri::AppHandle, width: f64, height: f64) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("rainscaper") {
        use tauri::{LogicalSize, PhysicalPosition};

        // Temporarily enable resizing (window is created with resizable=false)
        window.set_resizable(true).ok();
        window.set_size(LogicalSize::new(width, height))
            .map_err(|e| format!("Failed to resize: {}", e))?;
        window.set_resizable(false).ok();

        // Clamp position to keep window in work area
        if let (Ok(pos), Some(monitor)) = (window.outer_position(), window.current_monitor().ok().flatten()) {
            let scale = monitor.scale_factor();
            let mon_size = monitor.size();
            let mon_pos = monitor.position();

            // Get actual work area from Windows API (excludes taskbar)
            let work_area = get_monitor_work_area(
                mon_pos.x,
                mon_pos.y,
                mon_size.width,
                mon_size.height
            );

            // Convert window size to physical pixels for comparison
            let phys_width = (width * scale) as i32;
            let phys_height = (height * scale) as i32;

            let mut new_x = pos.x;
            let mut new_y = pos.y;
            let mut moved = false;

            // If window bottom exceeds work area, move it up
            let work_bottom = work_area.y + work_area.height as i32;
            if new_y + phys_height > work_bottom {
                new_y = (work_bottom - phys_height).max(work_area.y);
                moved = true;
            }

            // If window right exceeds work area, move it left
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

/// Get Windows accent color for adaptive theme
#[tauri::command]
fn get_windows_accent_color() -> String {
    get_accent_color_from_registry().unwrap_or_else(|| "#0078d4".to_string())
}

/// Calculate position for Rainscaper window above tray icon
fn calculate_rainscaper_position(app: &tauri::AppHandle, tray_x: i32, tray_y: i32) -> (i32, i32) {
    const PANEL_WIDTH: i32 = 400;
    const PANEL_HEIGHT: i32 = 500;
    const MARGIN: i32 = 8;

    // Get monitors to find screen bounds
    let monitors: Vec<tauri::Monitor> = app
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .collect();

    // Find which monitor contains the tray icon
    let mut screen_x = 0;
    let mut screen_y = 0;
    let mut screen_width = 1920;
    let mut screen_height = 1080;
    let mut taskbar_at_top = false;

    for monitor in &monitors {
        let pos = monitor.position();
        let size = monitor.size();

        if tray_x >= pos.x && tray_x < pos.x + size.width as i32 &&
           tray_y >= pos.y && tray_y < pos.y + size.height as i32 {
            screen_x = pos.x;
            screen_y = pos.y;
            screen_width = size.width as i32;
            screen_height = size.height as i32;

            // Check if taskbar is at top (tray_y near top of screen)
            taskbar_at_top = tray_y < pos.y + 100;
            break;
        }
    }

    // Position window above tray icon, centered horizontally
    let mut x = tray_x - (PANEL_WIDTH / 2);
    let mut y = if taskbar_at_top {
        tray_y + 40 + MARGIN  // Below taskbar
    } else {
        tray_y - PANEL_HEIGHT - MARGIN  // Above taskbar
    };

    // Clamp to screen bounds
    x = x.max(screen_x + MARGIN).min(screen_x + screen_width - PANEL_WIDTH - MARGIN);
    y = y.max(screen_y + MARGIN).min(screen_y + screen_height - PANEL_HEIGHT - MARGIN);

    (x, y)
}

/// Create the Rainscaper popup window (calculates position from tray coords)
fn create_rainscaper_window(app: &tauri::AppHandle, tray_x: i32, tray_y: i32) -> Result<(), String> {
    let (x, y) = calculate_rainscaper_position(app, tray_x, tray_y);
    create_rainscaper_window_at(app, x, y)
}

/// Create the Rainscaper popup window at specified position
fn create_rainscaper_window_at(app: &tauri::AppHandle, x: i32, y: i32) -> Result<(), String> {
    log::info!("[Rainscaper] Creating window at ({}, {})", x, y);

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
        .focused(true)
        .shadow(false)
        .visible(true)
        .build()
        .map_err(|e| format!("Failed to create window: {}", e))?;

    // Enable mouse events so panel is clickable (not click-through)
    window.set_ignore_cursor_events(false).ok();

    // Open DevTools in dev mode
    #[cfg(debug_assertions)]
    {
        window.open_devtools();
    }

    RAINSCAPER_VISIBLE.store(true, Ordering::SeqCst);
    log::info!("[Rainscaper] Window created successfully");

    Ok(())
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

#[tauri::command]
fn get_virtual_desktop(app: tauri::AppHandle) -> Result<VirtualDesktop, String> {
    let monitors: Vec<tauri::Monitor> = app
        .available_monitors()
        .map_err(|e| format!("Failed to get monitors: {}", e))?
        .into_iter()
        .collect();

    if monitors.is_empty() {
        return Err("No monitors found".to_string());
    }

    // Calculate bounding box (X_min, Y_min, X_max, Y_max)
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

    let total_width = (x_max - x_min) as u32;
    let total_height = (y_max - y_min) as u32;

    log::info!(
        "[VirtualDesktop] Bounding box: ({}, {}) {}x{}",
        x_min, y_min, total_width, total_height
    );

    // Get primary monitor index
    let primary_index = get_primary_monitor_index(&monitors);

    // Build monitor regions with coordinates relative to bounding box origin
    let mut regions = Vec::new();
    for (index, monitor) in monitors.iter().enumerate() {
        let pos = monitor.position();
        let size = monitor.size();
        let scale = monitor.scale_factor();

        // Get actual work area from Windows API
        let work_area = get_monitor_work_area(pos.x, pos.y, size.width, size.height);

        // Convert to bounding-box-relative coordinates (always positive)
        let rel_x = (pos.x - x_min) as u32;
        let rel_y = (pos.y - y_min) as u32;
        let rel_work_x = (work_area.x - x_min) as u32;
        let rel_work_y = (work_area.y - y_min) as u32;

        regions.push(MonitorRegion {
            index,
            x: rel_x,
            y: rel_y,
            width: size.width,
            height: size.height,
            work_x: rel_work_x,
            work_y: rel_work_y,
            work_width: work_area.width,
            work_height: work_area.height,
            scale_factor: scale,
        });

        log::info!(
            "[VirtualDesktop] Monitor {}{}: rel({}, {}) {}x{} work_height={}",
            index,
            if index == primary_index { " (primary)" } else { "" },
            rel_x, rel_y, size.width, size.height, work_area.height
        );
    }

    Ok(VirtualDesktop {
        origin_x: x_min,
        origin_y: y_min,
        width: total_width,
        height: total_height,
        monitors: regions,
        primary_index,
    })
}

/// Create mega-background window spanning entire virtual desktop (HWND_BOTTOM)
#[cfg(target_os = "windows")]
fn create_mega_background(
    app: &tauri::App,
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

    // Enable click-through
    window.set_ignore_cursor_events(true)?;

    // Push to bottom of z-order (just above desktop)
    let hwnd = window.hwnd()?;
    unsafe {
        let _ = SetWindowPos(
            HWND(hwnd.0),
            HWND_BOTTOM,
            0, 0, 0, 0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE
        );
    }

    // Note: Renderer requests virtual-desktop info via get_virtual_desktop command when ready.
    // No need for push-based emission with timing hacks.

    log::info!("Mega-background created successfully");
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn create_mega_background(
    _app: &tauri::App,
    _desktop: &VirtualDesktop,
) -> Result<(), Box<dyn std::error::Error>> {
    // Background windows only supported on Windows for now
    Ok(())
}

/// Create mega-overlay window spanning entire virtual desktop (always-on-top)
fn create_mega_overlay(
    app: &tauri::App,
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

    // Enable click-through
    window.set_ignore_cursor_events(true)?;

    // Open DevTools in dev mode
    #[cfg(debug_assertions)]
    {
        window.open_devtools();
    }

    // Note: Renderer requests virtual-desktop info via get_virtual_desktop command when ready.
    // No need for push-based emission with timing hacks.

    log::info!("Mega-overlay created successfully");
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
            get_virtual_desktop,
            set_rainscape,
            set_ignore_mouse_events,
            save_rainscape,
            autosave_rainscape,
            get_startup_rainscape_cmd,
            load_rainscapes,
            read_rainscape,
            update_rainscape_param,
            trigger_audio_start,
            renderer_ready,
            background_ready,
            show_rainscaper,
            hide_rainscaper,
            toggle_rainscaper,
            resize_rainscaper,
            get_windows_accent_color
        ])
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("overlay") {
                let _ = window.set_focus();
            }
            log::info!("Second instance blocked: RainyDesk is already running");
        }))
        .plugin({
            // Set up session-specific log file with rolling cleanup
            // Keep 5 most recent logs, max 1 MB each
            let log_dir = dirs::data_local_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("com.rainydesk.app")
                .join("logs");
            let log_path = setup_session_log(&log_dir, 5, 1_048_576); // 1 MB = 1,048,576 bytes
            let log_filename = log_path.file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.trim_end_matches(".log").to_string())
                .unwrap_or_else(|| "RainyDesk".to_string());

            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .max_file_size(1_048_576) // 1 MB max per log file
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some(log_filename),
                    }),
                ])
                .build()
        })
        .setup(|app| {
            log::info!("RainyDesk Tauri starting...");

            // Calculate virtual desktop (bounding box of all monitors)
            let desktop = get_virtual_desktop(app.handle().clone())
                .map_err(|e| Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))?;

            log::info!(
                "Virtual desktop: {}x{} at ({}, {}) with {} monitor(s)",
                desktop.width, desktop.height,
                desktop.origin_x, desktop.origin_y,
                desktop.monitors.len()
            );

            // Create mega-background (HWND_BOTTOM - atmospheric rain behind windows)
            if let Err(e) = create_mega_background(app, &desktop) {
                log::error!("Failed to create mega-background: {}", e);
            }

            // Create mega-overlay (always-on-top - physics rain + UI)
            if let Err(e) = create_mega_overlay(app, &desktop) {
                log::error!("Failed to create mega-overlay: {}", e);
            }

            // Start window detection polling (25ms for responsive physics)
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(25));

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

            // Listen for hide-rainscaper-request from frontend (X button)
            let app_handle_for_hide = app.handle().clone();
            app.listen("hide-rainscaper-request", move |_event| {
                log::info!("[Rainscaper] Hide requested via event (X button)");
                if let Some(window) = app_handle_for_hide.get_webview_window("rainscaper") {
                    window.set_ignore_cursor_events(true).ok();
                    if let Err(e) = window.hide() {
                        log::error!("[Rainscaper] Failed to hide: {}", e);
                    } else {
                        RAINSCAPER_VISIBLE.store(false, Ordering::SeqCst);
                        log::info!("[Rainscaper] Hidden via event, VISIBLE=false");
                    }
                }
            });

            // Set up system tray
            let quit_item = MenuItem::with_id(app, "quit", "Quit RainyDesk", true, None::<&str>)?;
            let pause_item = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
            let rainscaper_item = MenuItem::with_id(app, "rainscaper", "Open Rainscaper", true, None::<&str>)?;

            // Store pause item globally for sync between panel and tray
            if let Ok(mut guard) = PAUSE_MENU_ITEM.lock() {
                *guard = Some(pause_item.clone());
            }

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
                            // Emit same IPC as panel's pause toggle for unified control
                            // Must use JSON object format: { path, value } to match tauri-api.js listener
                            let _ = app.emit("update-rainscape-param", serde_json::json!({ "path": "system.paused", "value": paused }));
                            log::info!("Rain {} via tray menu", if paused { "paused" } else { "resumed" });
                        }
                        "rainscaper" => {
                            // Menu doesn't give position, use default (bottom-right of primary)
                            let visible = RAINSCAPER_VISIBLE.load(Ordering::SeqCst);
                            if visible {
                                let _ = hide_rainscaper(app.clone());
                            } else {
                                // Default to bottom-right area (typical tray location)
                                let _ = show_rainscaper(app.clone(), 1800, 1040);
                            }
                            log::info!("Rainscaper toggled via menu");
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
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, position, .. } = event {
                        let app = tray.app_handle();
                        let tray_x = position.x as i32;
                        let tray_y = position.y as i32;

                        // Toggle Rainscaper window directly (no longer through overlay)
                        let visible = RAINSCAPER_VISIBLE.load(Ordering::SeqCst);
                        log::info!("[Tray] Left-click, RAINSCAPER_VISIBLE={}", visible);
                        if visible {
                            if let Err(e) = hide_rainscaper(app.clone()) {
                                log::error!("[Tray] Failed to hide Rainscaper: {}", e);
                            }
                        } else {
                            if let Err(e) = show_rainscaper(app.clone(), tray_x, tray_y) {
                                log::error!("[Tray] Failed to show Rainscaper: {}", e);
                            }
                        }
                    }
                })
                .build(app)?;

            log::info!("System tray initialized");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
