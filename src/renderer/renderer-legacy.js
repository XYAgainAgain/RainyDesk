/**
 * RainyDesk Renderer
 * Rain particle simulation with realistic physics
 */

// Canvas and context
const canvas = document.getElementById('rain-canvas');
const ctx = canvas.getContext('2d');

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
  intensity: 50,        // 0-100
  volume: 50,           // 0-100
  wind: 0,              // -100 to 100
  dropColor: 'rgba(160, 196, 232, 0.6)',
  dropMinSize: 1,
  dropMaxSize: 3
};

// Physics constants
const GRAVITY = 980;           // pixels per second squared (scaled from 9.8 m/s^2)
const AIR_RESISTANCE = 0.02;
const TERMINAL_VELOCITY = 800; // max fall speed

// Particle arrays
let raindrops = [];
let splashParticles = [];

// Timing
let lastTime = performance.now();
let deltaTime = 0;

/**
 * Raindrop class with physics
 */
class Raindrop {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.mass = 0.5 + Math.random() * 1.5;
    this.radius = config.dropMinSize + (this.mass / 2) * (config.dropMaxSize - config.dropMinSize);
    this.length = this.radius * (4 + Math.random() * 4); // Trail length based on size

    // Velocity - start with some downward speed
    this.vx = (config.wind / 100) * 50 + (Math.random() - 0.5) * 20;
    this.vy = 200 + Math.random() * 200;

    // Visual properties
    this.opacity = 0.3 + Math.random() * 0.4;
  }

  update(dt) {
    // Apply gravity
    this.vy += GRAVITY * dt;

    // Apply wind force (lighter drops affected more)
    const windForce = (config.wind / 100) * 200 * (1 / this.mass);
    this.vx += windForce * dt;

    // Apply air resistance
    this.vx *= (1 - AIR_RESISTANCE);
    this.vy *= (1 - AIR_RESISTANCE);

    // Clamp to terminal velocity
    if (this.vy > TERMINAL_VELOCITY) {
      this.vy = TERMINAL_VELOCITY;
    }

    // Update position
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Check if off screen (use tracked canvas dimensions)
    return this.y < canvasHeight + 50 &&
           this.x > -50 &&
           this.x < canvasWidth + 50;
  }

  render(ctx) {
    // Calculate trail end point based on velocity
    const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    const normalizedVx = this.vx / speed;
    const normalizedVy = this.vy / speed;

    const trailLength = Math.min(this.length, speed * 0.03);
    const endX = this.x - normalizedVx * trailLength;
    const endY = this.y - normalizedVy * trailLength;

    // Draw raindrop as a gradient line
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
 * Splash particle for impact effects
 */
class SplashParticle {
  constructor(x, y, impactVelocity) {
    this.x = x;
    this.y = y;

    // Random direction for splash
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI;
    const speed = 50 + Math.random() * impactVelocity * 0.3;

    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;

    this.radius = 0.5 + Math.random() * 1.5;
    this.opacity = 0.6;
    this.life = 0.3 + Math.random() * 0.3; // seconds
  }

  update(dt) {
    // Apply gravity (less than raindrops)
    this.vy += GRAVITY * 0.5 * dt;

    // Update position
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Fade out
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
 * Spawn new raindrops based on intensity
 */
function spawnRaindrops(dt) {
  if (!config.enabled) return;

  // Calculate spawn rate based on intensity
  // At 100% intensity, spawn ~100 drops per frame at 60fps = 6000/second
  const baseRate = (config.intensity / 100) * 100;
  const spawnCount = baseRate * dt;

  // Spawn whole drops, carry over fraction
  const actualSpawn = Math.floor(spawnCount + Math.random());

  for (let i = 0; i < actualSpawn; i++) {
    // Spawn above screen with some horizontal offset based on wind
    const windOffset = (config.wind / 100) * -200; // Spawn upwind
    const x = Math.random() * (canvasWidth + 200) - 100 + windOffset;
    const y = -20 - Math.random() * 100;

    raindrops.push(new Raindrop(x, y));
  }
}

/**
 * Create splash effect when raindrop hits bottom of screen
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
  // Spawn new raindrops
  spawnRaindrops(dt);

  // Update raindrops
  raindrops = raindrops.filter(drop => {
    const alive = drop.update(dt);

    // Create splash if hitting bottom of screen
    if (!alive && drop.y >= canvasHeight) {
      createSplash(drop.x, drop.vy);
    }

    return alive;
  });

  // Update splash particles
  splashParticles = splashParticles.filter(particle => particle.update(dt));
}

/**
 * Render all particles
 */
function render() {
  // Clear canvas (transparent) - use full canvas buffer size
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Render raindrops
  raindrops.forEach(drop => drop.render(ctx));

  // Render splash particles
  splashParticles.forEach(particle => particle.render(ctx));
}

/**
 * Main game loop with delta time
 */
function gameLoop(currentTime) {
  // Calculate delta time in seconds
  deltaTime = (currentTime - lastTime) / 1000;
  lastTime = currentTime;

  // Cap delta time to prevent huge jumps (e.g., when tab is inactive)
  deltaTime = Math.min(deltaTime, 0.1);

  // Update and render
  update(deltaTime);
  render();

  // Request next frame
  requestAnimationFrame(gameLoop);
}

/**
 * Resize canvas to match display
 */
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const width = window.innerWidth;
  const height = window.innerHeight;

  // Track logical dimensions for particle bounds
  canvasWidth = width;
  canvasHeight = height;

  // Set canvas buffer size (scaled for DPR)
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';

  // Reset transform then apply DPR scale (scale is cumulative, must reset first)
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  window.rainydesk.log(`Canvas resized to ${width}x${height} (DPR: ${dpr})`);
}

/**
 * Initialize the rain simulation
 */
async function init() {
  window.rainydesk.log('Initializing RainyDesk renderer...');

  // Register IPC listeners FIRST (before any awaits) to avoid race conditions
  window.rainydesk.onDisplayInfo((info) => {
    displayInfo = info;
    window.rainydesk.log(`Display ${info.index}: ${info.bounds.width}x${info.bounds.height} @ ${info.refreshRate}Hz`);
  });

  window.rainydesk.onToggleRain((enabled) => {
    config.enabled = enabled;
    window.rainydesk.log(`Rain ${enabled ? 'enabled' : 'disabled'}`);
  });

  window.rainydesk.onSetIntensity((value) => {
    config.intensity = value;
    window.rainydesk.log(`Intensity set to ${value}%`);
  });

  window.rainydesk.onSetVolume((value) => {
    config.volume = value;
    window.rainydesk.log(`Volume set to ${value}%`);
  });

  // Set up canvas - window.innerWidth/Height are correct per-window
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Get initial config from main process
  const initialConfig = await window.rainydesk.getConfig();
  config.enabled = initialConfig.rainEnabled;
  config.intensity = initialConfig.intensity;
  config.volume = initialConfig.volume;

  // Start the game loop
  window.rainydesk.log(`Starting rain simulation... Canvas: ${canvasWidth}x${canvasHeight}`);
  requestAnimationFrame(gameLoop);
}

// Start when DOM is ready
document.addEventListener('DOMContentLoaded', init);
