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
  chunky: 0.125
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

// Fullscreen detection
let isFullscreenActive = false;
let fullscreenDebounceTimer = null;
let pendingFullscreenState = false;

// Pause state (from Rainscaper panel)
let isPaused = false;

// Wind oscillation (gusts) state
let windOscAmount = 0;     // 0-100 from knob
let windOscTarget = 0;     // Target wind value to lerp toward
let windOscCurrent = 0;    // Current interpolated wind value
let windOscNextChangeTime = 0; // When to pick a new target
let windOscUserCenter = 0; // User's manual wind slider value (center point)
let windOscLastBroadcast = 0; // Throttle param broadcasts (ms timestamp)
let windOscLastBroadcastValue = 0; // Last broadcasted wind value

// Window update state
let windowUpdateDebounceTimer = null;
let lastWindowData = null;
let lastWindowZonesForReinit = null;

/**
 * Wait for Tauri API to be available
 */
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

/**
 * Wait for first window data to be received
 */
function waitForFirstWindowData() {
  return new Promise((resolve) => {
    const unsubscribe = window.rainydesk.onWindowData((data) => {
      unsubscribe();
      resolve(data);
    });
  });
}

/**
 * Classify a window based on its coverage of a monitor.
 */
function classifyWindow(win, mon, desktop) {
  const winRelX = win.x - desktop.originX;
  const winRelY = win.y - desktop.originY;

  // Check work area match (exact)
  const workAreaMatch =
    win.width === mon.workWidth &&
    win.height === mon.workHeight &&
    winRelX === mon.workX &&
    winRelY === mon.workY;

  if (workAreaMatch) return 'work-area';

  // Check full resolution match (exact)
  const fullResMatch =
    win.width === mon.width &&
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

/**
 * Build void mask from virtual desktop monitor regions.
 * Void mask: 1 = void (gap between monitors), 0 = usable
 */
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
    window.rainydesk.log(`[VoidMask] Monitor "${monitor.name}": grid x=${mx}-${mx+mw-1}, y=${my}-${my+mh-1}`);
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

/**
 * Compute spawn map (per-column topmost non-void Y).
 */
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

/**
 * Compute splash floor map (per-column bottom of work area).
 */
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

/**
 * Compute display floor map (per-column bottom of actual display).
 */
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

  // Debug: Log floor heights at monitor boundaries to show "ledges"
  const boundaries = [];
  for (const monitor of desktop.monitors) {
    const mx = Math.floor(monitor.x * scale);
    const mw = Math.ceil(monitor.width * scale);
    boundaries.push({ x: mx, label: `${monitor.name} left` });
    boundaries.push({ x: mx + mw - 1, label: `${monitor.name} right` });
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

/**
 * Compare two window arrays to detect changes.
 */
function windowsChanged(oldWindows, newWindows) {
  if (!oldWindows || !newWindows) return true;
  if (oldWindows.length !== newWindows.length) return true;

  for (let i = 0; i < oldWindows.length; i++) {
    const a = oldWindows[i];
    const b = newWindows[i];
    if (!a || !b) return true;
    if (a.x !== b.x || a.y !== b.y ||
        a.width !== b.width || a.height !== b.height ||
        a.title !== b.title) {
      return true;
    }
  }

  return false;
}

/**
 * Initialize audio system with gentle fade-in
 */
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

/**
 * Gather current settings into a preset object (for autosave)
 */
function gatherPresetData() {
  return {
    name: 'Autosave',
    rain: {
      intensity: config.intensity,
      wind: windOscUserCenter, // Save the user's manual center, not oscillated value
      windOsc: windOscAmount,
    },
    physics: {
      gravity: gridSimulation?.getGravity?.() ?? 980,
      gridScale: GRID_SCALE,
      reverseGravity: gridSimulation?.isReverseGravity?.() ?? false,
      fpsLimit: config.fpsLimit,
    },
    audio: {
      muted: audioSystem?.isMuted ?? false,
      masterVolume: audioSystem?.getMasterVolume?.() ?? -12,
      matrixBass: glitchSynth?.getBassVolume?.() ?? -12,
      matrixCollision: glitchSynth?.getCollisionVolume?.() ?? -24,
      matrixDrone: glitchSynth?.getDroneVolume?.() ?? -12,
    },
    visual: {
      gayMode: pixiRenderer?.isGayMode?.() ?? false,
      rainColor: pixiRenderer?.getRainColor?.() ?? '#4a9eff',
      matrixMode: matrixMode,
      matrixDensity: matrixRenderer?.getDensity?.() ?? 20,
      matrixTranspose: glitchSynth?.getTranspose?.() ?? 0,
      transMode: matrixRenderer?.getTransMode?.() ?? false,
      transScrollDirection: matrixRenderer?.getTransScrollDirection?.() ?? 'off',
    },
  };
}

/**
 * Apply rainscape settings from autosave data
 */
function applyRainscapeData(data) {
  if (!data) return;
  window.rainydesk.log(`[Autosave] Applying settings...`);

  // Rain settings
  if (data.rain) {
    if (data.rain.intensity !== undefined) {
      config.intensity = data.rain.intensity;
      gridSimulation?.setIntensity(data.rain.intensity / 100);
      window.rainydesk.updateRainscapeParam('physics.intensity', data.rain.intensity);
    }
    if (data.rain.wind !== undefined) {
      config.wind = data.rain.wind;
      gridSimulation?.setWind(data.rain.wind);
      window.rainydesk.updateRainscapeParam('physics.wind', data.rain.wind);
    }
  }

  // Physics settings
  if (data.physics) {
    if (data.physics.gravity !== undefined) {
      gridSimulation?.setGravity?.(data.physics.gravity);
      window.rainydesk.updateRainscapeParam('physics.gravity', data.physics.gravity);
    }
    if (data.physics.reverseGravity !== undefined) {
      gridSimulation?.setReverseGravity?.(Boolean(data.physics.reverseGravity));
      window.rainydesk.updateRainscapeParam('physics.reverseGravity', data.physics.reverseGravity);
    }
    // Grid scale requires full reinit, skip on startup
  }

  // Audio settings
  if (data.audio) {
    if (data.audio.muted !== undefined) {
      audioSystem?.setMuted?.(data.audio.muted);
      window.rainydesk.updateRainscapeParam('audio.muted', data.audio.muted);
    }
    // Matrix synth volumes (dB values — applied to glitchSynth or queued as pending)
    if (data.audio.matrixBass !== undefined) {
      window.rainydesk.updateRainscapeParam('audio.matrix.bass', data.audio.matrixBass);
    }
    if (data.audio.matrixCollision !== undefined) {
      window.rainydesk.updateRainscapeParam('audio.matrix.collision', data.audio.matrixCollision);
    }
    if (data.audio.matrixDrone !== undefined) {
      window.rainydesk.updateRainscapeParam('audio.drone.volume', data.audio.matrixDrone);
    }
    if (data.audio.masterVolume !== undefined) {
      window.rainydesk.updateRainscapeParam('effects.masterVolume', data.audio.masterVolume);
    }
  }

  // Visual settings
  if (data.visual) {
    if (data.visual.gayMode !== undefined) {
      pixiRenderer?.setGayMode?.(data.visual.gayMode);
      window.rainydesk.updateRainscapeParam('visual.gayMode', data.visual.gayMode);
    }
    if (data.visual.rainColor !== undefined) {
      pixiRenderer?.setRainColor?.(data.visual.rainColor);
      window.rainydesk.updateRainscapeParam('visual.rainColor', data.visual.rainColor);
    }
    if (data.visual.matrixDensity !== undefined) {
      window.rainydesk.updateRainscapeParam('visual.matrixDensity', data.visual.matrixDensity);
    }
    if (data.visual.matrixTranspose !== undefined) {
      window.rainydesk.updateRainscapeParam('audio.matrix.transpose', data.visual.matrixTranspose);
    }
    if (data.visual.transMode !== undefined) {
      window.rainydesk.updateRainscapeParam('visual.transMode', data.visual.transMode);
    }
    if (data.visual.transScrollDirection !== undefined) {
      window.rainydesk.updateRainscapeParam('visual.transScrollDirection', data.visual.transScrollDirection);
    }
    if (data.visual.matrixMode !== undefined) {
      // Trigger via param update path to handle full init/destroy cycle
      window.rainydesk.updateRainscapeParam('visual.matrixMode', data.visual.matrixMode);
    }
  }

  // Physics extras
  if (data.physics) {
    if (data.physics.fpsLimit !== undefined) {
      config.fpsLimit = data.physics.fpsLimit;
      window.rainydesk.updateRainscapeParam('physics.fpsLimit', data.physics.fpsLimit);
    }
  }

  // Rain extras (wind OSC)
  if (data.rain) {
    if (data.rain.windOsc !== undefined) {
      windOscAmount = data.rain.windOsc;
      window.rainydesk.updateRainscapeParam('physics.windOsc', data.rain.windOsc);
    }
  }
}

/**
 * Reinitialize physics system with new grid scale
 */
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

  // --- Preserve all state before destroying ---
  let preservedSettings = null;
  if (gridSimulation) {
    preservedSettings = {
      gravity: gridSimulation.getGravity?.() ?? 980,
      radiusMax: gridSimulation.getDropMaxRadius?.() ?? 2.0,
      reverseGravity: gridSimulation.isReverseGravity?.() ?? false,
      wind: config.wind,
      intensity: config.intensity,
    };
  }
  let preservedVisual = null;
  if (pixiRenderer) {
    preservedVisual = {
      rainColor: pixiRenderer.getRainColor?.() ?? '#8aa8c0',
      gayMode: pixiRenderer.isGayMode?.() ?? false,
    };
  }
  let preservedAudio = null;
  if (audioSystem) {
    preservedAudio = {
      masterVolume: audioSystem.getMasterVolume?.() ?? -6,
      muted: audioSystem.isMuted ?? false,
    };
  }
  const wasMatrixMode = matrixMode;
  window.rainydesk.log(`[Reset] Preserving: gravity=${preservedSettings?.gravity}, color=${preservedVisual?.rainColor}, gayMode=${preservedVisual?.gayMode}, masterVol=${preservedAudio?.masterVolume}, muted=${preservedAudio?.muted}, matrix=${wasMatrixMode}`);

  try {
    // --- Tear down ---
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

    // Destroy Matrix mode if active
    if (wasMatrixMode) {
      destroyMatrixRenderer();
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

    // --- Rebuild ---
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

    // Restore physics settings
    if (preservedSettings && gridSimulation) {
      gridSimulation.setGravity?.(preservedSettings.gravity);
      gridSimulation.setDropMaxRadius?.(preservedSettings.radiusMax);
      gridSimulation.setReverseGravity?.(preservedSettings.reverseGravity);
      gridSimulation.setWind?.(preservedSettings.wind);
      gridSimulation.setIntensity?.(preservedSettings.intensity / 100);
    }
    // Restore visual settings
    if (preservedVisual && pixiRenderer) {
      pixiRenderer.setRainColor?.(preservedVisual.rainColor);
      pixiRenderer.setGayMode?.(preservedVisual.gayMode);
    }
    // Restore audio settings after fade-in completes (5s default)
    // Applying volume immediately would cut the fade-in ramp short
    if (preservedAudio && audioSystem) {
      if (preservedAudio.muted) audioSystem.setMuted?.(true);
      setTimeout(() => {
        if (audioSystem) audioSystem.setMasterVolume?.(preservedAudio.masterVolume);
      }, 5500);
    }

    // Reinit Matrix mode if it was active
    if (wasMatrixMode) {
      await initMatrixRenderer().catch(err => {
        window.rainydesk.log(`[Reset] Matrix re-init failed: ${err}`);
      });
    }

    window.rainydesk.log(`[Reset] Restored: gravity=${preservedSettings?.gravity}, reverseGravity=${preservedSettings?.reverseGravity}, color=${preservedVisual?.rainColor}, gayMode=${preservedVisual?.gayMode}, masterVol=${preservedAudio?.masterVolume}`);

    window.rainydesk.emitReinitStatus?.('raining');
    window.rainydesk.log('[Reset] Complete!');
  } catch (error) {
    window.rainydesk.log(`[Reset] FAILED: ${error.message}`);
    window.rainydesk.emitReinitStatus?.('raining');
  } finally {
    reinitInProgress = false;
  }
}

/**
 * Resize canvas to match display
 */
function resizeCanvas() {
  const width = window.innerWidth;
  const height = window.innerHeight;

  canvasWidth = width;
  canvasHeight = height;

  canvas.width = width;
  canvas.height = height;

  window.rainydesk.log(`[Resize] Canvas: ${width}x${height}`);
}

/**
 * Update simulation
 */
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

/**
 * Render simulation
 */
function render() {
  if (matrixMode && matrixRenderer) {
    // Matrix mode: render digital rain
    matrixRenderer.render();
  } else if (!reinitInProgress && pixiRenderer && gridSimulation) {
    // Normal mode: render rain physics
    pixiRenderer.render(gridSimulation);
  }
}

/**
 * Main game loop with delta time and optional FPS limiting
 */
function gameLoop(currentTime) {
  // Schedule next frame FIRST — uncaught errors must never kill the loop
  requestAnimationFrame(gameLoop);

  // FPS limiting
  if (config.fpsLimit > 0) {
    const minFrameTime = 1000 / config.fpsLimit;
    if (currentTime - lastFrameTime < minFrameTime) {
      return;
    }
    lastFrameTime = currentTime;
  }

  const dt = Math.min((currentTime - lastTime) / 1000, 0.1); // Cap at 100ms (10 FPS min)
  lastTime = currentTime;

  // Skip everything during reinit
  if (reinitInProgress) return;

  try {
    // Skip everything when fullscreen (app hidden behind fullscreen window)
    if (isFullscreenActive) {
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

      // Wind oscillation (gusts)
      if (windOscAmount > 0 && !matrixMode) {
        const now = currentTime / 1000; // seconds
        if (now >= windOscNextChangeTime) {
          // Pick new target wind value
          const oscNorm = windOscAmount / 100; // 0-1
          // Amplitude: low OSC = small swings around center, high OSC = full range
          const amplitude = 20 + oscNorm * 80; // 20-100 range
          windOscTarget = windOscUserCenter + (Math.random() * 2 - 1) * amplitude;
          windOscTarget = Math.max(-100, Math.min(100, windOscTarget));

          // Frequency: 5-10 changes/min, with 30% jitter
          const changesPerMin = 5 + oscNorm * 5;
          const interval = 60 / changesPerMin;
          const jitter = interval * 0.3 * (Math.random() * 2 - 1);
          windOscNextChangeTime = now + interval + jitter;
        }

        // Smooth lerp toward target (~1.5/sec)
        const lerpRate = 1.5 * dt;
        windOscCurrent += (windOscTarget - windOscCurrent) * Math.min(1, lerpRate);

        // Apply oscillated wind to simulation
        config.wind = Math.round(windOscCurrent);
        if (gridSimulation) {
          gridSimulation.setWind(config.wind);
        }

        // Modulate wind audio by magnitude (direction doesn't affect volume)
        if (audioSystem) {
          audioSystem.setWindSpeed(Math.abs(config.wind));
        }

        // Throttle broadcast to ~4 Hz for slider display sync (avoid IPC flood)
        const windVal = config.wind;
        if (currentTime - windOscLastBroadcast > 250 && windVal !== windOscLastBroadcastValue) {
          windOscLastBroadcast = currentTime;
          windOscLastBroadcastValue = windVal;
          window.rainydesk.updateRainscapeParam('physics.wind', windVal);
        }
      }

      // Feed particle count to audio system (skip in Matrix Mode - wind is muted)
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
      isFullscreenActive ? 'FULLSCREEN' : null,
      isPaused ? 'PAUSED' : null
    ].filter(Boolean).join(', ');
    window.rainydesk.log(`FPS: ${fps}, Particles: ${particles}, Windows: ${windowZoneCount}${statusFlags ? ', ' + statusFlags : ''}`);
    fpsCounter = 0;
    fpsTime = currentTime;
  }

  // Update debug stats more frequently (every 500ms) for responsive UI
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
      // Update local (for any in-window debug display)
      if (window._updateDebugStats) {
        window._updateDebugStats(statsPayload);
      }
      // Broadcast to other windows (Rainscaper panel)
      if (window.rainydesk?.emitStats) {
        window.rainydesk.emitStats(statsPayload);
      }
    }
    debugStatsTime = currentTime;
  }
}

