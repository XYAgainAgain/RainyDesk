/**
 * RainyDesk Renderer - Overlay Mode
 * Pixi hybrid physics, audio, and Rainscaper UI
 *
 * SEQUENTIAL STARTUP ARCHITECTURE:
 * 1. Hide canvas immediately (synchronous, at script top)
 * 2. Wait for Tauri API
 * 3. Get display info and calculate maps
 * 4. Init simulation (Pixi only)
 * 5. Register event listeners
 * 6. Init UI
 * 7. Wait for first window data
 * 8. Start game loop (still hidden)
 * 9. Signal ready, wait for coordinated fade-in
 */

// PHASE 1: Hide canvas (only on first load, not hot-reloads)
const canvas = document.getElementById('rain-canvas');

// Check if we recently initialized (within last 30 seconds) - survives WebView recreation
const lastInit = parseInt(localStorage.getItem('__RAINYDESK_OVERLAY_INIT_TIME__') || '0', 10);
const isRecentInit = (Date.now() - lastInit) < 30000;

if (!isRecentInit) {
  canvas.style.opacity = '0';
  canvas.style.visibility = 'hidden';
  canvas.style.transition = 'opacity 5s ease-in-out';
} else {
  console.log('[Overlay] Skipping canvas hide - recent init detected');
}

// Audio system (TypeScript, voice-pooled)
let audioSystem = null;

// Reinitialization state
let reinitInProgress = false;

// Render scale for pixelated 8-bit aesthetic (0.25 = 25% resolution)
let renderScale = 0.25;

// Grid scale presets for physics simulation
// Detailed (1:2) = 0.5  - More cells, smoother physics, higher CPU
// Normal (1:4)   = 0.25 - Balanced (default)
// Chunky (1:8)   = 0.125 - Fewer cells, blockier, faster physics
const GRID_SCALE_PRESETS = {
  detailed: 0.5,
  normal: 0.25,
  chunky: 0.125,
  potato: 0.0625
};
let GRID_SCALE = GRID_SCALE_PRESETS.normal; // Default to Normal (1:4)

// Virtual desktop info (mega-window architecture)
let virtualDesktop = null;

// Actual canvas dimensions (for particle bounds)
let canvasWidth = 1920;
let canvasHeight = 1080;

// Configuration
let config = {
  enabled: true,
  intensity: 50,
  volume: 50,
  wind: 0,
  dropColor: 'rgba(160, 196, 232, 0.6)',
  dropMinSize: 2,
  dropMaxSize: 6,
  fpsLimit: 0  // 0 = uncapped, otherwise target FPS
};

// FPS limiter state
let lastFrameTime = 0;

// Pixi hybrid physics
let gridSimulation = null;
let pixiRenderer = null;
let globalGridBounds = null;

// Matrix Mode
let matrixMode = false;
let matrixRenderer = null;
let glitchSynth = null;
let matrixCanvas = null; // Separate canvas for Matrix Mode (avoids WebGL context conflicts)
let matrixInitGeneration = 0; // Incremented on each toggle-ON to cancel stale async inits

// Autosave data (loaded during init, applied after audio starts)
let pendingAutosave = null;

// Pending Matrix params (queued when glitchSynth is null, applied in initMatrixRenderer)
let pendingMatrixParams = {};

// Timing
let lastTime = performance.now();
let fpsCounter = 0;
let fpsTime = performance.now();
let debugStatsTime = performance.now();

// Audio initialization flag
let audioInitialized = false;

// Window exclusion zones (local canvas coordinates)
let windowZones = [];
let windowZoneCount = 0;

// Per-monitor fullscreen tracking with asymmetric debounce
const fullscreenMonitors = new Set();
const lastFullscreenSeenTime = new Map();    // monitorIndex -> timestamp
const fullscreenEnterTimers = new Map();     // monitorIndex -> setTimeout ID
const fullscreenExitTimers = new Map();      // monitorIndex -> setTimeout ID
let allMonitorsFullscreen = false;
let lastMuffleAmount = 0;

// Per-monitor maximized tracking (mirrors fullscreen pattern)
const maximizedMonitors = new Set();
const lastMaximizedSeenTime = new Map();
const maximizedEnterTimers = new Map();
const maximizedExitTimers = new Map();
let allMonitorsMaximized = false;
let lastLoggedFullscreen = '';
let lastLoggedMaximized = '';

// Pause state (from Rainscaper panel)
let isPaused = false;

// Tracked settings for autosave (params without module getters)
let trackedRainIntensity = 50;       // audio.rainIntensity (0-100)
let trackedWindGainDb = -24;         // audio.wind.masterGain (dB)
let trackedThunderEnabled = false;   // audio.thunder.enabled
let trackedThunderStorminess = 50;   // audio.thunder.storminess (1–100)
let trackedThunderDistance = 5.0;    // audio.thunder.distance (km)
let trackedThunderEnvironment = 'forest'; // audio.thunder.environment
let trackedBgEnabled = true;         // backgroundRain.enabled
let trackedBgIntensity = 50;         // backgroundRain.intensity (0-100)
let trackedBgLayers = 3;             // backgroundRain.layers (1-5)
let trackedRainbowSpeed = 1;         // visual.rainbowSpeed (1-10)
let textureIntensityLinked = true;   // audio.texture.intensityLinked

// System behavior toggles (controlled from System tab, persisted in rainscapes)
let enableFullscreenDetection = true;
let enableMaximizedDetection = true;
let enableWindowCollision = true;
let enableAudioMuffling = true;
let enableMaximizedMuffling = true;

/* Wobbles a value around a user-set center point — shared by all OSC knobs */
class ParamOscillator {
  constructor({ min, max, lerpRate = 1.5, minAmplitude = 20, maxAmplitude = 100,
                minChangesPerMin = 5, maxChangesPerMin = 10, jitter = 0.3,
                roundOutput = true }) {
    this._min = min;
    this._max = max;
    this._lerpRate = lerpRate;
    this._minAmplitude = minAmplitude;
    this._maxAmplitude = maxAmplitude;
    this._minChangesPerMin = minChangesPerMin;
    this._maxChangesPerMin = maxChangesPerMin;
    this._jitter = jitter;
    this._roundOutput = roundOutput;
    // State
    this._amount = 0;        // Knob value (0-100)
    this._userCenter = 0;    // Manual slider center point
    this._target = 0;        // Target value to lerp toward
    this._current = 0;       // Current interpolated value
    this._nextChangeTime = 0; // When to pick a new target (seconds)
    this._lastBroadcast = 0;  // Throttle broadcasts (ms timestamp)
    this._lastBroadcastValue = null; // Dedup broadcasts
  }

  setAmount(v) { this._amount = v; this._nextChangeTime = 0; }
  setUserCenter(v) { this._userCenter = v; this._current = v; }

  get active() { return this._amount > 0; }
  get current() { return this._roundOutput ? Math.round(this._current) : this._current; }
  get userCenter() { return this._userCenter; }
  get amount() { return this._amount; }

  /* Advance one frame. Returns new output value, or null if inactive. */
  tick(dt, nowSec) {
    if (this._amount <= 0) return null;

    // OSC picks a new random target & lerps toward it smoothly
    if (nowSec >= this._nextChangeTime) {
      const oscNorm = this._amount / 100;
      const amplitude = this._minAmplitude + oscNorm * (this._maxAmplitude - this._minAmplitude);
      this._target = this._userCenter + (Math.random() * 2 - 1) * amplitude;
      this._target = Math.max(this._min, Math.min(this._max, this._target));

      const changesPerMin = this._minChangesPerMin + oscNorm * (this._maxChangesPerMin - this._minChangesPerMin);
      const interval = 60 / changesPerMin;
      const jitter = interval * this._jitter * (Math.random() * 2 - 1);
      this._nextChangeTime = nowSec + interval + jitter;
    }

    const rate = this._lerpRate * dt;
    this._current += (this._target - this._current) * Math.min(1, rate);

    return this.current;
  }

  /* Reset to user center (when knob set to 0). Returns center value. */
  snapToCenter() {
    this._current = this._userCenter;
    this._target = this._userCenter;
    return this._roundOutput ? Math.round(this._userCenter) : this._userCenter;
  }

  /* 250ms throttle + value-change dedup. Returns value to broadcast, or null. */
  shouldBroadcast(nowMs) {
    if (this._amount <= 0) return null;
    const val = this.current;
    if (nowMs - this._lastBroadcast > 250 && val !== this._lastBroadcastValue) {
      this._lastBroadcast = nowMs;
      this._lastBroadcastValue = val;
      return val;
    }
    return null;
  }
}

// Oscillator instances
const windOsc = new ParamOscillator({
  min: -100, max: 100, lerpRate: 1.5,
  minAmplitude: 20, maxAmplitude: 50, roundOutput: true
});
const intensityOsc = new ParamOscillator({
  min: 1, max: 100, lerpRate: 2.0,
  minAmplitude: 10, maxAmplitude: 40, roundOutput: true
});
const turbulenceOsc = new ParamOscillator({
  min: 0, max: 1, lerpRate: 0.8,
  minAmplitude: 0.1, maxAmplitude: 0.5, roundOutput: false,
  minChangesPerMin: 3, maxChangesPerMin: 8
});
// Splash scale linked to drop mass (default on, toggled by panel chain icon)
let splashLinked = true;

// Apply functions for each oscillator (called on each tick with the new value)
function applyWind(val) {
  config.wind = val;
  if (gridSimulation) gridSimulation.setWind(val);
  if (audioSystem) audioSystem.setWindSpeed(Math.abs(val));
}
function applyIntensity(val) {
  config.intensity = val;
  if (gridSimulation) gridSimulation.setIntensity(val / 100);
  if (matrixRenderer) matrixRenderer.setIntensity(val);
  if (textureIntensityLinked && audioSystem) {
    audioSystem.updateParam('texture.intensity', val);
  }
}
function applyTurbulence(val) {
  if (gridSimulation) gridSimulation.setTurbulence(val);
  if (matrixRenderer) matrixRenderer.setGlitchiness(val);
}
function applySheet(val) {
  if (!audioSystem) return;
  // SheetLayer bypasses rain bus compressor → directly to master limiter.
  // Range: -24 dB (1%) to 0 dB (100%), 50% = -12 dB
  const db = val <= 0 ? -Infinity : (val / 100 * 24) - 24;
  if (val <= 0) {
    audioSystem.getSheetLayer()?.stop();
  } else {
    audioSystem.updateParam('sheetLayer.maxVolume', db);
    if (!audioSystem.getSheetLayer()?.isPlaying && !matrixMode) {
      audioSystem.getSheetLayer()?.start();
    }
  }
}

// Sheet volume oscillator (oscillates the percentage, not dB)
const sheetOsc = new ParamOscillator({
  min: 0, max: 100, lerpRate: 0.6,
  minAmplitude: 2, maxAmplitude: 30, roundOutput: true,
  minChangesPerMin: 2, maxChangesPerMin: 6
});

// Thunder oscillators — very slow drift (storms evolve over minutes)
const thunderStorminessOsc = new ParamOscillator({
  min: 1, max: 100, lerpRate: 0.4,
  minAmplitude: 5, maxAmplitude: 25, roundOutput: true,
  minChangesPerMin: 1, maxChangesPerMin: 3
});
const thunderDistanceOsc = new ParamOscillator({
  min: 0.5, max: 15, lerpRate: 0.3,
  minAmplitude: 0.5, maxAmplitude: 3.0, roundOutput: false,
  minChangesPerMin: 0.5, maxChangesPerMin: 2
});

function applyThunderStorminess(val) {
  trackedThunderStorminess = val;
  if (audioSystem) audioSystem.updateParam('thunder.storminess', val);
}
function applyThunderDistance(val) {
  trackedThunderDistance = val;
  if (audioSystem) audioSystem.updateParam('thunder.distance', val);
}

// Oscillator registry: tick loop iterates this
const oscillators = [
  { osc: windOsc, apply: applyWind, param: 'physics.wind', disableInMatrix: true },
  { osc: intensityOsc, apply: applyIntensity, param: 'physics.intensity', disableInMatrix: false },
  { osc: turbulenceOsc, apply: applyTurbulence, param: 'physics.turbulence', disableInMatrix: false },
  { osc: sheetOsc, apply: applySheet, param: 'audio.sheetVolume', disableInMatrix: true },
  { osc: thunderStorminessOsc, apply: applyThunderStorminess, param: 'audio.thunder.storminess', disableInMatrix: true, gateOn: () => trackedThunderEnabled },
  { osc: thunderDistanceOsc, apply: applyThunderDistance, param: 'audio.thunder.distance', disableInMatrix: true, gateOn: () => trackedThunderEnabled },
];

// Window update state
let windowUpdateDebounceTimer = null;
let lastWindowData = null;
let lastWindowZonesForReinit = null;

