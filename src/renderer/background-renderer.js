/**
 * RainyDesk Background Renderer
 * Minimal renderer for atmospheric background rain (desktop-level windows)
 * No physics, no audio, no UI - just the procedural rain shader
 */

import WebGLRainRenderer from './webgl/WebGLRainRenderer.js';

console.log('[Background] Module loaded');

const canvas = document.getElementById('rain-canvas');
let renderer = null;
let renderScale = 0.25;
let displayInfo = { index: 0, bounds: { width: 1920, height: 1080 } };
let lastTime = performance.now();

async function init() {
  // Wait for Tauri API with retries
  let retries = 0;
  const maxRetries = 10;
  while (!window.rainydesk && retries < maxRetries) {
    console.warn(`[Background] Waiting for Tauri API... (${retries + 1}/${maxRetries})`);
    await new Promise(resolve => setTimeout(resolve, 100));
    retries++;
  }
  if (!window.rainydesk) {
    console.error('[Background] Tauri API not available after retries');
    return;
  }

  console.log('[Background] Tauri API ready, initializing...');
  window.rainydesk.log('[Background] Initializing...');

  // Get display info
  try {
    displayInfo = await window.rainydesk.getDisplayInfo();
    const msg = `[Background] Display ${displayInfo.index}: ${displayInfo.bounds.width}x${displayInfo.bounds.height}`;
    window.rainydesk.log(msg);
    console.log(msg);
  } catch (e) {
    console.warn('[Background] getDisplayInfo failed:', e);
  }

  // Initialize WebGL renderer
  try {
    renderer = new WebGLRainRenderer(canvas);
    renderer.init();
    const msg = '[Background] WebGL renderer initialized';
    window.rainydesk.log(msg);
    console.log(msg);
  } catch (error) {
    const msg = `[Background] WebGL init failed: ${error.message}`;
    window.rainydesk.log(msg);
    console.error(msg, error);
    return;
  }

  // Set initial background rain config
  renderer.setBackgroundRainConfig({
    intensity: 0.5,
    wind: 0,
    layerCount: 3,
    speed: 1.0,
    enabled: true
  });

  // Resize canvas
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Listen for display info updates
  window.rainydesk.onDisplayInfo((info) => {
    displayInfo = info;
    resizeCanvas();
  });

  // Listen for pause/resume from tray menu
  window.rainydesk.onToggleRain((enabled) => {
    renderer.setBackgroundRainConfig({ enabled: enabled });
  });

  // Listen for parameter updates from overlay windows
  window.rainydesk.onUpdateRainscapeParam((path, value) => {
    // Log to both Tauri and console for debugging
    const msg = `[Background] Param: ${path} = ${value}`;
    window.rainydesk.log(msg);
    console.log(msg);

    if (path === 'physics.wind') {
      // Clamp wind to valid range (-1 to 1)
      const wind = Math.max(-1, Math.min(1, value / 100));
      renderer.setBackgroundRainConfig({ wind });
    }

    if (path === 'physics.intensity') {
      const normalized = value / 100;
      if (normalized < 0.01) {
        // Intensity ~0: disable background rain entirely
        renderer.setBackgroundRainConfig({ enabled: false });
      } else {
        // Scale layers 1-5 and speed 0.5-1.5x based on intensity
        const layers = Math.round(1 + normalized * 4);
        const speed = 0.5 + normalized;
        renderer.setBackgroundRainConfig({
          enabled: true,
          intensity: normalized,
          layerCount: layers,
          speed: speed
        });
      }
    }

    if (path === 'physics.renderScale') {
      renderScale = Math.max(0.125, Math.min(1.0, value));
      resizeCanvas();
    }

    // Direct background rain controls (override auto-link)
    if (path === 'backgroundRain.enabled') {
      renderer.setBackgroundRainConfig({ enabled: Boolean(value) });
    }
    if (path === 'backgroundRain.intensity') {
      renderer.setBackgroundRainConfig({ intensity: value / 100 });
    }
    if (path === 'backgroundRain.layerCount') {
      renderer.setBackgroundRainConfig({ layerCount: Math.max(1, Math.min(5, value)) });
    }
    if (path === 'backgroundRain.speed') {
      renderer.setBackgroundRainConfig({ speed: Math.max(0.1, Math.min(3, value)) });
    }
  });

  // Start render loop
  requestAnimationFrame(renderLoop);
  const initMsg = '[Background] Initialization complete';
  window.rainydesk.log(initMsg);
  console.log(initMsg);
}

function resizeCanvas() {
  const width = displayInfo.bounds?.width || window.innerWidth;
  const height = displayInfo.bounds?.height || window.innerHeight;
  canvas.width = width;
  canvas.height = height;
  if (renderer) {
    renderer.resize(width, height, 1, renderScale);
  }
}

function renderLoop() {
  const now = performance.now();
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  if (renderer) {
    renderer.clear();
    renderer.renderBackgroundOnly(dt);
  }

  requestAnimationFrame(renderLoop);
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
