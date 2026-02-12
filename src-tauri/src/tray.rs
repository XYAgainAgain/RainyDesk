// System tray construction + event handlers.

use std::sync::atomic::Ordering;
use tauri::{
    Emitter,
    menu::{Menu, MenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use crate::commands::{hide_rainscaper, show_rainscaper};
use crate::platform::load_theme_icon;
use crate::window_mgmt::reset_panel_position;
use crate::{RAIN_PAUSED, PAUSE_MENU_ITEM, RAINSCAPER_MENU_ITEM, RAINSCAPER_VISIBLE};

fn handle_menu_event(app: &tauri::AppHandle, id: &str, pause_item: &MenuItem<tauri::Wry>) {
    match id {
        "quit" => {
            log::info!("Quit requested via tray");
            app.exit(0);
        }
        "pause" => {
            let paused = !RAIN_PAUSED.load(Ordering::Relaxed);
            RAIN_PAUSED.store(paused, Ordering::Relaxed);
            let _ = pause_item.set_text(if paused { "Resume" } else { "Pause" });
            let _ = app.emit("update-rainscape-param", serde_json::json!({
                "path": "system.paused", "value": paused
            }));
            log::info!("Rain {} via tray menu", if paused { "paused" } else { "resumed" });
        }
        "rainscaper" => {
            let visible = RAINSCAPER_VISIBLE.load(Ordering::SeqCst);
            if visible {
                let _ = hide_rainscaper(app.clone());
            } else {
                let _ = show_rainscaper(app.clone(), 1800, 1040);
            }
            log::info!("Rainscaper toggled via menu");
        }
        "reset_position" => {
            reset_panel_position(app);
        }
        _ => {
            if let Some(vol_str) = id.strip_prefix("vol_") {
                let volume = match vol_str {
                    "mute" => 0,
                    _ => vol_str.parse::<i32>().unwrap_or(50),
                };
                let _ = app.emit("set-volume", volume);
            }
        }
    }
}

fn handle_tray_click(app: &tauri::AppHandle, x: i32, y: i32) {
    let visible = RAINSCAPER_VISIBLE.load(Ordering::SeqCst);
    log::info!("[Tray] Left-click, RAINSCAPER_VISIBLE={}", visible);
    if visible {
        if let Err(e) = hide_rainscaper(app.clone()) {
            log::error!("[Tray] Failed to hide Rainscaper: {}", e);
        }
    } else {
        if let Err(e) = show_rainscaper(app.clone(), x, y) {
            log::error!("[Tray] Failed to show Rainscaper: {}", e);
        }
    }
}

pub(crate) fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let quit_item = MenuItem::with_id(app, "quit", "Quit RainyDesk", true, None::<&str>)?;
    let pause_item = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
    let rainscaper_item = MenuItem::with_id(app, "rainscaper", "Open Rainscaper", true, None::<&str>)?;
    let reset_pos_item = MenuItem::with_id(app, "reset_position", "Reset Panel", true, None::<&str>)?;

    if let Ok(mut guard) = PAUSE_MENU_ITEM.lock() {
        *guard = Some(pause_item.clone());
    }
    if let Ok(mut guard) = RAINSCAPER_MENU_ITEM.lock() {
        *guard = Some(rainscaper_item.clone());
    }

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

    let icon = load_theme_icon();

    let pause_item_clone = pause_item.clone();
    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("RainyDesk")
        .on_menu_event(move |app, event| {
            handle_menu_event(app, event.id.as_ref(), &pause_item_clone);
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                position, ..
            } = event {
                handle_tray_click(tray.app_handle(), position.x as i32, position.y as i32);
            }
        })
        .build(app)?;

    log::info!("System tray initialized");
    Ok(())
}
