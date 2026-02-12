// Session log setup with rolling cleanup.

use std::fs;
use std::path::PathBuf;
use chrono::Local;

fn is_rainydesk_log(entry: &fs::DirEntry) -> bool {
    let name = entry.file_name();
    let name = name.to_string_lossy();
    name.starts_with("RainyDesk_") && name.ends_with(".log")
}

fn collect_log_files(dir: &PathBuf) -> Vec<fs::DirEntry> {
    let mut files: Vec<_> = fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(is_rainydesk_log)
        .collect();

    // Sort by modification time (oldest first)
    files.sort_by(|a, b| {
        let a_time = a.metadata().and_then(|m| m.modified()).ok();
        let b_time = b.metadata().and_then(|m| m.modified()).ok();
        a_time.cmp(&b_time)
    });

    files
}

fn cleanup_old_logs(files: &mut Vec<fs::DirEntry>, max_logs: usize) {
    while files.len() >= max_logs {
        if let Some(oldest) = files.first() {
            let _ = fs::remove_file(oldest.path());
            files.remove(0);
        }
    }
}

fn cleanup_oversized_logs(files: &[fs::DirEntry], max_bytes: u64) {
    for log_file in files {
        if let Ok(metadata) = log_file.metadata() {
            if metadata.len() > max_bytes {
                let _ = fs::remove_file(log_file.path());
            }
        }
    }
}

fn cleanup_legacy_log(dir: &PathBuf) {
    let legacy_log = dir.join("RainyDesk.log");
    if legacy_log.exists() {
        let _ = fs::remove_file(&legacy_log);
    }
}

/// Clean up old log files, keeping only the N most recent.
/// Returns the path to the new log file for this session.
pub(crate) fn setup_session_log(log_dir: &PathBuf, max_logs: usize, max_size_bytes: u64) -> PathBuf {
    if !log_dir.exists() {
        let _ = fs::create_dir_all(log_dir);
    }

    let timestamp = Local::now().format("%Y-%m-%d_%H-%M-%S");
    let log_filename = format!("RainyDesk_{}.log", timestamp);
    let new_log_path = log_dir.join(&log_filename);

    let mut log_files = collect_log_files(log_dir);
    cleanup_old_logs(&mut log_files, max_logs);
    cleanup_oversized_logs(&log_files, max_size_bytes);
    cleanup_legacy_log(log_dir);

    new_log_path
}
