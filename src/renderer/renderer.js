/**
 * RainyDesk Renderer - Overlay Mode
 * Physics rain, particles, audio, and Rainscaper UI
 *
 * Note: Background mode uses separate file (background-renderer.js)
 */

import audioSystem from './audioSystem.js';
import RainPhysicsSystem from './physicsSystem.js';

// New TypeScript audio system (Phase 4.5 integration)
let newAudioSystem = null;
let useNewAudio = true;
import WebGLRainRenderer from './webgl/WebGLRainRenderer.js';
import Canvas2DRenderer from './Canvas2DRenderer.js';

// New TypeScript Rainscaper (Phase 4 panel rewrite)
let rainscaper = null;
let useNewRainscaper = true;

// Canvas and context
const canvas = document.getElementById('rain-canvas');
let renderer = null;  // Will be WebGLRainRenderer or Canvas2DRenderer

// Render scale for pixelated 8-bit aesthetic (0.25 = 25% resolution)
// Physics runs at this scale, then upscaled with nearest-neighbor for blocky look
// Mutable so it can be adjusted via Rainscaper
let renderScale = 0.25;

// Display info (set by main process)
let displayInfo = {
  index: 0,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1,
  refreshRate: 60
};

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
  useMatterJS: true 
};

// Physics system (Matter.js)
let physicsSystem = null;

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

/**
 * Legacy Raindrop class (for non-Matter.js mode)
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
 * Legacy SplashParticle class (for non-Matter.js mode)
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
 * Initialize audio system with gentle 5-second fade-in
 * Applies full autosave config BEFORE fade-in to avoid surprise sounds
 */
async function initAudio() {
  if (audioInitialized) return;

  try {
    // Step 0: Load and initialize new TypeScript audio system
    try {
      const { AudioSystem } = await import('./audio.bundle.js');
      newAudioSystem = new AudioSystem({
        impactPoolSize: 12,
        bubblePoolSize: 12
      });
      await newAudioSystem.init();
      window.rainydesk.log('[New Audio] TypeScript AudioSystem initialized');
    } catch (err) {
      window.rainydesk.log(`[New Audio] Failed to initialize: ${err.message}`);
      console.error('[New Audio] Error:', err);
    }

    // Step 1: Initialize old audio system (only if not using new one)
    if (!useNewAudio) {
      await audioSystem.init();
      window.rainydesk.log('Audio system initialized');

      // Step 2: Apply full autosaved preset BEFORE starting fade-in
      if (pendingAutosave) {
        window.rainydesk.log('Applying autosaved rainscape before fade-in');
        rainscaper.applyPreset(pendingAutosave);
        pendingAutosave = null; // Clear after applying
      }

      // Step 3: Capture target values (now includes autosave settings)
      const targetVolume = config.volume;
      const targetIntensity = config.intensity;
      const targetWind = config.wind;

      // Step 4: Set everything to 0 for fade-in
      audioSystem.setVolume(0);
      audioSystem.setIntensity(0);

      // Step 5: Start audio playback
      await audioSystem.start();
    } else {
      window.rainydesk.log('[New Audio] Old system disabled - using new TypeScript system only');
    }

    // Step 5.5: Start new audio system
    if (newAudioSystem) {
      try {
        await newAudioSystem.start(true); // true = enable fade-in
        window.rainydesk.log('[New Audio] Started with fade-in');

        // Pass new audio system to physics for collision events
        if (physicsSystem) {
          physicsSystem.setNewAudioSystem(newAudioSystem);
          window.rainydesk.log('[New Audio] Connected to physics system');
        }

        // Connect new audio system to new rainscaper
        if (useNewRainscaper && rainscaper && rainscaper.setAudioSystem) {
          rainscaper.setAudioSystem(newAudioSystem);
          window.rainydesk.log('[New Audio] Connected to Rainscaper');
        }
      } catch (err) {
        window.rainydesk.log(`[New Audio] Failed to start: ${err.message}`);
      }
    }

    // Step 6: Gentle 5-second fade-in to target values (old system only)
    if (!useNewAudio) {
      const targetVolume = config.volume;
      const targetIntensity = config.intensity;
      const targetWind = config.wind;

      const fadeDuration = 5000;
      const fadeSteps = 50;
      const stepDuration = fadeDuration / fadeSteps;

      for (let i = 0; i <= fadeSteps; i++) {
        const progress = i / fadeSteps;
        const easedProgress = progress * progress; // Ease-in curve

        audioSystem.setVolume(targetVolume * easedProgress);
        audioSystem.setIntensity(targetIntensity * easedProgress);
        audioSystem.setWind(targetWind * easedProgress);

        if (i < fadeSteps) {
          await new Promise(resolve => setTimeout(resolve, stepDuration));
        }
      }
      window.rainydesk.log('Audio fade-in complete');
    } else {
      window.rainydesk.log('[New Audio] Fade-in handled by AudioSystem.start()');
    }

    audioInitialized = true;

    rainscaper.refresh();
  } catch (error) {
    window.rainydesk.log(`Audio init error: ${error.message}`);
  }
}

