/**
 * RainyDesk Renderer (ES Module version with tone.js + matter.js)
 * Rain particle simulation with realistic physics and procedural audio
 */

import audioSystem from './audioSystem.js';
import RainPhysicsSystem from './physicsSystem.js';

// New TypeScript audio system (Phase 4.5 integration)
let newAudioSystem = null;
let useNewAudio = true; // Using new system exclusively now
import WebGLRainRenderer from './webgl/WebGLRainRenderer.js';
import Canvas2DRenderer from './Canvas2DRenderer.js';
import { rainscaper } from './rainscaper.js';

// Canvas and context
const canvas = document.getElementById('rain-canvas');
let renderer = null;  // Will be WebGLRainRenderer or Canvas2DRenderer

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
 * Check if two rectangles overlap
 */
function rectsOverlap(a, b) {
  return !(a.x + a.width < b.x || a.x > b.x + b.width ||
           a.y + a.height < b.y || a.y > b.y + b.height);
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

  update(dt);
  render();

  // Feed particle count to new audio system
  if (newAudioSystem && physicsSystem) {
    const particleCount = physicsSystem.getParticleCount();
    newAudioSystem.setParticleCount(particleCount);
  }

  // FPS monitoring
  fpsCounter++;
  if (currentTime - fpsTime > 5000) {
    const fps = Math.round(fpsCounter / 5);
    const particles = physicsSystem ? physicsSystem.getParticleCount() : raindrops.length;
    window.rainydesk.log(`FPS: ${fps}, Particles: ${particles}, Windows: ${windowZoneCount}`);
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

  if (renderer) renderer.resize(width, height, dpr);

  let floorY = height;
  if (displayInfo && displayInfo.workArea && displayInfo.bounds) {
    const globalFloorY = displayInfo.workArea.y + displayInfo.workArea.height;
    floorY = globalFloorY - displayInfo.bounds.y;
    floorY = Math.min(Math.max(0, floorY), height);
  }

  if (physicsSystem) physicsSystem.resize(width, height, floorY);
}

/**
 * Initialize the rain simulation
 */
async function init() {
  window.rainydesk.log('Initializing RainyDesk renderer...');

  // Register IPC listeners
  window.rainydesk.onDisplayInfo((info) => {
    displayInfo = info;
    resizeCanvas();
  });

  window.rainydesk.onToggleRain((enabled) => { config.enabled = enabled; });

  window.rainydesk.onSetIntensity((value) => {
    config.intensity = value;
    if (audioInitialized) audioSystem.setIntensity(value);
  });

  window.rainydesk.onSetVolume((value) => {
    config.volume = value;
    if (audioInitialized) audioSystem.setVolume(value);
  });

  window.rainydesk.onWindowData((data) => {
    windowZones = data.windows
      .filter(w => rectsOverlap(w.bounds, displayInfo.bounds))
      .map(w => ({
        x: w.bounds.x - displayInfo.bounds.x,
        y: w.bounds.y - displayInfo.bounds.y,
        width: w.bounds.width,
        height: w.bounds.height
      }));
    windowZoneCount = windowZones.length;
    if (physicsSystem) physicsSystem.setWindowZones(windowZones);
  });

  // Handle Parameter Sync
  window.rainydesk.onUpdateRainscapeParam((path, value) => {
    if (path.startsWith('physics.')) {
      const param = path.split('.')[1];
      if (param === 'gravity' && physicsSystem) physicsSystem.setGravity(value);
      if (param === 'wind' && physicsSystem) physicsSystem.setWind(value);
      if (param === 'intensity') {
        config.intensity = value;
        if (audioSystem.isInitialized) audioSystem.setIntensity(value);
      }
      if (param === 'dropMinSize') config.dropMinSize = value;
      if (param === 'dropMaxSize') config.dropMaxSize = value;
    } else if (audioSystem.isInitialized) {
      audioSystem.updateParam(path, value);
    }
  });

  // Hook up Debug Panel toggle
  window.rainydesk.onToggleRainscaper(() => {
    if (displayInfo.index === 0) rainscaper.toggle();
  });

  // Initialize renderer
  try {
    renderer = new WebGLRainRenderer(canvas);
    renderer.init();
  } catch (error) {
    renderer = new Canvas2DRenderer(canvas);
    renderer.init();
  }

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  if (config.useMatterJS) {
    physicsSystem = new RainPhysicsSystem(canvasWidth, canvasHeight);
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

  // Init Debug Tool
  try {
    rainscaper.init(physicsSystem, config);
    window.rainydesk.log('Rainscaper initialized');
  } catch (err) {
    window.rainydesk.log(`Rainscaper init failed: ${err.message}`);
  }

  startAutosave();

  // Audio starts on first click anywhere (browser policy requirement)
  // Clicking on ANY monitor triggers audio on ALL monitors
  document.addEventListener('click', () => {
    window.rainydesk.log('First click detected - triggering audio start on all monitors');

    // Switch to click-through mode immediately so clicks pass through
    window.rainydesk.setIgnoreMouseEvents(true, { forward: true });

    // Trigger audio start on all monitors via main process
    window.rainydesk.triggerAudioStart();
  }, { once: true });

  // Listen for audio start broadcast from main process
  window.rainydesk.onStartAudio(async () => {
    window.rainydesk.log('Received audio start signal');
    await initAudio();
  });

  requestAnimationFrame(gameLoop);
}

document.addEventListener('DOMContentLoaded', init);