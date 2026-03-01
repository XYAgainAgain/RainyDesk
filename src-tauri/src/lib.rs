use tauri::{Emitter, Listener, Manager, menu::MenuItem};
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::path::PathBuf;
use std::time::{Duration, Instant};

mod commands;
mod logging;
mod platform;
mod rainscape;
mod tray;
mod types;
mod window_detector;
mod window_mgmt;

use commands::*;
use logging::setup_session_log;
use types::*;
use window_mgmt::*;

// Global pause state
static RAIN_PAUSED: AtomicBool = AtomicBool::new(false);

// Global reference to pause menu item for sync between panel and tray
static PAUSE_MENU_ITEM: Mutex<Option<MenuItem<tauri::Wry>>> = Mutex::new(None);

// Global reference to rainscaper menu item for Open/Close text sync
static RAINSCAPER_MENU_ITEM: Mutex<Option<MenuItem<tauri::Wry>>> = Mutex::new(None);

// Rainscaper panel visibility state
static RAINSCAPER_VISIBLE: AtomicBool = AtomicBool::new(false);

// Last tray click position (physical coords) for snap-to-tray positioning
pub(crate) static LAST_TRAY_POSITION: Mutex<(i32, i32)> = Mutex::new((0, 0));

// WebView health tracking for crash detection
pub(crate) static OVERLAY_HEALTH: Mutex<Option<WindowHealth>> = Mutex::new(None);
pub(crate) static BACKGROUND_HEALTH: Mutex<Option<WindowHealth>> = Mutex::new(None);

// Disable unnecessary WebView2 components (~50+ MB of DRM, speech, ad filters, ML models).
// Must be set before any WebView2 initialization.
// Wry defaults (msWebOOUI, msPdfOOUI, msSmartScreenProtection) re-included because
// setting this env var overrides them.
// GPUCache/GrShaderCache (~11 MB) intentionally kept for compiled ANGLE shaders.
fn configure_webview2_env() {
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
}

// Per-session log file w/ rolling cleanup; keeps 5 most recent, max 1 MB each
fn build_logging_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let log_dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.rainydesk.app")
        .join("logs");
    let log_path = setup_session_log(&log_dir, 5, 1_048_576);
    let log_filename = log_path.file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.trim_end_matches(".log").to_string())
        .unwrap_or_else(|| "RainyDesk".to_string());

    tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .max_file_size(1_048_576)
        .targets([
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                file_name: Some(log_filename),
            }),
        ])
        .build()
}

// Preload Rainscaper panel + Help window hidden so first open is instant
fn preload_windows(app: &tauri::App) {
    let preload_pos = load_panel_config(app.handle())
        .and_then(|c| c.x.zip(c.y))
        .map(|(sx, sy)| clamp_panel_to_work_area(app.handle(), sx, sy, 400, 500))
        .unwrap_or((0, 0));
    if let Err(e) = create_rainscaper_window_at(app.handle(), preload_pos.0, preload_pos.1, false) {
        log::warn!("[Rainscaper] Failed to preload panel: {}", e);
    } else {
        log::info!("[Rainscaper] Panel preloaded hidden at ({}, {})", preload_pos.0, preload_pos.1);
    }

    if let Err(e) = create_help_window(app.handle(), false) {
        log::warn!("[Help] Failed to preload: {}", e);
    } else {
        log::info!("[Help] Window preloaded hidden");
    }
}

// First launch auto-opens Help window; flag is version-specific
fn handle_first_launch(app: &tauri::App) {
    let Ok(app_data) = app.handle().path().app_data_dir() else { return };
    let version = app.config().version.as_deref().unwrap_or("unknown");
    let flag_path = app_data.join(format!("first-launch-v{}.flag", version));
    if flag_path.exists() { return; }

    let _ = std::fs::create_dir_all(&app_data);
    std::fs::write(&flag_path, "").ok();
    log::info!("[Setup] First launch detected (v{}), will show help window", version);

    let handle = app.handle().clone();
    std::thread::spawn(move || {
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

// Start window detection polling (16ms = 60 Hz, matching physics tick rate)
fn start_window_polling(app: &tauri::App) {
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
                Err(e) => log::error!("Failed to get windows: {}", e),
            }
        }
    });
    log::info!("Window detection polling started");
}

