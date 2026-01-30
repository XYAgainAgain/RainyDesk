/**
 * RainyDesk Renderer - Overlay Mode
 * Physics rain, particles, audio, and Rainscaper UI
 *
 * Note: Background mode uses separate file (background-renderer.js)
 */

import RainPhysicsSystem from './physicsSystem.js';
import WebGLRainRenderer from './webgl/WebGLRainRenderer.js';
import Canvas2DRenderer from './Canvas2DRenderer.js';

// Audio system (TypeScript, voice-pooled)
let audioSystem = null;

// Rainscaper UI panel
let rainscaper = null;

// Canvas and context
const canvas = document.getElementById('rain-canvas');
let renderer = null;  // Will be WebGLRainRenderer or Canvas2DRenderer

// Render scale for pixelated 8-bit aesthetic (0.25 = 25% resolution)
// Physics runs at this scale, then upscaled with nearest-neighbor for blocky look
// Mutable so it can be adjusted via Rainscaper
let renderScale = 0.25;

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
  useMatterJS: true,
  usePixiPhysics: true,  // Toggle between Pixi (true) and Matter.js (false)
  fpsLimit: 0  // 0 = uncapped, otherwise target FPS
};

// FPS limiter state
let lastFrameTime = 0;

// Physics system (Matter.js - legacy)
let physicsSystem = null;

// Pixi hybrid physics (new system)
let gridSimulation = null;
let pixiRenderer = null;
let globalGridBounds = null;  // { minX, minY, width, height, logicWidth, logicHeight }

// Custom physics arrays (fallback)
let raindrops = [];
let splashParticles = [];

// Autosave data (loaded during init, applied after audio starts)
let pendingAutosave = null;

// Timing
let lastTime = performance.now();
let deltaTime = 0;
let fpsCounter = 0;
let fpsTime = performance.now();

// Audio initialization flag
let audioInitialized = false;

// Window exclusion zones (local canvas coordinates)
let windowZones = [];
let windowZoneCount = 0;

// Fullscreen detection: hide rain when this monitor has a fullscreen window
let isFullscreenActive = false;
let fullscreenDebounceTimer = null;
let pendingFullscreenState = false;

/**
 * Check if any window covers a monitor's work area (fullscreen/borderless detection).
 * Returns monitor indices that have fullscreen windows, or empty array if none.
 * @param {Array} windows - Window zones with screen coordinates
 * @param {Array} monitors - Monitor regions with virtual desktop relative coordinates
 * @param {Object} desktop - Virtual desktop info with originX/originY
 * @returns {number[]} Array of monitor indices with fullscreen windows
 */
function getFullscreenMonitors(windows, monitors, desktop) {
  if (!monitors || monitors.length === 0 || !desktop) return [];

  const TOLERANCE = 50; // Allow differences for window chrome, DPI scaling, etc.
  const fullscreenMonitors = [];

  for (const win of windows) {
    // Skip small windows
    if (win.width < 800 || win.height < 600) continue;

    // Convert window screen coordinates to virtual desktop relative coordinates
    const winRelX = win.x - desktop.originX;
    const winRelY = win.y - desktop.originY;

    for (const mon of monitors) {
      // Skip if already marked as fullscreen
      if (fullscreenMonitors.includes(mon.index)) continue;

      // Check if window covers this monitor's work area (or full monitor)
      const coversWidth = win.width >= mon.workWidth - TOLERANCE;
      const coversHeight = win.height >= mon.workHeight - TOLERANCE;

      // Check position alignment (window starts near monitor work area origin)
      const positionMatches =
        Math.abs(winRelX - mon.workX) < TOLERANCE &&
        Math.abs(winRelY - mon.workY) < TOLERANCE;

      // Also check against full monitor bounds (for true fullscreen)
      const coversFullWidth = win.width >= mon.width - TOLERANCE;
      const coversFullHeight = win.height >= mon.height - TOLERANCE;
      const fullPositionMatches =
        Math.abs(winRelX - mon.x) < TOLERANCE &&
        Math.abs(winRelY - mon.y) < TOLERANCE;

      const isFullscreen =
        (coversWidth && coversHeight && positionMatches) ||
        (coversFullWidth && coversFullHeight && fullPositionMatches);

      if (isFullscreen) {
        fullscreenMonitors.push(mon.index);
        // Log which window triggered fullscreen detection (once per window)
        if (!window._loggedFullscreenWindows) window._loggedFullscreenWindows = new Set();
        if (!window._loggedFullscreenWindows.has(win.title)) {
          window._loggedFullscreenWindows.add(win.title);
          window.rainydesk.log(`[Fullscreen] Matched: "${win.title?.substring(0, 30)}" (${win.width}x${win.height}) on monitor ${mon.index}`);
        }
      }
    }
  }

  // Clear logged windows when no fullscreen detected
  if (fullscreenMonitors.length === 0) {
    window._loggedFullscreenWindows = null;
  }

  return fullscreenMonitors;
}