/* Re-classify stored window data when a behavior toggle changes.
   Reclassifies from raw windowZones so toggle state affects void/normal split. */
function reprocessWindowState() {
  if (!virtualDesktop || !virtualDesktop.monitors) return;

  // Re-classify from raw window data (respects current toggle state)
  const voidWins = [];
  const normal = [];
  const spawn = [];
  const detectedFullscreenMonitors = new Set();
  const detectedMaximizedMonitors = new Set();

  if (windowZones && windowZones.length > 0) {
    for (const win of windowZones) {
      let classified = false;
      for (const mon of virtualDesktop.monitors) {
        const classification = classifyWindow(win, mon, virtualDesktop);
        if (classification === 'work-area') {
          detectedMaximizedMonitors.add(mon.index);
          if (!classified) {
            if (enableMaximizedDetection) voidWins.push(win);
            else normal.push(win);
            classified = true;
          }
        } else if (classification === 'full-resolution') {
          detectedFullscreenMonitors.add(mon.index);
          if (!classified) {
            if (enableFullscreenDetection) voidWins.push(win);
            else normal.push(win);
            classified = true;
          }
        } else if (classification === 'snapped') {
          if (!classified) {
            normal.push(win);
            spawn.push(win);
            classified = true;
          }
        }
      }
      if (!classified) normal.push(win);
    }
  }

  // Update cached classification
  lastWindowZonesForReinit = { normal, void: voidWins, spawn };

  // Apply collision zones
  if (gridSimulation) {
    if (enableWindowCollision) {
      gridSimulation.updateWindowZones(normal, voidWins, spawn);
    } else {
      gridSimulation.updateWindowZones([], [], []);
    }
    suppressFullscreenColumns();
    suppressMaximizedColumns();
  }

  if (matrixRenderer) {
    const originX = virtualDesktop.originX || 0;
    const originY = virtualDesktop.originY || 0;
    if (enableWindowCollision) {
      const allWindows = [...normal, ...voidWins];
      matrixRenderer.updateWindowZones(allWindows.map(w => ({
        left: w.x - originX,
        top: w.y - originY,
        right: w.x + w.width - originX,
        bottom: w.y + w.height - originY,
      })));
    } else {
      matrixRenderer.updateWindowZones([]);
    }
  }

  // Apply detection state (skip debounce for immediate response)
  if (enableFullscreenDetection) {
    for (const idx of detectedFullscreenMonitors) {
      if (!fullscreenMonitors.has(idx)) fullscreenMonitors.add(idx);
    }
    updateFullscreenState();
  }

  if (enableMaximizedDetection) {
    for (const idx of detectedMaximizedMonitors) {
      if (!maximizedMonitors.has(idx)) maximizedMonitors.add(idx);
    }
    updateMaximizedState();
  }

  // Re-evaluate muffling (independent of rain suppression)
  const anyMufflingEnabled = enableAudioMuffling || enableMaximizedMuffling;
  if (anyMufflingEnabled && audioSystem) {
    let coveredWidth = 0;
    const totalWidth = virtualDesktop.width;
    const muffledMonitorIndices = new Set();

    if (enableMaximizedMuffling) {
      for (const idx of detectedMaximizedMonitors) muffledMonitorIndices.add(idx);
    }
    if (enableAudioMuffling) {
      for (const idx of detectedFullscreenMonitors) muffledMonitorIndices.add(idx);
    }

    for (const mon of virtualDesktop.monitors) {
      if (muffledMonitorIndices.has(mon.index)) coveredWidth += mon.width;
    }

    const muffleAmount = totalWidth > 0 ? (coveredWidth / totalWidth) * 0.7 : 0;
    if (Math.abs(muffleAmount - lastMuffleAmount) > 0.01) {
      audioSystem.setMuffleAmount(muffleAmount);
      lastMuffleAmount = muffleAmount;
    }
  } else if (audioSystem && lastMuffleAmount !== 0) {
    audioSystem.setMuffleAmount(0);
    lastMuffleAmount = 0;
  }
}

/* Wait for Tauri API to be available */
function waitForTauriAPI() {
  return new Promise((resolve) => {
    if (window.rainydesk) return resolve();
    const check = setInterval(() => {
      if (window.rainydesk) {
        clearInterval(check);
        resolve();
      }
    }, 50);
  });
}

/* NOT A BUG, I PROMISE! CRUCIAL INIT FUNCTION! Don't touch this! */
function waitForFirstWindowData() {
  return new Promise((resolve) => {
    const listenerPromise = window.rainydesk.onWindowData((data) => {
      resolve(data);
      listenerPromise.then(unsub => unsub());
    });
  });
}

/* Classify a window based on its coverage of a monitor */
function classifyWindow(win, mon, desktop) {
  const winRelX = win.x - desktop.originX;
  const winRelY = win.y - desktop.originY;

  // Maximized windows (especially WPF/HwndWrapper apps like Affinity Photo)
  // may overshoot monitor edges by ~8px on each side. DWM extended frame
  // bounds don't always trim invisible borders for these windows.
  const tol = win.isMaximized ? 16 : 0;

  // Check work area match (exact for normal windows, fuzzy for maximized)
  const workAreaMatch = tol > 0
    ? Math.abs(win.width - mon.workWidth) <= tol &&
      Math.abs(win.height - mon.workHeight) <= tol &&
      Math.abs(winRelX - mon.workX) <= tol &&
      Math.abs(winRelY - mon.workY) <= tol
    : win.width === mon.workWidth &&
      win.height === mon.workHeight &&
      winRelX === mon.workX &&
      winRelY === mon.workY;

  if (workAreaMatch) return 'work-area';

  // Check full resolution match (exact for normal, fuzzy for maximized)
  const fullResMatch = tol > 0
    ? Math.abs(win.width - mon.width) <= tol &&
      Math.abs(win.height - mon.height) <= tol &&
      Math.abs(winRelX - mon.x) <= tol &&
      Math.abs(winRelY - mon.y) <= tol
    : win.width === mon.width &&
      win.height === mon.height &&
      winRelX === mon.x &&
      winRelY === mon.y;

  if (fullResMatch) return 'full-resolution';

  // Check snapped windows (Windows standard snap positions)
  const isHalfWidth = win.width === Math.floor(mon.workWidth / 2);
  const isHalfHeight = win.height === Math.floor(mon.workHeight / 2);
  const isFullWidth = win.width === mon.workWidth;
  const isFullHeight = win.height === mon.workHeight;

  const isHalfSnap = (isHalfWidth && isFullHeight) || (isFullWidth && isHalfHeight);
  const isQuarterSnap = isHalfWidth && isHalfHeight;

  if (isHalfSnap || isQuarterSnap) return 'snapped';

  return 'normal';
}

/* Called when fullscreenMonitors set changes. Updates derived state and notifies background. */
function updateFullscreenState() {
  if (!enableFullscreenDetection) {
    fullscreenMonitors.clear();
    allMonitorsFullscreen = false;
    if (audioSystem && lastMuffleAmount !== 0) {
      audioSystem.setMuffleAmount(0);
      lastMuffleAmount = 0;
    }
    if (window.rainydesk.emitFullscreenMonitors) {
      window.rainydesk.emitFullscreenMonitors([]);
    }
    return;
  }

  const monitorCount = virtualDesktop?.monitors?.length || 1;
  allMonitorsFullscreen = fullscreenMonitors.size >= monitorCount;

  suppressFullscreenColumns();

  // Prevent stale frozen drops left mid-flight when monitors entered fullscreen
  if (gridSimulation && fullscreenMonitors.size > 0) {
    gridSimulation.clearAllDrops();
  }

  if (window.rainydesk.emitFullscreenMonitors) {
    window.rainydesk.emitFullscreenMonitors(Array.from(fullscreenMonitors));
  }

  const fullscreenStr = `[${Array.from(fullscreenMonitors)}], all=${allMonitorsFullscreen}`;
  if (fullscreenStr !== lastLoggedFullscreen) {
    lastLoggedFullscreen = fullscreenStr;
    window.rainydesk.log(`[Fullscreen] Active monitors: ${fullscreenStr}`);
  }
}

/* Sets spawnMap columns within fullscreen monitor bounds to -1 (no spawn).
   Must run AFTER updateWindowZones since that restores spawnMap from originalSpawnMap. */
function suppressFullscreenColumns() {
  if (!enableFullscreenDetection) return;
  if (!gridSimulation || !virtualDesktop || fullscreenMonitors.size === 0) return;

  const scale = GRID_SCALE;
  for (const idx of fullscreenMonitors) {
    const mon = virtualDesktop.monitors.find(m => m.index === idx);
    if (!mon) continue;

    const startCol = Math.floor(mon.x * scale);
    const endCol = Math.ceil((mon.x + mon.width) * scale);
    gridSimulation.suppressSpawnColumns(startCol, endCol);
  }
}

/* Mirrors updateFullscreenState() for maximized windows */
function updateMaximizedState() {
  if (!enableMaximizedDetection) {
    maximizedMonitors.clear();
    allMonitorsMaximized = false;
    return;
  }

  const monitorCount = virtualDesktop?.monitors?.length || 1;
  allMonitorsMaximized = maximizedMonitors.size >= monitorCount;

  suppressMaximizedColumns();

  if (gridSimulation && maximizedMonitors.size > 0) {
    gridSimulation.clearAllDrops();
  }

  const maximizedStr = `[${Array.from(maximizedMonitors)}], all=${allMonitorsMaximized}`;
  if (maximizedStr !== lastLoggedMaximized) {
    lastLoggedMaximized = maximizedStr;
    window.rainydesk.log(`[Maximized] Active monitors: ${maximizedStr}`);
  }
}

/* Suppress spawn columns within maximized monitor bounds */
function suppressMaximizedColumns() {
  if (!enableMaximizedDetection) return;
  if (!gridSimulation || !virtualDesktop || maximizedMonitors.size === 0) return;

  const scale = GRID_SCALE;
  for (const idx of maximizedMonitors) {
    const mon = virtualDesktop.monitors.find(m => m.index === idx);
    if (!mon) continue;

    const startCol = Math.floor(mon.x * scale);
    const endCol = Math.ceil((mon.x + mon.width) * scale);
    gridSimulation.suppressSpawnColumns(startCol, endCol);
  }
}

/* Build void mask: 1 = gap between monitors, 0 = usable */
function buildVoidMask(desktop, scale) {
  const gridWidth = Math.ceil(desktop.width * scale);
  const gridHeight = Math.ceil(desktop.height * scale);

  const voidMask = new Uint8Array(gridWidth * gridHeight);
  voidMask.fill(1);

  for (const monitor of desktop.monitors) {
    const mx = Math.floor(monitor.x * scale);
    const my = Math.floor(monitor.y * scale);
    const mw = Math.ceil(monitor.width * scale);
    const mh = Math.ceil(monitor.height * scale);

    for (let y = my; y < my + mh && y < gridHeight; y++) {
      for (let x = mx; x < mx + mw && x < gridWidth; x++) {
        voidMask[y * gridWidth + x] = 0;
      }
    }
  }

  const voidCount = voidMask.reduce((sum, v) => sum + v, 0);
  window.rainydesk.log(`[VoidMask] Grid ${gridWidth}x${gridHeight}, void=${voidCount}, usable=${voidMask.length - voidCount}`);

  // Debug: Log each monitor's grid bounds
  for (const monitor of desktop.monitors) {
    const mx = Math.floor(monitor.x * scale);
    const my = Math.floor(monitor.y * scale);
    const mw = Math.ceil(monitor.width * scale);
    const mh = Math.ceil(monitor.height * scale);
    window.rainydesk.log(`[VoidMask] Monitor ${monitor.index}: grid x=${mx}-${mx+mw-1}, y=${my}-${my+mh-1}`);
  }

  // Debug: Check for void columns (entire column is void = gap between monitors)
  let voidColumnRanges = [];
  let inVoidRange = false;
  let rangeStart = 0;
  for (let x = 0; x < gridWidth; x++) {
    let columnIsVoid = true;
    for (let y = 0; y < gridHeight; y++) {
      if (voidMask[y * gridWidth + x] === 0) {
        columnIsVoid = false;
        break;
      }
    }
    if (columnIsVoid && !inVoidRange) {
      inVoidRange = true;
      rangeStart = x;
    } else if (!columnIsVoid && inVoidRange) {
      inVoidRange = false;
      voidColumnRanges.push(`${rangeStart}-${x-1}`);
    }
  }
  if (inVoidRange) {
    voidColumnRanges.push(`${rangeStart}-${gridWidth-1}`);
  }
  if (voidColumnRanges.length > 0) {
    window.rainydesk.log(`[VoidMask] WARNING: Void column ranges (gaps): ${voidColumnRanges.join(', ')}`);
  } else {
    window.rainydesk.log(`[VoidMask] No void columns - monitors are edge-to-edge horizontally`);
  }

  return voidMask;
}