// Initialize health tracking for a window, preserving crash_count across recreations
fn init_health(health_mutex: &Mutex<Option<WindowHealth>>) {
    let mut guard = health_mutex.lock().unwrap();
    let crash_count = guard.as_ref().map(|h| h.crash_count).unwrap_or(0);
    *guard = Some(WindowHealth {
        created_at: Instant::now(),
        last_heartbeat: None,
        init_complete: false,
        crash_count,
    });
}

fn recover_window(handle: &tauri::AppHandle, label: &str) {
    let health_mutex = match label {
        "overlay" => &OVERLAY_HEALTH,
        "background" => &BACKGROUND_HEALTH,
        _ => return,
    };

    let crash_count = {
        let mut guard = health_mutex.lock().unwrap();
        let health = match guard.as_mut() {
            Some(h) => h,
            None => return,
        };
        health.crash_count += 1;
        // Reset timers so watchdog doesn't re-trigger during recovery backoff
        health.created_at = Instant::now();
        health.init_complete = false;
        health.last_heartbeat = None;
        health.crash_count
    };

    if crash_count > 3 {
        log::error!("[Recovery] {} failed {} times, giving up — window stays hidden", label, crash_count);
        if let Some(window) = handle.get_webview_window(label) {
            window.hide().ok();
        }
        return;
    }

    log::warn!("[Recovery] {} crash #{}, attempting recovery...", label, crash_count);

    // Close the broken window
    if let Some(window) = handle.get_webview_window(label) {
        window.close().ok();
    }

    let handle = handle.clone();
    let label = label.to_string();
    let backoff = Duration::from_secs(1 << crash_count.min(4)); // 2s, 4s, 8s, 16s cap

    std::thread::spawn(move || {
        log::info!("[Recovery] Waiting {:?} before recreating {}...", backoff, label);
        std::thread::sleep(backoff);

        let desktop = match get_virtual_desktop(handle.clone()) {
            Ok(d) => d,
            Err(e) => {
                log::error!("[Recovery] Failed to get virtual desktop for {}: {}", label, e);
                return;
            }
        };

        let health_mutex = match label.as_str() {
            "overlay" => &OVERLAY_HEALTH,
            "background" => &BACKGROUND_HEALTH,
            _ => return,
        };

        match label.as_str() {
            "overlay" => {
                init_health(health_mutex);
                if let Err(e) = create_mega_overlay(&handle, &desktop) {
                    log::error!("[Recovery] Failed to recreate overlay: {}", e);
                }
            }
            "background" => {
                init_health(health_mutex);
                if let Err(e) = create_mega_background(&handle, &desktop) {
                    log::error!("[Recovery] Failed to recreate background: {}", e);
                }
            }
            _ => {}
        }
    });
}

// Watchdog thread: checks heartbeats every 5s, triggers recovery on failure
fn start_health_monitor(handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        // Wait for initial startup before monitoring
        std::thread::sleep(Duration::from_secs(30));
        log::info!("[Health] Watchdog active");

        loop {
            std::thread::sleep(Duration::from_secs(5));

            for (label, health_mutex) in [("overlay", &OVERLAY_HEALTH), ("background", &BACKGROUND_HEALTH)] {
                let needs_recovery = {
                    let guard = health_mutex.lock().unwrap();
                    let Some(health) = guard.as_ref() else { continue };

                    // Already given up
                    if health.crash_count > 3 { continue; }

                    let age = health.created_at.elapsed();

                    if !health.init_complete {
                        // WebView never initialized — JS never ran
                        if age > Duration::from_secs(30) {
                            log::warn!("[Health] {} never initialized after {:.0}s", label, age.as_secs_f64());
                            true
                        } else {
                            false
                        }
                    } else if let Some(last) = health.last_heartbeat {
                        // Was running, heartbeat stopped
                        let silence = last.elapsed();
                        if silence > Duration::from_secs(15) {
                            log::warn!("[Health] {} heartbeat lost for {:.0}s", label, silence.as_secs_f64());
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                };

                if needs_recovery {
                    recover_window(&handle, label);
                }
            }
        }
    });
}

