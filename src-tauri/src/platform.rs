// OS-specific utilities: registry, monitors, GPU detection.

use crate::types::Bounds;

// Shared registry helper — eliminates duplicated unsafe registry boilerplate
#[cfg(target_os = "windows")]
fn read_registry_dword(subkey: &str, value_name: &str) -> Option<u32> {
    use windows::Win32::System::Registry::{
        RegOpenKeyExW, RegQueryValueExW, RegCloseKey, HKEY_CURRENT_USER, KEY_READ, REG_DWORD,
    };
    use windows::core::PCWSTR;

    unsafe {
        let mut hkey = std::mem::zeroed();
        let subkey_wide: Vec<u16> = format!("{}\0", subkey).encode_utf16().collect();

        if RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(subkey_wide.as_ptr()), Some(0), KEY_READ, &mut hkey).is_err() {
            return None;
        }

        let value_wide: Vec<u16> = format!("{}\0", value_name).encode_utf16().collect();
        let mut data: u32 = 0;
        let mut data_size = std::mem::size_of::<u32>() as u32;
        let mut data_type = REG_DWORD;

        let result = RegQueryValueExW(
            hkey,
            PCWSTR(value_wide.as_ptr()),
            None,
            Some(&mut data_type),
            Some(&mut data as *mut u32 as *mut u8),
            Some(&mut data_size),
        );

        let _ = RegCloseKey(hkey);

        if result.is_ok() { Some(data) } else { None }
    }
}

// Load theme-aware tray icon (white for dark theme, black for light theme)
pub(crate) fn load_theme_icon() -> tauri::image::Image<'static> {
    let is_dark = is_dark_theme();
    let icon_bytes: &[u8] = if is_dark {
        include_bytes!("../../assets/icons/RainyDeskIconWhite.png")
    } else {
        include_bytes!("../../assets/icons/RainyDeskIconBlack.png")
    };

    let img = image::load_from_memory(icon_bytes).expect("valid icon PNG");
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    tauri::image::Image::new_owned(rgba.into_raw(), width, height)
}

