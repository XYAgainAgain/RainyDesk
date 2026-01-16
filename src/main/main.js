const { app, BrowserWindow, screen, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const windowDetector = require('./windowDetector');

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

// Single instance lock: prevent multiple app launches
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('Another instance is already running. Exiting.');
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance
    // We could focus a window or show a tray notification here
    console.log('Second instance blocked: RainyDesk is already running');
  });
}

// Keep references to prevent garbage collection
let tray = null;
const overlayWindows = [];

// Logging configuration (initialized in whenReady)
let LOG_DIR = null;
let LOG_FILE = null;
const MAX_LOG_SIZE = 1024 * 1024; // 1MB

// Rainscape storage path (initialized in whenReady)
let RAINSCAPE_DIR;
let USER_CONFIG_PATH;

/**
 * Setup logging directory and rotate old logs on startup
 */
function setupLogging() {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    if (fs.existsSync(LOG_FILE)) {
      const stats = fs.statSync(LOG_FILE);
      if (stats.size > MAX_LOG_SIZE) {
        const oldLog = path.join(LOG_DIR, 'rainydesk.old.log');
        try {
          if (fs.existsSync(oldLog)) {
            fs.unlinkSync(oldLog);
          }
          fs.renameSync(LOG_FILE, oldLog);
          console.log('Rotated old log file');
        } catch (err) {
          console.error('Failed to rotate log file:', err);
        }
      }
    }
    
    // Write session start marker
    fs.appendFileSync(LOG_FILE, `\n=== Session Started: ${new Date().toISOString()} ===\n`);
  } catch (err) {
    console.error('Logging setup failed:', err);
  }
}

/**
 * Write to log file and console
 */
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;

  // Console output
  console.log(message);

  // File output (only if LOG_FILE is initialized)
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, logMessage + '\n');
    } catch (err) {
      // Fail silently to avoid infinite loops if logging fails
    }
  }
}

// Configuration defaults
let config = {
  rainEnabled: true,
  intensity: 50,
  volume: 50,
  rainscapeName: 'Glass Window' // Default
};

/**
 * Creates a transparent overlay window for a specific display
 */
function createOverlayWindow(display, index) {
  const overlay = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    transparent: true,
    frame: false,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    fullscreenable: false,
    enableLargerThanScreen: true,  // Allow windows larger than screen
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Force exact bounds (Electron sometimes constrains window size)
  overlay.setBounds({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height
  });

  // Start with clicks enabled for first audio interaction
  // Renderer will switch to click-through after audio starts
  overlay.setIgnoreMouseEvents(false);

  // Load the renderer
  overlay.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Pass display info to renderer once loaded
  overlay.webContents.on('did-finish-load', () => {
    // Log actual window bounds after creation
    const actualBounds = overlay.getBounds();
    log(`  Window ${index} actual bounds: x=${actualBounds.x}, y=${actualBounds.y}, w=${actualBounds.width}, h=${actualBounds.height}`);

    overlay.webContents.send('display-info', {
      index,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      refreshRate: display.displayFrequency || 60 // Default to 60 if not available
    });
  });

  // Store reference
  overlayWindows.push({
    window: overlay,
    display,
    index,
    isPaused: false
  });

  return overlay;
}

/**
 * Creates overlay windows for all displays
 */
function createAllOverlays() {
  const displays = screen.getAllDisplays();
  log(`Found ${displays.length} display(s)`);

  displays.forEach((display, index) => {
    log(`Display ${index} details:`);
    log(`  Bounds: x=${display.bounds.x}, y=${display.bounds.y}, w=${display.bounds.width}, h=${display.bounds.height}`);
    log(`  Work Area: x=${display.workArea.x}, y=${display.workArea.y}, w=${display.workArea.width}, h=${display.workArea.height}`);
    log(`  Scale Factor: ${display.scaleFactor}`);
    log(`  Rotation: ${display.rotation}`);
    log(`  Refresh Rate: ${display.displayFrequency || '?'}Hz`);
    createOverlayWindow(display, index);
  });
}

/**
 * Creates the system tray icon and menu
 */
function createTray() {
  // Create a simple colored icon (will be replaced with proper icon later)
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'icons', 'tray-icon.png');

  // Create a simple 16x16 blue icon as fallback
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAADASURBVDiNtZKxDYMwEEWfIzogTZYgDRuwQUagpGYJaFkgDRuwQcYgBQVFGkqKKFBYwYkCSvKl086+/+8u2AbqQEQWwBl4A47W2o2I+EBSrXJ9oAn1sBVLwKXBnwJxNaEFXIE7MAJO/tCpgFMABMAAB+AB3IAd0AUaVYBZBQT8BwFPQAZkTQWogCwHQsAXSP6vglhXKAJ2/gFE/LYoAt6AL5DWNvgA0rpG/oAP8ABSrXL1gDu1AN1KIMkB+dACvgGXe2I/Mj7HDAAAAABJRU5ErkJggg=='
  );

  tray = new Tray(icon);
  
  // Left-click opens Rainscaper
  tray.on('click', () => {
    broadcastToOverlays('toggle-rainscaper');
  });

  updateTrayTooltip();
  updateTrayMenu();
}

function updateTrayTooltip() {
  if (tray) {
    tray.setToolTip(`RainyDesk: ${config.rainscapeName}`);
  }
}

/**
 * Updates the tray menu with current state
 */
