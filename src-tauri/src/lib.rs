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

// Global reference to rainscaper menu item for Open/Close text sync
static RAINSCAPER_MENU_ITEM: Mutex<Option<MenuItem<tauri::Wry>>> = Mutex::new(None);

// Rainscaper panel visibility state
static RAINSCAPER_VISIBLE: AtomicBool = AtomicBool::new(false);

// Fade-in coordination: both windows must be ready before synchronized fade
static OVERLAY_READY: AtomicBool = AtomicBool::new(false);
static BACKGROUND_READY: AtomicBool = AtomicBool::new(false);

/// Get the rainscapes directory, creating structure if needed:
/// Documents\RainyDesk\
/// ├── Autosave.rain            ← Always loaded first, overwritten on changes
/// ├── Default.rain             ← Fallback if no Autosave exists
/// └── Custom Rainscapes\       ← User-created presets
fn get_rainscapes_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let docs_dir = dirs::document_dir()
        .ok_or_else(|| "Failed to get Documents directory".to_string())?;
    let rainscapes_dir = docs_dir.join("RainyDesk");
    let custom_dir = rainscapes_dir.join("Custom Rainscapes");

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

    // One-time migration from old AppData location
    migrate_old_rainscapes(app, &rainscapes_dir);

    Ok(rainscapes_dir)
}

/// Migrate rainscape files from old AppData\Roaming location to Documents\RainyDesk.
/// Copies files then removes the old directory. Runs once (no-ops if old dir doesn't exist).
fn migrate_old_rainscapes(app: &tauri::AppHandle, new_dir: &PathBuf) {
    let old_dir = match app.path().app_data_dir() {
        Ok(d) => d.join("rainscapes"),
        Err(_) => return,
    };
    if !old_dir.exists() { return; }

    log::info!("[Migration] Found old rainscapes at {:?}, migrating to {:?}", old_dir, new_dir);

    let mut migrated = 0u32;
    let mut failed = 0u32;

    // Copy root-level .rain files
    if let Ok(entries) = fs::read_dir(&old_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_file() && path.extension().map(|ext| ext == "rain").unwrap_or(false) {
                let Some(name) = path.file_name() else { continue };
                let dest = new_dir.join(name);
                if !dest.exists() {
                    if let Err(e) = fs::copy(&path, &dest) {
                        log::error!("[Migration] Failed to copy {:?}: {}", path, e);
                        failed += 1;
                    } else {
                        migrated += 1;
                    }
                }
            }
        }
    }

    // Copy files from old Custom/ subdirectory to new Custom Rainscapes/
    let old_custom = old_dir.join("Custom");
    let new_custom = new_dir.join("Custom Rainscapes");
    if old_custom.exists() {
        if let Ok(entries) = fs::read_dir(&old_custom) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_file() && path.extension().map(|ext| ext == "rain").unwrap_or(false) {
                    let Some(name) = path.file_name() else { continue };
                    let dest = new_custom.join(name);
                    if !dest.exists() {
                        if let Err(e) = fs::copy(&path, &dest) {
                            log::error!("[Migration] Failed to copy custom {:?}: {}", path, e);
                            failed += 1;
                        } else {
                            migrated += 1;
                        }
                    }
                }
            }
        }
    }

    // Only remove old directory if every copy succeeded
    if failed == 0 {
        if let Err(e) = fs::remove_dir_all(&old_dir) {
            log::warn!("[Migration] Failed to remove old dir {:?}: {}", old_dir, e);
        }
    } else {
        log::warn!("[Migration] {} copies failed, keeping old dir {:?} as backup", failed, old_dir);
    }

    log::info!("[Migration] Complete: {} migrated, {} failed", migrated, failed);
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
        RegOpenKeyExW, RegQueryValueExW, RegCloseKey, HKEY_CURRENT_USER, KEY_READ, REG_DWORD,
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

