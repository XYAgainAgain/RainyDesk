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
let isPaused = false;
let isFullscreenActive = false;
let lastTime = performance.now();
let fpsLimit = 0;
let lastFrameTime = 0;

// Matrix Mode (background layer)
let matrixMode = false;
let matrixRenderer = null;
let matrixCanvas = null; // Separate canvas for Matrix Mode (avoids WebGL context conflicts)

/* Wait for Tauri API to be available */
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

/* Resize canvas to full virtual desktop */
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
  window.rainydesk?.log?.(`[Background] Canvas resized to ${width}x${height}, dpr=${window.devicePixelRatio}`);
}

/* Render loop */
function renderLoop() {
  const now = performance.now();

  // FPS limiting via ideal-time accumulation
  if (fpsLimit > 0) {
    const minFrameTime = 1000 / fpsLimit;
    const elapsed = now - lastFrameTime;
    if (elapsed > 1000) {
      lastFrameTime = now;
    } else if (elapsed < minFrameTime * 0.97) {
      requestAnimationFrame(renderLoop);
      return;
    } else {
      lastFrameTime += minFrameTime;
      if (now - lastFrameTime > minFrameTime) lastFrameTime = now;
    }
  }

  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  if (!isPaused && !isFullscreenActive) {
    if (matrixMode && matrixRenderer) {
      matrixRenderer.update(dt);
      matrixRenderer.render();
    } else if (renderer) {
      renderer.clear();
      renderer.renderBackgroundOnly(dt);
    }
  }

  requestAnimationFrame(renderLoop);
}

/* Register all event listeners */
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

    if (path === 'physics.fpsLimit') {
      fpsLimit = Number(value) || 0;
    }

    if (path === 'physics.renderScale') {
      renderScale = Math.max(0.125, Math.min(1.0, value));
      resizeCanvas();
    }

    if (path === 'backgroundRain.enabled') {
      renderer.setBackgroundRainConfig({ enabled: Boolean(value) });
      // Also toggle BG matrix visibility when in Matrix Mode
      if (matrixMode && matrixCanvas) {
        matrixCanvas.style.display = Boolean(value) ? 'block' : 'none';
      }
    }
    if (path === 'backgroundRain.intensity') {
      renderer.setBackgroundRainConfig({ intensity: value / 100 });
      // Sync intensity to BG matrix alpha (0-100 → 0.1-0.6 alpha range)
      if (matrixRenderer) {
        matrixRenderer.setAlphaMult(0.1 + (value / 100) * 0.5);
      }
    }
    if (path === 'backgroundRain.layerCount' || path === 'backgroundRain.layers') {
      renderer.setBackgroundRainConfig({ layerCount: Math.max(1, Math.min(5, value)) });
    }
    if (path === 'backgroundRain.speed') {
      renderer.setBackgroundRainConfig({ speed: Math.max(0.1, Math.min(3, value)) });
    }

    if (path === 'system.paused') {
      isPaused = Boolean(value);
      window.rainydesk.log(`[Background] Pause state: ${isPaused ? 'PAUSED' : 'RESUMED'}`);
    }

    // Gay Mode / Rainbow Mode sync
    if (path === 'visual.gayMode' || path === 'visual.rainbowMode') {
      renderer.setBackgroundRainConfig({ rainbowMode: Boolean(value) });
      // Sync Gaytrix to background matrix
      if (matrixRenderer) {
        matrixRenderer.setGaytrixMode(Boolean(value));
      }
    }

    if (path === 'visual.rainbowSpeed') {
      renderer.setBackgroundRainConfig({ rainbowSpeed: Number(value) || 1 });
    }

    // Trans Mode sync (background matrix layer)
    if (path === 'visual.transMode') {
      if (matrixRenderer) {
        matrixRenderer.setTransMode(Boolean(value));
      }
    }
    if (path === 'visual.transScrollDirection') {
      if (matrixRenderer) {
        matrixRenderer.setTransScrollDirection(String(value));
      }
    }

    // Reverse Gravity sync (affects both normal rain shader and Matrix mode)
    if (path === 'physics.reverseGravity') {
      renderer.setBackgroundRainConfig({ reverseGravity: Boolean(value) });
      // Sync to background matrix
      if (matrixRenderer) {
        matrixRenderer.setReverseGravity(Boolean(value));
      }
    }

    // Matrix Mode
    if (path === 'visual.matrixMode') {
      matrixMode = Boolean(value);
      if (matrixMode) {
        // Hide rain shader canvas, create separate matrix canvas
        canvas.style.display = 'none';
        renderer.setBackgroundRainConfig({ enabled: false });

        // Create separate canvas for Matrix Mode (avoids WebGL context conflicts)
        matrixCanvas = document.createElement('canvas');
        matrixCanvas.id = 'matrix-bg-canvas';
        matrixCanvas.style.cssText = canvas.style.cssText;
        matrixCanvas.style.display = 'block';
        matrixCanvas.width = canvas.width;
        matrixCanvas.height = canvas.height;
        document.body.appendChild(matrixCanvas);

        // Init background matrix
        initBackgroundMatrix();
      } else {
        // Destroy matrix and its canvas
        destroyBackgroundMatrix();
        // Show rain shader canvas
        canvas.style.display = 'block';
        renderer.setBackgroundRainConfig({ enabled: true });
      }
    }

    // Rain Color sync
    if (path === 'visual.rainColor') {
      const hex = value.replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;
      renderer.setBackgroundRainConfig({ colorTint: [r, g, b] });
      // Sync to background matrix
      if (matrixRenderer) {
        matrixRenderer.setRainColor(String(value));
      }
    }

    // CRT Filter intensity (Matrix Mode only, 0-1)
    if (path === 'visual.crtIntensity') {
      if (matrixRenderer) {
        matrixRenderer.setCrtIntensity(Number(value));
      }
    }
  });

  // Reinit status: pause background during overlay reset
  window.rainydesk.onReinitStatus?.((status) => {
    if (status === 'stopped' || status === 'initializing') {
      isPaused = true;
      canvas.style.opacity = '0';
      if (matrixCanvas) matrixCanvas.style.opacity = '0';
      window.rainydesk.log(`[Background] Reinit: ${status} — hiding`);
    } else if (status === 'raining') {
      isPaused = false;
      if (!isFullscreenActive) {
        canvas.style.opacity = '1';
        if (matrixCanvas) matrixCanvas.style.opacity = '1';
      }
      window.rainydesk.log('[Background] Reinit complete — showing');
    }
  });

  // Per-monitor fullscreen state from overlay
  window.rainydesk.onFullscreenMonitors?.((indices) => {
    const monitorCount = virtualDesktop?.monitors?.length || 1;
    isFullscreenActive = indices.length >= monitorCount;
    window.rainydesk.log(`[Background] Fullscreen monitors: [${indices}], hiding=${isFullscreenActive}`);
  });
}

