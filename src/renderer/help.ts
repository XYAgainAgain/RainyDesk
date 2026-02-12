/* Help window displays USERHELP.md + TOC via marked.js, syncs theme, has text size rocker,
 * auto font swap per mode, has clickable settings folder path, and ignores normal UI scaler */

import { marked } from 'marked';

import { applyTheme as applyPanelTheme, applyCustomTheme } from './rainydesk-panel/themes';

const BASE_FONT_SIZE = 12; // Default text size in pt
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 42;
const FONT_STEP = 2;
// Window size is now calculated by Rust (75% of primary monitor's shorter dimension)

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

// Apply theme as per panel (built-in or custom)
async function applyThemeToWindow(themeId: string): Promise<void> {
  if (themeId.startsWith('custom-')) {
    try {
      const themesFile = await window.rainydesk.loadUserThemes();
      if (themesFile?.themes) {
        const match = themesFile.themes.find((t: { id: string }) => t.id === themeId);
        if (match) {
          applyCustomTheme(match);
          currentTheme = themeId;
          return;
        }
      }
    } catch { /* fall through to blue */ }
    // Custom theme not found or load failed — fall back to default
    await applyPanelTheme('blue');
    currentTheme = 'blue';
    return;
  }
  await applyPanelTheme(themeId);
  currentTheme = themeId;
}

// Sync Matrix Mode font swap
function syncMatrixMode(): void {
  const helpWindow = document.querySelector('.help-window');
  if (!helpWindow) return;

  // Matrix Mode font swap logic; uses localStorage
  const matrixMode = localStorage.getItem('rainscaper-matrix-mode') === 'true';
  helpWindow.classList.toggle('matrix-font-mode', matrixMode);
}

// CSS zoom on #help-root (not <html>) so theme wipe overlay stays full-viewport
function applyUIScale(): void {
  const scale = parseFloat(localStorage.getItem('rainscaper-ui-scale') || '1.0');
  const root = document.getElementById('help-root');
  if (root) root.style.zoom = scale !== 1.0 ? `${scale}` : '';
}

// Fancy matchy-matchy wipe transition
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

  // Force the browser to commit the initial clip-path before animating.
  // Without this, the initial and final states can batch into one paint frame.
  overlay.getBoundingClientRect();

  // Animate the wipe
  requestAnimationFrame(() => {
    overlay.style.clipPath = wipe[1]!;
    overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
    // Fallback: remove overlay if transitionend never fires (reduced motion, etc.)
    setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 700);
  });
}