/* Compute spawn map (per-column topmost non-void Y) */
function computeSpawnMap(voidMask, gridWidth, gridHeight) {
  const spawnMap = new Int16Array(gridWidth);
  spawnMap.fill(-1);

  for (let x = 0; x < gridWidth; x++) {
    for (let y = 0; y < gridHeight; y++) {
      if (voidMask[y * gridWidth + x] === 0) {
        spawnMap[x] = y;
        break;
      }
    }
  }

  return spawnMap;
}

/* Compute splash floor map (per-column bottom of work area) */
function computeFloorMap(desktop, scale, gridWidth, gridHeight) {
  const floorMap = new Int16Array(gridWidth);
  floorMap.fill(gridHeight);

  for (const monitor of desktop.monitors) {
    const mx = Math.floor(monitor.x * scale);
    const mw = Math.ceil(monitor.width * scale);
    const workBottom = Math.floor((monitor.workY + monitor.workHeight) * scale);

    for (let x = mx; x < mx + mw && x < gridWidth; x++) {
      floorMap[x] = Math.min(floorMap[x], workBottom);
    }
  }

  return floorMap;
}

/* Compute display floor map (per-column bottom of actual display) */
function computeDisplayFloorMap(desktop, scale, gridWidth, gridHeight) {
  const displayFloorMap = new Int16Array(gridWidth);
  displayFloorMap.fill(gridHeight);

  for (const monitor of desktop.monitors) {
    const mx = Math.floor(monitor.x * scale);
    const mw = Math.ceil(monitor.width * scale);
    const displayBottom = Math.floor((monitor.y + monitor.height) * scale);

    for (let x = mx; x < mx + mw && x < gridWidth; x++) {
      displayFloorMap[x] = Math.min(displayFloorMap[x], displayBottom);
    }
  }

  // Log each monitor's grid bounds
  const boundaries = [];
  for (const monitor of desktop.monitors) {
    const mx = Math.floor(monitor.x * scale);
    const mw = Math.ceil(monitor.width * scale);
    boundaries.push({ x: mx, label: `Monitor ${monitor.index} left` });
    boundaries.push({ x: mx + mw - 1, label: `Monitor ${monitor.index} right` });
  }
  boundaries.sort((a, b) => a.x - b.x);

  let floorDebug = '[DisplayFloor] Floor heights at boundaries: ';
  for (const b of boundaries) {
    if (b.x >= 0 && b.x < gridWidth) {
      floorDebug += `x=${b.x}(${b.label}):y=${displayFloorMap[b.x]}, `;
    }
  }
  window.rainydesk.log(floorDebug);

  return displayFloorMap;
}

function windowsChanged(oldWindows, newWindows) {
  if (!oldWindows || !newWindows) return true;
  if (oldWindows.length !== newWindows.length) return true;

  for (let i = 0; i < oldWindows.length; i++) {
    const a = oldWindows[i];
    const b = newWindows[i];
    if (!a || !b) return true;
    if (a.x !== b.x || a.y !== b.y ||
        a.width !== b.width || a.height !== b.height ||
        a.isMaximized !== b.isMaximized) {
      return true;
    }
  }

  return false;
}

/* Initialize audio system with gentle fade-in */
async function initAudio() {
  if (audioInitialized) return;

  try {
    const { AudioSystem } = await import('./audio.bundle.js');
    audioSystem = new AudioSystem({
      impactPoolSize: 12,
      bubblePoolSize: 12
    });
    await audioSystem.init();
    window.rainydesk.log('[Audio] Initialized');

    // Start with fade-in
    await audioSystem.start(true);
    window.rainydesk.log('[Audio] Started with fade-in');

    // Connect to Pixi physics for collision events
    if (gridSimulation) {
      gridSimulation.onCollision = (event) => {
        audioSystem.handleCollision(event);
      };
      window.rainydesk.log('[Audio] Connected to Pixi physics system');
    }

    audioInitialized = true;
  } catch (error) {
    window.rainydesk.log(`Audio init error: ${error.message}`);
    console.error('[Audio] Error:', error);
  }
}

/* Migrate old .rain format (no version field) to v2 structure */
function migrateToV2(data) {
  if (!data || data.version === 2) return data;
  window.rainydesk.log('[Migration] Converting old .rain format to v2');

  return {
    version: 2,
    name: data.name,
    rain: {
      intensity: data.rain?.intensity,
      wind: data.rain?.wind,
      gravity: data.physics?.gravity,
      reverseGravity: data.physics?.reverseGravity,
      turbulence: data.rain?.turbulence,
      splashScale: data.rain?.splashScale,
      splashLinked: data.rain?.splashLinked,
      puddleDrain: data.rain?.puddleDrain,
      dropSize: data.rain?.dropSize,
      color: data.visual?.rainColor,
      gayMode: data.visual?.gayMode,
      rainbowSpeed: data.visual?.rainbowSpeed,
      sheetVolume: data.rain?.sheetVolume,
      osc: {
        intensity: data.rain?.intensityOsc,
        wind: data.rain?.windOsc,
        turbulence: data.rain?.turbulenceOsc,
        sheet: data.rain?.sheetOsc,
      },
    },
    matrix: {
      density: data.visual?.matrixDensity,
      transpose: data.visual?.matrixTranspose,
      transMode: data.visual?.transMode,
      transScrollDirection: data.visual?.transScrollDirection,
    },
    audio: {
      muted: data.audio?.muted,
      rain: {
        masterVolume: data.audio?.masterVolume,
        rainIntensity: data.audio?.rainIntensity,
        impactPitch: data.audio?.impactPitch,
        impactPitchOsc: data.audio?.impactPitchOsc,
        windMasterGain: data.audio?.windMasterGain,
        thunderEnabled: data.audio?.thunderEnabled,
      },
      matrix: {
        bass: data.audio?.matrixBass,
        collision: data.audio?.matrixCollision,
        drone: data.audio?.matrixDrone,
      },
    },
    visual: {
      matrixMode: data.visual?.matrixMode,
      backgroundShaderEnabled: data.visual?.backgroundShaderEnabled ?? data.system?.backgroundShaderEnabled,
      backgroundIntensity: data.visual?.backgroundIntensity,
      backgroundLayers: data.visual?.backgroundLayers,
    },
    system: {
      fpsLimit: data.physics?.fpsLimit,
      gridScale: data.physics?.gridScale,
      renderScale: data.system?.renderScale,
      maximizedDetection: data.system?.maximizedDetection,
      maximizedMuffling: data.system?.maximizedMuffling,
      fullscreenDetection: data.system?.fullscreenDetection,
      audioMuffling: data.system?.audioMuffling,
      windowCollision: data.system?.windowCollision,
    },
  };
}

/* Gather current settings into a preset object for autosave (v2 format) */
function gatherPresetData() {
  return {
    version: 2,
    name: 'Autosave',
    rain: {
      intensity: intensityOsc.active ? intensityOsc.userCenter : config.intensity,
      wind: windOsc.userCenter,
      gravity: gridSimulation?.getGravity?.() ?? 980,
      reverseGravity: gridSimulation?.isReverseGravity?.() ?? false,
      turbulence: turbulenceOsc.userCenter,
      splashScale: gridSimulation?.getSplashScale?.() ?? 1.0,
      splashLinked,
      puddleDrain: gridSimulation?.getEvaporationRate?.() ?? 0.2,
      dropSize: { max: gridSimulation?.getDropMaxRadius?.() ?? 4 },
      color: pixiRenderer?.getRainColor?.() ?? '#4a9eff',
      gayMode: pixiRenderer?.isGayMode?.() ?? false,
      rainbowSpeed: trackedRainbowSpeed,
      sheetVolume: sheetOsc.userCenter,
      osc: {
        intensity: intensityOsc.amount,
        wind: windOsc.amount,
        turbulence: turbulenceOsc.amount,
        sheet: sheetOsc.amount,
      },
    },
    matrix: {
      density: matrixRenderer?.getDensity?.() ?? 20,
      transpose: glitchSynth?.getTranspose?.() ?? 0,
      transMode: matrixRenderer?.getTransMode?.() ?? false,
      transScrollDirection: matrixRenderer?.getTransScrollDirection?.() ?? 'off',
    },
    audio: {
      muted: audioSystem?.isMuted ?? false,
      rain: {
        masterVolume: audioSystem?.getMasterVolume?.() ?? -12,
        rainIntensity: trackedRainIntensity,
        impactPitch: audioSystem?.getImpactPool()?.getSynthConfig()?.pitchCenter ?? 50,
        impactPitchOsc: audioSystem?.getImpactPool()?.getSynthConfig()?.pitchOscAmount ?? 0,
        windMasterGain: trackedWindGainDb,
      },
      thunder: {
        enabled: trackedThunderEnabled,
        storminess: thunderStorminessOsc.active ? thunderStorminessOsc.userCenter : trackedThunderStorminess,
        distance: thunderDistanceOsc.active ? thunderDistanceOsc.userCenter : trackedThunderDistance,
        environment: trackedThunderEnvironment,
        osc: {
          storminess: thunderStorminessOsc.amount,
          distance: thunderDistanceOsc.amount,
        },
      },
      matrix: {
        bass: glitchSynth?.getBassVolume?.() ?? -12,
        collision: glitchSynth?.getCollisionVolume?.() ?? -24,
        drone: glitchSynth?.getDroneVolume?.() ?? -12,
      },
      texture: audioSystem?.getTextureLayer?.()?.getConfig?.() ?? {
        enabled: false, volume: 70, intensity: 50, intensityLinked: true, surface: 'generic',
      },
    },
    visual: {
      matrixMode: matrixMode,
      backgroundShaderEnabled: trackedBgEnabled,
      backgroundIntensity: trackedBgIntensity,
      backgroundLayers: trackedBgLayers,
    },
    system: {
      fpsLimit: config.fpsLimit,
      gridScale: GRID_SCALE,
      renderScale: renderScale,
      maximizedDetection: enableMaximizedDetection,
      maximizedMuffling: enableMaximizedMuffling,
      fullscreenDetection: enableFullscreenDetection,
      audioMuffling: enableAudioMuffling,
      windowCollision: enableWindowCollision,
    },
  };
}

