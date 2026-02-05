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
      wind: config.wind,
    },
    physics: {
      gravity: gridSimulation?.getGravity?.() ?? 980,
      gridScale: GRID_SCALE,
    },
    audio: {
      muted: audioSystem?.isMuted ?? false,
      masterVolume: audioSystem?.getMasterVolume?.() ?? -12,
    },
    visual: {
      gayMode: pixiRenderer?.isGayMode?.() ?? false,
      rainColor: pixiRenderer?.getRainColor?.() ?? '#4a9eff',
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
    // Grid scale requires full reinit, skip on startup
  }

  // Audio settings
  if (data.audio) {
    if (data.audio.muted !== undefined) {
      audioSystem?.setMuted?.(data.audio.muted);
      window.rainydesk.updateRainscapeParam('audio.muted', data.audio.muted);
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
  }
}

/**
 * Reinitialize physics system with new grid scale
 */
async function reinitializePhysics(newGridScale) {
  if (reinitInProgress) {
    window.rainydesk.log('[Physics] Reinit already in progress');
    return;
  }

  reinitInProgress = true;
  window.rainydesk.emitReinitStatus?.('stopped');
  window.rainydesk.log(`[Physics] Reinitializing: ${GRID_SCALE} -> ${newGridScale}`);

  // Preserve simulation settings before destroying
  let preservedSettings = null;
  if (gridSimulation) {
    preservedSettings = {
      gravity: gridSimulation.getGravity?.() ?? 980,
      radiusMax: gridSimulation.getDropMaxRadius?.() ?? 2.0,
    };
  }
  // Preserve renderer settings (color, gay mode)
  let preservedVisual = null;
  if (pixiRenderer) {
    preservedVisual = {
      rainColor: pixiRenderer.getRainColor?.() ?? '#8aa8c0',
      gayMode: pixiRenderer.isGayMode?.() ?? false,
    };
  }
  window.rainydesk.log(`[Physics] Preserving: gravity=${preservedSettings?.gravity}, radiusMax=${preservedSettings?.radiusMax}, color=${preservedVisual?.rainColor}, gayMode=${preservedVisual?.gayMode}`);

  try {
    // Clear timers
    if (windowUpdateDebounceTimer) {
      clearTimeout(windowUpdateDebounceTimer);
      windowUpdateDebounceTimer = null;
    }

    // Disconnect callbacks
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

    window.rainydesk.emitReinitStatus?.('initializing');

    GRID_SCALE = newGridScale;
    await initPixiPhysics();

    // Reconnect audio collision handler
    if (audioSystem && gridSimulation) {
      gridSimulation.onCollision = (event) => audioSystem.handleCollision(event);
    }

    // Reapply window zones
    if (lastWindowZonesForReinit && gridSimulation) {
      gridSimulation.updateWindowZones(lastWindowZonesForReinit.normal, lastWindowZonesForReinit.void, lastWindowZonesForReinit.spawn);
    }

    // Restore preserved settings
    if (preservedSettings && gridSimulation) {
      gridSimulation.setGravity?.(preservedSettings.gravity);
      gridSimulation.setDropMaxRadius?.(preservedSettings.radiusMax);
    }
    // Restore visual settings (color, gay mode)
    if (preservedVisual && pixiRenderer) {
      pixiRenderer.setRainColor?.(preservedVisual.rainColor);
      pixiRenderer.setGayMode?.(preservedVisual.gayMode);
    }
    window.rainydesk.log(`[Physics] Restored: gravity=${preservedSettings?.gravity}, radiusMax=${preservedSettings?.radiusMax}, color=${preservedVisual?.rainColor}, gayMode=${preservedVisual?.gayMode}`);

    window.rainydesk.emitReinitStatus?.('raining');
    window.rainydesk.log('[Physics] Reinit complete!');
  } catch (error) {
    window.rainydesk.log(`[Physics] Reinit FAILED: ${error.message}`);
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
    // Matrix mode: update digital rain
    matrixRenderer.update(dt);
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
  // FPS limiting
  if (config.fpsLimit > 0) {
    const minFrameTime = 1000 / config.fpsLimit;
    if (currentTime - lastFrameTime < minFrameTime) {
      requestAnimationFrame(gameLoop);
      return;
    }
    lastFrameTime = currentTime;
  }

  const dt = Math.min((currentTime - lastTime) / 1000, 0.033);
  lastTime = currentTime;

  // Skip everything during reinit
  if (reinitInProgress) {
    requestAnimationFrame(gameLoop);
    return;
  }

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

    // Feed particle count to audio system
    if (audioSystem && gridSimulation) {
      const particleCount = gridSimulation.getActiveDropCount();
      audioSystem.setParticleCount(particleCount);
    }
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

  requestAnimationFrame(gameLoop);
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
      }
    }, 32);
  });

  // Parameter sync
  window.rainydesk.onUpdateRainscapeParam((path, value) => {
    if (path.startsWith('physics.')) {
      const param = path.split('.')[1];

      if (param === 'gravity' && gridSimulation) {
        gridSimulation.setGravity(value);
      }
      if (param === 'wind') {
        config.wind = value;
        if (gridSimulation) {
          gridSimulation.setWind(value);
        }
      }
      if (param === 'intensity') {
        config.intensity = value;
        if (gridSimulation) {
          gridSimulation.setIntensity(value / 100);
        }
      }
      // New physics params
      if (param === 'splashScale' && gridSimulation) {
        gridSimulation.setSplashScale(value);
      }
      if (param === 'turbulence' && gridSimulation) {
        gridSimulation.setTurbulence(value);
      }
      if (param === 'puddleDrain' && gridSimulation) {
        gridSimulation.setEvaporationRate(value);
      }
      if (param === 'dropMaxSize' && gridSimulation) {
        gridSimulation.setDropMaxRadius(value);
      }
      if (param === 'reverseGravity' && gridSimulation) {
        gridSimulation.setReverseGravity(Boolean(value));
      }
      if (param === 'resetSimulation') {
        const newScale = Math.max(0.125, Math.min(0.5, value));
        reinitializePhysics(newScale);
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

        // Hide rain canvas (keep rain system intact, just hidden)
        canvas.style.display = 'none';

        // Create a separate canvas for Matrix Mode (avoids WebGL context conflicts)
        matrixCanvas = document.createElement('canvas');
        matrixCanvas.id = 'matrix-canvas';
        matrixCanvas.style.cssText = canvas.style.cssText; // Copy all styles
        matrixCanvas.style.display = 'block';
        matrixCanvas.width = canvas.width;
        matrixCanvas.height = canvas.height;
        document.body.appendChild(matrixCanvas);

        initMatrixRenderer();
      } else {
        // Switching FROM Matrix Mode: destroy matrix, show rain again
        window.rainydesk.log('[Matrix] Switching back to Rain Mode...');
        destroyMatrixRenderer();

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
          audioSystem.start();
        }
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

  window.rainydesk.onFullscreenStatus((isFullscreen) => {
    isFullscreenActive = isFullscreen;
    if (isFullscreen) {
      window.rainydesk.log('[Fullscreen] Detected - hiding rain');
    } else {
      window.rainydesk.log('[Fullscreen] Ended - showing rain');
    }
  });

  window.rainydesk.onAudioMuffle((shouldMuffle) => {
    if (audioSystem) {
      audioSystem.setMuffled(shouldMuffle);
      window.rainydesk.log(`Audio muffling: ${shouldMuffle ? 'ON' : 'OFF'}`);
    }
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

  // Audio: create glitch synth (beat-quantized at 120 BPM)
  glitchSynth = new GlitchSynth();
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
    await glitchSynth.startDrone('./sounds/EvolvingSawsLoop.ogg', 5);
    window.rainydesk.log('[Matrix] Drone audio started');
  } catch (err) {
    window.rainydesk.log(`[Matrix] Drone audio failed: ${err}`);
  }

  // Sync Gaytrix state from current gayMode
  const isGaytrix = pixiRenderer?.isGayMode?.() ?? false;
  matrixRenderer.setGaytrixMode(isGaytrix);

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