/// Query actual refresh rate for the monitor at given position
#[cfg(target_os = "windows")]
fn get_monitor_refresh_rate(x: i32, y: i32, width: u32, height: u32) -> u32 {
    use windows::Win32::Graphics::Gdi::{
        MonitorFromPoint, GetMonitorInfoW, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST,
        EnumDisplaySettingsW, DEVMODEW, ENUM_CURRENT_SETTINGS,
    };

    unsafe {
        let center_x = x + (width as i32 / 2);
        let center_y = y + (height as i32 / 2);
        let point = POINT { x: center_x, y: center_y };
        let hmonitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);

        let mut info = MONITORINFOEXW {
            monitorInfo: MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFOEXW>() as u32,
                ..Default::default()
            },
            ..Default::default()
        };

        if !GetMonitorInfoW(hmonitor, &mut info.monitorInfo).as_bool() {
            return 60;
        }

        let mut devmode = DEVMODEW {
            dmSize: std::mem::size_of::<DEVMODEW>() as u16,
            ..Default::default()
        };

        if EnumDisplaySettingsW(
            windows::core::PCWSTR(info.szDevice.as_ptr()),
            ENUM_CURRENT_SETTINGS,
            &mut devmode,
        ).as_bool() {
            let hz = devmode.dmDisplayFrequency;
            if hz > 0 { hz } else { 60 }
        } else {
            60
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn get_monitor_refresh_rate(_x: i32, _y: i32, _width: u32, _height: u32) -> u32 {
    60
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

fn get_panel_config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("panel-config.json"))
}

fn load_panel_config(app: &tauri::AppHandle) -> Option<PanelConfig> {
    let path = get_panel_config_path(app)?;
    std::fs::read_to_string(&path).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn save_panel_config(app: &tauri::AppHandle, config: &PanelConfig) {
    let Some(path) = get_panel_config_path(app) else { return };
    // Ensure app data directory exists
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
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

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemSpecs {
    cpu_model: String,
    gpu_model: String,
    total_ram_gb: f64,
}

/// Virtual desktop info: bounding box of all monitors + individual regions
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct VirtualDesktop {
    /// Bounding box origin (may be negative if monitor extends left of primary)
    origin_x: i32,
    origin_y: i32,
    /// Total bounding box dimensions (logical pixels)
    width: u32,
    height: u32,
    /// Individual monitor regions with coordinates relative to bounding box
    monitors: Vec<MonitorRegion>,
    /// Index of the primary monitor (for Rainscaper UI positioning)
    primary_index: usize,
    /// Primary monitor's DPI scale factor (JS uses this to convert window detector coords)
    primary_scale_factor: f64,
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
    refresh_rate: u32,
}

// Tauri commands (invoked from renderer via window.__TAURI__.core.invoke)

#[tauri::command]
fn log_message(message: String) {
    log::info!("[Renderer] {}", message);
}

#[tauri::command]
fn get_config(state: tauri::State<AppState>) -> Result<serde_json::Value, String> {
    let config = state.config.lock().map_err(|e| format!("Config lock poisoned: {}", e))?;
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

    // Custom presets go in Custom Rainscapes/ subdirectory (except Autosave and Default)
    let file_path = if filename == "Autosave.rain" || filename == "Default.rain" {
        rainscapes_dir.join(&filename)
    } else {
        rainscapes_dir.join("Custom Rainscapes").join(&filename)
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
    let custom_dir = rainscapes_dir.join("Custom Rainscapes");

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

    // Check root first (Autosave.rain, Default.rain), then Custom Rainscapes/
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

    // Get actual panel dimensions (accounts for UI Scale) or use defaults
    let (panel_w, panel_h) = app.get_webview_window("rainscaper")
        .and_then(|w| {
            let size = w.outer_size().ok()?;
            let s = w.current_monitor().ok()??.scale_factor();
            Some(((size.width as f64 / s) as i32, (size.height as f64 / s) as i32))
        })
        .unwrap_or((400, 500));

    // Try saved position first (clamped to work area), fallback to tray-relative
    let (x, y) = load_panel_config(&app)
        .and_then(|c| c.x.zip(c.y))
        .map(|(sx, sy)| clamp_panel_to_work_area(&app, sx, sy, panel_w, panel_h))
        .unwrap_or_else(|| calculate_rainscaper_position(&app, tray_x, tray_y));

    // Check if window exists
    let window_exists = app.get_webview_window("rainscaper").is_some();
    log::info!("[Rainscaper] Window exists: {}", window_exists);

    if let Some(window) = app.get_webview_window("rainscaper") {
        // Window exists, just show and position it
        log::info!("[Rainscaper] Reusing existing window");
        log::info!("[Rainscaper] Positioning to ({}, {})", x, y);
        window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x as f64, y as f64)))
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
        if let Ok(guard) = RAINSCAPER_MENU_ITEM.lock() {
            if let Some(item) = guard.as_ref() {
                let _ = item.set_text("Close Rainscaper");
            }
        }
        log::info!("[Rainscaper] Shown successfully at ({}, {})", x, y);
    } else {
        // Create the window at saved/calculated position
        log::info!("[Rainscaper] Window not found, creating new one at ({}, {})", x, y);
        create_rainscaper_window_at(&app, x, y, true)?;
    }

    Ok(())
}