// Build TOC from rendered headings
function buildTOC(): void {
  const toc = document.getElementById('help-toc');
  const content = document.getElementById('help-content');
  if (!toc || !content) return;

  const headings = content.querySelectorAll('h2, h3');

  // Create scrollable items wrapper + fixed footer
  toc.innerHTML = '';
  const itemsWrap = document.createElement('div');
  itemsWrap.className = 'help-toc-items';

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
    itemsWrap.appendChild(btn);
  });

  toc.appendChild(itemsWrap);

  // Retune button pinned at bottom of TOC
  const footer = document.createElement('div');
  footer.className = 'help-toc-footer';
  const retuneBtn = document.createElement('button');
  retuneBtn.className = 'retune-btn';
  retuneBtn.title = 'Pick a performance preset';
  // Gear icon (assets/icons/weather/gear.svg, stroke swapped to currentColor)
  retuneBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M15 12C15 13.6569 13.6569 15 12 15C10.3431 15 9 13.6569 9 12C9 10.3431 10.3431 9 12 9C13.6569 9 15 10.3431 15 12Z"/>
    <path d="M12.9046 3.06005C12.6988 3 12.4659 3 12 3C11.5341 3 11.3012 3 11.0954 3.06005C10.7942 3.14794 10.5281 3.32808 10.3346 3.57511C10.2024 3.74388 10.1159 3.96016 9.94291 4.39272C9.69419 5.01452 9.00393 5.33471 8.36857 5.123L7.79779 4.93281C7.3929 4.79785 7.19045 4.73036 6.99196 4.7188C6.70039 4.70181 6.4102 4.77032 6.15701 4.9159C5.98465 5.01501 5.83376 5.16591 5.53197 5.4677C5.21122 5.78845 5.05084 5.94882 4.94896 6.13189C4.79927 6.40084 4.73595 6.70934 4.76759 7.01551C4.78912 7.2239 4.87335 7.43449 5.04182 7.85566C5.30565 8.51523 5.05184 9.26878 4.44272 9.63433L4.16521 9.80087C3.74031 10.0558 3.52786 10.1833 3.37354 10.3588C3.23698 10.5141 3.13401 10.696 3.07109 10.893C3 11.1156 3 11.3658 3 11.8663C3 12.4589 3 12.7551 3.09462 13.0088C3.17823 13.2329 3.31422 13.4337 3.49124 13.5946C3.69158 13.7766 3.96395 13.8856 4.50866 14.1035C5.06534 14.3261 5.35196 14.9441 5.16236 15.5129L4.94721 16.1584C4.79819 16.6054 4.72367 16.829 4.7169 17.0486C4.70875 17.3127 4.77049 17.5742 4.89587 17.8067C5.00015 18.0002 5.16678 18.1668 5.5 18.5C5.83323 18.8332 5.99985 18.9998 6.19325 19.1041C6.4258 19.2295 6.68733 19.2913 6.9514 19.2831C7.17102 19.2763 7.39456 19.2018 7.84164 19.0528L8.36862 18.8771C9.00393 18.6654 9.6942 18.9855 9.94291 19.6073C10.1159 20.0398 10.2024 20.2561 10.3346 20.4249C10.5281 20.6719 10.7942 20.8521 11.0954 20.94C11.3012 21 11.5341 21 12 21C12.4659 21 12.6988 21 12.9046 20.94C13.2058 20.8521 13.4719 20.6719 13.6654 20.4249C13.7976 20.2561 13.8841 20.0398 14.0571 19.6073C14.3058 18.9855 14.9961 18.6654 15.6313 18.8773L16.1579 19.0529C16.605 19.2019 16.8286 19.2764 17.0482 19.2832C17.3123 19.2913 17.5738 19.2296 17.8063 19.1042C17.9997 18.9999 18.1664 18.8333 18.4996 18.5001C18.8328 18.1669 18.9994 18.0002 19.1037 17.8068C19.2291 17.5743 19.2908 17.3127 19.2827 17.0487C19.2759 16.8291 19.2014 16.6055 19.0524 16.1584L18.8374 15.5134C18.6477 14.9444 18.9344 14.3262 19.4913 14.1035C20.036 13.8856 20.3084 13.7766 20.5088 13.5946C20.6858 13.4337 20.8218 13.2329 20.9054 13.0088C21 12.7551 21 12.4589 21 11.8663C21 11.3658 21 11.1156 20.9289 10.893C20.866 10.696 20.763 10.5141 20.6265 10.3588C20.4721 10.1833 20.2597 10.0558 19.8348 9.80087L19.5569 9.63416C18.9478 9.26867 18.6939 8.51514 18.9578 7.85558C19.1262 7.43443 19.2105 7.22383 19.232 7.01543C19.2636 6.70926 19.2003 6.40077 19.0506 6.13181C18.9487 5.94875 18.7884 5.78837 18.4676 5.46762C18.1658 5.16584 18.0149 5.01494 17.8426 4.91583C17.5894 4.77024 17.2992 4.70174 17.0076 4.71872C16.8091 4.73029 16.6067 4.79777 16.2018 4.93273L15.6314 5.12287C14.9961 5.33464 14.3058 5.0145 14.0571 4.39272C13.8841 3.96016 13.7976 3.74388 13.6654 3.57511C13.4719 3.32808 13.2058 3.14794 12.9046 3.06005Z"/>
  </svg>Performance`;
  retuneBtn.addEventListener('click', () => showOnboardingOverlay());
  footer.appendChild(retuneBtn);
  toc.appendChild(footer);

  // Highlight active TOC item on scroll
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const id = entry.target.id;
          itemsWrap.querySelectorAll('.toc-item').forEach((item, idx) => {
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

// Convert folder path inline codes to clickable folder links
function makeFolderPathsClickable(): void {
  const content = document.getElementById('help-content');
  if (!content) return;

  const codeElements = content.querySelectorAll('code');
  codeElements.forEach((code) => {
    const text = code.textContent || '';

    // Rainscapes folder: Documents\RainyDesk
    if (text.includes('Documents') && text.includes('RainyDesk')) {
      const link = document.createElement('span');
      link.className = 'folder-link';
      link.textContent = text;
      link.title = 'Click to open folder';
      link.addEventListener('click', () => {
        window.rainydesk?.openRainscapesFolder?.();
      });
      code.replaceWith(link);
      return;
    }

    // Logs folder: %LOCALAPPDATA%\com.rainydesk.app\logs
    if (text.includes('%LOCALAPPDATA%') && text.includes('com.rainydesk.app')) {
      const link = document.createElement('span');
      link.className = 'folder-link';
      link.textContent = text;
      link.title = 'Click to open folder';
      link.addEventListener('click', () => {
        window.rainydesk?.openLogsFolder?.();
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

function setupWindowControls(): void {
  document.getElementById('help-close-btn')?.addEventListener('click', () => {
    window.rainydesk?.hideHelpWindow?.();
  });

  const maxBtn = document.getElementById('help-maximize-btn');
  maxBtn?.addEventListener('click', async () => {
    const isNowMaximized = await window.rainydesk?.toggleMaximizeHelpWindow?.();
    maxBtn.classList.toggle('is-maximized', isNowMaximized);
  });
}

// ── Onboarding Performance Preset Picker ──

interface PerformanceTier {
  name: string;
  desc: string;
  specs: string;
  intensity: number;
  fpsLimit: number;
  gridScale: number;
  renderScale: number;
  backgroundRain: boolean;
  windowCollision: boolean;
  masterVolume: number; // dB
}

const PRESET_SVG_ATTR = 'width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle;margin-right:4px"';
const PRESET_ICONS: Record<string, string> = {
  Potato: `<svg ${PRESET_SVG_ATTR}><path d="M21 14.7C21 18.1794 19.0438 21 15.5 21C11.9562 21 10 18.1794 10 14.7C10 11.2206 15.5 3 15.5 3C15.5 3 21 11.2206 21 14.7Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 8.2C8 9.7464 7.11083 11 5.5 11C3.88917 11 3 9.7464 3 8.2C3 6.6536 5.5 3 5.5 3C5.5 3 8 6.6536 8 8.2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  Light: `<svg ${PRESET_SVG_ATTR}><path d="M10.5 21L12 18M14.5 21L16 18M6.5 21L8 18M8.8 15C6.14903 15 4 12.9466 4 10.4137C4 8.31435 5.6 6.375 8 6C8.75283 4.27403 10.5346 3 12.6127 3C15.2747 3 17.4504 4.99072 17.6 7.5C19.0127 8.09561 20 9.55741 20 11.1402C20 13.2719 18.2091 15 16 15L8.8 15Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  Balanced: `<svg ${PRESET_SVG_ATTR}><path d="M16 13V20M4 14.7519C3.37037 13.8768 3 12.8059 3 11.6493C3 9.20008 4.8 6.9375 7.5 6.5C8.34694 4.48637 10.3514 3 12.6893 3C15.684 3 18.1317 5.32251 18.3 8.25C19.8893 8.94488 21 10.6503 21 12.4969C21 13.4232 20.7205 14.2842 20.2413 15M12 14V21M8 13V20" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  Cranked: `<svg ${PRESET_SVG_ATTR}><path d="M19.3278 16C20.3478 15.1745 21 13.9119 21 12.4969C21 10.6503 19.8893 8.94488 18.3 8.25C18.1317 5.32251 15.684 3 12.6893 3C10.3514 3 8.34694 4.48637 7.5 6.5C4.8 6.9375 3 9.20008 3 11.6493C3 13.1613 3.63296 14.5269 4.65065 15.5M8 18V20M8 12V14M12 19V21M16 18V20M16 12V14M12 13V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

