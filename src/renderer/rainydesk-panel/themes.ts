/**
 * RainyDesk Panel - Theme System
 *
 * Theme definitions, switching logic, custom theme engine,
 * color derivation, HSL randomizer, and WCAG contrast enforcement.
 */

import type { CustomTheme, CustomThemeFonts } from './types';

export interface Theme {
  name: string;
  cssClass: string;
}

export const themes: Record<string, Theme> = {
  blue: { name: 'Business Blue', cssClass: 'blue' },
  purple: { name: 'Purdy Purple', cssClass: 'purple' },
  warm: { name: 'Warm Wood', cssClass: 'warm' },
  sakura: { name: 'Beautiful Blossom', cssClass: 'sakura' },
  forest: { name: 'Funky Forest', cssClass: 'forest' },
  midnight: { name: 'Modern Midnight', cssClass: 'midnight' },
  lavender: { name: 'Lovely Lavender', cssClass: 'lavender' },
  gothic: { name: 'Grand Gothic', cssClass: 'gothic' },
  ocean: { name: 'Optimistic Ocean', cssClass: 'ocean' },
  ember: { name: 'Earnest Ember', cssClass: 'ember' },
  windows: { name: 'Windows ...Waccent?', cssClass: 'windows' },
};

export const DEFAULT_THEME_NAMES: Record<string, string> = {
  blue: 'Business Blue',
  purple: 'Purdy Purple',
  warm: 'Warm Wood',
  sakura: 'Beautiful Blossom',
  forest: 'Funky Forest',
  midnight: 'Modern Midnight',
  lavender: 'Lovely Lavender',
  gothic: 'Grand Gothic',
  ocean: 'Optimistic Ocean',
  ember: 'Earnest Ember',
  windows: 'Windows ...Waccent?',
};

// CSS properties that adaptive/custom themes set inline
const ADAPTIVE_PROPS = [
  '--accent-color', '--accent-hover', '--accent-active',
  '--panel-bg', '--panel-shadow', '--panel-border',
  '--text-primary', '--text-secondary', '--text-muted',
  '--tab-active', '--tab-hover', '--tab-bg',
  '--slider-track', '--slider-fill',
  '--toggle-bg', '--toggle-active',
  '--input-bg', '--input-border', '--close-hover'
];

// HSL Color Utilities

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return '#' + [clamp(r), clamp(g), clamp(b)]
    .map(v => v.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToHsl(hex: string): [number, number, number] {
  const rgb = hexToRgb(hex);
  const r = rgb[0] / 255;
  const g = rgb[1] / 255;
  const b = rgb[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) return [0, 0, l * 100];

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;

  return [h * 360, s * 100, l * 100];
}

export function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }

  return rgbToHex(
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  );
}

export function lightenHex(hex: string, amount: number): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, s, Math.min(100, l + amount));
}

export function darkenHex(hex: string, amount: number): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, s, Math.max(0, l - amount));
}

// WCAG Contrast Ratio

/* Relative luminance per WCAG 2.1 */
function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  const linearize = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linearize(rgb[0]) + 0.7152 * linearize(rgb[1]) + 0.0722 * linearize(rgb[2]);
}

export function getContrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// Color Derivation (shared between Windows theme and custom themes)

export interface DerivedColors {
  accentColor: string;
  accentHover: string;
  accentActive: string;
  panelBg: string;
  panelShadow: string;
  panelBorder: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  tabActive: string;
  tabHover: string;
  tabBg: string;
  sliderTrack: string;
  sliderFill: string;
  toggleBg: string;
  toggleActive: string;
  inputBg: string;
  inputBorder: string;
  closeHover: string;
}