/// Hide the Rainscaper window
#[tauri::command]
fn hide_rainscaper(app: tauri::AppHandle) -> Result<(), String> {
    log::info!("[Rainscaper] Hide requested");
    if let Some(window) = app.get_webview_window("rainscaper") {
        // Save position before hiding (convert physical → logical for consistent storage)
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
        // Set click-through BEFORE hiding so rain doesn't puddle on invisible window
        window.set_ignore_cursor_events(true).ok();
        log::info!("[Rainscaper] Calling window.hide()");
        window.hide().map_err(|e| format!("Failed to hide window: {}", e))?;
        RAINSCAPER_VISIBLE.store(false, Ordering::SeqCst);
        if let Ok(guard) = RAINSCAPER_MENU_ITEM.lock() {
            if let Some(item) = guard.as_ref() {
                let _ = item.set_text("Open Rainscaper");
            }
        }
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

/// Show the Help window (show-or-create pattern, like Rainscaper)
#[tauri::command]
fn show_help_window(app: tauri::AppHandle) -> Result<(), String> {
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

/// Hide the Help window (kept alive for instant reopen; destroy caused zombie WebView2)
#[tauri::command]
fn hide_help_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("help") {
        window.hide().map_err(|e| format!("Failed to hide help: {}", e))?;
        log::info!("[Help] Hidden");
    }
    app.emit("help-window-hidden", ()).ok();
    Ok(())
}

/// Resize the Help window (for UI scale inheritance)
#[tauri::command]
fn resize_help_window(app: tauri::AppHandle, width: f64, height: f64) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("help") {
        window.set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| format!("Failed to resize help: {}", e))?;
        log::info!("[Help] Resized to {}x{}", width, height);
    }
    Ok(())
}

