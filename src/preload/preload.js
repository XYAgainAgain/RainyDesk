const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('rainydesk', {
  // Receive display info from main process
  onDisplayInfo: (callback) => {
    ipcRenderer.on('display-info', (event, data) => callback(data));
  },

  // Receive rain toggle commands
  onToggleRain: (callback) => {
    ipcRenderer.on('toggle-rain', (event, enabled) => callback(enabled));
  },

  // Receive intensity changes
  onSetIntensity: (callback) => {
    ipcRenderer.on('set-intensity', (event, value) => callback(value));
  },

  // Receive volume changes
  onSetVolume: (callback) => {
    ipcRenderer.on('set-volume', (event, value) => callback(value));
  },

  // Receive window position data for exclusion zones
  onWindowData: (callback) => {
    ipcRenderer.on('window-data', (event, data) => callback(data));
  },

  // Get current configuration
  getConfig: () => ipcRenderer.invoke('get-config'),

  // Notify main process of current rainscape (for tray tooltip)
  setRainscape: (name) => ipcRenderer.send('set-rainscape', name),

  // Toggle Rainscaper Debug Panel
  onToggleRainscaper: (callback) => {
    ipcRenderer.on('toggle-rainscaper', () => {
      console.log('Preload: received toggle-rainscaper');
      callback();
    });
  },

  // Control mouse transparency
  setIgnoreMouseEvents: (ignore, options) => {
    ipcRenderer.send('set-ignore-mouse-events', ignore, options);
  },

  // Rainscape File I/O
  saveRainscape: (filename, data) => ipcRenderer.invoke('save-rainscape', filename, data),
  loadRainscapes: () => ipcRenderer.invoke('load-rainscapes'),
  readRainscape: (filename) => ipcRenderer.invoke('read-rainscape', filename),

  // Rainscape Parameter Sync
  updateRainscapeParam: (path, value) => ipcRenderer.send('update-rainscape-param', path, value),
  onUpdateRainscapeParam: (callback) => ipcRenderer.on('update-rainscape-param', (event, path, value) => callback(path, value)),

  // Log messages to main process console
  log: (message) => ipcRenderer.send('log', message)
});