/* Initialize background Matrix renderer (dimmed, no collision) */
async function initBackgroundMatrix() {
  if (matrixRenderer || !matrixCanvas) {
    window.rainydesk?.log?.(`[Background] initBackgroundMatrix skipped: renderer=${!!matrixRenderer}, canvas=${!!matrixCanvas}`);
    return;
  }

  try {
    window.rainydesk.log('[Background] Importing simulation.bundle.js for Matrix...');
    const module = await import('./simulation.bundle.js');
    window.rainydesk.log(`[Background] Import OK, MatrixPixiRenderer: ${typeof module.MatrixPixiRenderer}`);

    const { MatrixPixiRenderer } = module;
    if (!MatrixPixiRenderer) {
      throw new Error('MatrixPixiRenderer not exported from simulation.bundle.js');
    }

    const width = virtualDesktop?.width || window.innerWidth;
    const height = virtualDesktop?.height || window.innerHeight;
    window.rainydesk.log(`[Background] Creating MatrixPixiRenderer: ${width}x${height}`);

    matrixRenderer = new MatrixPixiRenderer({
      canvas: matrixCanvas,
      width,
      height,
      dimmed: true,
      speedMultiplier: 0.5,
      alphaMultiplier: 0.4,
      collisionEnabled: false,
    });
    await matrixRenderer.init();
    window.rainydesk.log('[Background] Matrix renderer initialized (dimmed layer)');
  } catch (err) {
    window.rainydesk.log(`[Background] Failed to init matrix: ${err?.message || err}`);
    if (err?.stack) {
      window.rainydesk.log(`[Background] Stack: ${err.stack.substring(0, 300)}`);
    }
    // Clean up broken instance so render loop doesn't try to use it
    if (matrixRenderer) {
      try { matrixRenderer.destroy(); } catch (_) { /* ignore */ }
      matrixRenderer = null;
    }
    // Fallback: re-enable rain shader so SOMETHING renders in the background
    if (matrixCanvas) {
      matrixCanvas.remove();
      matrixCanvas = null;
    }
    canvas.style.display = 'block';
    renderer.setBackgroundRainConfig({ enabled: true });
    window.rainydesk.log('[Background] Falling back to rain shader (matrix init failed)');
  }
}

/* Destroy background Matrix renderer */
function destroyBackgroundMatrix() {
  if (matrixRenderer) {
    matrixRenderer.destroy();
    matrixRenderer = null;
  }
  if (matrixCanvas) {
    matrixCanvas.remove();
    matrixCanvas = null;
  }
  window.rainydesk.log('[Background] Matrix renderer destroyed');
}

/* Main initialization */
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

  // Set initial defaults
  renderer.setBackgroundRainConfig({
    intensity: 0.5,
    wind: 0,
    layerCount: 3,
    speed: 1.0,
    enabled: true
  });

  // Try to load startup rainscape settings
  try {
    const startup = await window.rainydesk.getStartupRainscape();
    if (startup && startup.data) {
      const data = startup.data;
      // Apply rain settings
      if (data.rain && typeof data.rain === 'object') {
        const rain = data.rain;
        if (typeof rain.intensity === 'number') {
          const normalized = rain.intensity / 100;
          renderer.setBackgroundRainConfig({
            intensity: normalized,
            layerCount: Math.round(1 + normalized * 4),
            speed: 0.5 + normalized
          });
        }
        if (typeof rain.wind === 'number') {
          const wind = Math.max(-1, Math.min(1, rain.wind / 100));
          renderer.setBackgroundRainConfig({ wind });
        }
      }
      // FPS limit
      if (data.system && typeof data.system.fpsLimit === 'number') {
        fpsLimit = data.system.fpsLimit;
      }
      window.rainydesk.log('[Background] Applied startup rainscape settings');
    }
  } catch (err) {
    window.rainydesk.log(`[Background] Failed to load startup rainscape: ${err}`);
  }

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