/// Re-center Help window on primary monitor (accounts for post-creation resize)
#[tauri::command]
fn center_help_window(app: tauri::AppHandle) -> Result<(), String> {
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

    // Convert work area to logical pixels
    let work_w = work.width as f64 / scale;
    let work_h = work.height as f64 / scale;
    let work_x = work.x as f64 / scale;
    let work_y = work.y as f64 / scale;

    // Window's actual logical size
    let mut win_w = win_size.width as f64 / scale;
    let mut win_h = win_size.height as f64 / scale;

    // Clamp to work area with margin so it doesn't spill off-screen
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

/// Toggle maximize/restore for the Help window
#[tauri::command]
fn toggle_maximize_help_window(app: tauri::AppHandle) -> Result<bool, String> {
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

/// Open the rainscapes folder (Documents\RainyDesk) in Explorer
#[tauri::command]
fn open_rainscapes_folder() -> Result<(), String> {
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

/// Open the logs folder in Explorer
#[tauri::command]
fn open_logs_folder() -> Result<(), String> {
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

/// Reset panel position to bottom-right of the taskbar monitor's work area.
/// Saves the new position and moves the window if it's visible.
fn reset_panel_position(app: &tauri::AppHandle) {
    const PANEL_WIDTH: i32 = 400;
    const PANEL_HEIGHT: i32 = 500;
    const MARGIN: i32 = 12;

    let monitors: Vec<tauri::Monitor> = app
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .collect();

    if monitors.is_empty() { return; }

    // Primary monitor is where the taskbar lives
    let idx = get_primary_monitor_index(&monitors);
    let mon = &monitors[idx];
    let pos = mon.position();
    let size = mon.size();
    let scale = mon.scale_factor();
    let work = get_monitor_work_area(pos.x, pos.y, size.width, size.height);

    // Convert work area to logical pixels
    let work_x = (work.x as f64 / scale) as i32;
    let work_y = (work.y as f64 / scale) as i32;
    let work_w = (work.width as f64 / scale) as i32;
    let work_h = (work.height as f64 / scale) as i32;

    // Bottom-right corner with margin
    let x = work_x + work_w - PANEL_WIDTH - MARGIN;
    let y = work_y + work_h - PANEL_HEIGHT - MARGIN;

    // Save the new position
    let mut config = load_panel_config(app).unwrap_or_default();
    config.x = Some(x);
    config.y = Some(y);
    save_panel_config(app, &config);

    // Reset window size to default (undo any UI Scale resize) and reposition
    if let Some(window) = app.get_webview_window("rainscaper") {
        window.set_resizable(true).ok();
        window.set_size(tauri::LogicalSize::new(PANEL_WIDTH as f64, PANEL_HEIGHT as f64)).ok();
        window.set_resizable(false).ok();
        window.set_position(tauri::Position::Logical(
            tauri::LogicalPosition::new(x as f64, y as f64)
        )).ok();

        // If hidden, show it so the user sees the result
        if !RAINSCAPER_VISIBLE.load(Ordering::SeqCst) {
            window.unminimize().ok();
            window.show().ok();
            window.set_ignore_cursor_events(false).ok();
            window.set_always_on_top(true).ok();
            window.set_focus().ok();
            RAINSCAPER_VISIBLE.store(true, Ordering::SeqCst);
            if let Ok(guard) = RAINSCAPER_MENU_ITEM.lock() {
                if let Some(item) = guard.as_ref() {
                    let _ = item.set_text("Close Rainscaper");
                }
            }
        }
    }

    // Tell the panel to reset UI scale to 100%
    let _ = app.emit("update-rainscape-param", serde_json::json!({
        "path": "system.resetPanel",
        "value": true
    }));

    log::info!("[Rainscaper] Panel reset: position ({}, {}), UI scale 100%", x, y);
}

// Open URL via ShellExecuteW (cmd.exe is injection-prone with untrusted strings)
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    // Reject non-HTTP(S) schemes (blocks file://, javascript:, etc.)
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

/// Calculate position for Rainscaper window above tray icon
/// Calculate panel position in LOGICAL coordinates.
/// Input tray_x/tray_y are physical (from tray click events).
/// All monitor values are converted to logical so the result works with
/// WebviewWindowBuilder::position() and Position::Logical.
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

    // Find which monitor contains the tray icon (hit-test in physical space)
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
            // Use work area (excludes taskbar) instead of full screen bounds
            let work = get_monitor_work_area(pos.x, pos.y, size.width, size.height);
            work_x = (work.x as f64 / scale) as i32;
            work_y = (work.y as f64 / scale) as i32;
            work_w = (work.width as f64 / scale) as i32;
            work_h = (work.height as f64 / scale) as i32;

            // Check if taskbar is at top (tray_y near top of screen, physical)
            taskbar_at_top = tray_y < pos.y + 100;
            break;
        }
    }

    // Convert tray position to logical
    let tray_lx = (tray_x as f64 / scale) as i32;
    let tray_ly = (tray_y as f64 / scale) as i32;

    // Position window above tray icon, centered horizontally (all logical)
    let mut x = tray_lx - (PANEL_WIDTH / 2);
    let mut y = if taskbar_at_top {
        tray_ly + (40.0 / scale) as i32 + MARGIN  // Below taskbar
    } else {
        tray_ly - PANEL_HEIGHT - MARGIN  // Above taskbar
    };

    // Clamp to work area (excludes taskbar). If panel exceeds area, pin to top-left margin.
    let x_min = work_x + MARGIN;
    let y_min = work_y + MARGIN;
    x = x.max(x_min).min((work_x + work_w - PANEL_WIDTH - MARGIN).max(x_min));
    y = y.max(y_min).min((work_y + work_h - PANEL_HEIGHT - MARGIN).max(y_min));

    (x, y)
}

/// Clamp a saved panel position to the current work area so it doesn't overlap the taskbar.
/// panel_w/panel_h are logical dimensions (accounts for UI Scale).
fn clamp_panel_to_work_area(app: &tauri::AppHandle, x: i32, y: i32, panel_w: i32, panel_h: i32) -> (i32, i32) {
    const MARGIN: i32 = 8;

    let monitors: Vec<tauri::Monitor> = app
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .collect();

    // Find which monitor contains the saved position
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

            // If panel exceeds work area, pin to top-left margin instead of going off-screen
            let x_min = work_x + MARGIN;
            let y_min = work_y + MARGIN;
            let x_max = (work_x + work_w - panel_w - MARGIN).max(x_min);
            let y_max = (work_y + work_h - panel_h - MARGIN).max(y_min);
            let cx = x.max(x_min).min(x_max);
            let cy = y.max(y_min).min(y_max);
            return (cx, cy);
        }
    }

    (x, y) // No matching monitor, return as-is
}