/* Derive all 19 CSS variables from 3 primary colors */
export function deriveThemeColors(accent: string, background: string, text: string): DerivedColors {
  const [ar, ag, ab] = hexToRgb(accent);
  const [br, bg_, bb] = hexToRgb(background);
  const [tr, tg, tb] = hexToRgb(text);

  const darkenRgb = (v: number, amount: number) => Math.max(0, Math.floor(v * (1 - amount)));
  const lightenRgb = (v: number, amount: number) => Math.min(255, Math.floor(v + (255 - v) * amount));

  return {
    accentColor: accent,
    accentHover: rgbToHex(lightenRgb(ar, 0.15), lightenRgb(ag, 0.15), lightenRgb(ab, 0.15)),
    accentActive: rgbToHex(darkenRgb(ar, 0.15), darkenRgb(ag, 0.15), darkenRgb(ab, 0.15)),
    panelBg: `rgba(${br}, ${bg_}, ${bb}, 0.85)`,
    panelShadow: `rgba(${darkenRgb(br, 0.3)}, ${darkenRgb(bg_, 0.3)}, ${darkenRgb(bb, 0.3)}, 0.5)`,
    panelBorder: `rgba(${lightenRgb(br, 0.25)}, ${lightenRgb(bg_, 0.25)}, ${lightenRgb(bb, 0.25)}, 0.3)`,
    textPrimary: text,
    textSecondary: `rgba(${tr}, ${tg}, ${tb}, 0.7)`,
    textMuted: `rgba(${tr}, ${tg}, ${tb}, 0.5)`,
    tabActive: `rgba(${ar}, ${ag}, ${ab}, 0.4)`,
    tabHover: `rgba(${ar}, ${ag}, ${ab}, 0.25)`,
    tabBg: `rgba(${darkenRgb(ar, 0.5)}, ${darkenRgb(ag, 0.5)}, ${darkenRgb(ab, 0.5)}, 0.4)`,
    sliderTrack: `rgba(${ar}, ${ag}, ${ab}, 0.3)`,
    sliderFill: accent,
    toggleBg: `rgba(${darkenRgb(ar, 0.6)}, ${darkenRgb(ag, 0.6)}, ${darkenRgb(ab, 0.6)}, 0.4)`,
    toggleActive: accent,
    inputBg: `rgba(${darkenRgb(br, 0.1)}, ${darkenRgb(bg_, 0.1)}, ${darkenRgb(bb, 0.1)}, 0.5)`,
    inputBorder: `rgba(${ar}, ${ag}, ${ab}, 0.4)`,
    closeHover: 'rgba(220, 80, 80, 0.8)',
  };
}

/* Apply derived colors to the document root as inline CSS variables */
function setDerivedColors(root: HTMLElement, colors: DerivedColors): void {
  root.style.setProperty('--accent-color', colors.accentColor);
  root.style.setProperty('--accent-hover', colors.accentHover);
  root.style.setProperty('--accent-active', colors.accentActive);
  root.style.setProperty('--panel-bg', colors.panelBg);
  root.style.setProperty('--panel-shadow', colors.panelShadow);
  root.style.setProperty('--panel-border', colors.panelBorder);
  root.style.setProperty('--text-primary', colors.textPrimary);
  root.style.setProperty('--text-secondary', colors.textSecondary);
  root.style.setProperty('--text-muted', colors.textMuted);
  root.style.setProperty('--tab-active', colors.tabActive);
  root.style.setProperty('--tab-hover', colors.tabHover);
  root.style.setProperty('--tab-bg', colors.tabBg);
  root.style.setProperty('--slider-track', colors.sliderTrack);
  root.style.setProperty('--slider-fill', colors.sliderFill);
  root.style.setProperty('--toggle-bg', colors.toggleBg);
  root.style.setProperty('--toggle-active', colors.toggleActive);
  root.style.setProperty('--input-bg', colors.inputBg);
  root.style.setProperty('--input-border', colors.inputBorder);
  root.style.setProperty('--close-hover', colors.closeHover);
}

// Custom Theme Application

