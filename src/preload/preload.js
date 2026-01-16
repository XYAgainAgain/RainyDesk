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

  // Log messages to main process console
  log: (message) => ipcRenderer.send('log', message)
});
