// Tauri API compatibility layer for window.rainydesk
// Provides same API as Electron preload but uses Tauri invoke/listen

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

window.rainydesk = {
  // Receive display info from main process (event-based)
  onDisplayInfo: (callback) => {
    listen('display-info', (event) => callback(event.payload));
  },

  // Get display info via command (more reliable than event)
  getDisplayInfo: () => invoke('get_display_info'),

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

  // Receive volume changes
  onSetVolume: (callback) => {
    listen('set-volume', (event) => callback(event.payload));
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

  // Fullscreen detection: hide rain on this monitor when fullscreen window detected
  onFullscreenStatus: (callback) => {
    listen('fullscreen-status', (event) => callback(event.payload));
  },

  // Audio muffling: triggered when ANY monitor has fullscreen (since audio is global)
  onAudioMuffle: (callback) => {
    listen('audio-muffle', (event) => callback(event.payload));
  },

  // Log messages to main process console
  log: (message) => invoke('log_message', { message })
};

console.log('Tauri API shim loaded');
