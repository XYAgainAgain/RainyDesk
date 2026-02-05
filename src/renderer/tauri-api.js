// Tauri API bridge for window.rainydesk
// Uses Tauri invoke/listen for IPC communication with Rust backend

import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';

window.rainydesk = {
  // Receive display info from main process (event-based)
  onDisplayInfo: (callback) => {
    listen('display-info', (event) => callback(event.payload));
  },

  // Get display info via command (more reliable than event)
  getDisplayInfo: () => invoke('get_display_info'),

  // Get all displays for multi-monitor grid calculation
  getAllDisplays: () => invoke('get_all_displays'),

  // Get virtual desktop info (bounding box + monitor regions)
  getVirtualDesktop: () => invoke('get_virtual_desktop'),

  // Receive virtual desktop info from main process (event-based)
  onVirtualDesktop: (callback) => {
    listen('virtual-desktop', (event) => callback(event.payload));
  },

  // Receive rain toggle commands (pause/resume from tray menu)
  onToggleRain: (callback) => {
    listen('toggle-rain', (event) => {
      invoke('log_message', { message: `[TauriAPI] toggle-rain: ${event.payload}` });
      callback(event.payload);
    }).catch((e) => {
      invoke('log_message', { message: `[TauriAPI] FAILED to register toggle-rain listener: ${e}` });
    });
  },

  // Receive audio toggle commands (pause/resume audio system)
  onToggleAudio: (callback) => {
    listen('toggle-audio', (event) => callback(event.payload));
  },

  // Receive intensity changes
  onSetIntensity: (callback) => {
    listen('set-intensity', (event) => callback(event.payload));
  },

  // Receive volume changes (from tray menu presets)
  onSetVolume: (callback) => {
    listen('set-volume', (event) => callback(event.payload));
  },

  // Receive rainscape load command (from tray menu quick-select)
  onLoadRainscape: (callback) => {
    listen('load-rainscape', (event) => callback(event.payload));
  },

  // Receive window position data for exclusion zones
  onWindowData: (callback) => {
    listen('window-data', (event) => callback(event.payload));
  },

  // Get current configuration
  getConfig: () => invoke('get_config'),

  // Notify main process of current rainscape (for tray tooltip)
  setRainscape: (name) => invoke('set_rainscape', { name }),

  // Toggle Rainscaper Debug Panel
  onToggleRainscaper: (callback) => {
    listen('toggle-rainscaper', () => {
      console.log('Tauri API: received toggle-rainscaper');
      callback();
    });
  },

  // Control mouse transparency
  setIgnoreMouseEvents: (ignore, _options) => {
    invoke('set_ignore_mouse_events', { ignore });
  },

  // Rainscape File I/O
  saveRainscape: (filename, data) => invoke('save_rainscape', { filename, data }),
  autosaveRainscape: (data) => invoke('autosave_rainscape', { data }),
  getStartupRainscape: () => invoke('get_startup_rainscape_cmd'),
  loadRainscapes: () => invoke('load_rainscapes'),
  readRainscape: (filename) => invoke('read_rainscape', { filename }),

  // Rainscape Parameter Sync
  updateRainscapeParam: (path, value) => invoke('update_rainscape_param', { path, value }),
  onUpdateRainscapeParam: (callback) => {
    listen('update-rainscape-param', (event) => {
      callback(event.payload.path, event.payload.value);
    }).catch((e) => {
      invoke('log_message', { message: `[TauriAPI] FAILED to register param listener: ${e}` });
    });
  },

  // Audio start synchronization across monitors
  triggerAudioStart: () => invoke('trigger_audio_start'),
  onStartAudio: (callback) => {
    listen('start-audio', () => callback());
  },

  // Fade-in coordination: signal readiness and wait for synchronized start
  rendererReady: () => invoke('renderer_ready'),
  backgroundReady: () => invoke('background_ready'),
  onStartFadeIn: (callback) => {
    listen('start-fade-in', () => callback());
  },

  // Fullscreen detection: hide rain on this monitor when fullscreen window detected
  onFullscreenStatus: (callback) => {
    listen('fullscreen-status', (event) => callback(event.payload));
  },

  // Audio muffling: triggered when ANY monitor has fullscreen (since audio is global)
  onAudioMuffle: (callback) => {
    listen('audio-muffle', (event) => callback(event.payload));
  },

  // Log messages to main process console
  log: (message) => invoke('log_message', { message }),

  // Rainscaper window control
  // Use event instead of invoke - Rust handles it the same way as tray click
  hideRainscaper: () => emit('hide-rainscaper-request'),
  showRainscaper: (trayX, trayY) => invoke('show_rainscaper', { trayX, trayY }),
  toggleRainscaper: (trayX, trayY) => invoke('toggle_rainscaper', { trayX, trayY }),
  resizeRainscaper: (width, height) => invoke('resize_rainscaper', { width, height }),

  // System integration
  getWindowsAccentColor: () => invoke('get_windows_accent_color'),

  // Stats bridge (overlay → panel)
  // Emits stats from overlay window so panel can display them
  emitStats: (stats) => emit('renderer-stats', stats),
  onStats: (callback) => {
    listen('renderer-stats', (event) => callback(event.payload));
  }
};

// Debug log storage for Rainscaper panel
window._debugLog = [];
window._debugLogMaxEntries = 100;
window._debugStats = {
  fps: 0,
  waterCount: 0,
  activeDrops: 0,
  puddleCells: 0,
  lastUpdate: Date.now(),
};

// Add debug log entry (used by console intercept and direct calls)
window._addDebugLog = (level, message) => {
  window._debugLog.push({
    timestamp: new Date(),
    level,
    message,
  });
  // Trim to max entries
  while (window._debugLog.length > window._debugLogMaxEntries) {
    window._debugLog.shift();
  }
};

// Update debug stats (called by main renderer)
window._updateDebugStats = (stats) => {
  Object.assign(window._debugStats, stats, { lastUpdate: Date.now() });
};

// Intercept console.warn and console.error to pipe to Rust log
const originalWarn = console.warn;
const originalError = console.error;
const originalLog = console.log;

console.log = (...args) => {
  originalLog.apply(console, args);
  const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  window._addDebugLog('info', message);
};

console.warn = (...args) => {
  originalWarn.apply(console, args);
  const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  window._addDebugLog('warn', message);
  invoke('log_message', { message: `[ConsoleWarn] ${message}` }).catch(() => {});
};

console.error = (...args) => {
  originalError.apply(console, args);
  const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  window._addDebugLog('error', message);
  invoke('log_message', { message: `[ConsoleError] ${message}` }).catch(() => {});
};

console.log('Tauri API shim loaded');
