use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, serde::Serialize)]
struct DisplayInfo {
    index: usize,
    bounds: Bounds,
    work_area: Bounds,
    scale_factor: f64,
    refresh_rate: u32,
}

#[derive(Clone, serde::Serialize)]
struct Bounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

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
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("overlay-0") {
                let _ = window.set_focus();
            }
            log::info!("Second instance blocked: RainyDesk is already running");
        }))
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            log::info!("RainyDesk Tauri starting...");

            let monitors = app.available_monitors()?;
            log::info!("Found {} monitor(s)", monitors.len());

            // Phase 1: Create overlay on primary monitor only
            if let Some(primary) = app.primary_monitor()? {
                create_overlay_window(app, &primary, 0)?;
            } else if let Some(first) = monitors.first() {
                log::warn!("No primary monitor found, using first available");
                create_overlay_window(app, first, 0)?;
            } else {
                log::error!("No monitors found!");
            }

            // TODO Phase 2: Create overlays on all monitors
            // TODO Phase 3: Set up system tray
            // TODO Phase 4: Start window detection polling

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
