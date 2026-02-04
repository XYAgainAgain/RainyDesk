/**
 * RainyDesk Background Renderer
 * Minimal renderer for atmospheric background rain (desktop-level windows)
 * No physics, no audio, no UI - just the procedural rain shader
 *
 * SEQUENTIAL STARTUP ARCHITECTURE:
 * 1. Hide canvas immediately (synchronous)
 * 2. Wait for Tauri API
 * 3. Get virtual desktop info
 * 4. Init WebGL renderer
 * 5. Register event listeners
 * 6. Start render loop (hidden)
 * 7. Signal ready, wait for coordinated fade-in
 */

import WebGLRainRenderer from './webgl/WebGLRainRenderer.js';

// PHASE 1: Hide canvas (only on first load, not hot-reloads)
const canvas = document.getElementById('rain-canvas');

// Check if we recently initialized (within last 30 seconds) - survives WebView recreation
const lastInit = parseInt(localStorage.getItem('__RAINYDESK_BACKGROUND_INIT_TIME__') || '0', 10);
const isRecentInit = (Date.now() - lastInit) < 30000;

if (!isRecentInit) {
  canvas.style.opacity = '0';
  canvas.style.visibility = 'hidden';
  canvas.style.transition = 'opacity 5s ease-in-out';
} else {
  console.log('[Background] Skipping canvas hide - recent init detected');
}

let renderer = null;
let renderScale = 0.25;
let virtualDesktop = null;
let lastTime = performance.now();

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
 * Resize canvas to full virtual desktop
 */
function resizeCanvas() {
  const width = virtualDesktop?.width || window.innerWidth;
  const height = virtualDesktop?.height || window.innerHeight;
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  if (renderer) {
    renderer.resize(width, height, 1, renderScale);
  }
  window.rainydesk?.log?.(`[Background] Canvas resized to ${width}x${height}`);
}

/**
 * Render loop
 */
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

/**
 * Register all event listeners
 */
function registerEventListeners() {
  window.addEventListener('resize', resizeCanvas);

  window.rainydesk.onVirtualDesktop?.((info) => {
    virtualDesktop = info;
    resizeCanvas();
  });

  window.rainydesk.onToggleRain((enabled) => {
    window.rainydesk.log(`[Background] Toggle rain: enabled=${enabled}`);
    renderer.setBackgroundRainConfig({ enabled: enabled });
  });

  window.rainydesk.onUpdateRainscapeParam((path, value) => {
    if (path === 'physics.wind') {
      const wind = Math.max(-1, Math.min(1, value / 100));
      renderer.setBackgroundRainConfig({ wind });
    }

    if (path === 'physics.intensity') {
      const normalized = value / 100;
      if (normalized < 0.01) {
        renderer.setBackgroundRainConfig({ enabled: false });
      } else {
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
}

/**
 * Main initialization - SINGLE SEQUENTIAL FLOW
 */
async function init() {
  // PHASE 2: Wait for Tauri API
  await waitForTauriAPI();
  window.rainydesk.log('[Background] Initializing...');

  // PHASE 3: Get virtual desktop info
  try {
    virtualDesktop = await window.rainydesk.getVirtualDesktop();
    window.rainydesk.log(`[Background] Virtual desktop: ${virtualDesktop.width}x${virtualDesktop.height}`);
  } catch (e) {
    console.warn('[Background] getVirtualDesktop failed:', e);
    virtualDesktop = { width: window.innerWidth, height: window.innerHeight };
  }

  // PHASE 4: Init WebGL renderer
  try {
    renderer = new WebGLRainRenderer(canvas);
    renderer.init();
    window.rainydesk.log('[Background] WebGL renderer initialized');
  } catch (error) {
    window.rainydesk.log(`[Background] WebGL init failed: ${error.message}`);
    console.error('[Background] Error:', error);
    return;
  }

  renderer.setBackgroundRainConfig({
    intensity: 0.5,
    wind: 0,
    layerCount: 3,
    speed: 1.0,
    enabled: true
  });

  resizeCanvas();

  // PHASE 5: Register event listeners
  registerEventListeners();

  // PHASE 6: Start render loop (still hidden)
  requestAnimationFrame(renderLoop);
  window.rainydesk.log('[Background] Render loop started (hidden)');

  // PHASE 7: Start fade-in (no cross-window coordination needed)
  // Small delay to let render loop stabilize before showing
  setTimeout(() => {
    window.rainydesk.log('[Background] Starting fade-in');
    canvas.style.visibility = 'visible';
    canvas.style.opacity = '1';

    // Mark init time so hot-reloads don't flash (localStorage survives WebView recreation)
    localStorage.setItem('__RAINYDESK_BACKGROUND_INIT_TIME__', Date.now().toString());

    // Clean up transition after it completes
    setTimeout(() => {
      canvas.style.transition = 'none';
    }, 5000);
  }, 300);

  window.rainydesk.log('[Background] Initialization complete');
}

// INIT GUARD - prevents re-initialization on script re-execution
if (window.__RAINYDESK_BACKGROUND_INITIALIZED__) {
  window.rainydesk?.log?.('[Background] Already initialized, skipping re-init');
} else {
  window.__RAINYDESK_BACKGROUND_INITIALIZED__ = true;

  // Single entry point
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}