/* Apply a custom theme (from UserThemes.json or scratch slot) to the panel */
export function applyCustomTheme(theme: CustomTheme): void {
  const root = document.documentElement;

  root.removeAttribute('data-theme');
  clearAdaptiveStyles(root);

  // Derive base colors from the 3 primaries
  const derived = deriveThemeColors(
    theme.colors.accent,
    theme.colors.background,
    theme.colors.text,
  );

  // Override with fine-tuning values when present (regardless of autoColors toggle)
  if (theme.colors.accentHover) derived.accentHover = theme.colors.accentHover;
  if (theme.colors.accentActive) derived.accentActive = theme.colors.accentActive;
  if (theme.colors.borderColor) derived.panelBorder = theme.colors.borderColor;
  if (theme.colors.shadowColor) derived.panelShadow = theme.colors.shadowColor;
  if (theme.colors.closeHover) derived.closeHover = theme.colors.closeHover;
  if (theme.colors.sliderTrack) derived.sliderTrack = theme.colors.sliderTrack;
  if (theme.colors.toggleBg) derived.toggleBg = theme.colors.toggleBg;
  if (theme.colors.textSecondary) derived.textSecondary = theme.colors.textSecondary;

  setDerivedColors(root, derived);

  // Broadcast to other windows (Help) for live sync during editor fiddling
  localStorage.setItem('rainscaper-custom-theme-sync', JSON.stringify(theme));

  // Font application disabled for now (TODO: implement properly later)
  // if (theme.fonts) {
  //   applyCustomFonts(theme.fonts);
  // }
}

// Font Application

export function applyCustomFonts(fonts: CustomThemeFonts): void {
  const root = document.documentElement;
  if (fonts.body) {
    root.style.setProperty('--font-body', `'${fonts.body}', 'Segoe UI', sans-serif`);
  }
  if (fonts.headers) {
    root.style.setProperty('--font-headers', `'${fonts.headers}', monospace`);
  }
}

export function clearCustomFonts(): void {
  const root = document.documentElement;
  root.style.removeProperty('--font-body');
  root.style.removeProperty('--font-headers');
}

// Random Theme Generation (HSL + Harmony)

type HarmonyType = 'complementary' | 'analogous' | 'triadic' | 'split-complementary';

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function generateRandomTheme(): CustomTheme {
  const harmonies: HarmonyType[] = ['complementary', 'analogous', 'triadic', 'split-complementary'];
  const harmony = harmonies[Math.floor(Math.random() * harmonies.length)]!;

  const baseHue = Math.random() * 360;

  let accentHue: number;
  switch (harmony) {
    case 'complementary':
      accentHue = (baseHue + 180) % 360;
      break;
    case 'analogous':
      accentHue = (baseHue + (Math.random() > 0.5 ? 30 : -30)) % 360;
      break;
    case 'triadic':
      accentHue = (baseHue + (Math.random() > 0.5 ? 120 : 240)) % 360;
      break;
    case 'split-complementary':
      accentHue = (baseHue + (Math.random() > 0.5 ? 150 : 210)) % 360;
      break;
  }

  // Generate candidate colors with WCAG retry loop
  let accent = '';
  let background = '';
  let text = '';
  let valid = false;

  for (let attempt = 0; attempt < 10; attempt++) {
    const bgSat = randomInRange(15, 30);
    const bgLight = randomInRange(10, 25);
    background = hslToHex(baseHue, bgSat, bgLight);

    const acSat = randomInRange(50, 80);
    const acLight = randomInRange(40, 60);
    accent = hslToHex(accentHue, acSat, acLight);

    const textHue = baseHue + randomInRange(-10, 10);
    const textSat = randomInRange(5, 15);
    const textLight = randomInRange(85, 95);
    text = hslToHex(textHue, textSat, textLight);

    // WCAG AA: 4.5:1 for text, 3:1 for accent (large UI elements)
    const textContrast = getContrastRatio(text, background);
    const accentContrast = getContrastRatio(accent, background);

    if (textContrast >= 4.5 && accentContrast >= 3.0) {
      valid = true;
      break;
    }

    // Adjust lightness on retry: push text lighter, background darker
    if (textContrast < 4.5) {
      // Will naturally fix on next iteration with slightly different random values
    }
  }

  // Fallback: force high-contrast if all retries failed
  if (!valid) {
    background = hslToHex(baseHue, 20, 12);
    text = hslToHex(baseHue, 10, 92);
    accent = hslToHex(accentHue, 65, 55);
  }

  return {
    id: '',
    name: '',
    colors: {
      accent,
      background,
      text,
      autoColors: true,
      accentHover: null,
      accentActive: null,
      borderColor: null,
      shadowColor: null,
      closeHover: null,
      sliderTrack: null,
      toggleBg: null,
      textSecondary: null,
    },
    fonts: {
      body: 'Convergence',
      headers: 'Departure Mono',
      applyToMatrix: false,
    },
  };
}

