/**
 * Help window renderer
 *
 * Features:
 * - Fetches USERHELP.md, renders with marked
 * - Theme sync from localStorage with diagonal wipe transitions
 * - UI Scale inheritance from panel
 * - Text size rocker (independent of UI scale, persisted)
 * - Matrix Mode auto-font swap (Departure for headers, JetBrains for body)
 * - Auto-generated TOC sidebar from headings
 * - Clickable settings folder path
 * - External link interception via Tauri bridge
 */

import { marked } from 'marked';

// Import the real theme system so we get Windows adaptive theme support
import { applyTheme as applyPanelTheme } from './rainydesk-panel/themes';

const BASE_FONT_SIZE = 12; // Default text size in pt
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 42;
const FONT_STEP = 2;
const BASE_WIDTH = 860;
const BASE_HEIGHT = 1024;

let currentTheme = '';
let currentFontSize = BASE_FONT_SIZE;

// Read persisted text size
function loadFontSize(): number {
  const saved = localStorage.getItem('help-text-size');
  if (saved) {
    const n = parseInt(saved, 10);
    if (!isNaN(n) && n >= MIN_FONT_SIZE && n <= MAX_FONT_SIZE) return n;
  }
  return BASE_FONT_SIZE;
}

function saveFontSize(size: number): void {
  localStorage.setItem('help-text-size', String(size));
}

function applyFontSize(size: number): void {
  currentFontSize = size;
  const content = document.querySelector('.help-content') as HTMLElement;
  if (content) {
    content.style.fontSize = `${size}pt`;
  }
  saveFontSize(size);
}

// Apply theme using the real panel theme system (handles Windows adaptive, etc.)
async function applyThemeToWindow(themeId: string): Promise<void> {
  await applyPanelTheme(themeId);
  currentTheme = themeId;
}

// Sync Matrix Mode font swap
function syncMatrixMode(): void {
  const helpWindow = document.querySelector('.help-window');
  if (!helpWindow) return;

  // Check if Matrix Mode is enabled by reading visual.matrixMode from localStorage
  // The panel stores this state in the DOM class, but across windows we check localStorage
  const matrixMode = localStorage.getItem('rainscaper-matrix-mode') === 'true';
  helpWindow.classList.toggle('matrix-font-mode', matrixMode);
}

// Apply UI scale from panel setting
function applyUIScale(): void {
  const scale = parseFloat(localStorage.getItem('rainscaper-ui-scale') || '1.0');
  const helpWindow = document.querySelector('.help-window') as HTMLElement;
  if (helpWindow && scale !== 1.0) {
    helpWindow.style.width = `${BASE_WIDTH}px`;
    helpWindow.style.height = `${BASE_HEIGHT}px`;
    helpWindow.style.transform = `scale(${scale})`;
  } else if (helpWindow) {
    helpWindow.style.width = '';
    helpWindow.style.height = '';
    helpWindow.style.transform = '';
  }

  // Resize the Tauri window to match
  const newWidth = Math.round(BASE_WIDTH * scale);
  const newHeight = Math.round(BASE_HEIGHT * scale);
  window.rainydesk?.resizeHelpWindow?.(newWidth, newHeight);
}

// Diagonal wipe transition (matches panel's corner wipe)
async function themeWipeTransition(newTheme: string): Promise<void> {
  const helpWindow = document.querySelector('.help-window') as HTMLElement;
  if (!helpWindow) {
    await applyThemeToWindow(newTheme);
    return;
  }

  // Capture old background
  const oldBg = getComputedStyle(helpWindow).backgroundColor;

  // Create overlay with old color
  const overlay = document.createElement('div');
  overlay.className = 'theme-wipe-overlay';
  overlay.style.background = oldBg;

  // Random corner wipe (same set as panel)
  const wipes = [
    ['polygon(0 0, 300% 0, 0 300%)', 'polygon(0 0, 0 0, 0 0)'],
    ['polygon(100% 0, 100% 300%, -200% 0)', 'polygon(100% 0, 100% 0, 100% 0)'],
    ['polygon(0 100%, 300% 100%, 0 -200%)', 'polygon(0 100%, 0 100%, 0 100%)'],
    ['polygon(100% 100%, -200% 100%, 100% -200%)', 'polygon(100% 100%, 100% 100%, 100% 100%)'],
  ];
  const wipe = wipes[Math.floor(Math.random() * wipes.length)]!;
  overlay.style.clipPath = wipe[0]!;
  document.body.appendChild(overlay);

  // Apply new theme under the overlay
  await applyThemeToWindow(newTheme);

  // Animate the wipe
  requestAnimationFrame(() => {
    overlay.style.clipPath = wipe[1]!;
    overlay.addEventListener('transitionend', () => overlay.remove());
  });
}