/* Apply rainscape settings from autosave data (handles both v1 and v2 formats) */
function applyRainscapeData(rawData) {
  if (!rawData) return;
  const data = migrateToV2(rawData);
  window.rainydesk.log(`[Autosave] Applying v2 settings...`);

  // Rain settings
  if (data.rain) {
    if (data.rain.intensity !== undefined) {
      config.intensity = data.rain.intensity;
      intensityOsc.setUserCenter(data.rain.intensity);
      gridSimulation?.setIntensity(data.rain.intensity / 100);
      window.rainydesk.updateRainscapeParam('physics.intensity', data.rain.intensity);
    }
    if (data.rain.wind !== undefined) {
      config.wind = data.rain.wind;
      windOsc.setUserCenter(data.rain.wind);
      gridSimulation?.setWind(data.rain.wind);
      window.rainydesk.updateRainscapeParam('physics.wind', data.rain.wind);
    }
    if (data.rain.gravity !== undefined) {
      gridSimulation?.setGravity?.(data.rain.gravity);
      window.rainydesk.updateRainscapeParam('physics.gravity', data.rain.gravity);
    }
    if (data.rain.reverseGravity !== undefined) {
      gridSimulation?.setReverseGravity?.(Boolean(data.rain.reverseGravity));
      window.rainydesk.updateRainscapeParam('physics.reverseGravity', data.rain.reverseGravity);
    }
    if (data.rain.turbulence !== undefined) {
      gridSimulation?.setTurbulence?.(data.rain.turbulence);
      turbulenceOsc.setUserCenter(data.rain.turbulence);
      window.rainydesk.updateRainscapeParam('physics.turbulence', data.rain.turbulence);
    }
    // splashLinked: old files without it default to false (preserve independent behavior)
    if (data.rain.splashLinked !== undefined) {
      splashLinked = Boolean(data.rain.splashLinked);
    } else {
      splashLinked = false;
    }
    window.rainydesk.updateRainscapeParam('physics.splashLinked', splashLinked);

    if (splashLinked && data.rain.dropSize?.max !== undefined) {
      // Derive splash scale from drop mass when linked
      const derived = 0.5 + (data.rain.dropSize.max - 1) * (1.5 / 9);
      gridSimulation?.setSplashScale?.(derived);
      window.rainydesk.updateRainscapeParam('physics.splashScale', derived);
    } else if (data.rain.splashScale !== undefined) {
      gridSimulation?.setSplashScale?.(data.rain.splashScale);
      window.rainydesk.updateRainscapeParam('physics.splashScale', data.rain.splashScale);
    }
    if (data.rain.puddleDrain !== undefined) {
      gridSimulation?.setEvaporationRate?.(data.rain.puddleDrain);
      window.rainydesk.updateRainscapeParam('physics.puddleDrain', data.rain.puddleDrain);
    }
    if (data.rain.dropSize?.max !== undefined) {
      gridSimulation?.setDropMaxRadius?.(data.rain.dropSize.max);
      window.rainydesk.updateRainscapeParam('physics.dropMaxSize', data.rain.dropSize.max);
    }
    if (data.rain.color !== undefined) {
      pixiRenderer?.setRainColor?.(data.rain.color);
      window.rainydesk.updateRainscapeParam('visual.rainColor', data.rain.color);
    }
    if (data.rain.gayMode !== undefined) {
      pixiRenderer?.setGayMode?.(data.rain.gayMode);
      window.rainydesk.updateRainscapeParam('visual.gayMode', data.rain.gayMode);
    }
    if (data.rain.rainbowSpeed !== undefined) {
      window.rainydesk.updateRainscapeParam('visual.rainbowSpeed', data.rain.rainbowSpeed);
    }
    if (data.rain.sheetVolume !== undefined) {
      sheetOsc.setUserCenter(data.rain.sheetVolume);
      applySheet(data.rain.sheetVolume);
      window.rainydesk.updateRainscapeParam('audio.sheetVolume', data.rain.sheetVolume);
    }
    // Oscillator amounts (v2 nested under rain.osc)
    if (data.rain.osc) {
      if (data.rain.osc.intensity !== undefined) {
        intensityOsc.setAmount(data.rain.osc.intensity);
        window.rainydesk.updateRainscapeParam('physics.intensityOsc', data.rain.osc.intensity);
      }
      if (data.rain.osc.wind !== undefined) {
        windOsc.setAmount(data.rain.osc.wind);
        window.rainydesk.updateRainscapeParam('physics.windOsc', data.rain.osc.wind);
      }
      if (data.rain.osc.turbulence !== undefined) {
        turbulenceOsc.setAmount(data.rain.osc.turbulence);
        window.rainydesk.updateRainscapeParam('physics.turbulenceOsc', data.rain.osc.turbulence);
      }
      if (data.rain.osc.sheet !== undefined) {
        sheetOsc.setAmount(data.rain.osc.sheet);
        window.rainydesk.updateRainscapeParam('audio.sheetOsc', data.rain.osc.sheet);
      }
    }
  }

  // Matrix settings
  if (data.matrix) {
    if (data.matrix.density !== undefined) {
      window.rainydesk.updateRainscapeParam('visual.matrixDensity', data.matrix.density);
    }
    if (data.matrix.transpose !== undefined) {
      window.rainydesk.updateRainscapeParam('audio.matrix.transpose', data.matrix.transpose);
    }
    if (data.matrix.transMode !== undefined) {
      window.rainydesk.updateRainscapeParam('visual.transMode', data.matrix.transMode);
    }
    if (data.matrix.transScrollDirection !== undefined) {
      window.rainydesk.updateRainscapeParam('visual.transScrollDirection', data.matrix.transScrollDirection);
    }
  }

  // Audio settings (v2: split into audio.rain and audio.matrix)
  if (data.audio) {
    if (data.audio.muted !== undefined) {
      audioSystem?.setMuted?.(data.audio.muted);
      window.rainydesk.updateRainscapeParam('audio.muted', data.audio.muted);
    }
    if (data.audio.rain) {
      if (data.audio.rain.masterVolume !== undefined) {
        window.rainydesk.updateRainscapeParam('effects.masterVolume', data.audio.rain.masterVolume);
      }
      if (data.audio.rain.rainIntensity !== undefined) {
        trackedRainIntensity = data.audio.rain.rainIntensity;
        window.rainydesk.updateRainscapeParam('audio.rainIntensity', data.audio.rain.rainIntensity);
      }
      if (data.audio.rain.impactPitch !== undefined) {
        window.rainydesk.updateRainscapeParam('audio.impactPitch', data.audio.rain.impactPitch);
      }
      if (data.audio.rain.impactPitchOsc !== undefined) {
        window.rainydesk.updateRainscapeParam('audio.impactPitchOsc', data.audio.rain.impactPitchOsc);
      }
      if (data.audio.rain.windMasterGain !== undefined) {
        trackedWindGainDb = data.audio.rain.windMasterGain;
        window.rainydesk.updateRainscapeParam('audio.wind.masterGain', data.audio.rain.windMasterGain);
      }
      // Backward compat: old thunderEnabled boolean → storminess
      if (data.audio.rain.thunderEnabled !== undefined) {
        const enabled = Boolean(data.audio.rain.thunderEnabled);
        trackedThunderEnabled = enabled;
        trackedThunderStorminess = enabled ? 30 : 50;
        window.rainydesk.updateRainscapeParam('audio.thunder.enabled', enabled);
        window.rainydesk.updateRainscapeParam('audio.thunder.storminess', enabled ? 30 : 0);
      }
    }
    // Thunder settings (v2 format, sibling of audio.rain)
    if (data.audio.thunder) {
      // Enabled flag (backward compat: derive from storminess > 0)
      if (typeof data.audio.thunder.enabled === 'boolean') {
        trackedThunderEnabled = data.audio.thunder.enabled;
      } else if (data.audio.thunder.storminess !== undefined) {
        trackedThunderEnabled = data.audio.thunder.storminess > 0;
      }
      window.rainydesk.updateRainscapeParam('audio.thunder.enabled', trackedThunderEnabled);

      if (data.audio.thunder.storminess !== undefined) {
        trackedThunderStorminess = data.audio.thunder.storminess;
        thunderStorminessOsc.setUserCenter(data.audio.thunder.storminess);
        // Only send storminess to audio if enabled
        const storm = trackedThunderEnabled ? data.audio.thunder.storminess : 0;
        window.rainydesk.updateRainscapeParam('audio.thunder.storminess', storm);
      }
      if (data.audio.thunder.distance !== undefined) {
        trackedThunderDistance = data.audio.thunder.distance;
        thunderDistanceOsc.setUserCenter(data.audio.thunder.distance);
        window.rainydesk.updateRainscapeParam('audio.thunder.distance', data.audio.thunder.distance);
      }
      if (data.audio.thunder.environment !== undefined) {
        trackedThunderEnvironment = data.audio.thunder.environment;
        window.rainydesk.updateRainscapeParam('audio.thunder.environment', data.audio.thunder.environment);
      }
      // OSC amounts
      if (data.audio.thunder.osc) {
        if (data.audio.thunder.osc.storminess !== undefined) {
          thunderStorminessOsc.setAmount(data.audio.thunder.osc.storminess);
          window.rainydesk.updateRainscapeParam('audio.thunder.storminessOsc', data.audio.thunder.osc.storminess);
        }
        if (data.audio.thunder.osc.distance !== undefined) {
          thunderDistanceOsc.setAmount(data.audio.thunder.osc.distance);
          window.rainydesk.updateRainscapeParam('audio.thunder.distanceOsc', data.audio.thunder.osc.distance);
        }
      }
    }
    if (data.audio.matrix) {
      if (data.audio.matrix.bass !== undefined) {
        window.rainydesk.updateRainscapeParam('audio.matrix.bass', data.audio.matrix.bass);
      }
      if (data.audio.matrix.collision !== undefined) {
        window.rainydesk.updateRainscapeParam('audio.matrix.collision', data.audio.matrix.collision);
      }
      if (data.audio.matrix.drone !== undefined) {
        window.rainydesk.updateRainscapeParam('audio.drone.volume', data.audio.matrix.drone);
      }
    }
    // Texture layer settings
    if (data.audio.texture) {
      const tex = data.audio.texture;
      if (tex.intensityLinked !== undefined) {
        textureIntensityLinked = tex.intensityLinked;
        window.rainydesk.updateRainscapeParam('audio.texture.intensityLinked', tex.intensityLinked);
      }
      if (tex.surface !== undefined) {
        window.rainydesk.updateRainscapeParam('audio.texture.surface', tex.surface);
      }
      if (tex.volume !== undefined) {
        window.rainydesk.updateRainscapeParam('audio.texture.volume', tex.volume);
      }
      if (tex.intensity !== undefined) {
        window.rainydesk.updateRainscapeParam('audio.texture.intensity', tex.intensity);
      }
      if (tex.enabled !== undefined) {
        window.rainydesk.updateRainscapeParam('audio.texture.enabled', tex.enabled);
      }
    }
  }

  // Visual settings (v2: only background + mode toggle)
  if (data.visual) {
    if (data.visual.matrixMode !== undefined) {
      window.rainydesk.updateRainscapeParam('visual.matrixMode', data.visual.matrixMode);
    }
    if (data.visual.backgroundShaderEnabled !== undefined) {
      trackedBgEnabled = data.visual.backgroundShaderEnabled;
      window.rainydesk.updateRainscapeParam('backgroundRain.enabled', data.visual.backgroundShaderEnabled);
    }
    if (data.visual.backgroundIntensity !== undefined) {
      trackedBgIntensity = data.visual.backgroundIntensity;
      window.rainydesk.updateRainscapeParam('backgroundRain.intensity', data.visual.backgroundIntensity);
    }
    if (data.visual.backgroundLayers !== undefined) {
      trackedBgLayers = data.visual.backgroundLayers;
      window.rainydesk.updateRainscapeParam('backgroundRain.layers', data.visual.backgroundLayers);
    }
  }

  // System settings
  if (data.system) {
    if (typeof data.system.fpsLimit === 'number') {
      config.fpsLimit = data.system.fpsLimit;
      window.rainydesk.updateRainscapeParam('physics.fpsLimit', data.system.fpsLimit);
    }
    if (typeof data.system.maximizedDetection === 'boolean') {
      enableMaximizedDetection = data.system.maximizedDetection;
      window.rainydesk.updateRainscapeParam('system.maximizedDetection', data.system.maximizedDetection);
    }
    if (typeof data.system.maximizedMuffling === 'boolean') {
      enableMaximizedMuffling = data.system.maximizedMuffling;
      window.rainydesk.updateRainscapeParam('system.maximizedMuffling', data.system.maximizedMuffling);
    }
    if (typeof data.system.fullscreenDetection === 'boolean') {
      enableFullscreenDetection = data.system.fullscreenDetection;
      window.rainydesk.updateRainscapeParam('system.fullscreenDetection', data.system.fullscreenDetection);
    }
    if (typeof data.system.audioMuffling === 'boolean') {
      enableAudioMuffling = data.system.audioMuffling;
      window.rainydesk.updateRainscapeParam('system.audioMuffling', data.system.audioMuffling);
    }
    if (typeof data.system.windowCollision === 'boolean') {
      enableWindowCollision = data.system.windowCollision;
      window.rainydesk.updateRainscapeParam('system.windowCollision', data.system.windowCollision);
    }
    if (typeof data.system.renderScale === 'number') {
      renderScale = Math.max(0.125, Math.min(1.0, data.system.renderScale));
      window.rainydesk.updateRainscapeParam('physics.renderScale', renderScale);
    }
    if (typeof data.system.audioChannels === 'number') {
      if (audioSystem) audioSystem.setAudioTier(data.system.audioChannels);
      window.rainydesk.updateRainscapeParam('system.audioChannels', data.system.audioChannels);
    }
  }
}

/* Reinitialize physics system with new grid scale */
async function reinitializePhysics(newGridScale) {
  if (reinitInProgress) {
    window.rainydesk.log('[Reset] Already in progress');
    return;
  }

  reinitInProgress = true;
  window.rainydesk.emitReinitStatus?.('stopped');
  window.rainydesk.log(`[Reset] Starting full reset: grid ${GRID_SCALE} -> ${newGridScale}`);

  // Brief pause so "Stopped" state is visible in the panel
  await new Promise(r => setTimeout(r, 300));

  // Snapshot all state before destroying — applyRainscapeData restores everything after rebuild
  const preResetData = gatherPresetData();
  const wasMatrixMode = matrixMode;
  window.rainydesk.log(`[Reset] Snapshotting state, matrix=${wasMatrixMode}`);

  try {
    // Tear down
    if (windowUpdateDebounceTimer) {
      clearTimeout(windowUpdateDebounceTimer);
      windowUpdateDebounceTimer = null;
    }

    // Disconnect and destroy physics
    if (gridSimulation) {
      gridSimulation.onCollision = null;
      gridSimulation.onDebugLog = null;
      gridSimulation.dispose();
      gridSimulation = null;
    }
    if (pixiRenderer) {
      pixiRenderer.destroy();
      pixiRenderer = null;
    }
    globalGridBounds = null;

    // Destroy Matrix renderer but keep canvas in DOM for reuse after rebuild
    if (wasMatrixMode) {
      destroyMatrixRenderer(true);
    }

    // Dispose audio gracefully
    if (audioSystem) {
      audioSystem.dispose();
      audioSystem = null;
      audioInitialized = false;
    }

    window.rainydesk.emitReinitStatus?.('initializing');

    // Brief pause so "Initializing" state is visible in the panel
    await new Promise(r => setTimeout(r, 300));

    // Rebuild
    GRID_SCALE = newGridScale;
    await initPixiPhysics();

    // Reinit audio with fade-in
    await initAudio();

    // Reconnect collision handler
    if (audioSystem && gridSimulation) {
      gridSimulation.onCollision = (event) => audioSystem.handleCollision(event);
    }

    // Reapply window zones
    if (lastWindowZonesForReinit && gridSimulation) {
      gridSimulation.updateWindowZones(lastWindowZonesForReinit.normal, lastWindowZonesForReinit.void, lastWindowZonesForReinit.spawn);
    }

    // Restore everything from the pre-reset snapshot
    applyRainscapeData(preResetData);

    // Reinit Matrix mode if it was active
    if (wasMatrixMode) {
      matrixMode = false;
      await activateMode('matrix');
    }

    window.rainydesk.log('[Reset] State restored from snapshot');

    window.rainydesk.emitReinitStatus?.('raining');
    window.rainydesk.log('[Reset] Complete!');
  } catch (error) {
    window.rainydesk.log(`[Reset] FAILED: ${error.message}`);
    window.rainydesk.emitReinitStatus?.('raining');
  } finally {
    reinitInProgress = false;
  }
}