function updateTrayMenu() {
  const contextMenu = Menu.buildFromTemplate([
    {
      label: config.rainEnabled ? 'Pause Rain' : 'Resume Rain',
      click: () => {
        config.rainEnabled = !config.rainEnabled;
        broadcastToOverlays('toggle-rain', config.rainEnabled);
        updateTrayMenu();
      }
    },
    { type: 'separator' },
    {
      label: 'Open Rainscaper Panel',
      click: () => broadcastToOverlays('toggle-rainscaper')
    },
    { type: 'separator' },
    {
      label: 'Quit RainyDesk',
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

/**
 * Broadcast a message to all overlay windows
 */
function broadcastToOverlays(channel, ...args) {
  overlayWindows.forEach(({ window }) => {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, ...args);
    }
  });
}

/**
 * Set rain intensity
 */
function setIntensity(value) {
  config.intensity = value;
  broadcastToOverlays('set-intensity', value);
}

/**
 * Set audio volume
 */
function setVolume(value) {
  config.volume = value;
  broadcastToOverlays('set-volume', value);
}

/**
 * Handle display changes (monitors added/removed)
 */
function handleDisplayChange() {
  log('Display configuration changed');

  // Stop window detection temporarily
  windowDetector.stop();

  // Close all existing overlay windows
  overlayWindows.forEach(({ window }) => {
    if (!window.isDestroyed()) {
      window.close();
    }
  });
  overlayWindows.length = 0;

  // Recreate overlays for new display configuration
  createAllOverlays();

  // Restart window detection after overlays are ready
  setTimeout(startWindowDetection, 1000);
}

/**
 * Start window detection and broadcast window positions to renderers
 */
function startWindowDetection() {
  // Get native window IDs for overlay windows to exclude them from detection
  const overlayIds = overlayWindows.map(({ window }) => {
    try {
      // Get the native window handle and read as 32-bit integer
      const handle = window.getNativeWindowHandle();
      return handle.readInt32LE(0);
    } catch (err) {
      log(`Warning: Could not get native handle for overlay: ${err.message}`);
      return null;
    }
  }).filter(id => id !== null);

  log(`Starting window detection, excluding ${overlayIds.length} overlay window(s)`);

  // Start detector with 250ms poll rate
  windowDetector.start(overlayIds, (windows) => {
    broadcastToOverlays('window-data', {
      timestamp: Date.now(),
      windows: windows.map(w => ({
        id: w.id,
        bounds: w.bounds,
        title: w.title
      }))
    });
  }, 250);
}

// App lifecycle
app.whenReady().then(() => {
  // Initialize paths using userData directory
  const USER_DATA = app.getPath('userData');
  LOG_DIR = path.join(USER_DATA, 'logs');
  LOG_FILE = path.join(LOG_DIR, 'rainydesk.log');
  RAINSCAPE_DIR = path.join(USER_DATA, 'rainscapes');
  USER_CONFIG_PATH = path.join(USER_DATA, 'config.json');

  // Setup logging first
  setupLogging();

  // Create rainscape directory
  if (!fs.existsSync(RAINSCAPE_DIR)) {
    fs.mkdirSync(RAINSCAPE_DIR, { recursive: true });
  }

  // Load saved config
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, 'utf-8'));
      config = { ...config, ...saved };
      log(`Loaded config: ${config.rainscapeName}`);
    }
  } catch (err) {
    console.error('Failed to load config:', err);
  }
  createAllOverlays();
  createTray();

  // Start window detection after a short delay to ensure overlays are ready
  setTimeout(startWindowDetection, 1000);

  // Listen for display changes
  screen.on('display-added', handleDisplayChange);
  screen.on('display-removed', handleDisplayChange);
  screen.on('display-metrics-changed', handleDisplayChange);

  log('RainyDesk started');
});

// Keep the app running even when all windows are "closed"
app.on('window-all-closed', () => {
  // Don't quit on window close - we want to stay in tray
});

app.on('before-quit', () => {
  // Save config on quit
  try {
    if (USER_CONFIG_PATH) fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (e) { console.error('Failed to save config:', e); }

  // Stop window detection
  windowDetector.stop();

  // Clean up overlay windows
  overlayWindows.forEach(({ window }) => {
    if (!window.isDestroyed()) {
      window.destroy();
    }
  });
});

// --- IPC HANDLERS ---

ipcMain.handle('get-config', () => {
  return config;
});

ipcMain.on('log', (event, message) => {
  log(`[Renderer] ${message}`);
});

ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.setIgnoreMouseEvents(ignore, options);
  }
});

ipcMain.on('set-rainscape', (event, name) => {
  if (config.rainscapeName !== name) {
    config.rainscapeName = name;
    updateTrayTooltip();
    // Auto-save config
    try {
      if (USER_CONFIG_PATH) fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (e) {}
  }
});

// Rainscape Sync: Broadcast parameter updates to ALL renderers
ipcMain.on('update-rainscape-param', (event, paramPath, value) => {
  broadcastToOverlays('update-rainscape-param', paramPath, value);
});

// Audio Start Sync: When one monitor clicks, start audio on all monitors
ipcMain.on('trigger-audio-start', () => {
  log('Audio start triggered - broadcasting to all monitors');
  broadcastToOverlays('start-audio');
});

// Rainscape File I/O
ipcMain.handle('save-rainscape', async (event, filename, data) => {
  try {
    if (!RAINSCAPE_DIR) return { success: false, error: 'Not ready' };
    const filePath = path.join(RAINSCAPE_DIR, filename.endsWith('.json') ? filename : `${filename}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('load-rainscapes', async () => {
  try {
    if (!RAINSCAPE_DIR || !fs.existsSync(RAINSCAPE_DIR)) return [];
    return fs.readdirSync(RAINSCAPE_DIR).filter(f => f.endsWith('.json'));
  } catch (err) {
    return [];
  }
});

ipcMain.handle('read-rainscape', async (event, filename) => {
  try {
    const filePath = path.join(RAINSCAPE_DIR, filename);
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    return null;
  }
});