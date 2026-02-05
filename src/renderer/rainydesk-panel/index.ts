/**
 * RainyDesk Panel - Standalone Rainscaper Window
 *
 * Entry point for the standalone Rainscaper panel window.
 * Separate from the overlay, communicates via Tauri IPC.
 */

import { RainyDeskPanel } from './RainyDeskPanel';

// Wait for DOM and Tauri API
async function init() {
  // Wait for Tauri API
  await new Promise<void>((resolve) => {
    if (window.rainydesk) {
      resolve();
      return;
    }
    const check = setInterval(() => {
      if (window.rainydesk) {
        clearInterval(check);
        resolve();
      }
    }, 50);
  });

  window.rainydesk.log('[RainyDeskPanel] Initializing...');

  const root = document.getElementById('rainscaper-root');
  if (!root) {
    console.error('Root element not found');
    return;
  }

  const panel = new RainyDeskPanel(root);
  await panel.init();

  window.rainydesk.log('[RainyDeskPanel] Ready');
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