/// Create the Rainscaper popup window at specified position
fn create_rainscaper_window_at(app: &tauri::AppHandle, x: i32, y: i32, visible: bool) -> Result<(), String> {
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
        // Enable mouse events so panel is clickable (not click-through)
        window.set_ignore_cursor_events(false).ok();
    } else {
        // Preloaded hidden — set click-through so rain doesn't interact with it
        window.set_ignore_cursor_events(true).ok();
    }

    // Open DevTools in dev mode
    #[cfg(debug_assertions)]
    {
        window.open_devtools();
    }

    RAINSCAPER_VISIBLE.store(visible, Ordering::SeqCst);
    if let Ok(guard) = RAINSCAPER_MENU_ITEM.lock() {
        if let Some(item) = guard.as_ref() {
            let _ = item.set_text(if visible { "Close Rainscaper" } else { "Open Rainscaper" });
        }
    }
    log::info!("[Rainscaper] Window created successfully (visible={})", visible);

    Ok(())
}

/// Create the Help window
fn create_help_window(app: &tauri::AppHandle, visible: bool) -> Result<(), String> {
    log::info!("[Help] Creating window, visible={}", visible);

    // Size to 75% of work area width in 16:9, clamped to fit
    let monitors: Vec<tauri::Monitor> = app
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .collect();

    let (help_w, help_h, pos_x, pos_y) = if !monitors.is_empty() {
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

        (
            w, h,
            work_x + (work_w - w) / 2.0,
            work_y + (work_h - h) / 2.0,
        )
    } else {
        (1120.0, 630.0, 100.0, 100.0)
    };

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

    // Open DevTools in dev mode
    #[cfg(debug_assertions)]
    {
        window.open_devtools();
    }

    let _ = window; // suppress unused warning in release
    log::info!("[Help] Window created (visible={})", visible);
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
            refresh_rate: get_monitor_refresh_rate(pos.x, pos.y, size.width, size.height),
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
            refresh_rate: get_monitor_refresh_rate(pos.x, pos.y, size.width, size.height),
        });
    }

    log::info!("[get_all_displays] Found {} monitors", displays.len());
    Ok(displays)
}