// Monitor hot-swap detection: polls every 5s, emits event on geometry change (2s debounce)
fn start_monitor_polling(app: &tauri::App) {
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        // Capture initial state
        let mut last_snapshot = platform::get_monitor_snapshot(&handle);
        let mut pending_change: Option<Instant> = None;

        loop {
            std::thread::sleep(Duration::from_secs(5));

            let current = platform::get_monitor_snapshot(&handle);
            if current != last_snapshot {
                if pending_change.is_none() {
                    log::info!("[MonitorPoll] Display config change detected, debouncing 2s...");
                    pending_change = Some(Instant::now());
                }
            } else {
                // Config reverted (e.g. rapid plug/unplug) — cancel pending
                pending_change = None;
            }

            // Emit after 2s debounce
            if let Some(changed_at) = pending_change {
                if changed_at.elapsed() >= Duration::from_secs(2) {
                    log::info!("[MonitorPoll] Emitting monitor-config-changed ({} monitors)", current.len());
                    let _ = handle.emit("monitor-config-changed", ());
                    last_snapshot = current;
                    pending_change = None;
                }
            }
        }
    });
    log::info!("Monitor hot-swap polling started (5s interval)");
}

fn setup_application(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    log::info!("RainyDesk Tauri starting...");

    let desktop = get_virtual_desktop(app.handle().clone())
        .map_err(|e| Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))?;

    log::info!(
        "Virtual desktop: {}x{} at ({}, {}) with {} monitor(s)",
        desktop.width, desktop.height,
        desktop.origin_x, desktop.origin_y,
        desktop.monitors.len()
    );

    for m in &desktop.monitors {
        log::info!(
            "  Monitor {}: {}x{} @ {} Hz, scale {:.0}%, pos ({}, {})",
            m.index, m.width, m.height, m.refresh_rate,
            m.scale_factor * 100.0, m.x, m.y
        );
    }

    init_health(&BACKGROUND_HEALTH);
    if let Err(e) = create_mega_background(app.handle(), &desktop) {
        log::error!("Failed to create mega-background: {}", e);
    }

    init_health(&OVERLAY_HEALTH);
    if let Err(e) = create_mega_overlay(app.handle(), &desktop) {
        log::error!("Failed to create mega-overlay: {}", e);
    }

    preload_windows(app);
    handle_first_launch(app);
    start_window_polling(app);
    start_monitor_polling(app);
    start_health_monitor(app.handle().clone());

    // Listen for umbrella button hide request
    let app_handle_for_hide = app.handle().clone();
    app.listen("hide-rainscaper-request", move |_event| {
        log::info!("[Rainscaper] Hide requested via event (X button)");
        let _ = hide_rainscaper(app_handle_for_hide.clone());
    });

    tray::setup_tray(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_webview2_env();

    let default_config = serde_json::json!({
        "rainEnabled": true,
        "intensity": 50,
        "volume": 50,
        "wind": 0
    });

    // Collect hardware specs once at startup (avoids CMD flash from wmic on every System tab open)
    let specs = commands::collect_system_specs();

    log::info!(
        "Hardware: {} | {} ({} VRAM) | {:.1} GB RAM",
        specs.cpu_model, specs.gpu_model,
        specs.gpu_vram_gb.map_or("? GB".to_string(), |v| format!("{:.0} GB", v)),
        specs.total_ram_gb
    );

    tauri::Builder::default()
        .manage(AppState {
            config: Mutex::new(default_config),
            system_specs: specs,
        })
        .invoke_handler(tauri::generate_handler![
            log_message,
            quit_app,
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
            heartbeat,
            show_rainscaper,
            hide_rainscaper,
            toggle_rainscaper,
            resize_rainscaper,
            get_panel_detached,
            set_panel_detached,
            snap_panel_to_tray,
            get_windows_accent_color,
            show_help_window,
            hide_help_window,
            minimize_help_window,
            resize_help_window,
            center_help_window,
            toggle_maximize_help_window,
            open_url,
            open_rainscapes_folder,
            open_logs_folder,
            load_user_themes,
            save_user_themes
        ])
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("overlay") {
                let _ = window.set_focus();
            }
            log::info!("Second instance blocked: RainyDesk is already running");
        }))
        .plugin(build_logging_plugin())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| setup_application(app))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