/* Resize canvas to match display */
function resizeCanvas() {
  const width = virtualDesktop?.width || window.innerWidth;
  const height = virtualDesktop?.height || window.innerHeight;

  canvasWidth = width;
  canvasHeight = height;

  canvas.width = width;
  canvas.height = height;

  // Keep persistent matrix canvas in sync even when hidden
  if (matrixCanvas) {
    matrixCanvas.width = width;
    matrixCanvas.height = height;
  }
  if (matrixRenderer) {
    matrixRenderer.resize(width, height);
  }

  window.rainydesk.log(`[Resize] Canvas: ${width}x${height}, display=${window.innerWidth}x${window.innerHeight}, dpr=${window.devicePixelRatio}`);
}

/* Update simulation */
function update(dt) {
  if (matrixMode && matrixRenderer) {
    // Matrix mode: update digital rain + arpeggio sequencer
    matrixRenderer.update(dt);
    if (glitchSynth) glitchSynth.update();
  } else if (gridSimulation) {
    // Normal mode: update rain physics
    gridSimulation.step(dt);
  }
}

/* Render simulation */
function render() {
  if (matrixMode && matrixRenderer) {
    // Matrix mode: render digital rain
    matrixRenderer.render();
  } else if (!reinitInProgress && pixiRenderer && gridSimulation) {
    // Normal mode: render rain physics
    pixiRenderer.render(gridSimulation);
  }
}

/* Main game loop with delta time and optional FPS limiting */
function gameLoop(currentTime) {
  // Schedule next frame FIRST — uncaught errors must never kill the loop
  requestAnimationFrame(gameLoop);

  // FPS limiting via ideal-time accumulation
  if (config.fpsLimit > 0) {
    const minFrameTime = 1000 / config.fpsLimit;
    const elapsed = currentTime - lastFrameTime;
    if (elapsed > 1000) {
      lastFrameTime = currentTime;
    } else if (elapsed < minFrameTime * 0.97) {
      return;
    } else {
      lastFrameTime += minFrameTime;
      if (currentTime - lastFrameTime > minFrameTime) {
        lastFrameTime = currentTime;
      }
    }
  }

  const dt = Math.min((currentTime - lastTime) / 1000, 0.1); // Cap at 100ms (10 FPS min)
  lastTime = currentTime;

  // Skip everything during reinit
  if (reinitInProgress) return;

  try {
    // Skip everything when ALL monitors are fullscreen
    if (allMonitorsFullscreen) {
      if (audioSystem) {
        audioSystem.setParticleCount(0);
      }
    } else if (isPaused) {
      // Paused: freeze physics but keep rendering (Quicksilver mode)
      render();
      if (audioSystem) {
        audioSystem.setParticleCount(0);
      }
    } else {
      // Normal operation: update physics and render
      update(dt);
      render();

      // Parameter oscillation (all OSC knobs)
      const nowSec = currentTime / 1000;
      for (const entry of oscillators) {
        if (!entry.osc.active) continue;
        if (entry.disableInMatrix && matrixMode) continue;
        if (entry.gateOn && !entry.gateOn()) continue;
        const val = entry.osc.tick(dt, nowSec);
        if (val !== null) entry.apply(val);
        const broadcast = entry.osc.shouldBroadcast(currentTime);
        if (broadcast !== null) {
          window.rainydesk.updateRainscapeParam(entry.param, broadcast);
        }
      }

      // Feed particle count to audio system (Skip in Matrix Mode, no wind)
      if (audioSystem && gridSimulation && !matrixMode) {
        const particleCount = gridSimulation.getActiveDropCount();
        audioSystem.setParticleCount(particleCount);
      }
    }
  } catch (err) {
    // Log but never let simulation errors kill the loop
    window.rainydesk?.log?.(`[GameLoop] Error in update/render: ${err?.message || err}`);
  }

  // FPS monitoring (every 5 seconds)
  fpsCounter++;
  if (currentTime - fpsTime > 5000) {
    const fps = Math.round(fpsCounter / 5);
    const particles = gridSimulation ? gridSimulation.getActiveDropCount() : 0;
    const statusFlags = [
      fullscreenMonitors.size > 0 ? `FS:${fullscreenMonitors.size}/${virtualDesktop?.monitors?.length || '?'}` : null,
      allMonitorsFullscreen ? 'ALL-FS' : null,
      isPaused ? 'PAUSED' : null
    ].filter(Boolean).join(', ');
    window.rainydesk.log(`FPS: ${fps}, Particles: ${particles}, Windows: ${windowZoneCount}${statusFlags ? ', ' + statusFlags : ''}`);
    fpsCounter = 0;
    fpsTime = currentTime;
  }

  // Debug stats update logic
  if (currentTime - debugStatsTime > 500) {
    if (gridSimulation) {
      const stats = gridSimulation.getStats();
      const fps = fpsCounter > 0 ? Math.round(fpsCounter / ((currentTime - fpsTime) / 1000)) : 0;
      const statsPayload = {
        fps,
        waterCount: stats.waterCount,
        activeDrops: stats.activeDrops,
        puddleCells: stats.puddleCells,
      };
      if (window._updateDebugStats) {
        window._updateDebugStats(statsPayload);
      }
      if (window.rainydesk?.emitStats) {
        window.rainydesk.emitStats(statsPayload);
      }
    }
    debugStatsTime = currentTime;
  }
}