/**
 * Raindrop class (fallback for non-Matter.js mode)
 */
class Raindrop {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.mass = 0.5 + Math.random() * 1.5;
    this.radius = config.dropMinSize + (this.mass / 2) * (config.dropMaxSize - config.dropMinSize);
    this.length = this.radius * (4 + Math.random() * 4);

    this.vx = (config.wind / 100) * 50 + (Math.random() - 0.5) * 20;
    this.vy = 200 + Math.random() * 200;

    this.opacity = 0.3 + Math.random() * 0.4;
  }

  update(dt) {
    const GRAVITY = 980;
    const AIR_RESISTANCE = 0.02;
    const TERMINAL_VELOCITY = 800;

    this.vy += GRAVITY * dt;

    const windForce = (config.wind / 100) * 200 * (1 / this.mass);
    this.vx += windForce * dt;

    this.vx *= (1 - AIR_RESISTANCE);
    this.vy *= (1 - AIR_RESISTANCE);

    if (this.vy > TERMINAL_VELOCITY) {
      this.vy = TERMINAL_VELOCITY;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    return this.y < canvasHeight + 50 &&
           this.x > -50 &&
           this.x < canvasWidth + 50;
  }

  render(ctx) {
    const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    const normalizedVx = this.vx / speed;
    const normalizedVy = this.vy / speed;

    const trailLength = Math.min(this.length, speed * 0.03);
    const endX = this.x - normalizedVx * trailLength;
    const endY = this.y - normalizedVy * trailLength;

    const gradient = ctx.createLinearGradient(endX, endY, this.x, this.y);
    gradient.addColorStop(0, 'rgba(160, 196, 232, 0)');
    gradient.addColorStop(1, `rgba(160, 196, 232, ${this.opacity})`);

    ctx.beginPath();
    ctx.moveTo(endX, endY);
    ctx.lineTo(this.x, this.y);
    ctx.strokeStyle = gradient;
    ctx.lineWidth = this.radius;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
}

/**
 * SplashParticle class (fallback for non-Matter.js mode)
 */
class SplashParticle {
  constructor(x, y, impactVelocity) {
    this.x = x;
    this.y = y;

    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI;
    const speed = 50 + Math.random() * impactVelocity * 0.3;

    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;

    this.radius = 0.5 + Math.random() * 1.5;
    this.opacity = 0.6;
    this.life = 0.3 + Math.random() * 0.3;
  }

  update(dt) {
    this.vy += 980 * 0.5 * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.life -= dt;
    this.opacity = Math.max(0, this.life * 2);

    return this.life > 0;
  }

  render(ctx) {
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(160, 196, 232, ${this.opacity})`;
    ctx.fill();
  }
}

/**
 * Check if two rectangles truly overlap (not just touching edges)
 */
function rectsOverlap(a, b) {
  // Use strict inequality to exclude windows that merely touch the boundary
  return !(a.x + a.width <= b.x || a.x >= b.x + b.width ||
           a.y + a.height <= b.y || a.y >= b.y + b.height);
}

/**
 * Calculate what percentage of rectangle 'a' overlaps with rectangle 'b'
 * Returns 0-1 (0% to 100%)
 */
function overlapPercentage(a, b) {
  // Find overlap rectangle
  const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const overlapY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const overlapArea = overlapX * overlapY;
  const aArea = a.width * a.height;
  return aArea > 0 ? overlapArea / aArea : 0;
}

/**
 * Initialize audio system with gentle fade-in
 */
async function initAudio() {
  if (audioInitialized) return;

  try {
    // Load and initialize audio system
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

    // Connect to physics for collision events
    if (physicsSystem) {
      physicsSystem.setAudioSystem(audioSystem);
      window.rainydesk.log('[Audio] Connected to Matter.js physics system');
    }

    // Connect to Pixi physics for collision events
    if (gridSimulation) {
      gridSimulation.onCollision = (event) => {
        audioSystem.handleCollision(event);
      };
      window.rainydesk.log('[Audio] Connected to Pixi physics system');
    }

    // Connect to Rainscaper
    if (rainscaper && rainscaper.setAudioSystem) {
      rainscaper.setAudioSystem(audioSystem);
      window.rainydesk.log('[Audio] Connected to Rainscaper');
    }

    audioInitialized = true;
    rainscaper.refresh();
  } catch (error) {
    window.rainydesk.log(`Audio init error: ${error.message}`);
    console.error('[Audio] Error:', error);
  }
}

/**
 * Build void mask from virtual desktop monitor regions.
 * Void mask: 1 = void (gap between monitors), 0 = usable
 */
function buildVoidMask(desktop, scale) {
  const gridWidth = Math.ceil(desktop.width * scale);
  const gridHeight = Math.ceil(desktop.height * scale);

  // Initialize all cells as void
  const voidMask = new Uint8Array(gridWidth * gridHeight);
  voidMask.fill(1);

  // Carve out monitor regions
  for (const monitor of desktop.monitors) {
    const mx = Math.floor(monitor.x * scale);
    const my = Math.floor(monitor.y * scale);
    const mw = Math.ceil(monitor.width * scale);
    const mh = Math.ceil(monitor.height * scale);

    for (let y = my; y < my + mh && y < gridHeight; y++) {
      for (let x = mx; x < mx + mw && x < gridWidth; x++) {
        voidMask[y * gridWidth + x] = 0; // Not void
      }
    }
  }

  const voidCount = voidMask.reduce((sum, v) => sum + v, 0);
  window.rainydesk.log(`[VoidMask] Grid ${gridWidth}×${gridHeight}, void=${voidCount}, usable=${voidMask.length - voidCount}`);

  return voidMask;
}

/**
 * Compute spawn map (per-column topmost non-void Y).
 * spawnY[x] = -1 if column is entirely void
 */
function computeSpawnMap(voidMask, gridWidth, gridHeight) {
  const spawnMap = new Int16Array(gridWidth);
  spawnMap.fill(-1);

  for (let x = 0; x < gridWidth; x++) {
    for (let y = 0; y < gridHeight; y++) {
      if (voidMask[y * gridWidth + x] === 0) {
        spawnMap[x] = y; // First non-void cell from top
        break;
      }
    }
  }

  return spawnMap;
}

/**
 * Compute floor map (per-column bottom of work area).
 * floorY[x] = gridHeight if column has no floor
 */
function computeFloorMap(desktop, scale, gridWidth, gridHeight) {
  const floorMap = new Int16Array(gridWidth);
  floorMap.fill(gridHeight);

  for (const monitor of desktop.monitors) {
    const mx = Math.floor(monitor.x * scale);
    const mw = Math.ceil(monitor.width * scale);

    // Floor is bottom of work area (excludes taskbar)
    const workBottom = Math.floor((monitor.workY + monitor.workHeight) * scale);

    for (let x = mx; x < mx + mw && x < gridWidth; x++) {
      // Use lowest floor if columns overlap
      floorMap[x] = Math.min(floorMap[x], workBottom);
    }
  }

  return floorMap;
}

/**
 * Initialize Pixi hybrid physics system
 */
async function initPixiPhysics() {
  if (gridSimulation || pixiRenderer) {
    window.rainydesk.log('[Pixi] Already initialized');
    return;
  }

  try {
    window.rainydesk.log('[Pixi] Initializing hybrid physics...');

    // Dynamically import simulation modules
    const { GridSimulation, RainPixiRenderer } = await import('./simulation.bundle.js');

    // Fetch virtual desktop info
    virtualDesktop = await window.rainydesk.getVirtualDesktop();
    window.rainydesk.log(`[Pixi] Virtual desktop: ${virtualDesktop.width}×${virtualDesktop.height} at (${virtualDesktop.originX}, ${virtualDesktop.originY}), ${virtualDesktop.monitors.length} monitors`);

    const scale = 0.25;
    const logicWidth = Math.ceil(virtualDesktop.width * scale);
    const logicHeight = Math.ceil(virtualDesktop.height * scale);

    // Build void mask, spawn map, floor map
    const voidMask = buildVoidMask(virtualDesktop, scale);
    const spawnMap = computeSpawnMap(voidMask, logicWidth, logicHeight);
    const floorMap = computeFloorMap(virtualDesktop, scale, logicWidth, logicHeight);

    globalGridBounds = {
      minX: virtualDesktop.originX,
      minY: virtualDesktop.originY,
      width: virtualDesktop.width,
      height: virtualDesktop.height,
      logicWidth,
      logicHeight
    };

    window.rainydesk.log(`[Pixi] Global grid: (${virtualDesktop.originX},${virtualDesktop.originY}) ${virtualDesktop.width}×${virtualDesktop.height} → ${logicWidth}×${logicHeight} logic`);

    // Calculate local offset for this monitor (use window bounds)
    const localOffsetX = 0; // Mega-window starts at origin
    const localOffsetY = 0;

    // Initialize GridSimulation with void/spawn/floor maps
    gridSimulation = new GridSimulation(
      logicWidth,
      logicHeight,
      virtualDesktop.originX,
      virtualDesktop.originY,
      {}, // Default config
      voidMask,
      spawnMap,
      floorMap
    );

    // Set initial parameters from config
    gridSimulation.setIntensity(config.intensity / 100);
    gridSimulation.setWind(config.wind);

    // Wire up audio callback
    if (audioSystem) {
      gridSimulation.onCollision = (event) => {
        audioSystem.handleCollision(event);
      };
      window.rainydesk.log('[Pixi] Audio callback connected');
    }

    // Initialize Pixi renderer
    pixiRenderer = new RainPixiRenderer({
      canvas: canvas,
      width: canvasWidth,
      height: canvasHeight,
      localOffsetX,
      localOffsetY,
      backgroundColor: 0x000000,
      preferWebGPU: true
    });

    await pixiRenderer.init();
    window.rainydesk.log('[Pixi] Renderer initialized');

    window.rainydesk.log('[Pixi] Hybrid physics ready!');
  } catch (error) {
    window.rainydesk.log(`[Pixi] Init error: ${error.message}`);
    console.error('[Pixi] Error:', error);
  }
}

/**
 * Switch between Matter.js and Pixi physics
 */
function switchPhysicsEngine(usePixi) {
  config.usePixiPhysics = usePixi;
  window.rainydesk.log(`[Physics] Switched to ${usePixi ? 'Pixi' : 'Matter.js'}`);

  // Initialize the appropriate system if not already done
  if (usePixi && !gridSimulation) {
    initPixiPhysics();
  } else if (!usePixi && !physicsSystem) {
    // Matter.js will be initialized in the existing init flow
  }
}

/**
 * Periodically save state to autosave.json
 */
function startAutosave() {
  setInterval(async () => {
    if (audioInitialized && rainscaper) {
      const data = rainscaper.gatherPresetData();
      data.name = "Autosave";
      await window.rainydesk.saveRainscape('autosave.json', data);
    }
  }, 30000);
}

/**
 * Spawn new raindrops based on intensity
 */
function spawnRaindrops(dt) {
  if (!config.enabled) return;

  const MAX_PARTICLES = 1000; 
  const currentParticles = config.useMatterJS && physicsSystem
    ? physicsSystem.getParticleCount()
    : raindrops.length + splashParticles.length;

  if (currentParticles >= MAX_PARTICLES) return;

  const baseRate = (config.intensity / 100) * 80;
  const spawnCount = baseRate * dt;
  const actualSpawn = Math.floor(spawnCount + Math.random());

  for (let i = 0; i < actualSpawn; i++) {
    if (currentParticles + i >= MAX_PARTICLES) break;

    const windOffset = (config.wind / 100) * -200;
    const x = Math.random() * (canvasWidth + 200) - 100 + windOffset;
    const y = -20 - Math.random() * 100;
    const mass = 0.5 + Math.random() * 1.5;

    if (config.useMatterJS && physicsSystem) {
      physicsSystem.createRaindrop(x, y, mass);
    } else {
      raindrops.push(new Raindrop(x, y));
    }
  }
}

/**
 * Update all particles
 */
function update(dt) {
  if (config.usePixiPhysics && gridSimulation) {
    // Pixi hybrid physics
    gridSimulation.step(dt);
  } else if (config.useMatterJS && physicsSystem) {
    // Matter.js physics
    spawnRaindrops(dt);
    physicsSystem.update(dt);
  } else {
    // Fallback: custom physics (non-Matter.js mode)
    spawnRaindrops(dt);
    raindrops = raindrops.filter(drop => {
      const alive = drop.update(dt);
      return alive;
    });
    splashParticles = splashParticles.filter(particle => particle.update(dt));
  }
}

/**
 * Render all particles
 */
function render() {
  if (config.usePixiPhysics && pixiRenderer && gridSimulation) {
    // Pixi hybrid renderer
    pixiRenderer.render(gridSimulation);
  } else if (config.useMatterJS && physicsSystem && renderer) {
    // Matter.js + WebGL renderer
    renderer.render(physicsSystem);
  } else if (!config.useMatterJS) {
    // Fallback canvas 2D renderer
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    raindrops.forEach(drop => drop.render(ctx));
    splashParticles.forEach(particle => particle.render(ctx));
  }
}

/**
 * Main game loop with delta time and optional FPS limiting
 */
function gameLoop(currentTime) {
  // FPS limiting: skip frame if we're ahead of schedule
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

  // Skip physics/rendering when fullscreen window detected on this monitor
  if (!isFullscreenActive) {
    update(dt);
    render();

    // Feed particle count to audio system for sheet layer modulation
    if (audioSystem) {
      let particleCount = 0;
      if (config.usePixiPhysics && gridSimulation) {
        particleCount = gridSimulation.getActiveDropCount();
      } else if (physicsSystem) {
        particleCount = physicsSystem.getParticleCount();
      } else {
        particleCount = raindrops.length;
      }
      audioSystem.setParticleCount(particleCount);
    }
  } else {
    // When fullscreen, feed zero particles to quiet the sheet layer
    if (audioSystem) {
      audioSystem.setParticleCount(0);
    }
  }

  // FPS monitoring
  fpsCounter++;
  if (currentTime - fpsTime > 5000) {
    const fps = Math.round(fpsCounter / 5);
    let particles = 0;
    if (config.usePixiPhysics && gridSimulation) {
      particles = gridSimulation.getActiveDropCount();
    } else if (physicsSystem) {
      particles = physicsSystem.getParticleCount();
    } else {
      particles = raindrops.length;
    }
    const engineName = config.usePixiPhysics ? 'Pixi' : 'Matter';
    window.rainydesk.log(`FPS: ${fps}, Particles: ${particles}, Windows: ${windowZoneCount}, Engine: ${engineName}${isFullscreenActive ? ', FULLSCREEN' : ''}`);
    fpsCounter = 0;
    fpsTime = currentTime;
  }

  requestAnimationFrame(gameLoop);
}

/**
 * Resize canvas to match display
 */
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const width = window.innerWidth;
  const height = window.innerHeight;

  canvasWidth = width;
  canvasHeight = height;

  // Set canvas backing store dimensions (not just CSS)
  canvas.width = width;
  canvas.height = height;

  // Pass scale factor to renderer for pixelated rendering
  if (renderer) renderer.resize(width, height, dpr, renderScale);

  window.rainydesk.log(`[Resize] Canvas: ${width}×${height}`);

  // Physics system handles its own scaling internally (floorY handled by floor map)
  if (physicsSystem) physicsSystem.resize(width, height, height);
}

/**
 * Initialize the rain simulation (overlay mode)
 */
async function init() {
  window.rainydesk.log('Initializing RainyDesk renderer...');

  // Mega-window: canvas sized to full window (spans entire virtual desktop)
  resizeCanvas();

  window.rainydesk.onToggleRain((enabled) => {
    config.enabled = enabled;
    // Also pause/resume audio when rain is toggled
    if (audioSystem) {
      if (enabled) {
        audioSystem.start();
      } else {
        audioSystem.stop();
      }
    }
  });

  // Audio pause/resume (from tray menu "Pause RainyDesk")
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
    // Update Pixi simulation if active
    if (config.usePixiPhysics && gridSimulation) {
      gridSimulation.setIntensity(value / 100);
    }
    // Audio responds to particle count, not intensity directly
  });

  window.rainydesk.onSetVolume((value) => {
    config.volume = value;
    // Convert 0-100 slider to dB range (-60 to 0)
    if (audioInitialized && audioSystem) {
      const db = value <= 0 ? -Infinity : (value / 100 * 60) - 60;
      audioSystem.setMasterVolume(db);
    }
    window.rainydesk.log(`Volume set to ${value}%`);
  });

  // Quick-select rainscape from tray menu
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

  // Track if we've logged window info for this session (log once per startup)
  let windowDataLogged = false;

  window.rainydesk.onWindowData((data) => {
    // Filter out RainyDesk and DevTools windows
    windowZones = data.windows
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

    // DEBUG: Log detected windows once per session
    if (!windowDataLogged) {
      windowDataLogged = true;
      window.rainydesk.log(`[WindowDebug] Detected ${windowZones.length} windows (global coords):`);
      windowZones.forEach((w, i) => {
        const maxFlag = w.isMaximized ? ' [MAXIMIZED]' : '';
        window.rainydesk.log(`  [${i}] "${w.title?.substring(0, 25) || '?'}" at (${w.x},${w.y}) ${w.width}×${w.height}${maxFlag}`);
      });
    }

    // Log when maximized windows are detected (help debug fullscreen issues)
    const maximizedWindows = windowZones.filter(w => w.isMaximized);
    if (maximizedWindows.length > 0 && !window._loggedMaximized) {
      window._loggedMaximized = true;
      window.rainydesk.log(`[WindowDebug] Maximized windows detected:`);
      maximizedWindows.forEach(w => {
        window.rainydesk.log(`  - "${w.title?.substring(0, 30)}" at (${w.x},${w.y}) ${w.width}×${w.height}`);
      });
    } else if (maximizedWindows.length === 0 && window._loggedMaximized) {
      window._loggedMaximized = false;
    }

    // Log zone count changes
    if (windowZones.length !== windowZoneCount) {
      window.rainydesk.log(`[WindowDebug] Zone count: ${windowZoneCount} → ${windowZones.length}`);
      windowZoneCount = windowZones.length;
    }

    // Fullscreen detection: check which monitors have fullscreen windows
    let fullscreenMonitors = [];
    if (virtualDesktop && virtualDesktop.monitors) {
      fullscreenMonitors = getFullscreenMonitors(windowZones, virtualDesktop.monitors, virtualDesktop);
      // Only pause rain globally if PRIMARY monitor has fullscreen
      const primaryIndex = virtualDesktop.primaryIndex || 0;
      const newFullscreenState = fullscreenMonitors.includes(primaryIndex);

      // Debounce fullscreen state changes (200ms) to avoid rapid toggling during window moves
      if (newFullscreenState !== pendingFullscreenState) {
        pendingFullscreenState = newFullscreenState;
        if (fullscreenDebounceTimer) clearTimeout(fullscreenDebounceTimer);
        fullscreenDebounceTimer = setTimeout(() => {
          if (pendingFullscreenState !== isFullscreenActive) {
            const wasFullscreen = isFullscreenActive;
            isFullscreenActive = pendingFullscreenState;

            if (isFullscreenActive && !wasFullscreen) {
              window.rainydesk.log(`[Fullscreen] Primary monitor fullscreen - pausing physics (monitors: ${fullscreenMonitors.join(', ')})`);
              // Don't mute audio - let sheets/wind continue for ambient vibes
              // Just the particle count will drop to 0, naturally quieting impact sounds
            } else if (!isFullscreenActive && wasFullscreen) {
              window.rainydesk.log('[Fullscreen] Primary monitor clear - resuming rain');
            }
          }
        }, 200);
      }
    }

    // Update physics system (window data is already in global coordinates)
    if (config.usePixiPhysics && gridSimulation) {
      gridSimulation.updateWindowZones(windowZones);
    } else if (physicsSystem) {
      // Matter.js still uses local coords (legacy)
      physicsSystem.setWindowZones(windowZones);
    }
  });

  // Handle Parameter Sync
  window.rainydesk.onUpdateRainscapeParam((path, value) => {
    if (path.startsWith('physics.')) {
      const param = path.split('.')[1];

      if (param === 'gravity') {
        if (config.usePixiPhysics && gridSimulation) {
          gridSimulation.setGravity(value);
        } else if (physicsSystem) {
          physicsSystem.setGravity(value);
        }
      }

      if (param === 'wind') {
        config.wind = value;
        if (config.usePixiPhysics && gridSimulation) {
          gridSimulation.setWind(value);
        } else if (physicsSystem) {
          physicsSystem.setWind(value);
        }
        // Also update background rain wind (normalize to -1..1)
        if (renderer && renderer.setBackgroundRainWind) {
          renderer.setBackgroundRainWind(value / 100);
        }
      }
      if (param === 'intensity') {
        config.intensity = value;
        // Update Pixi simulation intensity
        if (config.usePixiPhysics && gridSimulation) {
          gridSimulation.setIntensity(value / 100);
        }
        // Update background rain intensity (normalize to 0..1)
        if (renderer && renderer.setBackgroundRainIntensity) {
          renderer.setBackgroundRainIntensity(value / 100);
        }
      }
      if (param === 'dropMinSize') config.dropMinSize = value;
      if (param === 'dropMaxSize') config.dropMaxSize = value;
      if (param === 'renderScale') {
        // Update render scale and resize both systems
        renderScale = Math.max(0.125, Math.min(1.0, value));
        if (physicsSystem) physicsSystem.setScaleFactor(renderScale);
        resizeCanvas(); // Triggers renderer.resize with new scale
        window.rainydesk.log(`Render scale set to ${renderScale * 100}%`);
      }
      if (param === 'terminalVelocity' && physicsSystem) {
        physicsSystem.setTerminalVelocity(value);
      }
    } else if (path.startsWith('backgroundRain.')) {
      // Handle background rain shader parameters
      const param = path.split('.')[1];
      if (renderer && renderer.setBackgroundRainConfig) {
        const configUpdate = {};
        if (param === 'intensity') configUpdate.intensity = value / 100;
        else if (param === 'layerCount') configUpdate.layerCount = value;
        else if (param === 'speed') configUpdate.speed = value;
        else if (param === 'enabled') configUpdate.enabled = value;
        renderer.setBackgroundRainConfig(configUpdate);
      }
    } else if (path === 'system.fpsLimit') {
      // FPS limiter: 0 = uncapped, otherwise target FPS (Select sends string values)
      const numValue = typeof value === 'string' ? parseInt(value, 10) : value;
      config.fpsLimit = Math.max(0, Math.min(240, numValue || 0));
      window.rainydesk.log(`FPS limit set to ${config.fpsLimit === 0 ? 'uncapped' : config.fpsLimit}`);
    } else if (path === 'system.usePixiPhysics') {
      // Physics engine toggle
      switchPhysicsEngine(!!value);
    } else if (audioSystem) {
      audioSystem.updateParam(path, value);
    }
  });

  // Hook up Rainscaper toggle
  window.rainydesk.onToggleRainscaper(() => {
    if (rainscaper) rainscaper.toggle();
  });

  // Fullscreen detection: hide rain when fullscreen window detected
  window.rainydesk.onFullscreenStatus((isFullscreen) => {
    isFullscreenActive = isFullscreen;
    if (isFullscreen) {
      window.rainydesk.log('[Fullscreen] Detected - hiding rain');
      if (renderer) renderer.clear();
    } else {
      window.rainydesk.log('[Fullscreen] Ended - showing rain');
    }
  });

  // Audio muffling: triggered when fullscreen detected
  window.rainydesk.onAudioMuffle((shouldMuffle) => {
    if (audioSystem) {
      audioSystem.setMuffled(shouldMuffle);
      window.rainydesk.log(`Audio muffling: ${shouldMuffle ? 'ON' : 'OFF'}`);
    }
  });

  // Initialize renderer (only for Matter.js mode - Pixi has its own renderer)
  if (!config.usePixiPhysics) {
    try {
      renderer = new WebGLRainRenderer(canvas);
      renderer.init();
    } catch (error) {
      renderer = new Canvas2DRenderer(canvas);
      renderer.init();
    }

    // Set initial background rain config (matches physics defaults)
    if (renderer.setBackgroundRainConfig) {
      renderer.setBackgroundRainConfig({
        intensity: config.intensity / 100,
        wind: config.wind / 100,
        layerCount: 3,
        speed: 1.0,
        enabled: true
      });
    }
  }

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  if (config.useMatterJS) {
    // Create physics system with render scale for pixelated effect
    physicsSystem = new RainPhysicsSystem(canvasWidth, canvasHeight, renderScale);
  }

  const initialConfig = await window.rainydesk.getConfig();
  config.enabled = initialConfig.rainEnabled;
  config.intensity = initialConfig.intensity;
  config.volume = initialConfig.volume;

  // Load autosave config before audio starts (so fade-in uses correct values)
  try {
    pendingAutosave = await window.rainydesk.readRainscape('autosave.json');
    if (pendingAutosave) {
      window.rainydesk.log('Loading autosaved rainscape settings');

      // Extract basic config values for fade-in
      if (pendingAutosave.physics) {
        if (pendingAutosave.physics.intensity !== undefined) config.intensity = pendingAutosave.physics.intensity;
        if (pendingAutosave.physics.wind !== undefined) config.wind = pendingAutosave.physics.wind;
      }

      // Full preset will be applied after audio initializes
    }
  } catch (err) {
    window.rainydesk.log(`Autosave load failed: ${err.message}`);
  }

  // Init Rainscaper
  try {
    const { rainscaper: rsModule } = await import('./rainscaper.bundle.js');
    rainscaper = rsModule;
    await rainscaper.init(physicsSystem, config);
    window.rainydesk.log('[Rainscaper] Initialized');

    // Add physics engine toggle to Rainscaper (exposed as window function for UI)
    window.switchPhysicsEngine = switchPhysicsEngine;

    // Broadcast initial physics values to background windows
    // This ensures background rain starts with correct settings
    window.rainydesk.updateRainscapeParam('physics.intensity', config.intensity);
    window.rainydesk.updateRainscapeParam('physics.wind', config.wind || 0);
    window.rainydesk.updateRainscapeParam('physics.renderScale', renderScale);
    window.rainydesk.updateRainscapeParam('backgroundRain.enabled', true);
    window.rainydesk.log(`[Init] Broadcast initial values: intensity=${config.intensity}, wind=${config.wind}, renderScale=${renderScale}`);
  } catch (err) {
    window.rainydesk.log(`Rainscaper init failed: ${err.message}`);
    console.error('[Rainscaper] Error:', err);
  }

  // Initialize Pixi physics if enabled by default
  if (config.usePixiPhysics) {
    window.rainydesk.log('[Init] Pixi physics enabled, initializing...');
    await initPixiPhysics();

    // Position Rainscaper on primary monitor (now that virtualDesktop is set)
    if (virtualDesktop && rainscaper) {
      const primary = virtualDesktop.monitors[virtualDesktop.primaryIndex];
      const panel = document.getElementById('rainscaper');
      if (panel && primary) {
        // Position at bottom-right of primary monitor's work area
        panel.style.right = `${canvasWidth - (primary.x + primary.width) + 20}px`;
        panel.style.bottom = `${canvasHeight - (primary.workY + primary.workHeight) + 20}px`;
        window.rainydesk.log(`[Rainscaper] Positioned at right=${panel.style.right}, bottom=${panel.style.bottom}`);
      }
    }
  }

  startAutosave();

  // Enable click-through immediately (Tauri autoplay policy allows immediate start)
  window.rainydesk.setIgnoreMouseEvents(true, { forward: true });

  // Listen for audio start broadcast from main process
  window.rainydesk.onStartAudio(async () => {
    window.rainydesk.log('Received audio start signal');
    await initAudio();
  });

  // Auto-start audio after a short delay
  // No click required since autoplayPolicy: 'no-user-gesture-required' is set
  setTimeout(() => {
    window.rainydesk.log('Auto-triggering audio start');
    window.rainydesk.triggerAudioStart();
  }, 500);

  requestAnimationFrame(gameLoop);
}

document.addEventListener('DOMContentLoaded', init);