const PERFORMANCE_TIERS: PerformanceTier[] = [
  {
    name: 'Potato',
    desc: 'Integrated graphics, old hardware, or battery saving.',
    specs: 'Potato grid, Lo-Fi render, 30 FPS, no background, no collision',
    intensity: 15,
    fpsLimit: 30,
    gridScale: 0.0625,
    renderScale: 0.125,
    backgroundRain: false,
    windowCollision: false,
    masterVolume: -30,
  },
  {
    name: 'Light',
    desc: 'Entry-level dedicated GPU or a capable laptop.',
    specs: 'Chunky grid, Pixel render, 60 FPS, no background',
    intensity: 30,
    fpsLimit: 60,
    gridScale: 0.125,
    renderScale: 0.25,
    backgroundRain: false,
    windowCollision: true,
    masterVolume: -18,
  },
  {
    name: 'Balanced',
    desc: 'Mid-range GPU. The recommended default.',
    specs: 'Normal grid, Pixel render, 60 FPS, background on',
    intensity: 50,
    fpsLimit: 60,
    gridScale: 0.25,
    renderScale: 0.25,
    backgroundRain: true,
    windowCollision: true,
    masterVolume: -6,
  },
  {
    name: 'Cranked',
    desc: 'High-end GPU with headroom to spare. Go all out.',
    specs: 'Detailed grid, Clean render, uncapped FPS, background on',
    intensity: 70,
    fpsLimit: 0,
    gridScale: 0.5,
    renderScale: 0.5,
    backgroundRain: true,
    windowCollision: true,
    masterVolume: -6,
  },
];