// Build TOC from rendered headings
function buildTOC(): void {
  const toc = document.getElementById('help-toc');
  const content = document.getElementById('help-content');
  if (!toc || !content) return;

  const headings = content.querySelectorAll('h2, h3');
  toc.innerHTML = '';

  headings.forEach((heading, i) => {
    // Add ID for scroll targeting
    const id = `heading-${i}`;
    heading.id = id;

    const btn = document.createElement('button');
    btn.className = `toc-item toc-${heading.tagName.toLowerCase()}`;
    btn.textContent = heading.textContent;
    btn.addEventListener('click', () => {
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    toc.appendChild(btn);
  });

  // Highlight active TOC item on scroll
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const id = entry.target.id;
          toc.querySelectorAll('.toc-item').forEach((item, idx) => {
            item.classList.toggle('active', `heading-${idx}` === id);
          });
          break;
        }
      }
    },
    { root: content, rootMargin: '-10% 0px -80% 0px', threshold: 0 }
  );

  headings.forEach((h) => observer.observe(h));
}

// Convert `%LOCALAPPDATA%\com.rainydesk.app\` inline code to clickable folder link
function makeFolderPathsClickable(): void {
  const content = document.getElementById('help-content');
  if (!content) return;

  const codeElements = content.querySelectorAll('code');
  codeElements.forEach((code) => {
    const text = code.textContent || '';
    // Match the settings path pattern
    if (text.includes('%LOCALAPPDATA%') && text.includes('com.rainydesk.app')) {
      const link = document.createElement('span');
      link.className = 'folder-link';
      link.textContent = text;
      link.title = 'Click to open folder';
      link.addEventListener('click', () => {
        // Use dedicated Rust command that resolves %LOCALAPPDATA% server-side
        window.rainydesk?.openAppDataFolder?.();
      });
      code.replaceWith(link);
    }
  });
}

// Intercept external links to open via Tauri bridge
function interceptLinks(): void {
  const content = document.getElementById('help-content');
  if (!content) return;

  content.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const anchor = target.closest('a');
    if (anchor && anchor.href && anchor.href.startsWith('http')) {
      e.preventDefault();
      window.rainydesk?.openUrl?.(anchor.href);
    }
  });
}

// Set up text size rocker buttons
function setupTextSizeRocker(): void {
  const downBtn = document.getElementById('text-size-down');
  const resetBtn = document.getElementById('text-size-reset');
  const upBtn = document.getElementById('text-size-up');

  downBtn?.addEventListener('click', () => {
    const next = Math.max(MIN_FONT_SIZE, currentFontSize - FONT_STEP);
    applyFontSize(next);
  });

  upBtn?.addEventListener('click', () => {
    const next = Math.min(MAX_FONT_SIZE, currentFontSize + FONT_STEP);
    applyFontSize(next);
  });

  resetBtn?.addEventListener('click', () => {
    applyFontSize(BASE_FONT_SIZE);
  });
}

// Close button handler
function setupClose(): void {
  const closeBtn = document.getElementById('help-close-btn');
  closeBtn?.addEventListener('click', () => {
    window.rainydesk?.hideHelpWindow?.();
  });
}

async function init(): Promise<void> {
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

  // Apply initial theme (using the real panel theme system)
  const initialTheme = localStorage.getItem('rainscaper-theme') || 'blue';
  await applyThemeToWindow(initialTheme);

  // Sync Matrix Mode font
  syncMatrixMode();

  // Set up close button and text size rocker
  setupClose();
  setupTextSizeRocker();

  // Apply persisted text size
  currentFontSize = loadFontSize();
  // Will apply after content loads

  // Apply UI scale
  applyUIScale();

  // Live-sync changes from other windows via localStorage events
  window.addEventListener('storage', (e) => {
    if (e.key === 'rainscaper-theme' && e.newValue && e.newValue !== currentTheme) {
      themeWipeTransition(e.newValue);
    }
    if (e.key === 'rainscaper-ui-scale') {
      applyUIScale();
    }
    if (e.key === 'rainscaper-matrix-mode') {
      syncMatrixMode();
    }
  });

  // Fetch and render USERHELP.md
  const content = document.getElementById('help-content');
  if (!content) return;

  try {
    const response = await fetch('USERHELP.md');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const markdown = await response.text();
    content.innerHTML = await marked.parse(markdown);

    // Post-render setup
    applyFontSize(currentFontSize);
    buildTOC();
    interceptLinks();
    makeFolderPathsClickable();
  } catch (err) {
    content.innerHTML = `<p class="help-loading">Failed to load help content. Error: ${err}</p>`;
  }
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