/**
 * Register all event listeners
 */
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

  window.rainydesk.onSetIntensity((value) => {
    config.intensity = value;
    if (gridSimulation) {
      gridSimulation.setIntensity(value / 100);
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
    // Filter out RainyDesk and DevTools windows
    const newWindowZones = data.windows
      .filter(w => !w.title || !w.title.includes('RainyDesk'))
      .filter(w => !w.title || !w.title.includes('DevTools'))
      .map(w => ({
        x: w.bounds.x,
        y: w.bounds.y,
        width: w.bounds.width,
        height: w.bounds.height,
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
      // Log detected windows once per session
      if (!windowDataLogged) {
        windowDataLogged = true;
        window.rainydesk.log(`[WindowDebug] Detected ${windowZones.length} windows`);
      }

      if (windowZones.length !== windowZoneCount) {
        window.rainydesk.log(`[WindowDebug] Zone count: ${windowZoneCount} -> ${windowZones.length}`);
        windowZoneCount = windowZones.length;
        // Dump all detected windows for phantom investigation
        for (const win of windowZones) {
          window.rainydesk.log(`[WindowDebug]   "${win.title}" at (${win.x},${win.y}) ${win.width}x${win.height}${win.isMaximized ? ' [MAX]' : ''}`);
        }
      }

      // Classify windows
      const voidWindows = [];
      const normalWindows = [];
      const spawnBlockWindows = [];
      let hasPrimaryFullResolution = false;

      if (virtualDesktop && virtualDesktop.monitors) {
        const primaryIndex = virtualDesktop.primaryIndex || 0;

        for (const win of windowZones) {
          let classified = false;

          for (const mon of virtualDesktop.monitors) {
            const classification = classifyWindow(win, mon, virtualDesktop);

            if (classification === 'work-area') {
              if (!classified) {
                voidWindows.push(win);
                classified = true;
              }
            } else if (classification === 'full-resolution' && mon.index === primaryIndex) {
              if (!classified) {
                hasPrimaryFullResolution = true;
                normalWindows.push(win);
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

        // Handle fullscreen state with debounce
        const newFullscreenState = hasPrimaryFullResolution;
        if (newFullscreenState !== pendingFullscreenState) {
          pendingFullscreenState = newFullscreenState;
          if (fullscreenDebounceTimer) clearTimeout(fullscreenDebounceTimer);
          fullscreenDebounceTimer = setTimeout(() => {
            if (pendingFullscreenState !== isFullscreenActive) {
              const wasFullscreen = isFullscreenActive;
              isFullscreenActive = pendingFullscreenState;

              if (isFullscreenActive && !wasFullscreen) {
                window.rainydesk.log('[Fullscreen] Primary monitor fullscreen - hiding overlay');
                canvas.style.opacity = '0';
              } else if (!isFullscreenActive && wasFullscreen) {
                window.rainydesk.log('[Fullscreen] Primary monitor clear - showing overlay');
                canvas.style.opacity = '1';
              }
            }
          }, 200);
        }
      }

      // Update audio muffling
      if (audioSystem && virtualDesktop && virtualDesktop.monitors) {
        let coveredWidth = 0;
        const totalWidth = virtualDesktop.width;

        const fullscreenMonitorIndices = new Set();
        for (const win of voidWindows) {
          for (const mon of virtualDesktop.monitors) {
            const classification = classifyWindow(win, mon, virtualDesktop);
            if (classification === 'work-area') {
              fullscreenMonitorIndices.add(mon.index);
            }
          }
        }

        for (const mon of virtualDesktop.monitors) {
          if (fullscreenMonitorIndices.has(mon.index)) {
            coveredWidth += mon.width;
          }
        }

        const coverageRatio = totalWidth > 0 ? coveredWidth / totalWidth : 0;
        const muffleAmount = coverageRatio * 0.7;
        audioSystem.setMuffleAmount(muffleAmount);
      } else if (audioSystem) {
        audioSystem.setMuffleAmount(0);
      }

      // Store window zones for reinit
      lastWindowZonesForReinit = {
        normal: normalWindows,
        void: voidWindows,
        spawn: spawnBlockWindows
      };

      // Update physics with classified windows
      if (gridSimulation) {
        gridSimulation.updateWindowZones(normalWindows, voidWindows, spawnBlockWindows);
      }

      // Update Matrix renderer window zones (adjust for VD origin)
      // Include ALL windows (normal + void + spawnBlock) for collision detection
      if (matrixRenderer && virtualDesktop) {
        const originX = virtualDesktop.originX || 0;
        const originY = virtualDesktop.originY || 0;
        // Combine all window types - Matrix streams should collide with everything
        const allWindows = [...normalWindows, ...voidWindows];
        matrixRenderer.updateWindowZones(allWindows.map(w => ({
          left: w.x - originX,
          top: w.y - originY,
          right: w.x + w.width - originX,
          bottom: w.y + w.height - originY,
        })));

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
        if (windOscAmount > 0) return;
        config.wind = value;
        windOscUserCenter = value;
        windOscCurrent = value;
        if (gridSimulation) {
          gridSimulation.setWind(value);
        }
        // Note: Matrix Mode ignores wind (straight down only per spec)
      }
      if (param === 'intensity') {
        config.intensity = value;
        if (gridSimulation) {
          gridSimulation.setIntensity(value / 100);
        }
        // Matrix: intensity → spawn rate/density
        if (matrixRenderer) {
          matrixRenderer.setIntensity(value);
        }
      }
      // New physics params
      if (param === 'splashScale' && gridSimulation) {
        gridSimulation.setSplashScale(value);
        // Note: Matrix Mode ignores splash (no water physics)
      }
      if (param === 'turbulence') {
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
        const newScale = Math.max(0.125, Math.min(0.5, value));
        reinitializePhysics(newScale);
      }
      if (param === 'fpsLimit') {
        config.fpsLimit = Number(value);
        lastFrameTime = 0; // Reset so next frame renders immediately
      }
      if (param === 'windOsc') {
        windOscAmount = Number(value);
        if (windOscAmount <= 0) {
          // Snap back to user's manual wind center
          config.wind = windOscUserCenter;
          if (gridSimulation) gridSimulation.setWind(windOscUserCenter);
          if (audioSystem) audioSystem.setWindSpeed(Math.abs(windOscUserCenter));
          windOscCurrent = windOscUserCenter;
          windOscTarget = windOscUserCenter;
        }
        windOscNextChangeTime = 0; // Trigger immediate recalc
      }
    } else if (path === 'audio.muted') {
      if (audioSystem) {
        audioSystem.setMuted(Boolean(value));
        window.rainydesk.log(`Audio muted: ${value}`);
      }
    } else if (path === 'audio.rainMix' || path === 'audio.rainIntensity') {
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
    } else if (path === 'audio.wind.masterGain') {
      // Wind sound volume (dB)
      if (audioSystem) {
        audioSystem.updateParam('wind.masterGain', value);
      }
    } else if (path === 'audio.thunder.enabled') {
      // Thunder toggle (future)
      if (audioSystem) {
        audioSystem.updateParam('thunder.enabled', value);
      }
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
    } else if (path === 'visual.rainColor') {
      if (pixiRenderer) {
        pixiRenderer.setRainColor(value);
      }
      if (matrixRenderer) {
        matrixRenderer.setRainColor(String(value));
      }
    } else if (path === 'visual.rainbowMode' || path === 'visual.gayMode') {
      if (pixiRenderer) {
        pixiRenderer.setGayMode(Boolean(value));
      }
      if (matrixRenderer) {
        matrixRenderer.setGaytrixMode(Boolean(value));
      }
    } else if (path === 'visual.matrixMode') {
      const newMatrixMode = Boolean(value);
      if (newMatrixMode === matrixMode) return; // No change

      matrixMode = newMatrixMode;
      if (matrixMode) {
        // Switching TO Matrix Mode: pause rain, create separate canvas for matrix
        window.rainydesk.log('[Matrix] Switching to Matrix Mode...');

        // Set Matrix Mode flag on AudioSystem so start()/stop() knows which layers to run
        if (audioSystem) {
          audioSystem.setMatrixMode(true);
          audioSystem.getWindModule()?.stop();
          audioSystem.getSheetLayer()?.stop();
          audioSystem.setParticleCount(0);
          window.rainydesk.log('[Matrix] Stopped wind/sheet audio for Matrix Mode');
        }

        // Hide rain canvas (keep rain system intact, just hidden)
        canvas.style.display = 'none';

        // Create a separate canvas for Matrix Mode (avoids WebGL context conflicts)
        matrixCanvas = document.createElement('canvas');
        matrixCanvas.id = 'matrix-canvas';
        matrixCanvas.style.cssText = canvas.style.cssText; // Copy layout styles
        matrixCanvas.style.display = 'block';
        // Override fade-in styles that may still be hiding the rain canvas at startup
        matrixCanvas.style.visibility = 'visible';
        matrixCanvas.style.opacity = '1';
        matrixCanvas.style.transition = 'none';
        matrixCanvas.width = canvas.width;
        matrixCanvas.height = canvas.height;
        document.body.appendChild(matrixCanvas);

        // Init with error handling - rollback on failure
        initMatrixRenderer().catch(err => {
          window.rainydesk.log(`[Matrix] Init failed, rolling back: ${err}`);
          matrixMode = false;
          destroyMatrixRenderer();
          canvas.style.display = 'block';
        });
      } else {
        // Switching FROM Matrix Mode: destroy matrix, show rain again
        window.rainydesk.log('[Matrix] Switching back to Rain Mode...');
        destroyMatrixRenderer();

        // Restore wind and sheet audio
        if (audioSystem) {
          audioSystem.setMatrixMode(false);
          audioSystem.getWindModule()?.start();
          audioSystem.getSheetLayer()?.start();
          window.rainydesk.log('[Matrix] Restored wind/sheet audio for Rain Mode');
        }

        // Show rain canvas again
        canvas.style.display = 'block';
      }
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
    } else if (path === 'visual.crtIntensity') {
      // CRT Filter intensity (Matrix Mode only, 0-1)
      if (matrixRenderer) {
        matrixRenderer.setCrtIntensity(Number(value));
      }
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

/**
 * Initialize Pixi hybrid physics system
 */
async function initPixiPhysics() {
  window.rainydesk.log('[Pixi] Initializing hybrid physics...');

  const { GridSimulation, RainPixiRenderer } = await import('./simulation.bundle.js');

  const scale = GRID_SCALE;
  const logicWidth = Math.ceil(virtualDesktop.width * scale);
  const logicHeight = Math.ceil(virtualDesktop.height * scale);

  // Build void mask, spawn map, floor maps
  const voidMask = buildVoidMask(virtualDesktop, scale);
  const spawnMap = computeSpawnMap(voidMask, logicWidth, logicHeight);
  const floorMap = computeFloorMap(virtualDesktop, scale, logicWidth, logicHeight);
  const displayFloorMap = computeDisplayFloorMap(virtualDesktop, scale, logicWidth, logicHeight);

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

  gridSimulation.onDebugLog = (msg) => window.rainydesk.log(msg);
  gridSimulation.setIntensity(config.intensity / 100);
  gridSimulation.setWind(config.wind);

  // Initialize Pixi renderer
  pixiRenderer = new RainPixiRenderer({
    canvas: canvas,
    width: canvasWidth,
    height: canvasHeight,
    localOffsetX: 0,
    localOffsetY: 0,
    backgroundColor: 0x000000,
    preferWebGPU: true,
    gridScale: scale
  });

  await pixiRenderer.init();
  window.rainydesk.log('[Pixi] Renderer initialized');
  window.rainydesk.log('[Pixi] Hybrid physics ready!');
}

/**
 * Initialize Matrix Mode renderer
 */
async function initMatrixRenderer() {
  if (matrixRenderer || !matrixCanvas) return;

  const { MatrixPixiRenderer } = await import('./simulation.bundle.js');
  const { GlitchSynth } = await import('./audio.bundle.js');

  matrixRenderer = new MatrixPixiRenderer({
    canvas: matrixCanvas, // Use separate canvas to avoid WebGL context conflicts
    width: virtualDesktop?.width || window.innerWidth,
    height: virtualDesktop?.height || window.innerHeight,
    collisionEnabled: true,
  });
  await matrixRenderer.init();

  // Coordinate adjustment: window bounds are absolute, canvas is relative to VD origin
  const originX = virtualDesktop?.originX || 0;
  const originY = virtualDesktop?.originY || 0;

  // Set up window zones from saved classified data (includes all window types)
  // lastWindowZonesForReinit has normal/void/spawn arrays from classification
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
    // Fallback to raw window data if classification hasn't run yet
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

  // Compute initial blanked regions (monitors covered by maximized/fullscreen windows)
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

  // Set floor to bottom of work area (where taskbar is)
  // Use the minimum work area bottom from all monitors
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

  // Audio: create glitch synth (beat-quantized at 102 BPM)
  glitchSynth = new GlitchSynth();

  // Route GlitchSynth through AudioSystem master chain (master volume, muffle, limiter)
  if (audioSystem) {
    const masterInput = audioSystem.getMasterInput();
    if (masterInput) {
      glitchSynth.connectOutput(masterInput);
      window.rainydesk.log('[Matrix] GlitchSynth routed through AudioSystem master chain');
    }
  }

  // Apply any pending Matrix params that were queued before glitchSynth existed
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
    // Trigger returns { onBeat: boolean } for flash intensity
    const result = glitchSynth?.trigger() || { onBeat: false };
    // Only log on-beat collisions to avoid spam
    if (result.onBeat) {
      window.rainydesk.log(`[Matrix] ON-BEAT collision at (${Math.round(x)}, ${Math.round(y)})`);
    }
    return result;
  };

  // Start background drone (crossfade-looped ambient)
  // NOTE: Sound file is copied to src/renderer/sounds/ for dev mode (Tauri's frontendDist
  // is src/renderer/, so assets/ folder isn't served). Production builds use bundle resources.
  // See tauri.conf.json "resources" and .gitignore for sounds/ exclusion.
  try {
    await glitchSynth.startDrone('./sounds/SawLoopG.ogg', 5);
    window.rainydesk.log('[Matrix] Drone audio started');
  } catch (err) {
    window.rainydesk.log(`[Matrix] Drone audio failed: ${err}`);
  }

  // Sync Gaytrix state from current gayMode
  const isGaytrix = pixiRenderer?.isGayMode?.() ?? false;
  matrixRenderer.setGaytrixMode(isGaytrix);

  // Sync reverse gravity state from rain simulation
  const isReversed = gridSimulation?.isReverseGravity?.() ?? false;
  matrixRenderer.setReverseGravity(isReversed);

  // DON'T sync rain color - Matrix Mode should default to green unless explicitly set
  // Only apply custom color if Gaytrix is off and user has explicitly set a non-default color
  // (Leave this for later - for now, just use default green)

  window.rainydesk.log('[Matrix] Renderer initialized');
}

/**
 * Destroy Matrix Mode renderer
 */
function destroyMatrixRenderer() {
  if (matrixRenderer) {
    matrixRenderer.destroy();
    matrixRenderer = null;
  }
  if (glitchSynth) {
    glitchSynth.dispose();
    glitchSynth = null;
  }
  // Remove matrix canvas from DOM
  if (matrixCanvas) {
    matrixCanvas.remove();
    matrixCanvas = null;
  }
  window.rainydesk.log('[Matrix] Renderer destroyed');
}

/**
 * Periodically save state to Autosave.rain
 */
function startAutosave() {
  setInterval(async () => {
    if (audioInitialized) {
      const data = gatherPresetData();
      await window.rainydesk.autosaveRainscape(data);
    }
  }, 30000);
}

/**
 * Main initialization - SINGLE SEQUENTIAL FLOW
 */
async function init() {
  // PHASE 2: Wait for Tauri API
  await waitForTauriAPI();
  window.rainydesk.log('Initializing RainyDesk renderer...');

  // PHASE 3: Get display info and calculate
  virtualDesktop = await window.rainydesk.getVirtualDesktop();
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
      window.rainydesk.log('Loading autosaved rainscape settings');
      // Extract values for immediate use
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
