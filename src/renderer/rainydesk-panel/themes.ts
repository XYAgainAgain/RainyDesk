/**
 * RainyDesk Panel - Theme System
 *
 * Theme definitions and switching logic.
 */

export interface Theme {
  name: string;
  cssClass: string;
}

export const themes: Record<string, Theme> = {
  blue: { name: 'Blue', cssClass: 'blue' },
  purple: { name: 'Purple', cssClass: 'purple' },
  warm: { name: 'Warm', cssClass: 'warm' },
  sakura: { name: 'Sakura', cssClass: 'sakura' },
  forest: { name: 'Forest', cssClass: 'forest' },
  midnight: { name: 'Midnight', cssClass: 'midnight' },
  lavender: { name: 'Lavender', cssClass: 'lavender' },
  gothic: { name: 'Gothic', cssClass: 'gothic' },
  ocean: { name: 'Ocean', cssClass: 'ocean' },
  ember: { name: 'Ember', cssClass: 'ember' },
  windows: { name: 'Windows', cssClass: 'windows' },
  custom: { name: 'Custom', cssClass: 'custom' },
};

/**
 * Apply a theme to the document
 */
export async function applyTheme(themeId: string): Promise<void> {
  const root = document.documentElement;

  // Theme swapping!
  root.removeAttribute('data-theme');
  clearAdaptiveStyles(root);

  if (themeId === 'blue') {
    // Default theme, no attribute needed
    return;
  }

  if (themeId === 'windows') {
    // Grab Windows accent color & apply
    const accentColor = await getWindowsAccentColor();
    applyWindowsTheme(accentColor);
    root.setAttribute('data-theme', 'windows');
    return;
  }

  if (themeId === 'custom') {
    // Custom theme - placeholder for future theme editor
    // For now just applies default styling
    root.setAttribute('data-theme', 'custom');
    return;
  }

  root.setAttribute('data-theme', themeId);
}

/**
 * Clear inline styles set by adaptive theme
 */
function clearAdaptiveStyles(root: HTMLElement): void {
  const adaptiveProps = [
    '--accent-color', '--accent-hover', '--accent-active',
    '--panel-bg', '--panel-shadow', '--panel-border',
    '--text-primary', '--text-secondary', '--text-muted',
    '--tab-active', '--tab-hover', '--tab-bg',
    '--slider-track', '--slider-fill',
    '--toggle-bg', '--toggle-active',
    '--input-bg', '--input-border', '--close-hover'
  ];
  for (const prop of adaptiveProps) {
    root.style.removeProperty(prop);
  }
}

/**
 * Get Windows accent color from Rust backend
 * Falls back to default blue if not available
 */
export async function getWindowsAccentColor(): Promise<string> {
  try {
    if (window.rainydesk?.getWindowsAccentColor) {
      return await window.rainydesk.getWindowsAccentColor();
    }
  } catch (e) {
    console.warn('Failed to get Windows accent color:', e);
  }
  return '#0078d4';
}

/**
 * Apply Windows theme based on system accent color
 */
function applyWindowsTheme(accentColor: string): void {
  const root = document.documentElement;

  // Parse accent color
  const r = parseInt(accentColor.slice(1, 3), 16);
  const g = parseInt(accentColor.slice(3, 5), 16);
  const b = parseInt(accentColor.slice(5, 7), 16);

  // Generate color variations
  const darken = (v: number, amount: number) => Math.max(0, Math.floor(v * (1 - amount)));
  const lighten = (v: number, amount: number) => Math.min(255, Math.floor(v + (255 - v) * amount));

  // Auto-set CSS vars
  root.style.setProperty('--accent-color', accentColor);
  root.style.setProperty('--accent-hover', `rgb(${lighten(r, 0.15)}, ${lighten(g, 0.15)}, ${lighten(b, 0.15)})`);
  root.style.setProperty('--accent-active', `rgb(${darken(r, 0.15)}, ${darken(g, 0.15)}, ${darken(b, 0.15)})`);

  // Panel background uses a dark desaturated version of accent
  const bgR = darken(r, 0.75);
  const bgG = darken(g, 0.75);
  const bgB = darken(b, 0.75);
  root.style.setProperty('--panel-bg', `rgba(${bgR}, ${bgG}, ${bgB}, 0.85)`);
  root.style.setProperty('--panel-shadow', `rgba(${darken(r, 0.9)}, ${darken(g, 0.9)}, ${darken(b, 0.9)}, 0.5)`);

  // Border uses a lighter version
  root.style.setProperty('--panel-border', `rgba(${lighten(r, 0.3)}, ${lighten(g, 0.3)}, ${lighten(b, 0.3)}, 0.3)`);

  // Text colors should ALWAYS be white/light for contrast (WCAG compliance!)
  root.style.setProperty('--text-primary', '#ffffff');
  root.style.setProperty('--text-secondary', 'rgba(255, 255, 255, 0.7)');
  root.style.setProperty('--text-muted', 'rgba(255, 255, 255, 0.5)');

  // Tab colors
  root.style.setProperty('--tab-active', `rgba(${r}, ${g}, ${b}, 0.4)`);
  root.style.setProperty('--tab-hover', `rgba(${r}, ${g}, ${b}, 0.25)`);
  root.style.setProperty('--tab-bg', `rgba(${darken(r, 0.5)}, ${darken(g, 0.5)}, ${darken(b, 0.5)}, 0.4)`);

  // Slider colors
  root.style.setProperty('--slider-track', `rgba(${r}, ${g}, ${b}, 0.3)`);
  root.style.setProperty('--slider-fill', accentColor);

  // Toggle colors
  root.style.setProperty('--toggle-bg', `rgba(${darken(r, 0.6)}, ${darken(g, 0.6)}, ${darken(b, 0.6)}, 0.4)`);
  root.style.setProperty('--toggle-active', accentColor);

  // Input colors
  root.style.setProperty('--input-bg', `rgba(${bgR}, ${bgG}, ${bgB}, 0.5)`);
  root.style.setProperty('--input-border', `rgba(${r}, ${g}, ${b}, 0.4)`);

  // Close button hover (red for visibility)
  root.style.setProperty('--close-hover', 'rgba(220, 80, 80, 0.8)');
}