/* Register all event listeners */
function registerEventListeners() {
  window.rainydesk.onToggleRain((enabled) => {
    config.enabled = enabled;
    if (audioSystem) {
      if (enabled) {
        audioSystem.start();
      } else {
        audioSystem.stop();
      }
    }
  });

  window.rainydesk.onToggleAudio((enabled) => {
    if (audioSystem) {
      if (enabled) {
        audioSystem.start();
        window.rainydesk.log('Audio resumed');
      } else {
        audioSystem.stop();
        window.rainydesk.log('Audio paused');
      }
    }
  });

  window.rainydesk.onSetVolume((value) => {
    config.volume = value;
    if (audioInitialized && audioSystem) {
      const db = value <= 0 ? -Infinity : (value / 100 * 60) - 60;
      audioSystem.setMasterVolume(db);
    }
    window.rainydesk.log(`Volume set to ${value}%`);
  });

  window.rainydesk.onLoadRainscape(async (filename) => {
    try {
      const data = await window.rainydesk.readRainscape(filename);
      if (rainscaper && data) {
        rainscaper.applyRainscape(data);
        window.rainydesk.log(`Loaded rainscape: ${filename}`);
      }
    } catch (err) {
      window.rainydesk.log(`Failed to load rainscape ${filename}: ${err}`);
    }
  });

  // Window data handler
  let windowDataLogged = false;
  window.rainydesk.onWindowData((data) => {
    // Window detector sends physical pixel coordinates — convert to logical
    // using the primary monitor's scale factor (no-op at 100% / scale=1)
    const dpiScale = virtualDesktop?.primaryScaleFactor || window.devicePixelRatio || 1;

    // Filter out RainyDesk and DevTools windows
    const newWindowZones = data.windows
      .filter(w => !w.title || !w.title.startsWith('RainyDesk'))
      .filter(w => !w.title || !w.title.includes('DevTools'))
      .map(w => ({
        x: w.bounds.x / dpiScale,
        y: w.bounds.y / dpiScale,
        width: w.bounds.width / dpiScale,
        height: w.bounds.height / dpiScale,
        title: w.title,
        isMaximized: w.isMaximized || false
      }));

    // Skip update if windows haven't changed
    if (!windowsChanged(lastWindowData, newWindowZones)) {
      return;
    }

    windowZones = newWindowZones;
    lastWindowData = [...windowZones];

    // Debounce expensive operations
    if (windowUpdateDebounceTimer) clearTimeout(windowUpdateDebounceTimer);
    const capturedZones = [...windowZones];
    windowUpdateDebounceTimer = setTimeout(() => {
      // Log detected windows once per session, dump on zone count change
      if (!windowDataLogged) {
        windowDataLogged = true;
        window.rainydesk.log(`[WindowDebug] Detected ${windowZones.length} windows`);
      }

      if (windowZones.length !== windowZoneCount) {
        window.rainydesk.log(`[WindowDebug] Zone count: ${windowZoneCount} -> ${windowZones.length}`);
        windowZoneCount = windowZones.length;
        for (const win of windowZones) {
          window.rainydesk.log(`[WindowDebug]   "${win.title}" at (${win.x},${win.y}) ${win.width}x${win.height}${win.isMaximized ? ' [MAX]' : ''}`);
        }
      }

      // Classify windows
      // Detection toggles affect classification: when detection is OFF
      // (Rain Over X is ON), those windows become normal collision surfaces
      const voidWindows = [];
      const normalWindows = [];
      const spawnBlockWindows = [];
      const detectedFullscreenMonitors = new Set();
      const detectedMaximizedMonitors = new Set();

      if (virtualDesktop && virtualDesktop.monitors) {
        for (const win of windowZones) {
          let classified = false;

          for (const mon of virtualDesktop.monitors) {
            const classification = classifyWindow(win, mon, virtualDesktop);

            if (classification === 'work-area') {
              detectedMaximizedMonitors.add(mon.index);
              if (!classified) {
                // Void only when detection active; normal collision otherwise
                if (enableMaximizedDetection) {
                  voidWindows.push(win);
                } else {
                  normalWindows.push(win);
                }
                classified = true;
              }
            } else if (classification === 'full-resolution') {
              detectedFullscreenMonitors.add(mon.index);
              if (!classified) {
                if (enableFullscreenDetection) {
                  voidWindows.push(win);
                } else {
                  normalWindows.push(win);
                }
                classified = true;
              }
            } else if (classification === 'snapped') {
              if (!classified) {
                normalWindows.push(win);
                spawnBlockWindows.push(win);
                classified = true;
              }
            }
          }

          if (!classified) {
            normalWindows.push(win);
          }
        }

        // Fullscreen debounce (quick enter, slow exit with hysteresis)
        if (enableFullscreenDetection && virtualDesktop && virtualDesktop.monitors) {
          const now = Date.now();

          for (const mon of virtualDesktop.monitors) {
            const idx = mon.index;
            if (detectedFullscreenMonitors.has(idx)) {
              lastFullscreenSeenTime.set(idx, now);

              if (fullscreenExitTimers.has(idx)) {
                clearTimeout(fullscreenExitTimers.get(idx));
                fullscreenExitTimers.delete(idx);
              }

              if (!fullscreenMonitors.has(idx) && !fullscreenEnterTimers.has(idx)) {
                fullscreenEnterTimers.set(idx, setTimeout(() => {
                  fullscreenEnterTimers.delete(idx);
                  if (!fullscreenMonitors.has(idx)) {
                    fullscreenMonitors.add(idx);
                    window.rainydesk.log(`[Fullscreen] Monitor ${idx} entered fullscreen`);
                    updateFullscreenState();
                  }
                }, 200));
              }
            } else {
              if (fullscreenEnterTimers.has(idx)) {
                clearTimeout(fullscreenEnterTimers.get(idx));
                fullscreenEnterTimers.delete(idx);
              }

              if (fullscreenMonitors.has(idx) && !fullscreenExitTimers.has(idx)) {
                fullscreenExitTimers.set(idx, setTimeout(() => {
                  fullscreenExitTimers.delete(idx);
                  // Only exit if no fullscreen seen recently (hysteresis check)
                  const lastSeen = lastFullscreenSeenTime.get(idx) || 0;
                  if (Date.now() - lastSeen >= 1400) {
                    fullscreenMonitors.delete(idx);
                    window.rainydesk.log(`[Fullscreen] Monitor ${idx} exited fullscreen`);
                    updateFullscreenState();
                  }
                }, 1500));
              }
            }
          }
        }

        // Maximized debounce (mirrors fullscreen pattern)
        if (enableMaximizedDetection && virtualDesktop && virtualDesktop.monitors) {
          const now2 = Date.now();

          for (const mon of virtualDesktop.monitors) {
            const idx = mon.index;
            if (detectedMaximizedMonitors.has(idx)) {
              lastMaximizedSeenTime.set(idx, now2);

              if (maximizedExitTimers.has(idx)) {
                clearTimeout(maximizedExitTimers.get(idx));
                maximizedExitTimers.delete(idx);
              }

              if (!maximizedMonitors.has(idx) && !maximizedEnterTimers.has(idx)) {
                maximizedEnterTimers.set(idx, setTimeout(() => {
                  maximizedEnterTimers.delete(idx);
                  if (!maximizedMonitors.has(idx)) {
                    maximizedMonitors.add(idx);
                    window.rainydesk.log(`[Maximized] Monitor ${idx} entered maximized`);
                    updateMaximizedState();
                  }
                }, 200));
              }
            } else {
              if (maximizedEnterTimers.has(idx)) {
                clearTimeout(maximizedEnterTimers.get(idx));
                maximizedEnterTimers.delete(idx);
              }

              if (maximizedMonitors.has(idx) && !maximizedExitTimers.has(idx)) {
                maximizedExitTimers.set(idx, setTimeout(() => {
                  maximizedExitTimers.delete(idx);
                  const lastSeen = lastMaximizedSeenTime.get(idx) || 0;
                  if (Date.now() - lastSeen >= 1400) {
                    maximizedMonitors.delete(idx);
                    window.rainydesk.log(`[Maximized] Monitor ${idx} exited maximized`);
                    updateMaximizedState();
                  }
                }, 1500));
              }
            }
          }
        }
      }

      // Audio muffling (independent of rain suppression)
      const anyMufflingEnabled = enableAudioMuffling || enableMaximizedMuffling;

      if (anyMufflingEnabled && audioSystem && virtualDesktop && virtualDesktop.monitors) {
        let coveredWidth = 0;
        const totalWidth = virtualDesktop.width;

        const muffledMonitorIndices = new Set();

        if (enableMaximizedMuffling) {
          for (const idx of detectedMaximizedMonitors) {
            muffledMonitorIndices.add(idx);
          }
        }

        if (enableAudioMuffling) {
          for (const idx of detectedFullscreenMonitors) {
            muffledMonitorIndices.add(idx);
          }
        }

        for (const mon of virtualDesktop.monitors) {
          if (muffledMonitorIndices.has(mon.index)) {
            coveredWidth += mon.width;
          }
        }

        const coverageRatio = totalWidth > 0 ? coveredWidth / totalWidth : 0;
        const muffleAmount = coverageRatio * 0.7;
        if (Math.abs(muffleAmount - lastMuffleAmount) > 0.01) {
          audioSystem.setMuffleAmount(muffleAmount);
          lastMuffleAmount = muffleAmount;
        }
      } else if (audioSystem && lastMuffleAmount !== 0) {
        audioSystem.setMuffleAmount(0);
        lastMuffleAmount = 0;
      }

      // Store window zones for reinit
      lastWindowZonesForReinit = {
        normal: normalWindows,
        void: voidWindows,
        spawn: spawnBlockWindows
      };

      // Update physics with classified windows
      if (gridSimulation) {
        if (enableWindowCollision) {
          gridSimulation.updateWindowZones(normalWindows, voidWindows, spawnBlockWindows);
        } else {
          gridSimulation.updateWindowZones([], [], []);
        }
        suppressFullscreenColumns();
      }

      // Update Matrix renderer window zones (adjust for VD origin)
      // Include ALL windows (normal + void + spawnBlock) for collision detection
      if (matrixRenderer && virtualDesktop) {
        const originX = virtualDesktop.originX || 0;
        const originY = virtualDesktop.originY || 0;
        if (enableWindowCollision) {
          // Combine all window types - Matrix streams should collide with everything
          const allWindows = [...normalWindows, ...voidWindows];
          matrixRenderer.updateWindowZones(allWindows.map(w => ({
            left: w.x - originX,
            top: w.y - originY,
            right: w.x + w.width - originX,
            bottom: w.y + w.height - originY,
          })));
        } else {
          matrixRenderer.updateWindowZones([]);
        }

        // Compute blanked regions: monitors covered by maximized or fullscreen windows
        // Tracks which monitor indices have work-area or full-resolution windows
        const blankedMonitorIndices = new Set();
        for (const win of windowZones) {
          for (const mon of virtualDesktop.monitors) {
            const classification = classifyWindow(win, mon, virtualDesktop);
            if (classification === 'work-area' || classification === 'full-resolution') {
              blankedMonitorIndices.add(mon.index);
            }
          }
        }

        // Convert blanked monitor indices to pixel X ranges (relative to VD origin)
        const blankedRegions = [];
        for (const mon of virtualDesktop.monitors) {
          if (blankedMonitorIndices.has(mon.index)) {
            blankedRegions.push({
              left: mon.x,
              right: mon.x + mon.width,
            });
          }
        }
        matrixRenderer.setBlankedRegions(blankedRegions);
      }
    }, 32);
  });

  // Parameter sync
  window.rainydesk.onUpdateRainscapeParam((path, value) => {
    if (path.startsWith('physics.')) {
      const param = path.split('.')[1];

      if (param === 'gravity') {
        if (gridSimulation) {
          gridSimulation.setGravity(value);
        }
        // Matrix: gravity → fall speed
        if (matrixRenderer) {
          matrixRenderer.setFallSpeed(value);
        }
      }
      if (param === 'wind') {
        // When OSC is active, it drives wind directly -- skip IPC echo
        if (windOsc.active) return;
        config.wind = value;
        windOsc.setUserCenter(value);
        if (gridSimulation) {
          gridSimulation.setWind(value);
        }
        // Note: Matrix Mode ignores wind (straight down only per spec)
      }
      if (param === 'intensity') {
        intensityOsc.setUserCenter(value);
        config.intensity = value;
        if (textureIntensityLinked && audioSystem) {
          audioSystem.updateParam('texture.intensity', Number(value));
        }
        if (intensityOsc.active) return;
        if (gridSimulation) {
          gridSimulation.setIntensity(value / 100);
        }
        if (matrixRenderer) {
          matrixRenderer.setIntensity(value);
        }
      }
      // New physics params
      if (param === 'splashScale') {
        if (gridSimulation) {
          gridSimulation.setSplashScale(value);
        }
        // Note: Matrix Mode ignores splash (no water physics)
      }
      if (param === 'turbulence') {
        turbulenceOsc.setUserCenter(value);
        if (turbulenceOsc.active) return;
        if (gridSimulation) {
          gridSimulation.setTurbulence(value);
        }
        // Matrix: turbulence → glitchiness
        if (matrixRenderer) {
          matrixRenderer.setGlitchiness(value);
        }
      }
      if (param === 'puddleDrain' && gridSimulation) {
        gridSimulation.setEvaporationRate(value);
        // Note: Matrix Mode ignores puddles
      }
      if (param === 'dropMaxSize') {
        if (gridSimulation) {
          gridSimulation.setDropMaxRadius(value);
        }
        // Matrix: drop size → string/tail length
        if (matrixRenderer) {
          matrixRenderer.setStringLength(value);
        }
        // When linked, derive splash scale from drop mass
        if (splashLinked && gridSimulation) {
          const derived = 0.5 + (value - 1) * (1.5 / 9);
          gridSimulation.setSplashScale(derived);
        }
      }
      if (param === 'splashLinked') {
        splashLinked = Boolean(value);
        // When linking on, derive splash from current drop mass
        if (splashLinked && gridSimulation) {
          const dropMax = gridSimulation.getDropMaxRadius?.() ?? 4;
          const derived = 0.5 + (dropMax - 1) * (1.5 / 9);
          gridSimulation.setSplashScale(derived);
          window.rainydesk.updateRainscapeParam('physics.splashScale', derived);
        }
      }
      if (param === 'reverseGravity') {
        if (gridSimulation) {
          gridSimulation.setReverseGravity(Boolean(value));
        }
        // Matrix: reverse gravity → streams rise from bottom
        if (matrixRenderer) {
          matrixRenderer.setReverseGravity(Boolean(value));
        }
      }
      if (param === 'resetSimulation') {
        // Accept either a number (backward compat) or { gridScale, renderScale } object
        if (typeof value === 'object' && value !== null) {
          const newGridScale = Math.max(0.0625, Math.min(0.5, value.gridScale ?? GRID_SCALE));
          if (typeof value.renderScale === 'number') {
            renderScale = Math.max(0.125, Math.min(1.0, value.renderScale));
          }
          reinitializePhysics(newGridScale);
        } else {
          const newScale = Math.max(0.0625, Math.min(0.5, value));
          reinitializePhysics(newScale);
        }
      }
      if (param === 'fpsLimit') {
        config.fpsLimit = Number(value);
        lastFrameTime = 0; // Reset so next frame renders immediately
      }
      if (param === 'renderScale') {
        // Update local tracking variable only — background renderer has its own
        // handler for this path via the same Rust broadcast, so no forwarding needed
        renderScale = Math.max(0.125, Math.min(1.0, Number(value)));
      }
      if (param === 'windOsc') {
        windOsc.setAmount(Number(value));
        if (!windOsc.active) {
          const center = windOsc.snapToCenter();
          config.wind = center;
          if (gridSimulation) gridSimulation.setWind(center);
          if (audioSystem) audioSystem.setWindSpeed(Math.abs(center));
        }
      }
      if (param === 'intensityOsc') {
        intensityOsc.setAmount(Number(value));
        if (!intensityOsc.active) {
          const center = intensityOsc.snapToCenter();
          config.intensity = center;
          if (gridSimulation) gridSimulation.setIntensity(center / 100);
          if (matrixRenderer) matrixRenderer.setIntensity(center);
        }
      }
      if (param === 'turbulenceOsc') {
        turbulenceOsc.setAmount(Number(value));
        if (!turbulenceOsc.active) {
          const center = turbulenceOsc.snapToCenter();
          if (gridSimulation) gridSimulation.setTurbulence(center);
          if (matrixRenderer) matrixRenderer.setGlitchiness(center);
        }
      }
    } else if (path === 'audio.muted') {
      if (audioSystem) {
        audioSystem.setMuted(Boolean(value));
      }
    } else if (path === 'audio.rainMix' || path === 'audio.rainIntensity') {
      trackedRainIntensity = Number(value);
      if (audioSystem) {
        audioSystem.setRainMix(value);
      }
    } else if (path === 'effects.masterVolume') {
      // Master volume (dB)
      if (audioSystem) {
        audioSystem.setMasterVolume(value);
      }
    } else if (path === 'audio.bubble.gain') {
      // Bubble/plink sound volume (dB)
      if (audioSystem) {
        audioSystem.updateParam('bubble.gain', value);
      }
    } else if (path === 'audio.sheetVolume') {
      // Rain sheet noise volume (percentage) — skip when OSC is driving
      if (sheetOsc.active) return;
      sheetOsc.setUserCenter(Number(value));
      applySheet(Number(value));
    } else if (path === 'audio.sheetOsc') {
      // Rain sheet OSC knob amount
      sheetOsc.setAmount(Number(value));
      if (!sheetOsc.active) {
        const center = sheetOsc.snapToCenter();
        applySheet(center);
      }
    } else if (path === 'audio.impactPitch') {
      // Impact filter center frequency (0-100)
      if (audioSystem) {
        audioSystem.setImpactPitch(Number(value));
      }
    } else if (path === 'audio.impactPitchOsc') {
      // Impact per-drop pitch randomization amount (0-100)
      if (audioSystem) {
        audioSystem.setImpactPitchOsc(Number(value));
      }
    } else if (path === 'audio.wind.masterGain') {
      // Wind sound volume (dB)
      trackedWindGainDb = Number(value);
      if (audioSystem) {
        audioSystem.updateParam('wind.masterGain', value);
      }
    } else if (path === 'audio.thunder.enabled') {
      trackedThunderEnabled = Boolean(value);
      if (audioSystem) {
        if (trackedThunderEnabled) {
          // Restore storminess
          const storm = Math.max(1, trackedThunderStorminess);
          audioSystem.updateParam('thunder.storminess', storm);
        } else {
          audioSystem.updateParam('thunder.storminess', 0);
        }
      }
    } else if (path === 'audio.thunder.storminess') {
      trackedThunderStorminess = Number(value);
      thunderStorminessOsc.setUserCenter(Number(value));
      if (thunderStorminessOsc.active) return;
      if (audioSystem) {
        audioSystem.updateParam('thunder.storminess', value);
      }
    } else if (path === 'audio.thunder.storminessOsc') {
      thunderStorminessOsc.setAmount(Number(value));
      if (!thunderStorminessOsc.active) {
        const center = thunderStorminessOsc.snapToCenter();
        trackedThunderStorminess = center;
        if (audioSystem) audioSystem.updateParam('thunder.storminess', center);
      }
    } else if (path === 'audio.thunder.distance') {
      trackedThunderDistance = Number(value);
      thunderDistanceOsc.setUserCenter(Number(value));
      if (thunderDistanceOsc.active) return;
      if (audioSystem) {
        audioSystem.updateParam('thunder.distance', value);
      }
    } else if (path === 'audio.thunder.distanceOsc') {
      thunderDistanceOsc.setAmount(Number(value));
      if (!thunderDistanceOsc.active) {
        const center = thunderDistanceOsc.snapToCenter();
        trackedThunderDistance = center;
        if (audioSystem) audioSystem.updateParam('thunder.distance', center);
      }
    } else if (path === 'audio.thunder.environment') {
      trackedThunderEnvironment = String(value);
      if (audioSystem) {
        audioSystem.updateParam('thunder.environment', value);
      }
    } else if (path === 'audio.thunder.testStrike') {
      if (audioSystem) audioSystem.triggerThunderStrike();
    } else if (path === 'audio.drone.volume') {
      // Matrix Mode drone volume (dB)
      if (glitchSynth) {
        glitchSynth.setDroneVolume(value);
      } else {
        pendingMatrixParams['drone.volume'] = value;
      }
    } else if (path === 'audio.matrix.bass') {
      // Matrix Mode bass synth volume (dB)
      if (glitchSynth) {
        glitchSynth.setBassVolume(value);
      } else {
        pendingMatrixParams['bass'] = value;
      }
    } else if (path === 'audio.matrix.collision') {
      // Matrix Mode collision sound volume (dB)
      if (glitchSynth) {
        glitchSynth.setCollisionVolume(value);
      } else {
        pendingMatrixParams['collision'] = value;
      }
    } else if (path === 'audio.matrix.strings') {
      // Matrix Mode string lead volume (dB)
      if (glitchSynth) {
        glitchSynth.setStringVolume(value);
      } else {
        pendingMatrixParams['strings'] = value;
      }
    } else if (path === 'audio.matrix.transpose') {
      // Matrix Mode key transpose (semitones)
      if (glitchSynth) {
        glitchSynth.setTranspose(value);
      } else {
        pendingMatrixParams['transpose'] = value;
      }
    } else if (path === 'audio.texture.enabled') {
      if (audioSystem) audioSystem.updateParam('texture.enabled', value);
    } else if (path === 'audio.texture.volume') {
      if (audioSystem) audioSystem.updateParam('texture.volume', value);
    } else if (path === 'audio.texture.intensity') {
      // Manual intensity change (only when NOT linked)
      if (audioSystem) audioSystem.updateParam('texture.intensity', value);
    } else if (path === 'audio.texture.intensityLinked') {
      textureIntensityLinked = Boolean(value);
      if (audioSystem) {
        audioSystem.updateParam('texture.intensityLinked', value);
        if (textureIntensityLinked) {
          audioSystem.updateParam('texture.intensity', config.intensity);
        }
      }
    } else if (path === 'audio.texture.surface') {
      if (audioSystem) audioSystem.updateParam('texture.surface', value);
    } else if (path === 'visual.rainColor') {
      const color = String(value);
      // Each mode has its own default — only sync custom colors to both renderers.
      // Matrix green (#008F11) stays on Matrix; rain blue (#8aa8c0) stays on rain.
      const isRainDefault = color === '#8aa8c0';
      const isMatrixDefault = color === '#008F11';
      if (pixiRenderer && !isMatrixDefault) {
        pixiRenderer.setRainColor(value);
      }
      if (matrixRenderer && !isRainDefault) {
        matrixRenderer.setRainColor(color);
      }
    } else if (path === 'visual.rainbowMode' || path === 'visual.gayMode') {
      if (pixiRenderer) {
        pixiRenderer.setGayMode(Boolean(value));
      }
      if (matrixRenderer) {
        matrixRenderer.setGaytrixMode(Boolean(value));
      }
    } else if (path === 'visual.rainbowSpeed') {
      const speed = Number(value) || 1;
      trackedRainbowSpeed = speed;
      if (pixiRenderer) pixiRenderer.setRainbowSpeed(speed);
    } else if (path === 'visual.matrixMode') {
      activateMode(Boolean(value) ? 'matrix' : 'rain');
    } else if (path === 'system.paused') {
      isPaused = Boolean(value);
      window.rainydesk.log(`[Pause] ${isPaused ? 'PAUSED' : 'RESUMED'} via Rainscaper panel`);
      if (audioSystem) {
        if (isPaused) {
          audioSystem.stop();
        } else {
          // Resume with short 0.5s fade (not full 5s startup fade)
          audioSystem.start(true, true);
        }
      }
    } else if (path === 'system.maximizedDetection') {
      enableMaximizedDetection = Boolean(value);
      // Clear stale debounce timers so they don't corrupt new state
      for (const id of maximizedEnterTimers.values()) clearTimeout(id);
      for (const id of maximizedExitTimers.values()) clearTimeout(id);
      maximizedEnterTimers.clear();
      maximizedExitTimers.clear();
      if (!enableMaximizedDetection) updateMaximizedState();
      reprocessWindowState();
    } else if (path === 'system.maximizedMuffling') {
      enableMaximizedMuffling = Boolean(value);
      reprocessWindowState();
    } else if (path === 'system.fullscreenDetection') {
      enableFullscreenDetection = Boolean(value);
      for (const id of fullscreenEnterTimers.values()) clearTimeout(id);
      for (const id of fullscreenExitTimers.values()) clearTimeout(id);
      fullscreenEnterTimers.clear();
      fullscreenExitTimers.clear();
      if (!enableFullscreenDetection) updateFullscreenState();
      reprocessWindowState();
    } else if (path === 'system.audioMuffling') {
      enableAudioMuffling = Boolean(value);
      if (!enableAudioMuffling && audioSystem && lastMuffleAmount !== 0) {
        audioSystem.setMuffleAmount(0);
        lastMuffleAmount = 0;
      } else {
        reprocessWindowState();
      }
    } else if (path === 'system.windowCollision') {
      enableWindowCollision = Boolean(value);
      reprocessWindowState();
    } else if (path === 'system.renderScale') {
      renderScale = Math.max(0.125, Math.min(1.0, Number(value)));
    } else if (path === 'system.audioChannels') {
      if (audioSystem) audioSystem.setAudioTier(Number(value));
    } else if (path === 'visual.matrixDensity') {
      // Data Stream Density (column spacing in px, Matrix Mode only)
      if (matrixRenderer) {
        matrixRenderer.setDensity(Number(value));
      }
    } else if (path === 'visual.transMode') {
      // Trans Mode easter egg (Matrix renderer only)
      if (matrixRenderer) {
        matrixRenderer.setTransMode(Boolean(value));
      }
    } else if (path === 'visual.transScrollDirection') {
      // Trans gradient scroll direction
      if (matrixRenderer) {
        matrixRenderer.setTransScrollDirection(String(value));
      }
    } else if (path === 'backgroundRain.enabled') {
      trackedBgEnabled = Boolean(value);
    } else if (path === 'backgroundRain.intensity') {
      trackedBgIntensity = Number(value);
    } else if (path === 'backgroundRain.layers') {
      trackedBgLayers = Number(value);
    } else if (audioSystem) {
      audioSystem.updateParam(path, value);
    }
  });

  // Rainscaper window is now separate - toggle handled by Rust backend
  // Keeping listener for backwards compatibility during transition
  window.rainydesk.onToggleRainscaper(() => {
    // No-op: Rainscaper is now a separate window managed by Rust
    window.rainydesk.log('[Overlay] toggle-rainscaper event received (deprecated)');
  });

  window.addEventListener('resize', resizeCanvas);
}

