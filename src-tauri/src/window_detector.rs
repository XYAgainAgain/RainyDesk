// Window collision detection — Win32 API bounds, clipped to monitor coords.
// Skips: invisible, minimized, cloaked (UWP phantoms), other virtual desktops,
//        tiny (<50px), untitled, RainyDesk/DevTools, system class names, system overlays
// UWP/WinUI3 apps are NOT skipped — cloaked check handles suspended instances.

#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicU32, Ordering};

#[cfg(target_os = "windows")]
use windows::{
    core::GUID,
    Win32::Foundation::{BOOL, HWND, LPARAM, RECT},
    Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS},
    Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED},
    Win32::UI::Shell::IVirtualDesktopManager,
    Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowPlacement, GetWindowRect, GetWindowTextW,
        IsIconic, IsWindowVisible, IsZoomed, SW_SHOWMINIMIZED, WINDOWPLACEMENT,
    },
};

// CLSID for VirtualDesktopManager COM class
#[cfg(target_os = "windows")]
const CLSID_VIRTUAL_DESKTOP_MANAGER: GUID = GUID {
    data1: 0xAA509086,
    data2: 0x5CA9,
    data3: 0x4C25,
    data4: [0x8F, 0x95, 0x58, 0x9D, 0x3C, 0x07, 0xB4, 0x8A],
};

// Debug counter for periodic logging (safe across threads)
#[cfg(target_os = "windows")]
static POLL_COUNT: AtomicU32 = AtomicU32::new(0);

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

/// Context passed through LPARAM to the EnumWindows callback.
/// Holds both the result vec and optional VDM for virtual desktop filtering.
#[cfg(target_os = "windows")]
struct EnumContext {
    windows: Vec<WindowInfo>,
    vdm: Option<IVirtualDesktopManager>,
}

#[cfg(target_os = "windows")]
pub fn get_visible_windows() -> Result<WindowData, Box<dyn std::error::Error>> {
    // Init COM once per thread (redundant calls are tolerated but leak refcounts)
    thread_local! {
        static COM_INIT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }
    COM_INIT.with(|init| {
        if !init.get() {
            unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
            init.set(true);
        }
    });

    // Create IVirtualDesktopManager (graceful fallback if COM fails)
    let vdm: Option<IVirtualDesktopManager> = unsafe {
        CoCreateInstance(&CLSID_VIRTUAL_DESKTOP_MANAGER, None, CLSCTX_ALL).ok()
    };

    let mut ctx = EnumContext {
        windows: Vec::new(),
        vdm,
    };

    unsafe {
        EnumWindows(
            Some(enum_window_callback),
            LPARAM(&mut ctx as *mut _ as isize),
        )?;
    }

    // DEBUG: Log window count periodically (every 600 calls = ~30 seconds at 50ms)
    let poll_num = POLL_COUNT.fetch_add(1, Ordering::Relaxed);
    if poll_num % 600 == 0 {
        log::info!("[WindowDetector] Poll #{}: found {} windows (raw)", poll_num + 1, ctx.windows.len());
    }

    Ok(WindowData { windows: ctx.windows })
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_window_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut EnumContext);

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

    // Skip cloaked windows (suspended UWP apps, hidden by shell, etc.)
    // Cloaked windows report "visible" but aren't actually on screen
    let mut cloaked: u32 = 0;
    if DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        &mut cloaked as *mut _ as *mut std::ffi::c_void,
        std::mem::size_of::<u32>() as u32,
    ).is_ok() && cloaked != 0 {
        return BOOL(1);
    }

    // Skip windows on other virtual desktops
    if let Some(ref vdm) = ctx.vdm {
        match vdm.IsWindowOnCurrentVirtualDesktop(hwnd) {
            Ok(is_current) if !is_current.as_bool() => return BOOL(1),
            Err(_) => {} // COM error — don't filter (safer to show than hide)
            _ => {}
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

    let width_raw = rect.right - rect.left;
    let height_raw = rect.bottom - rect.top;

    // Guard against malformed windows with negative dimensions
    if width_raw <= 0 || height_raw <= 0 {
        return BOOL(1);
    }

    let width = width_raw as u32;
    let height = height_raw as u32;

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

    // Skip system windows by class name (locale-independent)
    // UWP/WinUI3 NOT skipped — cloaked check catches suspended instances instead.
    // CoreWindow skipped to avoid double-counting inside ApplicationFrameWindow.
    if class_name == "CEF-OSC-WIDGET" ||    // NVIDIA GeForce Overlay (transparent, not a real window)
       class_name == "Progman" ||           // Desktop (Program Manager)
       class_name == "WorkerW" ||           // Desktop worker windows
       class_name == "Shell_TrayWnd" ||     // Taskbar
       class_name == "Shell_SecondaryTrayWnd" ||  // Secondary taskbar (multi-monitor)
       class_name == "NotifyIconOverflowWindow" ||  // System tray overflow
       class_name == "Windows.UI.Core.CoreWindow" ||  // UWP content (covered by ApplicationFrameWindow)
       class_name == "XamlExplorerHostIslandWindow" ||  // XAML hosting islands inside other windows
       class_name == "ForegroundStaging" ||  // Compositor staging
       class_name == "MultitaskingViewFrame" ||  // Task View (Win+Tab)
       class_name == "XamlWindow" {          // Various XAML overlays
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

    // Skip our own overlay windows (starts_with avoids false positives on
    // terminals whose title includes a "RainyDesk" directory path)
    if title.starts_with("RainyDesk") {
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

    // DEBUG: Log windows periodically (every ~30 sec only, not at startup)
    let poll_num = POLL_COUNT.load(Ordering::Relaxed);
    if poll_num % 600 == 0 {
        log::info!("[WindowDetector] Found: \"{}\" [{}] at ({},{}) {}x{}",
            title, class_name, rect.left, rect.top, width, height);
    }

    ctx.windows.push(WindowInfo {
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