function needsOnboarding(): boolean {
  return !localStorage.getItem('rainydesk-onboarding-complete');
}

function showOnboardingOverlay(): void {
  const helpBody = document.querySelector('.help-body') as HTMLElement;
  if (!helpBody) return;
  // Don't stack multiple overlays
  if (helpBody.querySelector('.onboarding-overlay')) return;
  helpBody.style.position = 'relative';
  helpBody.appendChild(createOnboardingOverlay(false));
}

function createOnboardingOverlay(isFirstLaunch = true): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = 'onboarding-overlay';

  const title = document.createElement('div');
  title.className = 'onboarding-title';
  title.textContent = isFirstLaunch ? 'Welcome to RainyDesk!' : 'Performance Presets';

  const subtitle = document.createElement('div');
  subtitle.className = 'onboarding-subtitle';
  subtitle.textContent = isFirstLaunch
    ? 'Pick a performance tier to match your hardware. You can tweak everything later in the Rainscaper panel.'
    : 'Pick a tier to reset your settings to a performance baseline.';

  const cards = document.createElement('div');
  cards.className = 'onboarding-cards';

  for (const tier of PERFORMANCE_TIERS) {
    const card = document.createElement('button');
    card.className = 'onboarding-card';

    const name = document.createElement('div');
    name.className = 'onboarding-card-name';
    name.innerHTML = `${PRESET_ICONS[tier.name] || ''}${tier.name}`;

    const desc = document.createElement('div');
    desc.className = 'onboarding-card-desc';
    desc.textContent = tier.desc;

    const specs = document.createElement('div');
    specs.className = 'onboarding-card-specs';
    specs.textContent = tier.specs;

    card.appendChild(name);
    card.appendChild(desc);
    card.appendChild(specs);

    card.addEventListener('click', () => applyPerformanceTier(tier, overlay));
    cards.appendChild(card);
  }

  overlay.appendChild(title);
  overlay.appendChild(subtitle);
  overlay.appendChild(cards);
  return overlay;
}

async function applyPerformanceTier(tier: PerformanceTier, overlay: HTMLElement): Promise<void> {
  // Disable all cards to prevent double-clicks
  overlay.querySelectorAll('.onboarding-card').forEach((card) => {
    (card as HTMLButtonElement).disabled = true;
  });

  const update = window.rainydesk?.updateRainscapeParam;
  if (!update) return;

  // Send params in sequence -- each goes through Rust IPC to all windows
  update('physics.intensity', tier.intensity);
  update('physics.fpsLimit', tier.fpsLimit);
  update('physics.renderScale', tier.renderScale);
  update('effects.masterVolume', tier.masterVolume);
  update('backgroundRain.enabled', tier.backgroundRain);
  update('system.windowCollision', tier.windowCollision);

  // Grid scale change requires a physics reinit (sends the scale value)
  update('physics.resetSimulation', tier.gridScale);

  localStorage.setItem('rainydesk-onboarding-complete', 'true');

  // Small delay for params to propagate, then fade out
  await new Promise(r => setTimeout(r, 500));
  overlay.classList.add('fade-out');
  // Safety net: remove after 600ms even if transitionend doesn't fire
  const removeOverlay = () => overlay.remove();
  overlay.addEventListener('transitionend', removeOverlay, { once: true });
  setTimeout(removeOverlay, 600);
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

  // Apply initial theme
  const initialTheme = localStorage.getItem('rainscaper-theme') || 'blue';
  await applyThemeToWindow(initialTheme);

  // Sync Matrix Mode font
  syncMatrixMode();

  setupWindowControls();
  setupTextSizeRocker();

  currentFontSize = loadFontSize();
  // Will apply after content loads

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
    // Live custom theme sync (instant updates during editor fiddling, no wipe)
    if (e.key === 'rainscaper-custom-theme-sync' && e.newValue) {
      try { applyCustomTheme(JSON.parse(e.newValue)); } catch { /* ignore */ }
    }
  });

  // Show onboarding overlay on first launch (covers help-body area)
  if (needsOnboarding()) {
    const helpBody = document.querySelector('.help-body') as HTMLElement;
    if (helpBody) {
      helpBody.style.position = 'relative';
      helpBody.appendChild(createOnboardingOverlay(true));
    }
  }

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