/* Initialize Pixi hybrid physics system */
async function initPixiPhysics() {
  window.rainydesk.log('[Pixi] Initializing hybrid physics...');

  const { GridSimulation, RainPixiRenderer } = await import('./simulation.bundle.js');

  const scale = GRID_SCALE;
  const logicWidth = Math.ceil(virtualDesktop.width * scale);
  const logicHeight = Math.ceil(virtualDesktop.height * scale);

  // Build void mask, spawn map, floor maps (yield between heavy ops to avoid UI freeze)
  const voidMask = buildVoidMask(virtualDesktop, scale);
  await new Promise(r => setTimeout(r, 0));

  const spawnMap = computeSpawnMap(voidMask, logicWidth, logicHeight);
  const floorMap = computeFloorMap(virtualDesktop, scale, logicWidth, logicHeight);
  const displayFloorMap = computeDisplayFloorMap(virtualDesktop, scale, logicWidth, logicHeight);
  await new Promise(r => setTimeout(r, 0));

  globalGridBounds = {
    minX: virtualDesktop.originX,
    minY: virtualDesktop.originY,
    width: virtualDesktop.width,
    height: virtualDesktop.height,
    logicWidth,
    logicHeight
  };

  window.rainydesk.log(`[Pixi] Virtual desktop: ${virtualDesktop.width}x${virtualDesktop.height} at (${virtualDesktop.originX}, ${virtualDesktop.originY}), ${virtualDesktop.monitors.length} monitors`);
  window.rainydesk.log(`[Pixi] Global grid: ${logicWidth}x${logicHeight} logic`);

  // Initialize GridSimulation
  gridSimulation = new GridSimulation(
    logicWidth,
    logicHeight,
    virtualDesktop.originX,
    virtualDesktop.originY,
    {},
    voidMask,
    spawnMap,
    floorMap,
    displayFloorMap,
    scale // Pass grid scale for coordinate conversion
  );
  await new Promise(r => setTimeout(r, 0));

  gridSimulation.onDebugLog = (msg) => window.rainydesk.log(msg);
  gridSimulation.setIntensity(config.intensity / 100);
  gridSimulation.setWind(config.wind);

  // Initialize oscillator user centers from config/defaults
  windOsc.setUserCenter(config.wind);
  intensityOsc.setUserCenter(config.intensity);
  turbulenceOsc.setUserCenter(0.3);  // GridSimulation default
  sheetOsc.setUserCenter(35);        // 35% default sheet volume
  thunderStorminessOsc.setUserCenter(trackedThunderStorminess);
  thunderDistanceOsc.setUserCenter(trackedThunderDistance);

  // Initialize Pixi renderer
  pixiRenderer = new RainPixiRenderer({
    canvas: canvas,
    width: canvasWidth,
    height: canvasHeight,
    localOffsetX: 0,
    localOffsetY: 0,
    backgroundColor: 0x000000,
    preferWebGPU: true,
    gridScale: scale,
    renderScale: renderScale
  });

  await pixiRenderer.init();
  window.rainydesk.log('[Pixi] Renderer initialized');
  window.rainydesk.log('[Pixi] Hybrid physics ready!');
}

/* Initialize Matrix Mode renderer (visual only — GlitchSynth created separately) */
async function initMatrixRenderer(gen) {
  if (matrixRenderer || !matrixCanvas) return;

  const { MatrixPixiRenderer } = await import('./simulation.bundle.js');
  if (gen !== matrixInitGeneration) return;

  matrixRenderer = new MatrixPixiRenderer({
    canvas: matrixCanvas,
    width: virtualDesktop?.width || window.innerWidth,
    height: virtualDesktop?.height || window.innerHeight,
    collisionEnabled: true,
  });
  await matrixRenderer.init();
  if (gen !== matrixInitGeneration) {
    matrixRenderer?.destroy();
    matrixRenderer = null;
    return;
  }

  const originX = virtualDesktop?.originX || 0;
  const originY = virtualDesktop?.originY || 0;

  // Window zones from classified data
  if (lastWindowZonesForReinit) {
    const allWindows = [
      ...(lastWindowZonesForReinit.normal || []),
      ...(lastWindowZonesForReinit.void || []),
    ];
    const zones = allWindows.map(w => ({
      left: w.x - originX,
      top: w.y - originY,
      right: w.x + w.width - originX,
      bottom: w.y + w.height - originY,
    }));
    matrixRenderer.updateWindowZones(zones);
    window.rainydesk.log(`[Matrix] Loaded ${zones.length} window zones (origin offset: ${originX}, ${originY})`);
  } else if (lastWindowData?.length) {
    const zones = lastWindowData.map(w => ({
      left: w.x - originX,
      top: w.y - originY,
      right: w.x + w.width - originX,
      bottom: w.y + w.height - originY,
    }));
    matrixRenderer.updateWindowZones(zones);
    window.rainydesk.log(`[Matrix] Loaded ${zones.length} window zones from raw data (origin offset: ${originX}, ${originY})`);
  } else {
    window.rainydesk.log('[Matrix] WARNING: No window data available for collision detection');
  }

  // Blanked regions (monitors covered by maximized/fullscreen windows)
  if (virtualDesktop?.monitors && lastWindowData?.length) {
    const blankedMonitorIndices = new Set();
    for (const win of lastWindowData) {
      for (const mon of virtualDesktop.monitors) {
        const classification = classifyWindow(win, mon, virtualDesktop);
        if (classification === 'work-area' || classification === 'full-resolution') {
          blankedMonitorIndices.add(mon.index);
        }
      }
    }
    const blankedRegions = [];
    for (const mon of virtualDesktop.monitors) {
      if (blankedMonitorIndices.has(mon.index)) {
        blankedRegions.push({ left: mon.x, right: mon.x + mon.width });
      }
    }
    if (blankedRegions.length > 0) {
      matrixRenderer.setBlankedRegions(blankedRegions);
      window.rainydesk.log(`[Matrix] Initial blanked regions: ${blankedRegions.map(r => `${r.left}-${r.right}`).join(', ')}`);
    }
  }

  // Floor at taskbar position (minimum work area bottom across monitors)
  if (virtualDesktop?.monitors?.length) {
    let minWorkBottom = Infinity;
    for (const mon of virtualDesktop.monitors) {
      const workBottom = mon.workY + mon.workHeight;
      if (workBottom < minWorkBottom) {
        minWorkBottom = workBottom;
      }
    }
    if (minWorkBottom < Infinity) {
      matrixRenderer.setFloorY(minWorkBottom - originY);
      window.rainydesk.log(`[Matrix] Floor set to Y=${minWorkBottom - originY} (work area bottom)`);
    }
  }

  // Sync visual state from rain simulation
  matrixRenderer.setGaytrixMode(pixiRenderer?.isGayMode?.() ?? false);
  matrixRenderer.setReverseGravity(gridSimulation?.isReverseGravity?.() ?? false);

  window.rainydesk.log('[Matrix] Renderer initialized');
}

