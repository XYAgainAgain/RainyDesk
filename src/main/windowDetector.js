/**
 * Window Detector Module
 * Polls for visible windows and broadcasts positions to renderers
 * Uses get-windows (sindresorhus) for cross-platform window enumeration
 */

let pollInterval = null;
let overlayIds = new Set();
let getWindowsModule = null;

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

module.exports = { start, stop, isRunning, getFilteredWindows };