#[tauri::command]
fn get_system_specs() -> SystemSpecs {
    use sysinfo::System;

    let mut sys = System::new_all();

    let cpu_model = sys.cpus().first()
        .map(|c| c.brand().trim().to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    let total_ram_gb = sys.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0);

    // GPU name via wmic (falls back to "Unknown")
    let gpu_model = get_gpu_name().unwrap_or_else(|| "Unknown".to_string());

    SystemSpecs {
        cpu_model,
        gpu_model,
        total_ram_gb: (total_ram_gb * 10.0).round() / 10.0,
    }
}

#[cfg(target_os = "windows")]
fn get_gpu_name() -> Option<String> {
    let output = std::process::Command::new("wmic")
        .args(["path", "win32_VideoController", "get", "name"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .skip(1)
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
}

#[cfg(not(target_os = "windows"))]
fn get_gpu_name() -> Option<String> {
    None
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

    // Get primary monitor index and its scale factor for DPI conversion
    let primary_index = get_primary_monitor_index(&monitors);
    let primary_scale = monitors[primary_index].scale_factor();

    // Convert bounding box from physical to logical pixels using primary scale factor.
    // This ensures Tauri's .inner_size() and .position() (which expect logical coords)
    // receive correct values. At 100% scaling (scale=1.0) this is a no-op.
    let to_logical = |v: i32| -> i32 { (v as f64 / primary_scale).round() as i32 };
    let to_logical_u = |v: u32| -> u32 { (v as f64 / primary_scale).round() as u32 };

    let logical_x_min = to_logical(x_min);
    let logical_y_min = to_logical(y_min);
    let logical_x_max = to_logical(x_max);
    let logical_y_max = to_logical(y_max);
    let total_width = (logical_x_max - logical_x_min) as u32;
    let total_height = (logical_y_max - logical_y_min) as u32;

    log::info!(
        "[VirtualDesktop] Physical bbox: ({}, {})→({}, {}), scale={}, logical bbox: ({}, {}) {}x{}",
        x_min, y_min, x_max, y_max, primary_scale,
        logical_x_min, logical_y_min, total_width, total_height
    );

    // Build monitor regions with coordinates relative to bounding box origin (logical pixels)
    let mut regions = Vec::new();
    for (index, monitor) in monitors.iter().enumerate() {
        let pos = monitor.position();
        let size = monitor.size();
        let scale = monitor.scale_factor();

        // Get actual work area from Windows API (physical pixels)
        let work_area = get_monitor_work_area(pos.x, pos.y, size.width, size.height);

        // Convert to logical, then to bounding-box-relative coordinates (always positive)
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

    // Prevent overlay from blocking taskbar auto-hide
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
    // Reduce WebView2 bloat: disable unnecessary components that would otherwise
    // auto-download ~50+ MB of DRM, speech, ad filters, ML models, etc. into EBWebView/.
    // Must be set before any WebView2 initialization.
    // Wry defaults (msWebOOUI, msPdfOOUI, msSmartScreenProtection) are re-included
    // because setting this overrides them.
    // NOTE: GPUCache/GrShaderCache (~11 MB) intentionally kept — stores compiled ANGLE
    // shaders for WebGL 2; disabling would force recompilation every launch.
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,\
msWebView2EnableTrackingPrevention,msWebView2EnableShoppingFeatures,\
SafeBrowsing,AutofillServerCommunication,Translate,\
PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies,\
SiteEngagementService,\
OptimizationGuideModelDownloading,OptimizationHintsFetching,\
OptimizationTargetPrediction,OptimizationHints,\
WidevineForMediaFoundation,SubresourceFilter,OriginTrials,\
WebGPU \
         --disable-component-update \
         --disable-background-networking \
         --disable-speech-api \
         --disable-sync \
         --disable-domain-reliability \
         --disable-breakpad \
         --no-pings \
         --no-first-run \
         --autoplay-policy=no-user-gesture-required \
         --disk-cache-size=1"
    );

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
            get_system_specs,
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
            get_windows_accent_color,
            show_help_window,
            hide_help_window,
            resize_help_window,
            center_help_window,
            toggle_maximize_help_window,
            open_url,
            open_rainscapes_folder,
            open_logs_folder
        ])
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("overlay") {
                let _ = window.set_focus();
            }
            log::info!("Second instance blocked: RainyDesk is already running");
        }))
        .plugin({
            // Per-session log file w/ rolling cleanup; keeps 5 most recent, max 1 MB each
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
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
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

            // Preload Rainscaper panel hidden so first tray-click open is instant
            // Use saved position if available, otherwise a default off-screen position
            let preload_pos = load_panel_config(app.handle())
                .and_then(|c| c.x.zip(c.y))
                .map(|(sx, sy)| clamp_panel_to_work_area(app.handle(), sx, sy, 400, 500))
                .unwrap_or((0, 0));
            if let Err(e) = create_rainscaper_window_at(app.handle(), preload_pos.0, preload_pos.1, false) {
                log::warn!("[Rainscaper] Failed to preload panel: {}", e);
            } else {
                log::info!("[Rainscaper] Panel preloaded hidden at ({}, {})", preload_pos.0, preload_pos.1);
            }

            // Preload Help window hidden so first open is instant
            if let Err(e) = create_help_window(app.handle(), false) {
                log::warn!("[Help] Failed to preload: {}", e);
            } else {
                log::info!("[Help] Window preloaded hidden");
            }

            // First launch auto-opens Help window; flag is version-specific
            if let Ok(app_data) = app.handle().path().app_data_dir() {
                let version = app.config().version.as_deref().unwrap_or("unknown");
                let flag_name = format!("first-launch-v{}.flag", version);
                let first_launch_flag = app_data.join(&flag_name);
                if !first_launch_flag.exists() {
                    // Ensure app data directory exists before writing the flag
                    let _ = std::fs::create_dir_all(&app_data);
                    std::fs::write(&first_launch_flag, "").ok();
                    log::info!("[Setup] First launch detected (v{}), will show help window", version);
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        // Wait for overlay + panel + help to finish loading
                        std::thread::sleep(std::time::Duration::from_secs(5));
                        if let Some(window) = handle.get_webview_window("help") {
                            window.show().ok();
                            window.set_focus().ok();
                            log::info!("[Help] First-launch auto-open complete");
                        } else {
                            log::warn!("[Help] First-launch: help window not found after delay");
                        }
                    });
                }
            }

            // Start window detection polling (16ms ≈ 60 Hz, matching physics tick rate)
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(16));

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

            // Listen for umbrella button hide request
            // Reuses hide_rainscaper() so position is saved on umbrella close
            let app_handle_for_hide = app.handle().clone();
            app.listen("hide-rainscaper-request", move |_event| {
                log::info!("[Rainscaper] Hide requested via event (X button)");
                let _ = hide_rainscaper(app_handle_for_hide.clone());
            });

            // Set up system tray
            let quit_item = MenuItem::with_id(app, "quit", "Quit RainyDesk", true, None::<&str>)?;
            let pause_item = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
            let rainscaper_item = MenuItem::with_id(app, "rainscaper", "Open Rainscaper", true, None::<&str>)?;
            let reset_pos_item = MenuItem::with_id(app, "reset_position", "Reset Panel", true, None::<&str>)?;

            // Store pause item globally for sync between panel and tray
            if let Ok(mut guard) = PAUSE_MENU_ITEM.lock() {
                *guard = Some(pause_item.clone());
            }

            // Store rainscaper item globally for Open/Close text sync
            if let Ok(mut guard) = RAINSCAPER_MENU_ITEM.lock() {
                *guard = Some(rainscaper_item.clone());
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

            let menu = Menu::with_items(app, &[
                &pause_item,
                &rainscaper_item,
                &reset_pos_item,
                &volume_submenu,
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
                            // Same IPC as panel's pause toggle so they match Tauri API listener
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
                        "reset_position" => {
                            reset_panel_position(app);
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
                        }
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, position, .. } = event {
                        let app = tray.app_handle();
                        let tray_x = position.x as i32;
                        let tray_y = position.y as i32;

                        // Toggle Rainscaper window
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
