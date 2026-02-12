// Rainscape file I/O: directory setup, migration, default config, startup loading.

use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

fn is_rain_file(path: &Path) -> bool {
    path.is_file() && path.extension().map(|ext| ext == "rain").unwrap_or(false)
}

// Copy .rain files from source dir to dest dir, tracking success/failure counts
fn copy_rain_files(source: &Path, dest: &Path, migrated: &mut u32, failed: &mut u32) {
    let entries = match fs::read_dir(source) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if !is_rain_file(&path) { continue; }
        let Some(name) = path.file_name() else { continue };
        let dest_path = dest.join(name);
        if dest_path.exists() { continue; }

        match fs::copy(&path, &dest_path) {
            Ok(_) => *migrated += 1,
            Err(e) => {
                log::error!("[Migration] Failed to copy {:?}: {}", path, e);
                *failed += 1;
            }
        }
    }
}

/// Get the rainscapes directory, creating structure if needed:
/// Documents\RainyDesk\
///   Autosave.rain, Default.rain, Custom Rainscapes\
pub(crate) fn get_rainscapes_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let docs_dir = dirs::document_dir()
        .ok_or_else(|| "Failed to get Documents directory".to_string())?;
    let rainscapes_dir = docs_dir.join("RainyDesk");
    let custom_dir = rainscapes_dir.join("Custom Rainscapes");

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

    let default_path = rainscapes_dir.join("Default.rain");
    if !default_path.exists() {
        let default_rainscape = create_default_rainscape();
        let json_str = serde_json::to_string_pretty(&default_rainscape)
            .map_err(|e| format!("Failed to serialize default: {}", e))?;
        fs::write(&default_path, json_str)
            .map_err(|e| format!("Failed to write Default.rain: {}", e))?;
        log::info!("Created Default.rain");
    }

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

    copy_rain_files(&old_dir, new_dir, &mut migrated, &mut failed);

    let old_custom = old_dir.join("Custom");
    let new_custom = new_dir.join("Custom Rainscapes");
    if old_custom.exists() {
        copy_rain_files(&old_custom, &new_custom, &mut migrated, &mut failed);
    }

    if failed == 0 {
        if let Err(e) = fs::remove_dir_all(&old_dir) {
            log::warn!("[Migration] Failed to remove old dir {:?}: {}", old_dir, e);
        }
    } else {
        log::warn!("[Migration] {} copies failed, keeping old dir {:?} as backup", failed, old_dir);
    }

    log::info!("[Migration] Complete: {} migrated, {} failed", migrated, failed);
}

/// Create the default rainscape configuration (v2 schema)
pub(crate) fn create_default_rainscape() -> serde_json::Value {
    serde_json::json!({
        "version": 2,
        "name": "Default",
        "rain": {
            "intensity": 50,
            "wind": 15,
            "gravity": 980,
            "reverseGravity": false,
            "turbulence": 0.3,
            "splashScale": 1.0,
            "splashLinked": true,
            "puddleDrain": 0.2,
            "dropSize": { "max": 4.0 },
            "color": "#8aa8c0",
            "gayMode": false,
            "rainbowSpeed": 1.0,
            "sheetVolume": 30,
            "osc": {
                "intensity": 0,
                "wind": 0,
                "turbulence": 0,
                "sheet": 0
            }
        },
        "matrix": {
            "density": 20,
            "transpose": 0,
            "transMode": false,
            "transScrollDirection": "off"
        },
        "audio": {
            "muted": false,
            "rain": {
                "masterVolume": -6,
                "rainIntensity": 50,
                "impactPitch": 50,
                "impactPitchOsc": 0,
                "windMasterGain": -12,
                "thunderEnabled": false
            },
            "matrix": {
                "bass": -9,
                "collision": -21.6,
                "drone": -17.4
            }
        },
        "visual": {
            "matrixMode": false,
            "backgroundShaderEnabled": true,
            "backgroundIntensity": 50,
            "backgroundLayers": 3
        },
        "system": {
            "fpsLimit": 60,
            "gridScale": 0.25,
            "renderScale": 0.25,
            "maximizedDetection": true,
            "maximizedMuffling": false,
            "fullscreenDetection": true,
            "audioMuffling": true,
            "windowCollision": true
        }
    })
}

/// Get the startup rainscape (Autosave.rain if exists, else Default.rain)
pub(crate) fn get_startup_rainscape(app: &tauri::AppHandle) -> Result<(String, serde_json::Value), String> {
    let rainscapes_dir = get_rainscapes_dir(app)?;

    let autosave_path = rainscapes_dir.join("Autosave.rain");
    if autosave_path.exists() {
        let content = fs::read_to_string(&autosave_path)
            .map_err(|e| format!("Failed to read Autosave.rain: {}", e))?;
        let data: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse Autosave.rain: {}", e))?;
        log::info!("Loading Autosave.rain");
        return Ok(("Autosave.rain".to_string(), data));
    }

    let default_path = rainscapes_dir.join("Default.rain");
    let content = fs::read_to_string(&default_path)
        .map_err(|e| format!("Failed to read Default.rain: {}", e))?;
    let data: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse Default.rain: {}", e))?;
    log::info!("Loading Default.rain (no autosave found)");
    Ok(("Default.rain".to_string(), data))
}
