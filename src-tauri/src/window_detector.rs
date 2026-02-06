// Window detection for Z-order collision zones (Windows-only for now)
//
// Enumerates visible windows via Win32 API and returns their bounds for rain collision.
// Renderer clips these to per-monitor local coordinates.
//
// Filtering strategy:
// - Skip invisible windows (IsWindowVisible)
// - Skip minimized windows (IsIconic) - they report "visible" but aren't on screen
// - Skip tiny windows (<50px) - likely system UI elements
// - Skip untitled windows - usually system background processes
// - Skip RainyDesk/DevTools - our own windows
// - Skip system windows by class name (locale-independent)
// - Skip phantom UWP apps - Settings, Calculator, etc. suspend rather than close
// - Skip system overlays - Task Switching, Task View, input panels

#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicU32, Ordering};

#[cfg(target_os = "windows")]
use windows::{
    Win32::Foundation::{BOOL, HWND, LPARAM, RECT},
    Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowPlacement, GetWindowRect, GetWindowTextW,
        IsIconic, IsWindowVisible, IsZoomed, SW_SHOWMINIMIZED, WINDOWPLACEMENT,
    },
    Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
};

// Debug counters using atomic operations (safe across threads)
#[cfg(target_os = "windows")]
static POLL_COUNT: AtomicU32 = AtomicU32::new(0);
#[cfg(target_os = "windows")]
static WINDOW_LOG_COUNT: AtomicU32 = AtomicU32::new(0);

#[derive(Debug, Clone, serde::Serialize)]
pub struct WindowInfo {
    pub bounds: Bounds,
    pub title: String,
    #[serde(rename = "isMaximized")]
    pub is_maximized: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct WindowData {
    pub windows: Vec<WindowInfo>,
}

#[cfg(target_os = "windows")]
pub fn get_visible_windows() -> Result<WindowData, Box<dyn std::error::Error>> {
    let mut windows: Vec<WindowInfo> = Vec::new();

    unsafe {
        EnumWindows(
            Some(enum_window_callback),
            LPARAM(&mut windows as *mut _ as isize),
        )?;
    }

    // DEBUG: Log window count periodically (every 60 calls = ~3 seconds at 50ms)
    let poll_num = POLL_COUNT.fetch_add(1, Ordering::Relaxed);
    if poll_num % 60 == 0 {
        log::info!("[WindowDetector] Poll #{}: found {} windows (raw)", poll_num + 1, windows.len());
    }

    Ok(WindowData { windows })
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_window_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let windows = &mut *(lparam.0 as *mut Vec<WindowInfo>);

    // Only include visible windows
    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1); // Continue enumeration
    }

    // Skip minimized windows using IsIconic
    if IsIconic(hwnd).as_bool() {
        return BOOL(1);
    }

    // Backup check via GetWindowPlacement (more reliable for some apps)
    let mut placement = WINDOWPLACEMENT {
        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        ..Default::default()
    };
    if GetWindowPlacement(hwnd, &mut placement).is_ok() {
        if placement.showCmd == SW_SHOWMINIMIZED.0 as u32 {
            return BOOL(1);
        }
    }

    // Check if window is maximized
    let is_maximized = IsZoomed(hwnd).as_bool();

    // Get window bounds using DWM extended frame bounds (accurate visible area)
    // Falls back to GetWindowRect if DWM fails
    let mut rect = RECT::default();
    let dwm_result = DwmGetWindowAttribute(
        hwnd,
        DWMWA_EXTENDED_FRAME_BOUNDS,
        &mut rect as *mut _ as *mut std::ffi::c_void,
        std::mem::size_of::<RECT>() as u32,
    );

    if dwm_result.is_err() {
        // Fallback to GetWindowRect (includes invisible frame)
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return BOOL(1);
        }
    }

    let width = (rect.right - rect.left) as u32;
    let height = (rect.bottom - rect.top) as u32;

    // Filter out tiny windows (likely system UI elements)
    if width < 50 || height < 50 {
        return BOOL(1);
    }

    // Get window class name (locale-independent, structural identity)
    let mut class_buf = [0u16; 256];
    let class_len = GetClassNameW(hwnd, &mut class_buf);
    let class_name = if class_len > 0 {
        String::from_utf16_lossy(&class_buf[..class_len as usize])
    } else {
        String::new()
    };

    // Skip system windows by class name (works on all localized Windows installs)
    // These class names are constant regardless of UI language
    if class_name == "Progman" ||           // Desktop (Program Manager)
       class_name == "WorkerW" ||           // Desktop worker windows
       class_name == "Shell_TrayWnd" ||     // Taskbar
       class_name == "Shell_SecondaryTrayWnd" ||  // Secondary taskbar (multi-monitor)
       class_name == "NotifyIconOverflowWindow" ||  // System tray overflow
       class_name == "Windows.UI.Core.CoreWindow" ||  // UWP system overlays
       class_name == "XamlExplorerHostIslandWindow" ||  // XAML islands (Settings, etc.)
       class_name == "ApplicationFrameWindow" ||  // UWP app frames (when suspended)
       class_name == "ForegroundStaging" ||  // Compositor staging
       class_name == "MultitaskingViewFrame" ||  // Task View (Win+Tab)
       class_name == "XamlWindow" {         // Various XAML overlays
        return BOOL(1);
    }

    // Get window title for additional filtering and logging
    let mut title_buf = [0u16; 512];
    let title_len = GetWindowTextW(hwnd, &mut title_buf);
    let title = if title_len > 0 {
        String::from_utf16_lossy(&title_buf[..title_len as usize])
    } else {
        String::new()
    };

    // Skip phantom windows at origin with portrait dimensions (often minimized apps)
    let is_near_origin = rect.left.abs() < 50 && rect.top.abs() < 50;
    let is_portrait_size = height > width && (width >= 1000 || height >= 1800);
    if is_near_origin && is_portrait_size {
        return BOOL(1);
    }

    // Skip windows without titles (system windows)
    if title.is_empty() {
        return BOOL(1);
    }

    // Skip our own overlay windows (use contains for robustness)
    if title.contains("RainyDesk") {
        return BOOL(1);
    }

    // Skip DevTools windows (Tauri dev mode)
    if title.contains("DevTools") {
        return BOOL(1);
    }

    // Skip known system overlays by title (fallback for edge cases)
    // Note: Most system windows now caught by class name above
    if title == "Windows Input Experience" ||
       title == "Microsoft Text Input Application" ||
       title == "Task Switching" ||   // Alt-Tab overlay
       title == "Task View" {         // Win+Tab overlay
        return BOOL(1);
    }

    // DEBUG: Log first ~20 windows detected (covers first poll cycle)
    let log_count = WINDOW_LOG_COUNT.fetch_add(1, Ordering::Relaxed);
    if log_count < 20 {
        log::info!("[WindowDetector] Found: \"{}\" [{}] at ({},{}) {}x{}",
            title, class_name, rect.left, rect.top, width, height);
    }

    windows.push(WindowInfo {
        bounds: Bounds {
            x: rect.left,
            y: rect.top,
            width,
            height,
        },
        title,
        is_maximized,
    });

    BOOL(1) // Continue enumeration
}

#[cfg(not(target_os = "windows"))]
pub fn get_visible_windows() -> Result<WindowData, Box<dyn std::error::Error>> {
    // TODO: Linux/macOS implementation
    Ok(WindowData {
        windows: Vec::new(),
    })
}