#[cfg(target_os = "windows")]
pub(crate) fn is_dark_theme() -> bool {
    // 0 = dark theme, 1 = light theme
    read_registry_dword(
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize",
        "AppsUseLightTheme",
    )
    .map(|v| v == 0)
    .unwrap_or(true)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn is_dark_theme() -> bool {
    true
}

#[cfg(target_os = "windows")]
pub(crate) fn get_accent_color_from_registry() -> Option<String> {
    let data = read_registry_dword(r"SOFTWARE\Microsoft\Windows\DWM", "AccentColor")?;
    // AccentColor is in ABGR format, convert to #RRGGBB
    let r = (data >> 0) & 0xFF;
    let g = (data >> 8) & 0xFF;
    let b = (data >> 16) & 0xFF;
    Some(format!("#{:02x}{:02x}{:02x}", r, g, b))
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn get_accent_color_from_registry() -> Option<String> {
    None
}

// Get the actual work area (excluding taskbar) for a monitor at given position
#[cfg(target_os = "windows")]
pub(crate) fn get_monitor_work_area(x: i32, y: i32, width: u32, height: u32) -> Bounds {
    use windows::Win32::Graphics::Gdi::{MonitorFromPoint, GetMonitorInfoW, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows::Win32::Foundation::POINT;

    unsafe {
        let center_x = x + (width as i32 / 2);
        let center_y = y + (height as i32 / 2);
        let point = POINT { x: center_x, y: center_y };
        let hmonitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);

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
            Bounds { x, y, width, height: height.saturating_sub(48) }
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn get_monitor_work_area(x: i32, y: i32, width: u32, height: u32) -> Bounds {
    Bounds { x, y, width, height: height.saturating_sub(48) }
}

#[cfg(target_os = "windows")]
fn query_refresh_rate_win32(x: i32, y: i32, width: u32, height: u32) -> Option<u32> {
    use windows::Win32::Graphics::Gdi::{
        MonitorFromPoint, GetMonitorInfoW, MONITORINFOEXW, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        EnumDisplaySettingsW, DEVMODEW, ENUM_CURRENT_SETTINGS,
    };
    use windows::Win32::Foundation::POINT;

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
            return None;
        }

        let mut devmode = DEVMODEW {
            dmSize: std::mem::size_of::<DEVMODEW>() as u16,
            ..Default::default()
        };

        if !EnumDisplaySettingsW(
            windows::core::PCWSTR(info.szDevice.as_ptr()),
            ENUM_CURRENT_SETTINGS,
            &mut devmode,
        ).as_bool() {
            return None;
        }

        let hz = devmode.dmDisplayFrequency;
        if hz > 0 { Some(hz) } else { None }
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn get_monitor_refresh_rate(x: i32, y: i32, width: u32, height: u32) -> u32 {
    query_refresh_rate_win32(x, y, width, height).unwrap_or(60)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn get_monitor_refresh_rate(_x: i32, _y: i32, _width: u32, _height: u32) -> u32 {
    60
}

// Find which monitor is the primary (contains point 0,0)
#[cfg(target_os = "windows")]
pub(crate) fn get_primary_monitor_index(monitors: &[tauri::Monitor]) -> usize {
    use windows::Win32::Graphics::Gdi::{
        MonitorFromPoint, GetMonitorInfoW, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
    };
    use windows::Win32::Foundation::POINT;

    unsafe {
        let primary = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);

        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };

        if GetMonitorInfoW(primary, &mut info).as_bool() {
            let primary_x = info.rcMonitor.left;
            let primary_y = info.rcMonitor.top;

            for (i, monitor) in monitors.iter().enumerate() {
                let pos = monitor.position();
                if pos.x == primary_x && pos.y == primary_y {
                    return i;
                }
            }
        }
    }
    0
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn get_primary_monitor_index(_monitors: &[tauri::Monitor]) -> usize {
    0
}

#[cfg(target_os = "windows")]
pub(crate) fn get_gpu_name() -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let output = std::process::Command::new("wmic")
        .args(["path", "win32_VideoController", "get", "name"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .skip(1)
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn get_gpu_name() -> Option<String> {
    None
}

// Reads VRAM from registry
#[cfg(target_os = "windows")]
pub(crate) fn get_gpu_vram_gb() -> Option<f64> {
    use windows::Win32::System::Registry::{
        RegOpenKeyExW, RegQueryValueExW, RegCloseKey, HKEY_LOCAL_MACHINE, KEY_READ, REG_QWORD,
    };
    use windows::core::PCWSTR;

    let base = r"SYSTEM\ControlSet001\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
    let mut max_vram: u64 = 0;

    // Check first 4 adapter subkeys, keep the largest (discrete GPU)
    for i in 0..4u32 {
        let subkey: Vec<u16> = format!("{}\\{:04}\0", base, i).encode_utf16().collect();

        unsafe {
            let mut hkey = std::mem::zeroed();
            if RegOpenKeyExW(HKEY_LOCAL_MACHINE, PCWSTR(subkey.as_ptr()), Some(0), KEY_READ, &mut hkey).is_err() {
                continue;
            }

            let value_name: Vec<u16> = "HardwareInformation.qwMemorySize\0".encode_utf16().collect();
            let mut data: u64 = 0;
            let mut data_size = std::mem::size_of::<u64>() as u32;
            let mut data_type = REG_QWORD;

            let result = RegQueryValueExW(
                hkey,
                PCWSTR(value_name.as_ptr()),
                None,
                Some(&mut data_type),
                Some(&mut data as *mut u64 as *mut u8),
                Some(&mut data_size),
            );

            let _ = RegCloseKey(hkey);

            if result.is_ok() && data > max_vram {
                max_vram = data;
            }
        }
    }

    if max_vram > 0 {
        let gb = max_vram as f64 / (1024.0 * 1024.0 * 1024.0);
        Some((gb * 10.0).round() / 10.0)
    } else {
        None
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn get_gpu_vram_gb() -> Option<f64> {
    None
}

// Monitor snapshot for hot-swap detection: count + geometry + scale factors
pub(crate) fn get_monitor_snapshot(handle: &tauri::AppHandle) -> Vec<(i32, i32, u32, u32, i32)> {
    let monitors = handle.available_monitors().unwrap_or_default();
    let mut snapshot: Vec<(i32, i32, u32, u32, i32)> = monitors.iter().map(|m| {
        let pos = m.position();
        let size = m.size();
        // Store scale as integer permille (1000 = 1.0×) to avoid float comparison issues
        let scale_permille = (m.scale_factor() * 1000.0) as i32;
        (pos.x, pos.y, size.width, size.height, scale_permille)
    }).collect();
    snapshot.sort(); // Deterministic order for comparison
    snapshot
}
