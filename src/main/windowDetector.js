/**
 * Window Detector Module
 * Polls for visible windows and broadcasts positions to renderers
 * Uses get-windows (sindresorhus) for cross-platform window enumeration
 */

let pollInterval = null;
let overlayIds = new Set();
let getWindowsModule = null;
let displayBounds = []; // Display bounds for fullscreen detection

/**
 * Load the ESM-only get-windows module via dynamic import
 */
async function loadModule() {
  if (!getWindowsModule) {
    getWindowsModule = await import('get-windows');
  }
  return getWindowsModule;
}

/**
 * Get filtered list of visible windows
 * Excludes: overlay windows, minimized windows, empty titles
 */
async function getFilteredWindows() {
  try {
    const { openWindows } = await loadModule();
    const allWindows = await openWindows();

    return allWindows.filter(win => {
      // Skip our overlay windows by ID
      if (overlayIds.has(win.id)) return false;

      // Skip minimized windows (zero or negative bounds)
      if (!win.bounds || win.bounds.width <= 0 || win.bounds.height <= 0) return false;

      // Skip windows with empty titles (often system windows)
      if (!win.title || win.title.trim() === '') return false;

      // Skip Program Manager (desktop)
      if (win.title === 'Program Manager') return false;

      return true;
    });
  } catch (err) {
    console.error('[WindowDetector] Error enumerating windows:', err.message);
    return [];
  }
}

/**
 * Start polling for window positions
 * @param {number[]} overlayWindowIds - Native window IDs to exclude
 * @param {function} onUpdate - Callback with window data array
 * @param {number} intervalMs - Poll interval (default 250ms)
 */
function start(overlayWindowIds, onUpdate, intervalMs = 250) {
  overlayIds = new Set(overlayWindowIds);
  console.log(`[WindowDetector] Starting with ${overlayIds.size} overlay IDs to exclude`);
  console.log(`[WindowDetector] Poll interval: ${intervalMs}ms`);

  // Initial poll
  getFilteredWindows().then(windows => {
    console.log(`[WindowDetector] Initial poll found ${windows.length} windows`);
    onUpdate(windows);
  });

  // Start interval
  pollInterval = setInterval(async () => {
    const windows = await getFilteredWindows();
    onUpdate(windows);
  }, intervalMs);
}

/**
 * Stop polling
 */
function stop() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log('[WindowDetector] Stopped');
  }
}

/**
 * Check if detector is running
 */
function isRunning() {
  return pollInterval !== null;
}

/**
 * Set display bounds for fullscreen detection
 * @param {Array} displays - Array of display objects with bounds property
 */
function setDisplays(displays) {
  displayBounds = displays.map((d, index) => ({
    index,
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height
  }));
}

/**
 * Check if a window covers a display (fullscreen, maximized, or borderless)
 * A window is considered "covering" if it fills at least 95% of the display
 * @param {Object} winBounds - Window bounds { x, y, width, height }
 * @param {Object} dispBounds - Display bounds { x, y, width, height }
 * @returns {boolean}
 */
function windowCoversDisplay(winBounds, dispBounds) {
  // Check if window is positioned over this display
  const winRight = winBounds.x + winBounds.width;
  const winBottom = winBounds.y + winBounds.height;
  const dispRight = dispBounds.x + dispBounds.width;
  const dispBottom = dispBounds.y + dispBounds.height;

  // Window must overlap the display significantly
  const overlapLeft = Math.max(winBounds.x, dispBounds.x);
  const overlapTop = Math.max(winBounds.y, dispBounds.y);
  const overlapRight = Math.min(winRight, dispRight);
  const overlapBottom = Math.min(winBottom, dispBottom);

  if (overlapRight <= overlapLeft || overlapBottom <= overlapTop) {
    return false; // No overlap
  }

  const overlapWidth = overlapRight - overlapLeft;
  const overlapHeight = overlapBottom - overlapTop;
  const overlapArea = overlapWidth * overlapHeight;
  const displayArea = dispBounds.width * dispBounds.height;

  // Window covers display if overlap is at least 95% of display area
  return overlapArea >= displayArea * 0.95;
}

/**
 * Detect which displays have fullscreen/maximized windows
 * @param {Array} windows - Array of window objects from getFilteredWindows
 * @returns {Array} Array of display indices that have fullscreen windows
 */
function detectFullscreenDisplays(windows, debug = false) {
  const fullscreenDisplays = [];

  for (const display of displayBounds) {
    for (const win of windows) {
      if (debug) {
        const coverage = calculateCoverage(win.bounds, display);
        if (coverage > 0.5) {  // Log windows covering >50% of display
          console.log(`[WindowDetector] "${win.title}" covers ${(coverage * 100).toFixed(1)}% of display ${display.index}`);
          console.log(`  Window: ${JSON.stringify(win.bounds)}`);
          console.log(`  Display: ${JSON.stringify(display)}`);
        }
      }
      if (windowCoversDisplay(win.bounds, display)) {
        fullscreenDisplays.push(display.index);
        break; // One fullscreen window per display is enough
      }
    }
  }

  return fullscreenDisplays;
}

/**
 * Calculate what percentage of display a window covers (for debugging)
 */
function calculateCoverage(winBounds, dispBounds) {
  const winRight = winBounds.x + winBounds.width;
  const winBottom = winBounds.y + winBounds.height;
  const dispRight = dispBounds.x + dispBounds.width;
  const dispBottom = dispBounds.y + dispBounds.height;

  const overlapLeft = Math.max(winBounds.x, dispBounds.x);
  const overlapTop = Math.max(winBounds.y, dispBounds.y);
  const overlapRight = Math.min(winRight, dispRight);
  const overlapBottom = Math.min(winBottom, dispBottom);

  if (overlapRight <= overlapLeft || overlapBottom <= overlapTop) {
    return 0;
  }

  const overlapArea = (overlapRight - overlapLeft) * (overlapBottom - overlapTop);
  const displayArea = dispBounds.width * dispBounds.height;
  return overlapArea / displayArea;
}

module.exports = { start, stop, isRunning, getFilteredWindows, setDisplays, detectFullscreenDisplays };