// Theme names for random generation
const RANDOM_NAMES = [
  'Neon Sunset', 'Cyber Dusk', 'Arctic Dawn', 'Solar Flare', 'Velvet Night',
  'Electric Sage', 'Coral Reef', 'Moonlit Fog', 'Amber Glow', 'Frozen Lake',
  'Misty Rose', 'Copper Sky', 'Iron Bloom', 'Cloud Nine', 'Prism Shift',
  'Dusty Plum', 'Wild Mint', 'Honey Dew', 'Storm Gray', 'Ruby Dusk',
  'Jade Temple', 'Burnt Sienna', 'Violet Hour', 'Tangerine Dream', 'Midnight Oil',
  'Crimson Tide', 'Sea Glass', 'Desert Sand', 'Pine Shadow', 'Cobalt Haze',
];

export function getRandomThemeName(): string {
  return RANDOM_NAMES[Math.floor(Math.random() * RANDOM_NAMES.length)]!;
}

// Main Theme Application

/**
 * Apply a theme to the document.
 * Handles built-in themes, Windows accent, and custom-N IDs.
 * For custom themes, call applyCustomTheme() directly instead.
 */
export async function applyTheme(themeId: string): Promise<void> {
  const root = document.documentElement;

  root.removeAttribute('data-theme');
  clearAdaptiveStyles(root);
  clearCustomFonts();

  if (themeId === 'blue') {
    return;
  }

  if (themeId === 'windows') {
    const accentColor = await getWindowsAccentColor();
    applyWindowsTheme(accentColor);
    root.setAttribute('data-theme', 'windows');
    return;
  }

  // Custom themes (custom-1 through custom-6) are applied via applyCustomTheme()
  // This path shouldn't normally be hit for custom themes, but guard anyway
  if (themeId.startsWith('custom-')) {
    return;
  }

  root.setAttribute('data-theme', themeId);
}

function clearAdaptiveStyles(root: HTMLElement): void {
  for (const prop of ADAPTIVE_PROPS) {
    root.style.removeProperty(prop);
  }
}

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

/* Windows theme now uses the shared derivation engine */
function applyWindowsTheme(accentColor: string): void {
  const root = document.documentElement;
  const [r, g, b] = hexToRgb(accentColor);

  // Windows theme derives background from accent (dark desaturated version)
  const darken = (v: number, amount: number) => Math.max(0, Math.floor(v * (1 - amount)));
  const bgHex = rgbToHex(darken(r, 0.75), darken(g, 0.75), darken(b, 0.75));

  const derived = deriveThemeColors(accentColor, bgHex, '#ffffff');
  setDerivedColors(root, derived);
}

// Font List (bundled + common Windows fonts)

export const FONT_LIST = {
  bundled: ['Convergence', 'JetBrains Mono', 'Departure Mono', 'Nimbus Mono'],
  system: [
    'Segoe UI', 'Segoe UI Variable',
    'Consolas', 'Cascadia Code', 'Cascadia Mono',
    'Arial', 'Verdana', 'Tahoma', 'Trebuchet MS',
    'Georgia', 'Times New Roman',
    'Comic Sans MS',
  ],
};
