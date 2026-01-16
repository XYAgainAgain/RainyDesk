/**
 * RainyDesk Renderer (ES Module version with tone.js + matter.js)
 * Rain particle simulation with realistic physics and procedural audio
 */

import audioSystem from './audioSystem.js';
import RainPhysicsSystem from './physicsSystem.js';
import WebGLRainRenderer from './webgl/WebGLRainRenderer.js';
import Canvas2DRenderer from './Canvas2DRenderer.js';

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
  useMatterJS: true // Toggle between custom physics and Matter.js
};

// Physics system (Matter.js)
let physicsSystem = null;

// Custom physics arrays (fallback)
let raindrops = [];
let splashParticles = [];

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
 * Check if a point is inside any window exclusion zone
 */
function isInsideWindow(x, y) {
  for (let i = 0; i < windowZones.length; i++) {
    const zone = windowZones[i];
    if (x >= zone.x && x <= zone.x + zone.width &&
        y >= zone.y && y <= zone.y + zone.height) {
      return true;
    }
  }
  return false;
}

/**
 * Initialize audio system on first user interaction
 */
async function initAudio() {
  if (audioInitialized) return;

  try {
    await audioSystem.init();
    await audioSystem.start();
    audioSystem.setVolume(config.volume);
    audioSystem.setIntensity(config.intensity);
    audioSystem.setWind(config.wind);
    audioInitialized = true;
    window.rainydesk.log('Audio system initialized and started');
  } catch (error) {
    window.rainydesk.log(`Audio initialization failed: ${error.message}`);
  }
}

/**
 * Spawn new raindrops based on intensity
 */
function spawnRaindrops(dt) {
  if (!config.enabled) return;

  // Particle limits - focus on functionality before optimization
  const MAX_PARTICLES = 1000; // Per monitor - testing before presets
  const currentParticles = config.useMatterJS && physicsSystem
    ? physicsSystem.getParticleCount()
    : raindrops.length + splashParticles.length;

  if (currentParticles >= MAX_PARTICLES) return;

  // Spawn rate: 40 particles/sec at 50% intensity, 80 at 100%
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
 * Create splash effect
 */
function createSplash(x, velocity) {
  const count = 3 + Math.floor(Math.random() * 5);
  for (let i = 0; i < count; i++) {
    splashParticles.push(new SplashParticle(x, canvasHeight, velocity));
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

      if (!alive && drop.y >= canvasHeight) {
        createSplash(drop.x, drop.vy);
      }

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
    // Legacy rendering (Canvas 2D only, rarely used)
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
  deltaTime = (currentTime - lastTime) / 1000;
  lastTime = currentTime;

  // Cap delta time only for extreme cases (tab switching, etc)
  deltaTime = Math.min(deltaTime, 0.033); // Max ~30fps delta

  update(deltaTime);
  render();

  // FPS monitoring (log every 5 seconds)
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

  // Delegate canvas sizing to renderer
  if (renderer) {
    renderer.resize(width, height, dpr);
  }

  // Calculate floor Y based on workArea (to avoid splashing on taskbar)
  let floorY = height;
  if (displayInfo && displayInfo.workArea && displayInfo.bounds) {
    // Floor relative to window top (which is at displayInfo.bounds.y)
    const globalFloorY = displayInfo.workArea.y + displayInfo.workArea.height;
    floorY = globalFloorY - displayInfo.bounds.y;
    // Clamp to ensure it's not off-screen in weird ways
    floorY = Math.min(Math.max(0, floorY), height);
  }

  if (physicsSystem) {
    physicsSystem.resize(width, height, floorY);
  }

  window.rainydesk.log(`Canvas resized: ${width}x${height} (FloorY: ${floorY})`);
}

/**
 * Initialize the rain simulation
 */
async function init() {
  window.rainydesk.log('Initializing RainyDesk renderer (with tone.js + matter.js)...');

  // Register IPC listeners
  window.rainydesk.onDisplayInfo((info) => {
    displayInfo = info;
    window.rainydesk.log(`Display ${info.index}: ${info.bounds.width}x${info.bounds.height} @ ${info.refreshRate}Hz`);
    resizeCanvas(); // Apply workArea to physics floor
  });

  window.rainydesk.onToggleRain((enabled) => {
    config.enabled = enabled;
    window.rainydesk.log(`Rain ${enabled ? 'enabled' : 'disabled'}`);
  });

  window.rainydesk.onSetIntensity((value) => {
    config.intensity = value;
    if (audioInitialized) {
      audioSystem.setIntensity(value);
    }
    window.rainydesk.log(`Intensity set to ${value}%`);
  });

  window.rainydesk.onSetVolume((value) => {
    config.volume = value;
    if (audioInitialized) {
      audioSystem.setVolume(value);
    }
    window.rainydesk.log(`Volume set to ${value}%`);
  });

  // Register window data listener for exclusion zones
  window.rainydesk.onWindowData((data) => {
    // Filter to windows that overlap this monitor and transform to local coords
    windowZones = data.windows
      .filter(w => rectsOverlap(w.bounds, displayInfo.bounds))
      .map(w => ({
        x: w.bounds.x - displayInfo.bounds.x,
        y: w.bounds.y - displayInfo.bounds.y,
        width: w.bounds.width,
        height: w.bounds.height
      }));
    windowZoneCount = windowZones.length;

    // Pass zones to physics system for collision detection
    if (physicsSystem) {
      physicsSystem.setWindowZones(windowZones);
    }
  });

  // Initialize renderer (WebGL with Canvas2D fallback)
  try {
    renderer = new WebGLRainRenderer(canvas);
    renderer.init();
    window.rainydesk.log('WebGL 2 renderer initialized');
  } catch (error) {
    window.rainydesk.log(`WebGL 2 failed: ${error.message}, falling back to Canvas 2D`);
    renderer = new Canvas2DRenderer(canvas);
    renderer.init();
  }

  // Set up canvas
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Initialize physics system
  if (config.useMatterJS) {
    physicsSystem = new RainPhysicsSystem(canvasWidth, canvasHeight);
    window.rainydesk.log('Matter.js physics system enabled');
  }

  // Get initial config
  const initialConfig = await window.rainydesk.getConfig();
  config.enabled = initialConfig.rainEnabled;
  config.intensity = initialConfig.intensity;
  config.volume = initialConfig.volume;

  // Initialize audio on first click/interaction
  document.addEventListener('click', initAudio, { once: true });
  window.addEventListener('keydown', initAudio, { once: true });

  // Try to init audio immediately (may fail due to autoplay policy)
  initAudio().catch(() => {
    window.rainydesk.log('Audio will start on first user interaction');
  });

  window.rainydesk.log(`Starting rain simulation... Canvas: ${canvasWidth}x${canvasHeight}`);
  requestAnimationFrame(gameLoop);
}

document.addEventListener('DOMContentLoaded', init);