/**
 * Periodically save state to autosave.json
 */
function startAutosave() {
  setInterval(async () => {
    if (audioInitialized && rainscaper.isVisible) {
      const data = rainscaper.gatherPresetData();
      data.name = "Autosave";
      await window.rainydesk.saveRainscape('autosave.json', data);
    }
  }, 10000); // Every 10 seconds
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
  spawnRaindrops(dt);

  if (config.useMatterJS && physicsSystem) {
    physicsSystem.update(dt);
  } else {
    // Legacy custom physics
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
  if (config.useMatterJS && physicsSystem && renderer) {
    renderer.render(physicsSystem);
  } else if (!config.useMatterJS) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    raindrops.forEach(drop => drop.render(ctx));
    splashParticles.forEach(particle => particle.render(ctx));
  }
}

/**
 * Main game loop with delta time
 */
function gameLoop(currentTime) {
  const dt = Math.min((currentTime - lastTime) / 1000, 0.033);
  lastTime = currentTime;

  // Skip physics/rendering when fullscreen window detected on this monitor
  if (!isFullscreenActive) {
    update(dt);
    render();

    // Feed particle count to new audio system
    if (newAudioSystem && physicsSystem) {
      const particleCount = physicsSystem.getParticleCount();
      newAudioSystem.setParticleCount(particleCount);
    }
  } else {
    // When fullscreen, feed zero particles to quiet the sheet layer
    if (newAudioSystem) {
      newAudioSystem.setParticleCount(0);
    }
  }

  // FPS monitoring
  fpsCounter++;
  if (currentTime - fpsTime > 5000) {
    const fps = Math.round(fpsCounter / 5);
    const particles = physicsSystem ? physicsSystem.getParticleCount() : raindrops.length;
    window.rainydesk.log(`FPS: ${fps}, Particles: ${particles}, Windows: ${windowZoneCount}${isFullscreenActive ? ', FULLSCREEN' : ''}`);
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

  // Pass scale factor to renderer for pixelated rendering
  if (renderer) renderer.resize(width, height, dpr, renderScale);

  let floorY = height;
  if (displayInfo && displayInfo.workArea && displayInfo.bounds) {
    const globalFloorY = displayInfo.workArea.y + displayInfo.workArea.height;
    floorY = globalFloorY - displayInfo.bounds.y;
    floorY = Math.min(Math.max(0, floorY), height);
  }

  window.rainydesk.log(`[Monitor ${displayInfo?.index ?? '?'}] Resize: ${width}x${height}, floorY=${floorY}`);

  // Physics system handles its own scaling internally
  if (physicsSystem) physicsSystem.resize(width, height, floorY);
}

/**
 * Initialize the rain simulation (overlay mode)
 */
async function init() {
  window.rainydesk.log('Initializing RainyDesk renderer...');

  // Get display info via command (more reliable than event timing)
  try {
    const info = await window.rainydesk.getDisplayInfo();
    console.log('[DEBUG] Got display-info via command:', JSON.stringify(info));
    displayInfo = info;
    displayInfo.fromTauri = true;
    resizeCanvas();
  } catch (e) {
    console.warn('[DEBUG] getDisplayInfo command failed, falling back to event:', e);
  }

  // Also listen for display-info events (fallback/updates)
  window.rainydesk.onDisplayInfo((info) => {
    console.log('[DEBUG] Received display-info event:', JSON.stringify(info));
    displayInfo = info;
    displayInfo.fromTauri = true;
    resizeCanvas();
  });

  window.rainydesk.onToggleRain((enabled) => { config.enabled = enabled; });

  // Audio pause/resume (from tray menu "Pause RainyDesk")
  window.rainydesk.onToggleAudio((enabled) => {
    if (newAudioSystem) {
      if (enabled) {
        newAudioSystem.start();
        window.rainydesk.log('Audio resumed');
      } else {
        newAudioSystem.stop();
        window.rainydesk.log('Audio paused');
      }
    }
  });

  window.rainydesk.onSetIntensity((value) => {
    config.intensity = value;
    if (audioInitialized) audioSystem.setIntensity(value);
  });

  window.rainydesk.onSetVolume((value) => {
    config.volume = value;
    if (audioInitialized) audioSystem.setVolume(value);
  });

  // Track if we've logged window info for this session (log once per startup)
  let windowDataLogged = false;

  window.rainydesk.onWindowData((data) => {
    // Skip processing until we have valid displayInfo from Tauri
    // (default bounds are 1920x1080, real monitors are different)
    if (!displayInfo.fromTauri) {
      return;
    }

    // DEBUG: Log ALL detected windows once per session (to log file for autonomous debugging)
    if (!windowDataLogged) {
      windowDataLogged = true;
      const allWindowInfo = data.windows.map(w =>
        `"${w.title?.substring(0, 25) || '?'}" at (${w.bounds.x},${w.bounds.y}) ${w.bounds.width}x${w.bounds.height}`
      );
      window.rainydesk.log(`[WindowDebug] Monitor ${displayInfo.index} at (${displayInfo.bounds.x},${displayInfo.bounds.y}) ${displayInfo.bounds.width}x${displayInfo.bounds.height}`);
      window.rainydesk.log(`[WindowDebug] All ${data.windows.length} detected windows:`);
      allWindowInfo.forEach((info, i) => window.rainydesk.log(`  [${i}] ${info}`));
    }

    // First, find windows that overlap this monitor
    const overlappingWindows = data.windows
      .filter(w => !w.title || !w.title.includes('RainyDesk'))
      .filter(w => !w.title || !w.title.includes('DevTools'))
      .filter(w => rectsOverlap(w.bounds, displayInfo.bounds));

    // Convert to local coordinates and CLIP to monitor bounds
    // This allows windows spanning multiple monitors to create zones on each
    const monitorWidth = displayInfo.bounds.width;
    const monitorHeight = displayInfo.bounds.height;

    windowZones = overlappingWindows.map(w => {
      // Convert to local coordinates
      let x = w.bounds.x - displayInfo.bounds.x;
      let y = w.bounds.y - displayInfo.bounds.y;
      let width = w.bounds.width;
      let height = w.bounds.height;

      // Clip left edge
      if (x < 0) {
        width += x;  // Reduce width by the negative amount
        x = 0;
      }
      // Clip top edge
      if (y < 0) {
        height += y;  // Reduce height by the negative amount
        y = 0;
      }
      // Clip right edge
      if (x + width > monitorWidth) {
        width = monitorWidth - x;
      }
      // Clip bottom edge
      if (y + height > monitorHeight) {
        height = monitorHeight - y;
      }

      return { x, y, width, height, title: w.title };
    }).filter(z => z.width > 0 && z.height > 0);  // Remove zones that clipped to nothing

    // Log final zones ONCE for this monitor
    if (!windowDataLogged || windowZones.length !== windowZoneCount) {
      if (windowZones.length > 0) {
        const zoneDetails = windowZones.map(z =>
          `"${z.title?.substring(0, 20) || '?'}" local:(${z.x},${z.y}) ${z.width}x${z.height}`
        );
        window.rainydesk.log(`[WindowDebug] Monitor ${displayInfo.index} final zones (${windowZones.length}):`);
        zoneDetails.forEach((d, i) => window.rainydesk.log(`  zone[${i}]: ${d}`));
      }
    }

    // Remove title from zones (not needed for physics)
    windowZones = windowZones.map(z => ({ x: z.x, y: z.y, width: z.width, height: z.height }));

    windowZoneCount = windowZones.length;
    if (physicsSystem) physicsSystem.setWindowZones(windowZones);
  });

  // Handle Parameter Sync
  window.rainydesk.onUpdateRainscapeParam((path, value) => {
    if (path.startsWith('physics.')) {
      const param = path.split('.')[1];
      if (param === 'gravity' && physicsSystem) physicsSystem.setGravity(value);
      if (param === 'wind' && physicsSystem) {
        physicsSystem.setWind(value);
        // Also update background rain wind (normalize to -1..1)
        if (renderer && renderer.setBackgroundRainWind) {
          renderer.setBackgroundRainWind(value / 100);
        }
      }
      if (param === 'intensity') {
        config.intensity = value;
        // Old audio system uses intensity directly; new system uses particle count from game loop
        if (!useNewAudio && audioSystem.isInitialized) audioSystem.setIntensity(value);
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
    } else if (newAudioSystem) {
      newAudioSystem.updateParam(path, value);
    } else if (!useNewAudio && audioSystem.isInitialized) {
      audioSystem.updateParam(path, value);
    }
  });

  // Hook up Debug Panel toggle
  window.rainydesk.onToggleRainscaper(() => {
    if (displayInfo.index === 0) rainscaper.toggle();
  });

  // Fullscreen detection: hide rain on this monitor when fullscreen window detected
  window.rainydesk.onFullscreenStatus((isFullscreen) => {
    isFullscreenActive = isFullscreen;
    if (isFullscreen) {
      window.rainydesk.log(`[Monitor ${displayInfo.index}] Fullscreen detected - hiding rain`);
      // Clear the canvas when going fullscreen
      if (renderer) renderer.clear();
    } else {
      window.rainydesk.log(`[Monitor ${displayInfo.index}] Fullscreen ended - showing rain`);
    }
  });

  // Audio muffling: triggered when ANY monitor has fullscreen
  window.rainydesk.onAudioMuffle((shouldMuffle) => {
    // Only handle on primary monitor to avoid duplicate processing
    if (displayInfo.index !== 0) return;

    if (newAudioSystem) {
      newAudioSystem.setMuffled(shouldMuffle);
      window.rainydesk.log(`Audio muffling: ${shouldMuffle ? 'ON' : 'OFF'}`);
    }
  });

  // Initialize renderer
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

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  if (config.useMatterJS) {
    // Create physics system with render scale for pixelated effect
    physicsSystem = new RainPhysicsSystem(canvasWidth, canvasHeight, renderScale);
  }

  audioSystem.onRainscapeChange = (name) => {
    window.rainydesk.setRainscape(name);
  };

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

  // Init Rainscaper (new TypeScript version or legacy fallback)
  try {
    if (useNewRainscaper) {
      const { rainscaper: newRainscaper } = await import('./rainscaper.bundle.js');
      rainscaper = newRainscaper;
      await rainscaper.init(physicsSystem, config);
      window.rainydesk.log('[New Rainscaper] TypeScript Rainscaper initialized');
    } else {
      // Legacy rainscaper fallback
      const { rainscaper: legacyRainscaper } = await import('./rainscaper.js');
      rainscaper = legacyRainscaper;
      await rainscaper.init(physicsSystem, config);
      window.rainydesk.log('Legacy Rainscaper initialized');
    }

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

  startAutosave();

  // Enable click-through immediately (autoplay policy bypassed in Electron)
  window.rainydesk.setIgnoreMouseEvents(true, { forward: true });

  // Listen for audio start broadcast from main process
  window.rainydesk.onStartAudio(async () => {
    window.rainydesk.log('Received audio start signal');
    await initAudio();
  });

  // Auto-start audio after a short delay (primary monitor triggers all)
  // No click required since autoplayPolicy: 'no-user-gesture-required' is set
  if (displayInfo.index === 0) {
    setTimeout(() => {
      window.rainydesk.log('Auto-triggering audio start on all monitors');
      window.rainydesk.triggerAudioStart();
    }, 500);  // Small delay to ensure all renderers are ready
  }

  requestAnimationFrame(gameLoop);
}

document.addEventListener('DOMContentLoaded', init);