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
// - Skip phantom UWP apps - Settings, Calculator, etc. suspend rather than close
// - Skip system overlays - Task Switching, Task View, input panels

#[cfg(target_os = "windows")]
use windows::{
    Win32::Foundation::{BOOL, HWND, LPARAM, RECT},
    Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowRect, GetWindowTextW, IsIconic, IsWindowVisible, IsZoomed,
    },
    Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
};

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

    Ok(WindowData { windows })
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_window_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let windows = &mut *(lparam.0 as *mut Vec<WindowInfo>);

    // Only include visible windows
    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1); // Continue enumeration
    }

    // Skip minimized windows (they report as "visible" but shouldn't block rain)
    if IsIconic(hwnd).as_bool() {
        return BOOL(1);
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

    // Get window title
    let mut title_buf = [0u16; 512];
    let title_len = GetWindowTextW(hwnd, &mut title_buf);
    let title = if title_len > 0 {
        String::from_utf16_lossy(&title_buf[..title_len as usize])
    } else {
        String::new()
    };

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

    // Skip common system windows that shouldn't block rain
    if title == "Program Manager" ||  // Desktop
       title.is_empty() ||
       title == "Windows Input Experience" ||
       title == "Microsoft Text Input Application" ||
       // UWP apps that suspend rather than close (phantom windows)
       title == "Settings" ||
       title == "Calculator" ||
       title == "Xbox" ||
       title == "Xbox Game Bar" ||
       title == "Your Phone" ||
       title == "Phone Link" ||
       title == "Feedback Hub" ||
       title == "Tips" ||
       title == "Snipping Tool" ||
       title == "Command Palette" ||  // VS Code command palette overlay
       title == "Task Switching" ||   // Alt-Tab overlay
       title == "Task View" {         // Win+Tab overlay
        return BOOL(1);
    }

    // DEBUG: Log first ~20 windows detected (covers first poll cycle)
    static mut WINDOW_LOG_COUNT: u32 = 0;
    if WINDOW_LOG_COUNT < 20 {
        WINDOW_LOG_COUNT += 1;
        log::info!("[WindowDetector] Found: \"{}\" at ({},{}) {}x{}",
            title, rect.left, rect.top, width, height);
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