/* Create GlitchSynth and wire collision handler (recreated on each activation) */
async function initGlitchSynth(gen) {
  if (glitchSynth || !matrixRenderer) return;

  const { GlitchSynth } = await import('./audio.bundle.js');
  if (gen !== matrixInitGeneration) return;

  glitchSynth = new GlitchSynth();

  if (audioSystem) {
    const masterInput = audioSystem.getMasterInput();
    if (masterInput) {
      glitchSynth.connectOutput(masterInput);
      window.rainydesk.log('[Matrix] GlitchSynth routed through AudioSystem master chain');
    }
  }

  // Apply queued params that arrived before glitchSynth existed
  if (pendingMatrixParams['transpose'] !== undefined) {
    glitchSynth.setTranspose(pendingMatrixParams['transpose']);
    window.rainydesk.log(`[Matrix] Applied pending transpose: ${pendingMatrixParams['transpose']}`);
  }
  if (pendingMatrixParams['bass'] !== undefined) {
    glitchSynth.setBassVolume(pendingMatrixParams['bass']);
  }
  if (pendingMatrixParams['collision'] !== undefined) {
    glitchSynth.setCollisionVolume(pendingMatrixParams['collision']);
  }
  if (pendingMatrixParams['drone.volume'] !== undefined) {
    glitchSynth.setDroneVolume(pendingMatrixParams['drone.volume']);
  }
  if (pendingMatrixParams['strings'] !== undefined) {
    glitchSynth.setStringVolume(pendingMatrixParams['strings']);
  }
  pendingMatrixParams = {};

  matrixRenderer.onCollision = (x, y) => {
    const result = glitchSynth?.trigger() || { onBeat: false };
    if (result.onBeat) {
      window.rainydesk.log(`[Matrix] ON-BEAT collision at (${Math.round(x)}, ${Math.round(y)})`);
    }
    return result;
  };

  // Drone audio file path differs between dev and production builds
  try {
    await glitchSynth.startDrone('./sounds/SawLoopG.ogg', 5);
    if (gen !== matrixInitGeneration) {
      glitchSynth?.dispose();
      glitchSynth = null;
      return;
    }
    window.rainydesk.log('[Matrix] Drone audio started');
  } catch (err) {
    window.rainydesk.log(`[Matrix] Drone audio failed: ${err}`);
  }
}

/* Destroy Matrix Mode renderer (keepCanvas=true retains the DOM canvas for Reset) */
function destroyMatrixRenderer(keepCanvas = false) {
  if (matrixRenderer) {
    matrixRenderer.destroy();
    matrixRenderer = null;
  }
  if (glitchSynth) {
    glitchSynth.dispose();
    glitchSynth = null;
  }
  if (!keepCanvas && matrixCanvas) {
    matrixCanvas.remove();
    matrixCanvas = null;
  }
  window.rainydesk.log(`[Matrix] Renderer destroyed (keepCanvas=${keepCanvas})`);
}

/* Central mode switch — lazy-init on first use, toggle via opacity */
async function activateMode(newMode) {
  const enteringMatrix = newMode === 'matrix';
  if (enteringMatrix === matrixMode) return;

  matrixMode = enteringMatrix;

  if (enteringMatrix) {
    window.rainydesk.log('[Matrix] Switching to Matrix Mode...');

    // Hide rain canvas + stop Pixi from painting stale sprites
    canvas.style.opacity = '0';
    if (pixiRenderer?.app?.stage) pixiRenderer.app.stage.visible = false;

    // Audio: switch to Matrix layers
    if (audioSystem) {
      audioSystem.setMatrixMode(true);
      audioSystem.getWindModule()?.stop();
      audioSystem.getSheetLayer()?.stop();
      audioSystem.getThunderModule()?.stopAuto();
      audioSystem.setParticleCount(0);
      window.rainydesk.log('[Matrix] Stopped wind/sheet/thunder audio for Matrix Mode');
    }

    // Lazy-init matrix canvas (created once, reused across toggles)
    if (!matrixCanvas) {
      matrixCanvas = document.createElement('canvas');
      matrixCanvas.id = 'matrix-canvas';
      matrixCanvas.style.cssText = canvas.style.cssText;
      matrixCanvas.style.visibility = 'visible';
      matrixCanvas.style.opacity = '0'; // Start hidden, reveal below
      matrixCanvas.style.transition = 'none';
      matrixCanvas.width = canvas.width;
      matrixCanvas.height = canvas.height;
      document.body.appendChild(matrixCanvas);
    }

    // Lazy-init matrix renderer (created once, reused across toggles)
    const gen = ++matrixInitGeneration;
    if (!matrixRenderer) {
      try {
        await initMatrixRenderer(gen);
      } catch (err) {
        if (gen !== matrixInitGeneration) return;
        window.rainydesk.log(`[Matrix] Init failed, rolling back: ${err}`);
        matrixMode = false;
        destroyMatrixRenderer();
        if (pixiRenderer?.app?.stage) pixiRenderer.app.stage.visible = true;
        if (audioSystem) {
          audioSystem.setMatrixMode(false);
          audioSystem.getWindModule()?.start();
          audioSystem.getSheetLayer()?.start();
          if (trackedThunderStorminess > 0) audioSystem.getThunderModule()?.startAuto();
        }
        return;
      }
    }

    // GlitchSynth is disposed on each deactivation, so always re-create
    await initGlitchSynth(gen);
    if (gen !== matrixInitGeneration) return;

    // Guard: init may have failed or been superseded
    if (!matrixMode || gen !== matrixInitGeneration) return;
    if (matrixCanvas) matrixCanvas.style.opacity = '1';
  } else {
    window.rainydesk.log('[Matrix] Switching back to Rain Mode...');

    // Cancel any in-flight async Matrix init
    matrixInitGeneration++;

    if (matrixCanvas) matrixCanvas.style.opacity = '0';

    if (glitchSynth) {
      glitchSynth.dispose();
      glitchSynth = null;
    }

    // Show rain canvas + sprites again
    canvas.style.opacity = '1';
    if (pixiRenderer?.app?.stage) pixiRenderer.app.stage.visible = true;

    // Restore wind, sheet, and thunder audio
    if (audioSystem) {
      audioSystem.setMatrixMode(false);
      audioSystem.getWindModule()?.start();
      audioSystem.getSheetLayer()?.start();
      if (trackedThunderStorminess > 0) {
        audioSystem.getThunderModule()?.startAuto();
      }
      window.rainydesk.log('[Matrix] Restored wind/sheet/thunder audio for Rain Mode');
    }
  }
}

/* Periodically save state to Autosave.rain */
function startAutosave() {
  setInterval(async () => {
    if (audioInitialized) {
      const data = gatherPresetData();
      await window.rainydesk.autosaveRainscape(data);
    }
  }, 30000);
}

/* Main initialization */
async function init() {
  // PHASE 2: Wait for Tauri API
  await waitForTauriAPI();
  window.rainydesk.log('Initializing RainyDesk renderer...');

  // PHASE 3: Get display info and calculate (includes phantom DPI detection)
  const dpiResult = await window.rainydesk.detectPhantomDPI();
  virtualDesktop = dpiResult.virtualDesktop || await window.rainydesk.getVirtualDesktop();
  resizeCanvas();

  // PHASE 4: Init simulation (Pixi only)
  await initPixiPhysics();

  // PHASE 5: Register event listeners
  registerEventListeners();

  // Broadcast initial physics values to background windows
  window.rainydesk.updateRainscapeParam('physics.intensity', config.intensity);
  window.rainydesk.updateRainscapeParam('physics.wind', config.wind || 0);
  window.rainydesk.updateRainscapeParam('physics.renderScale', renderScale);
  window.rainydesk.updateRainscapeParam('backgroundRain.enabled', true);
  window.rainydesk.log(`[Init] Broadcast initial values: intensity=${config.intensity}, wind=${config.wind}, renderScale=${renderScale}`);

  // Load autosave config (new format: Autosave.rain with rain.* keys)
  try {
    pendingAutosave = await window.rainydesk.readRainscape('Autosave.rain');
    if (pendingAutosave) {
      pendingAutosave = migrateToV2(pendingAutosave);
      window.rainydesk.log('Loading autosaved rainscape settings');
      if (pendingAutosave.rain?.intensity !== undefined) {
        config.intensity = pendingAutosave.rain.intensity;
      }
      if (pendingAutosave.rain?.wind !== undefined) {
        config.wind = pendingAutosave.rain.wind;
      }
    }
  } catch (err) {
    window.rainydesk.log(`Autosave load failed: ${err.message}`);
  }

  const initialConfig = await window.rainydesk.getConfig();
  config.enabled = initialConfig.rainEnabled;
  config.intensity = initialConfig.intensity;
  config.volume = initialConfig.volume;

  // Update simulation with loaded config
  if (gridSimulation) {
    gridSimulation.setIntensity(config.intensity / 100);
    gridSimulation.setWind(config.wind);
  }

  startAutosave();

  // Enable click-through
  window.rainydesk.setIgnoreMouseEvents(true, { forward: true });

  // PHASE 7: Wait for first window data
  window.rainydesk.log('[Init] Waiting for first window data...');
  await waitForFirstWindowData();
  window.rainydesk.log('[Init] First window data received');

  // PHASE 8: Start game loop (still hidden)
  requestAnimationFrame(gameLoop);
  window.rainydesk.log('[Init] Game loop started (hidden)');

  // PHASE 9: Start audio and fade-in (no cross-window coordination needed)
  window.rainydesk.log('[Init] Starting audio and fade-in...');

  // Start audio with fade-in
  await initAudio();
  window.rainydesk.log('[Init] Audio init complete');

  // Start visual fade FIRST (before applying rainscape which may fail)
  setTimeout(() => {
    window.rainydesk.log('[FadeIn] Starting overlay fade-in');
    canvas.style.visibility = 'visible';
    canvas.style.opacity = '1';

    // Mark init time so hot-reloads don't flash (localStorage survives WebView recreation)
    localStorage.setItem('__RAINYDESK_OVERLAY_INIT_TIME__', Date.now().toString());

    // Clean up transition after it completes
    setTimeout(() => {
      canvas.style.transition = 'none';
    }, 5000);
  }, 300);

  // Apply pending autosave after fade-in is scheduled
  if (pendingAutosave) {
    try {
      applyRainscapeData(pendingAutosave);
      window.rainydesk.log('[Init] Applied autosave settings');
    } catch (err) {
      window.rainydesk.log(`[Init] Failed to apply autosave: ${err.message}`);
    }
  }

  // Start heartbeat for crash detection watchdog
  setInterval(() => window.rainydesk.heartbeat().catch(() => {}), 5000);

  window.rainydesk.log('[Init] Initialization complete');
}

// INIT GUARD - prevents re-initialization on script re-execution
if (window.__RAINYDESK_OVERLAY_INITIALIZED__) {
  window.rainydesk?.log?.('[Overlay] Already initialized, skipping re-init');
} else {
  window.__RAINYDESK_OVERLAY_INITIALIZED__ = true;

  // Single entry point
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}
