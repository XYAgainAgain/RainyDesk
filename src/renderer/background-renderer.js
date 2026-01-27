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
  // Wait for Tauri API
  if (!window.rainydesk) {
    console.warn('[Background] Waiting for Tauri API...');
    await new Promise(resolve => setTimeout(resolve, 100));
    if (!window.rainydesk) {
      console.error('[Background] Tauri API not available');
      return;
    }
  }

  window.rainydesk.log('[Background] Initializing...');

  // Get display info
  try {
    displayInfo = await window.rainydesk.getDisplayInfo();
    window.rainydesk.log(`[Background] Display ${displayInfo.index}: ${displayInfo.bounds.width}x${displayInfo.bounds.height}`);
  } catch (e) {
    console.warn('[Background] getDisplayInfo failed:', e);
  }

  // Initialize WebGL renderer
  try {
    renderer = new WebGLRainRenderer(canvas);
    renderer.init();
    window.rainydesk.log('[Background] WebGL renderer initialized');
  } catch (error) {
    window.rainydesk.log(`[Background] WebGL init failed: ${error.message}`);
    console.error('[Background] WebGL init failed:', error);
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

  // Listen for parameter updates from overlay windows
  window.rainydesk.onUpdateRainscapeParam((path, value) => {
    window.rainydesk.log(`[Background] Param: ${path} = ${value}`);

    if (path === 'physics.wind') {
      renderer.setBackgroundRainConfig({ wind: value / 100 });
    }

    if (path === 'physics.intensity') {
      // Intensity controls everything for background rain
      const normalized = value / 100;
      const layers = Math.max(1, Math.round(1 + normalized * 4)); // 1-5 layers
      const speed = 0.5 + normalized; // 0.5x to 1.5x speed
      renderer.setBackgroundRainConfig({
        intensity: normalized,
        layerCount: layers,
        speed: speed
      });
    }

    if (path === 'physics.renderScale') {
      renderScale = Math.max(0.125, Math.min(1.0, value));
      resizeCanvas();
    }

    if (path === 'backgroundRain.enabled') {
      renderer.setBackgroundRainConfig({ enabled: Boolean(value) });
    }
  });

  // Start render loop
  requestAnimationFrame(renderLoop);
  window.rainydesk.log('[Background] Initialization complete');
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
