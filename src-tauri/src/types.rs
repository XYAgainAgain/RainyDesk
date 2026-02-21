// Shared data types for IPC serialization and app state.

use std::sync::Mutex;
use std::time::Instant;

// App state for configuration and cached hardware info
pub(crate) struct AppState {
    pub config: Mutex<serde_json::Value>,
    pub system_specs: SystemSpecs,
}

// Panel position and UI config persistence
#[derive(serde::Serialize, serde::Deserialize, Default)]
pub(crate) struct PanelConfig {
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub ui_scale: Option<f32>,
    pub detached: Option<bool>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DisplayInfo {
    pub index: usize,
    pub bounds: Bounds,
    pub work_area: Bounds,
    pub scale_factor: f64,
    pub refresh_rate: u32,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemSpecs {
    pub cpu_model: String,
    pub gpu_model: String,
    pub gpu_vram_gb: Option<f64>,
    pub total_ram_gb: f64,
}

// Virtual desktop info: bounding box of all monitors + individual regions
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VirtualDesktop {
    pub origin_x: i32,
    pub origin_y: i32,
    pub width: u32,
    pub height: u32,
    pub monitors: Vec<MonitorRegion>,
    pub primary_index: usize,
    pub primary_scale_factor: f64,
}

// WebView health tracking for crash detection and recovery
pub(crate) struct WindowHealth {
    pub created_at: Instant,
    pub last_heartbeat: Option<Instant>,
    pub init_complete: bool,
    pub crash_count: u32,
}

// Single monitor region within the virtual desktop
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MonitorRegion {
    pub index: usize,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub work_x: u32,
    pub work_y: u32,
    pub work_width: u32,
    pub work_height: u32,
    pub scale_factor: f64,
    pub refresh_rate: u32,
}
