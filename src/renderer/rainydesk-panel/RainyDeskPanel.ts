/* Main panel class — standalone Rainscaper window UI */

import { Slider, Toggle, ColorPicker, TriToggle, RotaryKnob, updateSliderValue, showTooltip, hideTooltip } from './components';
import { applyTheme, applyCustomTheme, generateRandomTheme, getRandomThemeName, DEFAULT_THEME_NAMES, clearCustomFonts, deriveThemeColors } from './themes';
import type { CustomTheme, UserThemesFile } from './types';
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from '@tauri-apps/plugin-autostart';

// Tab definitions
type TabId = 'basic' | 'physics' | 'audio' | 'visual' | 'system';

interface TabDef {
  id: TabId;
  label: string;
}

const TABS: TabDef[] = [
  { id: 'basic', label: 'Basics' },
  { id: 'physics', label: 'Physics' },
  { id: 'audio', label: 'Audio' },
  { id: 'visual', label: 'Visuals' },
  { id: 'system', label: 'System' },
];

// Default colors for different modes
const DEFAULT_RAIN_COLOR = '#8aa8c0';  // Gray-blue for normal rain
const DEFAULT_MATRIX_COLOR = '#008F11'; // Matrix green

// Initialize global debug storage if not already set
if (!window._debugLog) {
  window._debugLog = [];
}
if (!window._debugStats) {
  window._debugStats = {
    fps: 0,
    waterCount: 0,
    activeDrops: 0,
    puddleCells: 0,
    frameTime: 0,
    memoryMB: 0,
    lastUpdate: Date.now(),
  };
}

// State interface
interface PanelState {
  activeTab: TabId;
  theme: string;
  // Basic
  intensity: number;
  wind: number;
  volume: number;
  muted: boolean;
  paused: boolean;
  // Physics
  gravity: number;
  splashSize: number;
  splashLinked: boolean;
  puddleDrain: number;
  turbulence: number;
  dropSize: number;
  // Audio
  masterVolume: number;
  rainIntensity: number;
  sheetVolume: number;
  ambience: number;
  bubbleSound: number;
  thunderEnabled: boolean;
  thunderStorminess: number;
  thunderDistance: number;
  thunderEnvironment: string;
  thunderStorminessOsc: number;
  thunderDistanceOsc: number;
  windSound: number;
  // Matrix Mode audio (E1) — percentages that map to dB via (v/100*42)-30
  matrixBassVolume: number;       // Default 50% = -9 dB
  matrixCollisionVolume: number;  // Default 20% = -21.6 dB
  matrixDroneVolume: number;      // Default 30% = -17.4 dB
  matrixTranspose: number;
  // Visual
  backgroundShaderEnabled: boolean;
  backgroundIntensity: number;
  backgroundLayers: number;
  rainColor: string;
  gayMode: boolean;
  matrixMode: boolean;
  matrixDensity: number;
  uiScale: number;
  rainbowSpeed: number;
  // Trans Mode easter egg
  transMode: boolean;
  transScrollDirection: 'left' | 'off' | 'right';
  // FPS Limiter
  fpsLimit: number;
  // Impact pitch
  impactPitch: number;
  impactPitchOsc: number;
  // Oscillation knobs
  windOsc: number;
  intensityOsc: number;
  turbulenceOsc: number;
  sheetOsc: number;
  // Presets
  presets: string[];
  currentPreset: string;
  // Physics (Phase 2)
  reverseGravity: boolean;
  gridScale: number;
  gridScalePending: number;
  renderScale: number;
  renderScalePending: number;
  // System behavior toggles
  rainOverMaximized: boolean;
  maximizedMuffling: boolean;
  rainOverFullscreen: boolean;
  audioMuffling: boolean;
  windowCollision: boolean;
  // Spatial audio
  spatialAudio: boolean;
  // Help window state
  helpWindowOpen: boolean;
  // App status
  appStatus: 'raining' | 'paused' | 'stopped' | 'initializing';
  // Debug
  debugStats: {
    fps: number;
    waterCount: number;
    activeDrops: number;
    puddleCells: number;
    frameTime: number;
    memoryMB: number;
    lastUpdate: number;
  };
  debugLogFilter: 'all' | 'info' | 'warn' | 'error';
}

// Use existing window.rainydesk interface - extended methods added via tauri-api.js

export class RainyDeskPanel {
  private root: HTMLElement;
  private state: PanelState;
  // Auto-hide disabled — tray click toggle only until fixed
  // private autoHideTimer: ReturnType<typeof setTimeout> | null = null;
  // private autoHideDelay = 5000;
  private debugUpdateInterval: ReturnType<typeof setInterval> | null = null;
  private debugStatsElement: HTMLElement | null = null;
  private gayModeInterval: ReturnType<typeof setInterval> | null = null;
  private titleElement: HTMLElement | null = null;
  private logoElement: HTMLElement | null = null;
  private logoTotalRotation = 0;
  private logoClickCount = 0;
  private logoFirstClickTime = 0;
  private logoSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private logoParticleTimers: ReturnType<typeof setTimeout>[] = [];
  private resetRainButton: HTMLButtonElement | null = null;
  private autosaveIndicatorTimer: ReturnType<typeof setTimeout> | null = null;
  private autosaveRevertTimer: ReturnType<typeof setTimeout> | null = null;
  private autosaveState: 'idle' | 'saving' | 'saved' = 'idle';
  private reinitButton: HTMLButtonElement | null = null;
  private reinitCooldownTimer: ReturnType<typeof setInterval> | null = null;
  private reinitCooldownEnd: number = 0;
  private appStartTime: number = Date.now();
  // Document-level listeners (stored for cleanup on re-render)
  private previousTab: TabId = 'basic';
  private pulseTimers: ReturnType<typeof setTimeout>[] = [];
  private lastMatrixToggle = 0;
  private docClickListener: (() => void) | null = null;
  private docKeyListener: ((e: KeyboardEvent) => void) | null = null;
  // Custom theme state
  private customThemes: CustomTheme[] = [];
  private scratchTheme: CustomTheme | null = null;
  private themeEditorOpen = false;
  private previousThemeId: string = 'blue';
  private editingThemeId: string | null = null;
  private detachBtn: HTMLButtonElement | null = null;
  private isDetached: boolean = false;
  private headerElement: HTMLElement | null = null;

  // SVG factories — use DOM API + currentColor so icons follow theme colors
  private static createSVG(viewBox: string, pathD: string, fill = 'none', stroke = 'currentColor'): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('fill', fill);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathD);
    path.setAttribute('stroke', stroke);
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  private static createLockSVG(): SVGSVGElement {
    return RainyDeskPanel.createSVG('0 0 24 24',
      'M12 14.5V16.5M7 10.0288C7.47142 10 8.05259 10 8.8 10H15.2C15.9474 10 16.5286 10 17 10.0288M7 10.0288C6.41168 10.0647 5.99429 10.1455 5.63803 10.327C5.07354 10.6146 4.6146 11.0735 4.32698 11.638C4 12.2798 4 13.1198 4 14.8V16.2C4 17.8802 4 18.7202 4.32698 19.362C4.6146 19.9265 5.07354 20.3854 5.63803 20.673C6.27976 21 7.11984 21 8.8 21H15.2C16.8802 21 17.7202 21 18.362 20.673C18.9265 20.3854 19.3854 19.9265 19.673 19.362C20 18.7202 20 17.8802 20 16.2V14.8C20 13.1198 20 12.2798 19.673 11.638C19.3854 11.0735 18.9265 10.6146 18.362 10.327C18.0057 10.1455 17.5883 10.0647 17 10.0288M7 10.0288V8C7 5.23858 9.23858 3 12 3C14.7614 3 17 5.23858 17 8V10.0288'
    );
  }

  private static createUnlockSVG(): SVGSVGElement {
    return RainyDeskPanel.createSVG('0 0 24 24',
      'M16.584 6C15.8124 4.2341 14.0503 3 12 3C9.23858 3 7 5.23858 7 8V10.0288M12 14.5V16.5M7 10.0288C7.47142 10 8.05259 10 8.8 10H15.2C16.8802 10 17.7202 10 18.362 10.327C18.9265 10.6146 19.3854 11.0735 19.673 11.638C20 12.2798 20 13.1198 20 14.8V16.2C20 17.8802 20 18.7202 19.673 19.362C19.3854 19.9265 18.9265 20.3854 18.362 20.673C17.7202 21 16.8802 21 15.2 21H8.8C7.11984 21 6.27976 21 5.63803 20.673C5.07354 20.3854 4.6146 19.9265 4.32698 19.362C4 18.7202 4 17.8802 4 16.2V14.8C4 13.1198 4 12.2798 4.32698 11.638C4.6146 11.0735 5.07354 10.6146 5.63803 10.327C5.99429 10.1455 6.41168 10.0647 7 10.0288Z'
    );
  }

  private static createCloudQuestionSVG(): SVGSVGElement {
    return RainyDeskPanel.createSVG('0 0 24 24',
      'M12.437 13C13.437 12 14.437 11.6046 14.437 10.5C14.437 9.39543 13.5416 8.5 12.437 8.5C11.5051 8.5 10.722 9.13739 10.5 10M12.437 16H12.447M8.4 19C5.41766 19 3 16.6044 3 13.6493C3 11.2001 4.8 8.9375 7.5 8.5C8.34694 6.48637 10.3514 5 12.6893 5C15.684 5 18.1317 7.32251 18.3 10.25C19.8893 10.9449 21 12.6503 21 14.4969C21 16.9839 18.9853 19 16.5 19L8.4 19Z'
    );
  }

  private static createCloudBoltSVG(): SVGSVGElement {
    return RainyDeskPanel.createSVG('0 0 24 24',
      'M13 11L10 16H15L12 21M6 16.4438C4.22194 15.5683 3 13.7502 3 11.6493C3 9.20008 4.8 6.9375 7.5 6.5C8.34694 4.48637 10.3514 3 12.6893 3C15.684 3 18.1317 5.32251 18.3 8.25C19.8893 8.94488 21 10.6503 21 12.4969C21 14.0582 20.206 15.4339 19 16.2417'
    );
  }

  /* Get saved UI Scale, or auto-fit to screen on first launch */
  private static getInitialUIScale(): number {
    const saved = localStorage.getItem('rainscaper-ui-scale');
    if (saved) return parseFloat(saved);

    // First launch: pick the largest scale step that fits the work area
    const scaleSteps = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5];
    const BASE_W = 400;
    const BASE_H = 500;
    const MARGIN = 32;
    const availW = window.screen.availWidth;
    const availH = window.screen.availHeight;
    const maxScale = Math.min((availW - MARGIN) / BASE_W, (availH - MARGIN) / BASE_H);

    // Find the largest step that fits (default to smallest if none fit)
    let bestScale = scaleSteps[0]!;
    for (const step of scaleSteps) {
      if (step <= maxScale) bestScale = step;
    }

    // Cap at 1.0 for auto — user can always increase manually
    bestScale = Math.min(bestScale, 1.0);

    localStorage.setItem('rainscaper-ui-scale', String(bestScale));
    return bestScale;
  }

  constructor(root: HTMLElement) {
    this.root = root;
    this.state = this.getDefaultState();
  }

  private getDefaultState(): PanelState {
    // Restore tab from sessionStorage if available
    let savedTab = sessionStorage.getItem('rainscaper-tab') as TabId | null;
    // Migrate old 'debug' tab ID to 'system'
    if (savedTab === 'debug' as string) {
      savedTab = 'system';
      sessionStorage.setItem('rainscaper-tab', 'system');
    }

    return {
      activeTab: savedTab || 'basic',
      theme: localStorage.getItem('rainscaper-theme') || 'blue',
      // Basic
      intensity: 50,
      wind: 0,
      volume: 50,
      muted: false,
      paused: false,
      // Physics
      gravity: 980,
      splashSize: 1.0,
      splashLinked: true,
      puddleDrain: 0.2,
      turbulence: 0.3,
      dropSize: 4,
      // Audio
      masterVolume: 50,
      rainIntensity: 50,
      sheetVolume: 35,
      ambience: 30,
      bubbleSound: 30,
      thunderEnabled: false,
      thunderStorminess: 50,
      thunderDistance: 5.0,
      thunderEnvironment: 'forest',
      thunderStorminessOsc: 0,
      thunderDistanceOsc: 0,
      windSound: 20,
      // Matrix Mode audio (E1) — percentages matching GlitchSynth default dB values
      matrixBassVolume: 50,       // -9 dB
      matrixCollisionVolume: 20,  // -21.6 dB
      matrixDroneVolume: 30,      // -17.4 dB
      matrixTranspose: 0,
      // Visual
      backgroundShaderEnabled: true,
      backgroundIntensity: 50,
      backgroundLayers: 3,
      rainColor: '#8aa8c0',
      gayMode: false,
      matrixMode: false,
      matrixDensity: 28,
      uiScale: RainyDeskPanel.getInitialUIScale(),
      rainbowSpeed: 1,
      // Trans Mode easter egg
      transMode: false,
      transScrollDirection: 'off',
      // FPS Limiter
      fpsLimit: 0,
      // Impact pitch
      impactPitch: 50,
      impactPitchOsc: 0,
      // Oscillation knobs
      windOsc: 0,
      intensityOsc: 0,
      turbulenceOsc: 0,
      sheetOsc: 0,
      // Presets
      presets: [],
      currentPreset: '',
      // Physics (Phase 2)
      reverseGravity: false,
      gridScale: 0.25,
      gridScalePending: 0.25,
      renderScale: 0.25,
      renderScalePending: 0.25,
      // System behavior toggles
      rainOverMaximized: false,
      maximizedMuffling: true,
      rainOverFullscreen: false,
      audioMuffling: true,
      windowCollision: true,
      // Spatial audio
      spatialAudio: false,
      // Help window state
      helpWindowOpen: false,
      // App status
      appStatus: 'raining',
      // Debug
      debugStats: {
        fps: 0,
        waterCount: 0,
        activeDrops: 0,
        puddleCells: 0,
        frameTime: 0,
        memoryMB: 0,
        lastUpdate: Date.now(),
      },
      debugLogFilter: 'all',
    };
  }

  async init(): Promise<void> {
    // Detect and correct phantom DPI scaling (Intel Iris iGPU + WebView2, thanks dad)
    const dpiResult = await (window as any).rainydesk.detectPhantomDPI();
    if (dpiResult.corrected) {
      document.documentElement.style.zoom = String(dpiResult.correctionZoom);
    }

    // Apply saved theme
    await applyTheme(this.state.theme);

    // Load startup rainscape settings
    try {
      const startup = await window.rainydesk.getStartupRainscape();
      if (startup && startup.data) {
        this.applyRainscapeData(startup.data);
        if (startup.filename) {
          this.state.currentPreset = startup.filename.replace('.rain', '');
        }
      }
    } catch (err) {
      window.rainydesk.log(`[RainyDeskPanel] Failed to load startup rainscape: ${err}`);
    }

    // Load available presets
    try {
      const result = await window.rainydesk.loadRainscapes();
      const rootPresets = (result?.root || []).map((f: string) => f.replace('.rain', ''));
      const customPresets = (result?.custom || []).map((f: string) => `Custom/${f.replace('.rain', '')}`);
      this.state.presets = [...rootPresets, ...customPresets];
    } catch (err) {
      window.rainydesk.log(`[RainyDeskPanel] Failed to load presets: ${err}`);
    }

    // Load custom themes
    try {
      const themesFile = await window.rainydesk.loadUserThemes();
      if (themesFile && Array.isArray(themesFile.themes)) {
        this.customThemes = themesFile.themes;
      }
    } catch (err) {
      window.rainydesk.log(`[RainyDeskPanel] Failed to load custom themes: ${err}`);
    }

    // If the active theme is custom, apply it now
    if (this.state.theme.startsWith('custom-')) {
      const customTheme = this.customThemes.find(t => t.id === this.state.theme);
      if (customTheme) {
        applyCustomTheme(customTheme);
      } else {
        // Theme was deleted, fall back to blue
        this.state.theme = 'blue';
        localStorage.setItem('rainscaper-theme', 'blue');
        await applyTheme('blue');
      }
    }

    // Load panel detach state from Rust config
    try {
      this.isDetached = await window.rainydesk.getPanelDetached();
    } catch { this.isDetached = false; }

    // Hook param updates to flash the autosave indicator (skip non-saveable commands)
    const originalUpdateParam = window.rainydesk.updateRainscapeParam;
    window.rainydesk.updateRainscapeParam = (path: string, value: unknown) => {
      originalUpdateParam(path, value);
      // Skip autosave flash for commands and state toggles (not saveable param changes)
      if (path !== 'physics.resetSimulation' && path !== 'system.paused' && path !== 'audio.muted' && path !== 'audio.thunder.testStrike') {
        this.flashAutosaveIndicator();
      }
    };

    // Build UI
    this.render();

    // Sync initial Matrix Mode state for cross-window listeners (help window)
    localStorage.setItem('rainscaper-matrix-mode', String(this.state.matrixMode));

    // Apply saved UI scale
    if (this.state.uiScale !== 1.0) {
      this.applyUIScale(this.state.uiScale);
    }

    // Start Gay Mode title animation if already enabled
    if (this.state.gayMode) {
      this.startGayModeAnimation();
    }

    // Auto-hide disabled - tray icon toggles panel instead
    // this.setupAutoHide();

    // Listen for parameter updates from other windows
    window.rainydesk.onUpdateRainscapeParam((path, value) => {
      this.handleExternalParamUpdate(path, value);
    });

    // Listen for help window close (X button or Rust-side hide)
    window.rainydesk.onHelpWindowHidden(() => {
      this.state.helpWindowOpen = false;
    });

    // Listen for tray menu volume presets
    window.rainydesk.onSetVolume((value: number) => {
      const wasZero = this.state.volume === 0;
      this.state.volume = value;
      this.state.masterVolume = value;
      // Sync both volume sliders (Basic tab + Audio tab)
      updateSliderValue(this.root, 'volume', value);
      updateSliderValue(this.root, 'masterVolume', value);
      // Sync mute toggle with volume state
      if (value === 0 && !this.state.muted) {
        this.state.muted = true;
        this.updateMuteToggle();
      } else if (wasZero && value > 0 && this.state.muted) {
        this.state.muted = false;
        this.updateMuteToggle();
      }
    });

    // Listen for tray menu rainscape selection
    window.rainydesk.onLoadRainscape(async (filename: string) => {
      try {
        const data = await window.rainydesk.readRainscape(filename);
        if (data) {
          this.applyRainscapeData(data);
          this.state.currentPreset = filename.replace('.rain', '');
          this.render();
        }
      } catch (err) {
        window.rainydesk.log(`[RainyDeskPanel] Tray load failed: ${err}`);
      }
    });

    // Listen for stats from the overlay window
    window.rainydesk.onStats((stats: { fps: number; waterCount: number; activeDrops: number; puddleCells: number }) => {
      // Update stats so System tab displays 'em
      window._debugStats = {
        ...window._debugStats,
        ...stats,
        lastUpdate: Date.now(),
      };
    });

    // Listen for reinit status from the overlay window
    window.rainydesk.onReinitStatus?.((status: 'stopped' | 'initializing' | 'raining') => {
      this.state.appStatus = status;
      this.updateFooterStatus();
    });

    // Monitor hot-swap: show panel on System tab and flash the Reset button
    window.rainydesk.onMonitorConfigChanged?.(() => {
      window.rainydesk.log('[Panel] Monitor config changed, alerting user');
      window.rainydesk.showRainscaper(0, 0);
      this.state.activeTab = 'system';
      this.switchTab('system');
      // Button is created fresh by switchTab → apply glow after DOM settles
      requestAnimationFrame(() => this.flashReinitButton());
    });
  }

  /* Migrate old .rain format (no version field) to v2 structure */
  private static migrateToV2(data: Record<string, unknown>): Record<string, unknown> {
    if (data.version === 2) return data;

    const rain = (data.rain || {}) as Record<string, unknown>;
    const physics = (data.physics || {}) as Record<string, unknown>;
    const audio = (data.audio || {}) as Record<string, unknown>;
    const visual = (data.visual || {}) as Record<string, unknown>;
    const system = (data.system || {}) as Record<string, unknown>;

    return {
      version: 2,
      name: data.name,
      rain: {
        ...rain,
        gravity: physics.gravity,
        reverseGravity: physics.reverseGravity,
        color: visual.rainColor,
        gayMode: visual.gayMode,
        rainbowSpeed: visual.rainbowSpeed,
        osc: {
          intensity: rain.intensityOsc,
          wind: rain.windOsc,
          turbulence: rain.turbulenceOsc,
          sheet: rain.sheetOsc,
        },
      },
      matrix: {
        density: visual.matrixDensity,
        transpose: visual.matrixTranspose,
        transMode: visual.transMode,
        transScrollDirection: visual.transScrollDirection,
      },
      audio: {
        muted: audio.muted,
        rain: {
          masterVolume: audio.masterVolume,
          rainIntensity: audio.rainIntensity,
          impactPitch: audio.impactPitch,
          impactPitchOsc: audio.impactPitchOsc,
          windMasterGain: audio.windMasterGain,
        },
        thunder: {
          storminess: audio.thunderStorminess,
          distance: audio.thunderDistance,
          environment: audio.thunderEnvironment,
        },
        matrix: {
          bass: audio.matrixBass,
          collision: audio.matrixCollision,
          drone: audio.matrixDrone,
        },
      },
      visual: {
        matrixMode: visual.matrixMode,
        backgroundShaderEnabled: visual.backgroundShaderEnabled ?? system.backgroundShaderEnabled,
        backgroundIntensity: visual.backgroundIntensity,
        backgroundLayers: visual.backgroundLayers,
      },
      system: {
        fpsLimit: physics.fpsLimit,
        gridScale: physics.gridScale,
        renderScale: system.renderScale,
        maximizedDetection: system.maximizedDetection,
        maximizedMuffling: system.maximizedMuffling,
        fullscreenDetection: system.fullscreenDetection,
        audioMuffling: system.audioMuffling,
        windowCollision: system.windowCollision,
        spatialAudio: system.spatialAudio,
      },
    };
  }

  private applyRainscapeData(rawData: Record<string, unknown>): void {
    const data = RainyDeskPanel.migrateToV2(rawData);

    // Rain settings
    if (data.rain && typeof data.rain === 'object') {
      const rain = data.rain as Record<string, unknown>;
      if (typeof rain.intensity === 'number') this.state.intensity = rain.intensity;
      if (typeof rain.wind === 'number') this.state.wind = rain.wind;
      if (typeof rain.gravity === 'number') this.state.gravity = rain.gravity;
      if (typeof rain.reverseGravity === 'boolean') this.state.reverseGravity = rain.reverseGravity;
      if (typeof rain.turbulence === 'number') this.state.turbulence = rain.turbulence;
      if (typeof rain.splashScale === 'number') this.state.splashSize = rain.splashScale;
      // Old files without splashLinked default to false (preserve independent behavior)
      if (typeof rain.splashLinked === 'boolean') this.state.splashLinked = rain.splashLinked;
      else this.state.splashLinked = false;
      if (typeof rain.puddleDrain === 'number') this.state.puddleDrain = rain.puddleDrain;
      if (rain.dropSize && typeof rain.dropSize === 'object') {
        const dropSize = rain.dropSize as Record<string, unknown>;
        if (typeof dropSize.max === 'number') this.state.dropSize = dropSize.max;
      }
      if (typeof rain.color === 'string') this.state.rainColor = rain.color;
      if (typeof rain.gayMode === 'boolean') this.state.gayMode = rain.gayMode;
      if (typeof rain.rainbowSpeed === 'number') this.state.rainbowSpeed = rain.rainbowSpeed;
      if (typeof rain.sheetVolume === 'number') this.state.sheetVolume = rain.sheetVolume;
      // Oscillator amounts (v2: nested under rain.osc)
      if (rain.osc && typeof rain.osc === 'object') {
        const osc = rain.osc as Record<string, unknown>;
        if (typeof osc.intensity === 'number') this.state.intensityOsc = osc.intensity;
        if (typeof osc.wind === 'number') this.state.windOsc = osc.wind;
        if (typeof osc.turbulence === 'number') this.state.turbulenceOsc = osc.turbulence;
        if (typeof osc.sheet === 'number') this.state.sheetOsc = osc.sheet;
      }
    }

    // Matrix settings
    if (data.matrix && typeof data.matrix === 'object') {
      const matrix = data.matrix as Record<string, unknown>;
      if (typeof matrix.density === 'number') this.state.matrixDensity = matrix.density;
      if (typeof matrix.transpose === 'number') this.state.matrixTranspose = matrix.transpose;
      if (typeof matrix.transMode === 'boolean') this.state.transMode = matrix.transMode;
      if (typeof matrix.transScrollDirection === 'string') {
        this.state.transScrollDirection = matrix.transScrollDirection as 'left' | 'off' | 'right';
      }
    }

    // Audio settings (v2: split into audio.rain and audio.matrix)
    if (data.audio && typeof data.audio === 'object') {
      const audio = data.audio as Record<string, unknown>;
      if (typeof audio.muted === 'boolean') this.state.muted = audio.muted;

      if (audio.rain && typeof audio.rain === 'object') {
        const ar = audio.rain as Record<string, unknown>;
        if (typeof ar.masterVolume === 'number') {
          const dbValue = ar.masterVolume as number;
          this.state.masterVolume = Math.round(Math.max(0, Math.min(100, ((dbValue + 60) / 60) * 100)));
          this.state.volume = this.state.masterVolume;
        }
        if (typeof ar.rainIntensity === 'number') this.state.rainIntensity = ar.rainIntensity;
        if (typeof ar.impactPitch === 'number') this.state.impactPitch = ar.impactPitch;
        if (typeof ar.impactPitchOsc === 'number') this.state.impactPitchOsc = ar.impactPitchOsc;
        // Backward compat: old thunderEnabled boolean → storminess
        if (typeof ar.thunderEnabled === 'boolean') {
          this.state.thunderStorminess = ar.thunderEnabled ? 30 : 0;
        }
        // Wind: dB -> slider percentage (0% = -60dB mute, 1-100% = -24dB to +12dB)
        if (typeof ar.windMasterGain === 'number') {
          const db = ar.windMasterGain as number;
          this.state.windSound = db <= -60 ? 0 : Math.round(Math.max(0, Math.min(100, ((db + 24) / 36) * 100)));
        }
      }

      // Thunder settings (new v2 format)
      if (audio.thunder && typeof audio.thunder === 'object') {
        const at = audio.thunder as Record<string, unknown>;
        if (typeof at.storminess === 'number') this.state.thunderStorminess = at.storminess;
        if (typeof at.distance === 'number') this.state.thunderDistance = at.distance;
        if (typeof at.environment === 'string') this.state.thunderEnvironment = at.environment;
        // Enabled flag (backward compat: derive from storminess > 0 if missing)
        if (typeof at.enabled === 'boolean') {
          this.state.thunderEnabled = at.enabled;
        } else {
          this.state.thunderEnabled = this.state.thunderStorminess > 0;
        }
        // OSC amounts
        if (at.osc && typeof at.osc === 'object') {
          const osc = at.osc as Record<string, unknown>;
          if (typeof osc.storminess === 'number') this.state.thunderStorminessOsc = osc.storminess;
          if (typeof osc.distance === 'number') this.state.thunderDistanceOsc = osc.distance;
        }
        // Ensure storminess has a sane value when enabled
        if (this.state.thunderEnabled && this.state.thunderStorminess === 0) {
          this.state.thunderStorminess = 50;
        }
      }

      if (audio.matrix && typeof audio.matrix === 'object') {
        const am = audio.matrix as Record<string, unknown>;
        // dB → percentage via reverse of (v/100*42)-30
        if (typeof am.bass === 'number') {
          this.state.matrixBassVolume = Math.round(Math.max(0, Math.min(100, ((am.bass as number) + 30) / 42 * 100)));
        }
        if (typeof am.collision === 'number') {
          this.state.matrixCollisionVolume = Math.round(Math.max(0, Math.min(100, ((am.collision as number) + 30) / 42 * 100)));
        }
        if (typeof am.drone === 'number') {
          this.state.matrixDroneVolume = Math.round(Math.max(0, Math.min(100, ((am.drone as number) + 30) / 42 * 100)));
        }
      }
    }

    // Visual settings (v2: only background + mode toggle)
    if (data.visual && typeof data.visual === 'object') {
      const visual = data.visual as Record<string, unknown>;
      if (typeof visual.matrixMode === 'boolean') {
        this.state.matrixMode = visual.matrixMode;
        localStorage.setItem('rainscaper-matrix-mode', String(visual.matrixMode));
      }
      if (typeof visual.backgroundShaderEnabled === 'boolean') {
        this.state.backgroundShaderEnabled = visual.backgroundShaderEnabled;
      }
      if (typeof visual.backgroundIntensity === 'number') {
        this.state.backgroundIntensity = visual.backgroundIntensity;
      }
      if (typeof visual.backgroundLayers === 'number') {
        this.state.backgroundLayers = visual.backgroundLayers;
      }
    }

    // System settings
    if (data.system && typeof data.system === 'object') {
      const sys = data.system as Record<string, unknown>;
      if (typeof sys.fpsLimit === 'number') this.state.fpsLimit = sys.fpsLimit;
      // Saved files use detection=true (suppress rain), panel uses rainOver=true (show rain)
      if (typeof sys.maximizedDetection === 'boolean') {
        this.state.rainOverMaximized = !sys.maximizedDetection;
      }
      if (typeof sys.maximizedMuffling === 'boolean') {
        this.state.maximizedMuffling = sys.maximizedMuffling;
      }
      if (typeof sys.fullscreenDetection === 'boolean') {
        this.state.rainOverFullscreen = !sys.fullscreenDetection;
      }
      if (typeof sys.audioMuffling === 'boolean') this.state.audioMuffling = sys.audioMuffling;
      if (typeof sys.windowCollision === 'boolean') this.state.windowCollision = sys.windowCollision;
      if (typeof sys.renderScale === 'number') {
        this.state.renderScale = sys.renderScale;
        this.state.renderScalePending = sys.renderScale;
      }
      if (typeof sys.spatialAudio === 'boolean') this.state.spatialAudio = sys.spatialAudio;
    }
  }

  private handleExternalParamUpdate(path: string, value: unknown): void {
    // Update local state when parameters change from other sources
    if (path === 'physics.intensity' && typeof value === 'number') {
      this.state.intensity = value;
      updateSliderValue(this.root, 'intensity', value);
    } else if (path === 'physics.wind' && typeof value === 'number') {
      this.state.wind = value;
      updateSliderValue(this.root, 'wind', value);
    } else if (path === 'physics.turbulence' && typeof value === 'number') {
      this.state.turbulence = value;
      updateSliderValue(this.root, 'turbulence', value * 100);
    } else if (path === 'physics.splashScale' && typeof value === 'number') {
      this.state.splashSize = value;
      // Convert 0.5-2.0 → 0-100% for slider display
      updateSliderValue(this.root, 'splashSize', Math.round(((value - 0.5) / 1.5) * 100));
    } else if (path === 'audio.impactPitch' && typeof value === 'number') {
      this.state.impactPitch = value;
      updateSliderValue(this.root, 'impactPitch', value);
    } else if (path === 'audio.sheetVolume' && typeof value === 'number') {
      this.state.sheetVolume = value;
      updateSliderValue(this.root, 'sheetVolume', value);
    } else if (path === 'system.paused' && typeof value === 'boolean') {
      this.state.paused = value;
      this.updatePauseToggle();
      this.updateFooterStatus();
    } else if (path === 'audio.muted' && typeof value === 'boolean') {
      this.state.muted = value;
      this.updateMuteToggle();
    } else if (path === 'audio.thunder.enabled' && typeof value === 'boolean') {
      this.state.thunderEnabled = value;
      const toggle = this.root.querySelector<HTMLInputElement>('.thunder-header-row input[type="checkbox"]');
      if (toggle) toggle.checked = value;
      const content = this.root.querySelector<HTMLElement>('.thunder-content');
      if (content) content.classList.toggle('collapsed', !value);
    } else if (path === 'audio.thunder.storminess' && typeof value === 'number') {
      this.state.thunderStorminess = value;
      updateSliderValue(this.root, 'thunderStorminess', value);
    } else if (path === 'audio.thunder.distance' && typeof value === 'number') {
      this.state.thunderDistance = value;
      updateSliderValue(this.root, 'thunderDistance', value);
    } else if (path === 'system.resetPanel') {
      // Reset UI scale to 100% (triggered by tray "Reset Panel")
      this.state.uiScale = 1.0;
      localStorage.setItem('rainscaper-ui-scale', '1');
      this.applyUIScale(1.0);
      // Sync slider display (index 2 = 1.0x in scaleSteps)
      updateSliderValue(this.root, 'uiScale', 2);
      // Reset detach state to snapped
      this.isDetached = false;
      this.updateDetachButton();
    }
  }

  // Auto-hide disabled for now — tray click toggle only until fixed
  // private setupAutoHide(): void {
  //   const panel = this.root.querySelector('.rainscaper-panel');
  //   if (!panel) return;
  //
  //   // Reset timer on any interaction
  //   const resetTimer = () => {
  //     if (this.autoHideTimer) {
  //       clearTimeout(this.autoHideTimer);
  //     }
  //     this.autoHideTimer = setTimeout(() => {
  //       this.hide();
  //     }, this.autoHideDelay);
  //   };
  //
  //   // Events that reset the timer
  //   panel.addEventListener('mousemove', resetTimer);
  //   panel.addEventListener('mousedown', resetTimer);
  //   panel.addEventListener('keydown', resetTimer);
  //
  //   // Start the timer
  //   resetTimer();
  // }

  private hide(): void {
    // IMPORTANT: Do NOT run animations or delays before hiding!
    // Tauri/WebView2 quirk: hiding a window from inside its own JS context
    // causes a "zombie window" state that show() cannot recover from.
    // Just emit the event immediately and let Rust handle everything.
    window.rainydesk.log('[RainyDeskPanel] hide() - emitting request to Rust');
    window.rainydesk.hideRainscaper();
  }

  private render(): void {
    // Auto-hide disabled — tray click toggle only
    // if (this.autoHideTimer) {
    //   clearTimeout(this.autoHideTimer);
    //   this.autoHideTimer = null;
    // }

    // Clean up timers and listeners before wiping DOM
    if (this.debugUpdateInterval) { clearInterval(this.debugUpdateInterval); this.debugUpdateInterval = null; }
    if (this.gayModeInterval) { clearInterval(this.gayModeInterval); this.gayModeInterval = null; }
    if (this.autosaveIndicatorTimer) { clearTimeout(this.autosaveIndicatorTimer); this.autosaveIndicatorTimer = null; }
    if (this.autosaveRevertTimer) { clearTimeout(this.autosaveRevertTimer); this.autosaveRevertTimer = null; }
    if (this.reinitCooldownTimer) { clearInterval(this.reinitCooldownTimer); this.reinitCooldownTimer = null; }
    if (this.docClickListener) { document.removeEventListener('click', this.docClickListener); this.docClickListener = null; }
    if (this.docKeyListener) { document.removeEventListener('keydown', this.docKeyListener); this.docKeyListener = null; }

    this.root.innerHTML = '';

    const panel = document.createElement('div');
    panel.className = `rainscaper-panel${this.state.matrixMode ? ' matrix-font-mode' : ''}`;

    // Header
    panel.appendChild(this.createHeader());

    // Tab bar
    panel.appendChild(this.createTabBar());

    // Content
    const content = document.createElement('div');
    content.className = 'panel-content';
    content.appendChild(this.createTabContent(this.state.activeTab));
    panel.appendChild(content);

    // Footer
    panel.appendChild(this.createFooter());

    this.root.appendChild(panel);

    // Re-apply CSS scale after full DOM rebuild (theme changes call render())
    // Uses CSS-only version to avoid resizing the Tauri window and triggering position clamp
    if (this.state.uiScale !== 1.0) {
      this.applyUIScaleCSS(this.state.uiScale);
    }

    // Auto-hide disabled - tray icon toggles panel instead
    // this.setupAutoHide();
  }

  private createHeader(): HTMLElement {
    const header = document.createElement('div');
    header.className = 'panel-header';
    this.headerElement = header;

    // Only allow dragging when detached
    if (this.isDetached) {
      (header.style as any).webkitAppRegion = 'drag';
      header.style.cursor = 'move';
    }

    // Logo (left anchor)
    const logo = document.createElement('div');
    logo.className = 'panel-logo-wrap';
    logo.innerHTML = '<svg class="panel-logo" viewBox="0 0 600 600" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M300,0C134.31,0,0,134.31,0,300s134.31,300,300,300,300-134.31,300-300S465.69,0,300,0ZM431.25,414.83c5.26-18.73,17.56-36.28,35.54-44.82,0,0,3.88-1.77,3.88-1.77,6.84-3.12,14.92-.11,18.05,6.74,3.81,8.04-1.53,17.84-10.29,19.13-.83.17-2.74.55-3.53.68-5.43,1.5-10.29,3.93-14.81,7.62-5.65,4.51-10.63,10.55-14.24,16.92-.27.49-.81,1.25-1.09,1.7-4.87,7.1-15.7,2.04-13.5-6.19ZM270.53,76.6l115.07,138.89c6.17,7.45,5.13,18.48-2.31,24.65-7.45,6.17-18.48,5.13-24.65-2.31-.58-.62-106.35-145.8-106.96-146.57-8.61-12.72,8.58-26.15,18.85-14.66ZM254.11,212.59l143.34,174c6.15,7.46,5.08,18.5-2.38,24.64-7.71,6.39-19.35,4.93-25.25-3.16l-133.36-181.76c-8.11-11.89,8.01-24.55,17.65-13.73ZM234.11,414.67c5.24-18.14,17.02-34.86,34.07-43.8,1.27-.62,4.5-2.03,5.81-2.63,16.75-6.72,27.3,16.8,11.12,24.84-2.48,1.16-5.47,1.23-8.02,2.12-4.96,1.5-9.36,3.96-13.5,7.37-5.56,4.54-10.44,10.57-13.97,16.93-.26.5-.87,1.35-1.15,1.8-5.2,7.61-16.78,2.16-14.36-6.63ZM77.59,241.15c-8.19-12.16,8.2-24.97,18.04-14.03l115.47,138.58c6.19,7.43,5.19,18.47-2.24,24.66-7.72,6.49-19.5,5.01-25.38-3.17,0,0-105.89-146.03-105.89-146.03ZM130.46,412.23c-17.62-3.23-14.01-28.56,3.82-26.73,12.29,3.36,22.71,12.13,29.41,22.73.9,1.41,1.65,2.9,2.45,4.33,4.53,8.46-5.92,16.66-13.05,10.42-2.02-1.82-3.95-3.82-6.22-5.3-4.85-3.31-10.69-5.75-16.54-5.55-.02.02-.17.02.13.1ZM500.62,465.42c-5.26,6.36-10.85,12.51-16.77,18.43-49.11,49.11-114.4,76.15-183.85,76.15s-134.74-27.04-183.85-76.15c-5.91-5.91-11.51-12.06-16.77-18.43-3.78-4.57-.54-11.47,5.39-11.47h390.46c5.93,0,9.16,6.9,5.39,11.47ZM525.42,250.5c-7.99,7.21-20.97,5.28-26.56-3.89-4.86-7.46-27.99-43.05-32.31-49.68l-3.24-4.99c-.92-1.32-2.38-3.26-3.37-4.59-4.86-6.51-9.77-13.33-14.2-20.58-3.01-4.93-1.46-11.36,3.47-14.37,4.5-2.75,10.28-1.69,13.53,2.28,6.02,7.28,13.25,14.23,20.08,21.17,2.53,2.85,9.39,10.6,12.01,13.56l32.12,36.3c6.43,7.26,5.75,18.36-1.51,24.79Z"/></svg>';
    this.logoElement = logo;
    logo.style.cursor = 'pointer';
    logo.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handleLogoClick();
    });

    // Title (centered)
    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = 'RainyDesk Rainscaper';
    this.titleElement = title; // Store reference for Gay Mode color sync

    const helpBtn = document.createElement('button');
    helpBtn.className = 'panel-help';
    helpBtn.appendChild(RainyDeskPanel.createCloudQuestionSVG());
    helpBtn.title = 'Help';
    helpBtn.onclick = () => {
      if (this.state.helpWindowOpen) {
        window.rainydesk.hideHelpWindow();
        this.state.helpWindowOpen = false;
      } else {
        window.rainydesk.showHelpWindow();
        this.state.helpWindowOpen = true;
      }
    };

    // Detach/snap toggle — locks panel position or returns it to tray
    const detachBtn = document.createElement('button');
    detachBtn.className = 'panel-detach';
    const detachIcon = this.isDetached ? RainyDeskPanel.createLockSVG() : RainyDeskPanel.createUnlockSVG();
    detachBtn.appendChild(detachIcon);
    detachBtn.title = this.isDetached ? 'Snap to tray' : 'Detach panel';
    if (this.isDetached) detachBtn.classList.add('active');
    detachBtn.onclick = () => this.toggleDetach();
    this.detachBtn = detachBtn;

    // Close button — folded umbrella icon
    const closeBtn = document.createElement('button');
    closeBtn.className = 'panel-close';
    closeBtn.innerHTML = '<svg viewBox="0 0 512 512" fill="currentColor"><path d="M140.797,324.832c-5.256-2.381-11.449-0.047-13.829,5.21l-2.671,5.9c-2.379,5.257-0.047,11.449,5.21,13.829c1.398,0.633,2.862,0.933,4.303,0.933c3.978,0,7.779-2.283,9.526-6.142l2.671-5.899C148.386,333.403,146.054,327.212,140.797,324.832z"/><path d="M227.158,134.062c-5.255-2.38-11.449-0.047-13.829,5.21l-67.205,148.453c-2.379,5.257-0.047,11.449,5.21,13.829c1.398,0.633,2.862,0.933,4.303,0.933c3.977,0,7.779-2.284,9.526-6.142l67.204-148.453C234.749,142.634,232.415,136.442,227.158,134.062z"/><path d="M499.315,47.454l-0.577-0.577c-16.909-16.906-44.417-16.908-61.326,0L324.998,159.29c-11.905-17.292-14.589-40.639-5.574-57.021c2.241-4.073,1.521-9.139-1.766-12.426c-3.288-3.288-8.354-4.007-12.426-1.766c-7.605,4.184-16.244,6.396-24.981,6.397c-13.834,0.001-26.84-5.387-36.622-15.169c-13.845-13.843-18.684-34.034-12.627-52.69c1.713-5.275-0.994-10.969-6.165-12.971c-5.171-2.004-11.006,0.382-13.294,5.435L0.93,484.307c-1.794,3.964-0.945,8.622,2.131,11.698c2.002,2.002,4.676,3.061,7.392,3.061c1.456,0,2.924-0.305,4.306-0.931L479.99,287.524c5.052-2.286,7.437-8.121,5.435-13.293c-2.003-5.172-7.695-7.878-12.971-6.165c-5.189,1.684-10.596,2.538-16.071,2.538c-13.835,0-26.841-5.386-36.62-15.164c-16.205-16.206-19.811-41.537-8.77-61.604c2.241-4.073,1.521-9.138-1.765-12.426c-3.289-3.288-8.355-4.007-12.428-1.766c-6.32,3.478-13.988,5.315-22.173,5.316c-12.321,0.001-24.741-3.977-34.838-10.905L452.191,61.656c8.759-8.761,23.011-8.76,31.777,0.006l0.577,0.576c8.76,8.759,8.76,23.012,0,31.77c-4.081,4.081-4.081,10.697,0.001,14.778c4.079,4.081,10.697,4.081,14.778-0.001C516.228,91.878,516.228,64.368,499.315,47.454zM374.629,205.859c3.526,0,7-0.249,10.393-0.737c-4.372,23.19,2.702,47.833,19.964,65.096c7.438,7.437,16.203,13.063,25.763,16.657L31.408,467.659L212.186,68.331c3.583,9.482,9.187,18.273,16.664,25.751c13.731,13.729,31.985,21.291,51.402,21.29c4.597,0,9.176-0.438,13.668-1.296c-3.408,23.582,4.911,49.988,22.998,68.074C331.766,196.996,353.341,205.86,374.629,205.859z"/></svg>';
    closeBtn.onclick = () => this.hide();

    // Prevent double-click from maximizing the frameless window
    header.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    header.appendChild(logo);
    header.appendChild(title);
    header.appendChild(helpBtn);
    header.appendChild(detachBtn);
    header.appendChild(closeBtn);

    return header;
  }

  private async toggleDetach(): Promise<void> {
    const newState = !this.isDetached;
    try {
      if (newState) {
        await window.rainydesk.setPanelDetached(true);
      } else {
        await window.rainydesk.snapPanelToTray();
      }
      this.isDetached = newState;
      this.updateDetachButton();
    } catch (err) {
      window.rainydesk.log(`[RainyDeskPanel] toggleDetach failed: ${err}`);
    }
  }

  private updateDetachButton(): void {
    if (this.detachBtn) {
      const oldIcon = this.detachBtn.querySelector('svg');
      if (oldIcon) oldIcon.remove();
      this.detachBtn.appendChild(
        this.isDetached ? RainyDeskPanel.createLockSVG() : RainyDeskPanel.createUnlockSVG()
      );
      this.detachBtn.title = this.isDetached ? 'Snap to tray' : 'Detach panel';
      this.detachBtn.classList.toggle('active', this.isDetached);
    }
    if (this.headerElement) {
      (this.headerElement.style as any).webkitAppRegion = this.isDetached ? 'drag' : 'no-drag';
      this.headerElement.style.cursor = this.isDetached ? 'move' : 'default';
    }
  }

  /* Flash autosave state through the footer status dot */
  private flashAutosaveIndicator(): void {
    // Clear any pending timers
    if (this.autosaveIndicatorTimer) clearTimeout(this.autosaveIndicatorTimer);
    if (this.autosaveRevertTimer) clearTimeout(this.autosaveRevertTimer);

    // Phase 1: "Autosaving..." with white pulsing dot
    this.autosaveState = 'saving';
    this.updateFooterStatus();

    // Phase 2: After 1.5s, "Autosaved!" with solid white dot
    this.autosaveIndicatorTimer = setTimeout(() => {
      this.autosaveState = 'saved';
      this.updateFooterStatus();

      // Phase 3: After another 2s, revert to normal app status
      this.autosaveRevertTimer = setTimeout(() => {
        this.autosaveState = 'idle';
        this.updateFooterStatus();
      }, 2000);
    }, 1500);
  }



  private createTabBar(): HTMLElement {
    const tabBar = document.createElement('div');
    tabBar.className = 'tab-bar';

    for (const tab of TABS) {
      const btn = document.createElement('button');
      btn.className = `tab-button${tab.id === this.state.activeTab ? ' active' : ''}`;
      btn.textContent = tab.label;
      btn.onclick = () => {
        if (this.state.activeTab === tab.id) {
          this.pulseTabGlow(tabBar);
          return;
        }
        this.state.activeTab = tab.id;
        sessionStorage.setItem('rainscaper-tab', tab.id);
        this.switchTab(tab.id);
      };
      tabBar.appendChild(btn);
    }

    // Position gradient glow after layout settles
    requestAnimationFrame(() => this.updateTabGlow(tabBar));

    return tabBar;
  }

  /* Position the gradient overlay to match the active tab's bounds */
  private updateTabGlow(tabBar: HTMLElement, animate = false): void {
    const activeBtn = tabBar.querySelector('.tab-button.active') as HTMLElement;
    if (!activeBtn) return;
    const setPosition = () => {
      // getBoundingClientRect for sub-pixel precision, scaled back to local coords
      const barRect = tabBar.getBoundingClientRect();
      const btnRect = activeBtn.getBoundingClientRect();
      const scale = barRect.width / (tabBar.offsetWidth || barRect.width);
      const left = (btnRect.left - barRect.left) / scale;
      const width = btnRect.width / scale;
      tabBar.style.setProperty('--tab-glow-left', `${left}px`);
      tabBar.style.setProperty('--tab-glow-width', `${width}px`);
    };
    if (!animate) { setPosition(); return; }
    // Fade out → snap position → fade in
    tabBar.style.setProperty('--tab-glow-opacity', '0');
    setTimeout(() => {
      setPosition();
      requestAnimationFrame(() => tabBar.style.setProperty('--tab-glow-opacity', '1'));
    }, 100);
  }

  /* Two quick opacity pulses on the active tab gradient */
  private pulseTabGlow(tabBar: HTMLElement): void {
    this.clearPulseTimers();
    tabBar.style.setProperty('--tab-glow-opacity', '0.2');
    this.pulseTimers.push(setTimeout(() => {
      tabBar.style.setProperty('--tab-glow-opacity', '1');
      this.pulseTimers.push(setTimeout(() => {
        tabBar.style.setProperty('--tab-glow-opacity', '0.2');
        this.pulseTimers.push(setTimeout(() => {
          tabBar.style.setProperty('--tab-glow-opacity', '1');
          this.pulseTimers = [];
        }, 120));
      }, 120));
    }, 120));
  }

  private clearPulseTimers(): void {
    for (const t of this.pulseTimers) clearTimeout(t);
    this.pulseTimers = [];
  }

  /* Switch tab content without rebuilding entire panel */
  private switchTab(tabId: TabId): void {
    this.clearPulseTimers();
    // Determine slide direction from tab index change
    const prevIdx = TABS.findIndex(t => t.id === this.previousTab);
    const nextIdx = TABS.findIndex(t => t.id === tabId);
    const slideDir = nextIdx > prevIdx ? 'slide-left' : 'slide-right';
    this.previousTab = tabId;

    const tabBar = this.root.querySelector('.tab-bar') as HTMLElement;
    if (tabBar) {
      tabBar.querySelectorAll('.tab-button').forEach((btn, i) => {
        btn.classList.toggle('active', TABS[i]?.id === tabId);
      });
      this.updateTabGlow(tabBar, true);
    }

    // Stop debug interval if leaving system tab
    if (this.debugUpdateInterval && tabId !== 'system') {
      clearInterval(this.debugUpdateInterval);
      this.debugUpdateInterval = null;
    }

    // Replace content with directional slide animation
    const content = this.root.querySelector('.panel-content') as HTMLElement;
    if (content) {
      content.innerHTML = '';
      const newContent = this.createTabContent(tabId);
      newContent.classList.add(slideDir);
      content.appendChild(newContent);
    }
  }

  private createTabContent(tabId: TabId): HTMLElement {
    // Stop debug updates when leaving system tab
    if (this.debugUpdateInterval && tabId !== 'system') {
      clearInterval(this.debugUpdateInterval);
      this.debugUpdateInterval = null;
    }

    switch (tabId) {
      case 'basic':
        return this.createBasicTab();
      case 'physics':
        return this.createPhysicsTab();
      case 'audio':
        return this.createAudioTab();
      case 'visual':
        return this.createVisualTab();
      case 'system':
        return this.createSystemTab();
    }
  }

  private createBasicTab(): HTMLElement {
    const container = document.createElement('div');

    // Intensity OSC knob (inline with Intensity slider)
    const intensityOscKnob = RotaryKnob({
      value: this.state.intensityOsc,
      min: 0,
      max: 100,
      id: 'intensityOsc',
      description: 'Rain intensity drift (auto-varies how hard it rains)',
      onChange: (v) => {
        this.state.intensityOsc = v;
        window.rainydesk.updateRainscapeParam('physics.intensityOsc', v);
      },
    });

    // Intensity (min 1 — intensity 0 was confusing since Matrix still showed streams)
    container.appendChild(
      Slider({
        id: 'intensity',
        label: 'Intensity',
        value: this.state.intensity,
        min: 1,
        max: 100,
        unit: '%',
        extraElement: intensityOscKnob,
        onChange: (v) => {
          this.state.intensity = v;
          window.rainydesk.updateRainscapeParam('physics.intensity', v);
          this.updateFooterStatus();
        },
      })
    );

    // Wind OSC knob (inline with Wind slider)
    const windOscKnob = RotaryKnob({
      value: this.state.windOsc,
      min: 0,
      max: 100,
      id: 'windOsc',
      description: 'Wind gusts (oscillation strength)',
      onChange: (v) => {
        this.state.windOsc = v;
        window.rainydesk.updateRainscapeParam('physics.windOsc', v);
      },
    });

    // Wind (disabled in Matrix Mode coz Matrix uses fixed stream patterns)
    container.appendChild(
      Slider({
        id: 'wind',
        label: 'Windiness',
        value: this.state.wind,
        min: -100,
        max: 100,
        unit: '',
        defaultValue: 0,
        extraElement: windOscKnob,
        onChange: (v) => {
          this.state.wind = v;
          window.rainydesk.updateRainscapeParam('physics.wind', v);
        },
      })
    );

    // Volume
    container.appendChild(
      Slider({
        id: 'volume',
        label: 'Master Volume',
        value: this.state.volume,
        min: 0,
        max: 100,
        unit: '%',
        onChange: (v) => {
          this.applyVolumeChange(v);
        },
      })
    );

    // Mute + Pause row (combined)
    const toggleRow = document.createElement('div');
    toggleRow.className = 'toggle-pair-row';

    const muteToggle = Toggle({
      label: 'Mute',
      checked: this.state.muted,
      onChange: (v) => {
        this.state.muted = v;
        window.rainydesk.updateRainscapeParam('audio.muted', v);
        // When unmuting from 0 volume, set to 50%
        if (!v && this.state.volume === 0) {
          this.state.volume = 50;
          this.state.masterVolume = 50;
          const db = (50 / 100 * 60) - 60; // -30 dB
          window.rainydesk.updateRainscapeParam('effects.masterVolume', db);
          updateSliderValue(this.root, 'volume', 50);
          updateSliderValue(this.root, 'masterVolume', 50);
        }
      },
    });
    muteToggle.setAttribute('data-control', 'mute');
    toggleRow.appendChild(muteToggle);

    const separator = document.createElement('span');
    separator.className = 'toggle-separator';
    separator.textContent = '|';
    toggleRow.appendChild(separator);

    const pauseToggle = Toggle({
      label: 'Pause',
      checked: this.state.paused,
      onChange: (v) => {
        this.state.paused = v;
        window.rainydesk.updateRainscapeParam('system.paused', v);
        this.updateFooterStatus();
      },
    });
    pauseToggle.setAttribute('data-control', 'pause');
    toggleRow.appendChild(pauseToggle);

    container.appendChild(toggleRow);

    // Panel Appearance section (scale slider + theme grid with custom themes)
    const themeSection = document.createElement('div');
    themeSection.className = 'section';

    // Section header row with title + edit link
    const themeTitleRow = document.createElement('div');
    themeTitleRow.className = 'section-title-row';

    const themeTitle = document.createElement('div');
    themeTitle.className = 'section-title';
    themeTitle.textContent = 'Panel Appearance';
    themeTitleRow.appendChild(themeTitle);

    // Edit link (visible when a custom theme is active)
    const editLink = document.createElement('div');
    editLink.className = 'theme-edit-link';
    editLink.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg> Edit`;
    if (!this.state.theme.startsWith('custom-')) {
      editLink.style.display = 'none';
    }
    themeTitleRow.appendChild(editLink);

    themeSection.appendChild(themeTitleRow);

    // UI Scale slider
    const scaleSteps = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5];
    const foundIndex = scaleSteps.findIndex((s) => Math.abs(s - this.state.uiScale) < 0.01);
    const currentStepIndex = foundIndex >= 0 ? foundIndex : 2;

    themeSection.appendChild(
      Slider({
        id: 'uiScale',
        label: 'UI Scale',
        value: currentStepIndex,
        min: 0,
        max: scaleSteps.length - 1,
        unit: '%',
        defaultValue: 2,
        lazy: true,
        formatValue: (v) => `${Math.round(scaleSteps[v]! * 100)}`,
        onChange: (v) => {
          const scale = scaleSteps[v] ?? 1.0;
          this.state.uiScale = scale;
          localStorage.setItem('rainscaper-ui-scale', String(scale));
          this.applyUIScale(scale);
        },
      })
    );

    // Card flip container (wraps A-side theme grid + B-side editor)
    const flipContainer = document.createElement('div');
    flipContainer.className = 'flip-container';

    const flipCard = document.createElement('div');
    flipCard.className = 'flip-card';
    if (this.themeEditorOpen) flipCard.classList.add('flipped');

    // A-Side: Theme grid
    const flipFront = document.createElement('div');
    flipFront.className = 'flip-front';

    const themeGridWrapper = document.createElement('div');
    themeGridWrapper.className = 'theme-grid-wrapper';

    // Default themes (4x3, last slot is Randomize)
    const defaultGrid = document.createElement('div');
    defaultGrid.className = 'theme-selector theme-defaults';

    const defaultThemes = ['blue', 'purple', 'warm', 'sakura', 'forest', 'midnight', 'lavender', 'gothic', 'ocean', 'ember', 'windows'];
    for (const theme of defaultThemes) {
      const btn = document.createElement('button');
      btn.className = `theme-button${this.state.theme === theme ? ' active' : ''}`;
      btn.dataset.theme = theme;
      btn.dataset.tooltip = DEFAULT_THEME_NAMES[theme] || theme;
      btn.onclick = async () => {
        if (this.state.theme === theme) return;
        this.previousThemeId = this.state.theme;
        this.state.theme = theme;
        localStorage.setItem('rainscaper-theme', theme);
        editLink.style.display = 'none';
        await this.playThemeWipe(theme, btn, themeGridWrapper);
      };
      defaultGrid.appendChild(btn);
    }

    // Randomize button (replaces the old custom slot)
    const randomBtn = document.createElement('button');
    randomBtn.className = 'theme-button theme-randomize';
    randomBtn.dataset.tooltip = this.customThemes.length >= 12 ? 'All custom slots full' : 'Randomize!';
    if (this.customThemes.length >= 12) {
      randomBtn.classList.add('slots-full');
    }
    randomBtn.onclick = () => {
      if (this.customThemes.length >= 12) return;
      this.previousThemeId = this.state.theme;
      const random = generateRandomTheme();
      random.name = getRandomThemeName();
      this.scratchTheme = random;
      applyCustomTheme(random);
      this.openThemeEditor(null, flipCard);
    };
    defaultGrid.appendChild(randomBtn);

    // Defaults column (label + grid)
    const defaultsCol = document.createElement('div');
    defaultsCol.className = 'theme-column';
    const defaultsLabel = document.createElement('div');
    defaultsLabel.className = 'theme-grid-label';
    defaultsLabel.textContent = 'Defaults';
    defaultsCol.appendChild(defaultsLabel);
    defaultsCol.appendChild(defaultGrid);
    themeGridWrapper.appendChild(defaultsCol);

    const divider = document.createElement('div');
    divider.className = 'theme-divider';
    themeGridWrapper.appendChild(divider);

    // Yours column (label + grid)
    const customsCol = document.createElement('div');
    customsCol.className = 'theme-column';
    const customsLabel = document.createElement('div');
    customsLabel.className = 'theme-grid-label';
    customsLabel.textContent = 'Yours';
    customsCol.appendChild(customsLabel);

    // Custom themes grid (4×3, matching defaults)
    const customGrid = document.createElement('div');
    customGrid.className = 'theme-selector theme-customs';

    for (let i = 0; i < 12; i++) {
      const theme = this.customThemes[i];
      if (theme) {
        const btn = document.createElement('button');
        btn.className = `theme-button theme-custom-slot${this.state.theme === theme.id ? ' active' : ''}`;
        btn.dataset.theme = theme.id;
        btn.dataset.tooltip = theme.name || 'Custom Theme';
        btn.style.setProperty('--custom-accent', theme.colors.accent);
        btn.onclick = async () => {
          if (this.state.theme === theme.id) return;
          this.previousThemeId = this.state.theme;
          this.state.theme = theme.id;
          localStorage.setItem('rainscaper-theme', theme.id);
          editLink.style.display = '';
          await this.playThemeWipe(theme.id, btn, themeGridWrapper, () => applyCustomTheme(theme));
        };
        customGrid.appendChild(btn);
      } else if (i === this.customThemes.length) {
        // Next available slot: clickable "+" button
        const emptyBtn = document.createElement('button');
        emptyBtn.className = 'theme-button theme-empty-slot';
        emptyBtn.dataset.tooltip = 'New theme';
        emptyBtn.innerHTML = '+';
        emptyBtn.onclick = () => {
          if (this.customThemes.length >= 12) return;
          this.previousThemeId = this.state.theme;
          const random = generateRandomTheme();
          random.name = getRandomThemeName();
          this.scratchTheme = random;
          applyCustomTheme(random);
          this.openThemeEditor(null, flipCard);
        };
        customGrid.appendChild(emptyBtn);
      } else {
        // Future empty slots: faded non-interactive placeholders
        const placeholder = document.createElement('div');
        placeholder.className = 'theme-button theme-empty-slot theme-placeholder';
        placeholder.innerHTML = '+';
        customGrid.appendChild(placeholder);
      }
    }

    customsCol.appendChild(customGrid);
    themeGridWrapper.appendChild(customsCol);

    flipFront.appendChild(themeGridWrapper);

    // Wire up edit link click handler (link is in the section title row)
    editLink.onclick = () => {
      const activeTheme = this.customThemes.find(t => t.id === this.state.theme);
      if (activeTheme) {
        this.previousThemeId = this.state.theme;
        this.scratchTheme = JSON.parse(JSON.stringify(activeTheme));
        this.openThemeEditor(activeTheme.id, flipCard);
      }
    };

    // B-Side: Theme editor (content built lazily when opened)
    const flipBack = document.createElement('div');
    flipBack.className = 'flip-back';

    flipCard.appendChild(flipFront);
    flipCard.appendChild(flipBack);
    flipContainer.appendChild(flipCard);
    themeSection.appendChild(flipContainer);
    container.appendChild(themeSection);

    // Tooltip setup for theme buttons
    requestAnimationFrame(() => {
      this.setupThemeTooltips(themeSection);
      this.updateMatrixModeSliders();
    });

    return container;
  }

  // Theme Editor (B-side of card flip)
  private createThemeEditor(flipCard: HTMLElement): HTMLElement {
    const editor = document.createElement('div');
    editor.className = 'theme-editor';

    // Header
    const headerRow = document.createElement('div');
    headerRow.className = 'theme-editor-header';
    const headerTitle = document.createElement('span');
    headerTitle.textContent = 'Theme Editor';
    headerRow.appendChild(headerTitle);
    editor.appendChild(headerRow);

    // Theme name input
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'theme-name-input';
    nameInput.placeholder = 'Untitled Theme';
    nameInput.value = this.scratchTheme?.name || '';
    nameInput.maxLength = 30;
    nameInput.oninput = () => {
      if (this.scratchTheme) this.scratchTheme.name = nameInput.value;
    };
    editor.appendChild(nameInput);

    // Primary color pickers row
    const primaryRow = document.createElement('div');
    primaryRow.className = 'theme-primary-colors';

    const makeColorPicker = (label: string, value: string, onChange: (v: string) => void) => {
      const group = document.createElement('div');
      group.className = 'theme-color-group';

      const lbl = document.createElement('div');
      lbl.className = 'theme-color-label';
      lbl.textContent = label;
      group.appendChild(lbl);

      const input = document.createElement('input');
      input.type = 'color';
      input.className = 'theme-color-input';
      input.value = value;
      input.oninput = () => {
        hexLabel.textContent = input.value;
        onChange(input.value);
        if (this.scratchTheme) applyCustomTheme(this.scratchTheme);
      };
      group.appendChild(input);

      const hexLabel = document.createElement('div');
      hexLabel.className = 'theme-color-hex';
      hexLabel.textContent = value;
      group.appendChild(hexLabel);

      return group;
    };

    const scratch = this.scratchTheme!;
    primaryRow.appendChild(makeColorPicker('Accent', scratch.colors.accent, (v) => { scratch.colors.accent = v; }));
    primaryRow.appendChild(makeColorPicker('Background', scratch.colors.background, (v) => { scratch.colors.background = v; }));
    primaryRow.appendChild(makeColorPicker('Text', scratch.colors.text, (v) => { scratch.colors.text = v; }));
    editor.appendChild(primaryRow);

    // Auto Colors toggle
    const autoRow = document.createElement('div');
    autoRow.className = 'theme-auto-row';
    autoRow.appendChild(Toggle({
      label: 'Auto Colors',
      checked: scratch.colors.autoColors,
      onChange: (v) => {
        scratch.colors.autoColors = v;
        const ft = editor.querySelector('.theme-fine-tuning') as HTMLElement;
        if (ft) ft.classList.toggle('disabled', v);
      },
    }));
    editor.appendChild(autoRow);

    // Randomize button
    const randomizeBtn = document.createElement('button');
    randomizeBtn.className = 'theme-randomize-btn';
    randomizeBtn.textContent = 'Randomize!';
    randomizeBtn.onclick = () => {
      const newRandom = generateRandomTheme();
      newRandom.name = nameInput.value || getRandomThemeName();
      newRandom.id = scratch.id;
      newRandom.fonts = { ...scratch.fonts };
      Object.assign(scratch, newRandom);
      // Refresh editor inputs
      nameInput.value = scratch.name;
      const colorInputs = primaryRow.querySelectorAll('.theme-color-input') as NodeListOf<HTMLInputElement>;
      const hexLabels = primaryRow.querySelectorAll('.theme-color-hex');
      if (colorInputs[0]) { colorInputs[0].value = scratch.colors.accent; hexLabels[0]!.textContent = scratch.colors.accent; }
      if (colorInputs[1]) { colorInputs[1].value = scratch.colors.background; hexLabels[1]!.textContent = scratch.colors.background; }
      if (colorInputs[2]) { colorInputs[2].value = scratch.colors.text; hexLabels[2]!.textContent = scratch.colors.text; }
      applyCustomTheme(scratch);
    };
    editor.appendChild(randomizeBtn);

    // Fine Tuning (collapsible)
    const ftSection = document.createElement('div');
    ftSection.className = `theme-fine-tuning${scratch.colors.autoColors ? ' disabled' : ''}`;

    const ftHeader = document.createElement('div');
    ftHeader.className = 'theme-ft-header collapsible';
    ftHeader.innerHTML = '<span class="collapse-arrow">&#9654;</span> Fine Tuning';
    const ftContent = document.createElement('div');
    ftContent.className = 'theme-ft-content collapsible-section collapsed';

    ftHeader.onclick = () => {
      const isCollapsed = ftContent.classList.contains('collapsed');
      ftContent.classList.toggle('collapsed');
      ftHeader.querySelector('.collapse-arrow')!.innerHTML = isCollapsed ? '&#9660;' : '&#9654;';
    };

    const ftGrid = document.createElement('div');
    ftGrid.className = 'theme-ft-grid';

    // Get derived values to show as placeholders
    const derived = deriveThemeColors(scratch.colors.accent, scratch.colors.background, scratch.colors.text);

    const ftFields: [string, keyof typeof scratch.colors, string][] = [
      ['Accent Hover', 'accentHover', derived.accentHover],
      ['Accent Active', 'accentActive', derived.accentActive],
      ['Border Color', 'borderColor', derived.panelBorder],
      ['Shadow Color', 'shadowColor', derived.panelShadow],
      ['Close Hover', 'closeHover', derived.closeHover],
      ['Slider Track', 'sliderTrack', derived.sliderTrack],
      ['Toggle BG', 'toggleBg', derived.toggleBg],
      ['Text Secondary', 'textSecondary', derived.textSecondary],
    ];

    for (const [label, key] of ftFields) {
      const row = document.createElement('div');
      row.className = 'theme-ft-row';

      const lbl = document.createElement('span');
      lbl.className = 'theme-ft-label';
      lbl.textContent = label;
      row.appendChild(lbl);

      const input = document.createElement('input');
      input.type = 'color';
      input.className = 'theme-color-input theme-ft-input';
      // Fine tuning values can be hex or rgba — convert rgba placeholders to hex for color input
      const currentVal = scratch.colors[key] as string | null;
      input.value = currentVal || '#808080';
      if (!currentVal) input.classList.add('placeholder');
      input.oninput = () => {
        (scratch.colors as unknown as Record<string, unknown>)[key] = input.value;
        input.classList.remove('placeholder');
        applyCustomTheme(scratch);
      };
      row.appendChild(input);
      ftGrid.appendChild(row);
    }

    ftContent.appendChild(ftGrid);
    ftSection.appendChild(ftHeader);
    ftSection.appendChild(ftContent);
    editor.appendChild(ftSection);

    // Font editing (TODO: implement properly later so the freaks can have their Comic Sans)
    // const fontSection = document.createElement('div');
    // fontSection.className = 'theme-fonts';
    // const makeFontSelect = (label: string, current: string, onChange: (v: string) => void) => {
    //   const row = document.createElement('div');
    //   row.className = 'theme-font-row';
    //   const lbl = document.createElement('span');
    //   lbl.className = 'theme-font-label';
    //   lbl.textContent = label;
    //   row.appendChild(lbl);
    //   const select = document.createElement('select');
    //   select.className = 'theme-font-select';
    //   const bundledGroup = document.createElement('optgroup');
    //   bundledGroup.label = 'Bundled';
    //   for (const font of FONT_LIST.bundled) {
    //     const opt = document.createElement('option');
    //     opt.value = font;
    //     opt.textContent = font;
    //     opt.style.fontFamily = `'${font}'`;
    //     if (font === current) opt.selected = true;
    //     bundledGroup.appendChild(opt);
    //   }
    //   select.appendChild(bundledGroup);
    //   const systemGroup = document.createElement('optgroup');
    //   systemGroup.label = 'System';
    //   for (const font of FONT_LIST.system) {
    //     const opt = document.createElement('option');
    //     opt.value = font;
    //     opt.textContent = font;
    //     opt.style.fontFamily = `'${font}'`;
    //     if (font === current) opt.selected = true;
    //     systemGroup.appendChild(opt);
    //   }
    //   select.appendChild(systemGroup);
    //   select.onchange = () => {
    //     onChange(select.value);
    //     if (this.scratchTheme) applyCustomTheme(this.scratchTheme);
    //   };
    //   row.appendChild(select);
    //   return row;
    // };
    // fontSection.appendChild(makeFontSelect('Body Font', scratch.fonts.body, (v) => { scratch.fonts.body = v; }));
    // fontSection.appendChild(makeFontSelect('Header Font', scratch.fonts.headers, (v) => { scratch.fonts.headers = v; }));
    // fontSection.appendChild(Toggle({
    //   label: 'Apply to Matrix Mode',
    //   checked: scratch.fonts.applyToMatrix,
    //   onChange: (v) => { scratch.fonts.applyToMatrix = v; },
    // }));
    // editor.appendChild(fontSection);

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'theme-editor-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'theme-action-btn theme-save-btn';
    saveBtn.textContent = 'Save';
    let saveConfirmPending = false;
    saveBtn.onclick = () => {
      if (this.editingThemeId && !saveConfirmPending) {
        // Overwriting existing — require confirmation
        saveConfirmPending = true;
        saveBtn.textContent = 'Confirm?';
        saveBtn.classList.add('confirming');
        return;
      }
      this.saveCustomTheme(flipCard);
    };
    actions.appendChild(saveBtn);

    if (this.editingThemeId) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'theme-action-btn theme-delete-btn';
      deleteBtn.textContent = 'Delete';
      deleteBtn.onclick = () => this.deleteCustomTheme(flipCard);
      actions.appendChild(deleteBtn);
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'theme-action-btn theme-cancel-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => this.cancelThemeEditor(flipCard);
    actions.appendChild(cancelBtn);

    editor.appendChild(actions);
    return editor;
  }

  private openThemeEditor(existingId: string | null, flipCard: HTMLElement): void {
    this.editingThemeId = existingId;
    this.themeEditorOpen = true;

    // Rebuild editor content with current scratchTheme
    const flipBack = flipCard.querySelector('.flip-back') as HTMLElement;
    if (flipBack) {
      flipBack.innerHTML = '';
      flipBack.appendChild(this.createThemeEditor(flipCard));
    }

    // Toggle Edit → Back
    const editLink = flipCard.closest('.section')?.querySelector('.theme-edit-link') as HTMLElement | null;
    if (editLink) {
      editLink.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg> Back`;
      editLink.style.display = '';
      editLink.onclick = () => this.cancelThemeEditor(flipCard);
    }

    flipCard.classList.add('flipped');
  }

  private async cancelThemeEditor(flipCard: HTMLElement): Promise<void> {
    this.themeEditorOpen = false;
    this.scratchTheme = null;
    this.editingThemeId = null;
    flipCard.classList.remove('flipped');

    // Toggle Back → Edit (or hide if not a custom theme)
    const editLink = flipCard.closest('.section')?.querySelector('.theme-edit-link') as HTMLElement | null;
    if (editLink) {
      editLink.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg> Edit`;
      if (!this.previousThemeId.startsWith('custom-')) {
        editLink.style.display = 'none';
      }
      // Restore edit click handler
      editLink.onclick = () => {
        const activeTheme = this.customThemes.find(t => t.id === this.state.theme);
        if (activeTheme) {
          this.previousThemeId = this.state.theme;
          this.scratchTheme = JSON.parse(JSON.stringify(activeTheme));
          this.openThemeEditor(activeTheme.id, flipCard);
        }
      };
    }

    // Clear B-side after flip animation to collapse container height
    setTimeout(() => {
      const flipBack = flipCard.querySelector('.flip-back') as HTMLElement;
      if (flipBack) flipBack.innerHTML = '';
    }, 550);

    // Revert to the previous theme
    clearCustomFonts();
    if (this.previousThemeId.startsWith('custom-')) {
      const prev = this.customThemes.find(t => t.id === this.previousThemeId);
      if (prev) {
        applyCustomTheme(prev);
        this.state.theme = prev.id;
      } else {
        await applyTheme('blue');
        this.state.theme = 'blue';
      }
    } else {
      await applyTheme(this.previousThemeId);
      this.state.theme = this.previousThemeId;
    }
    localStorage.setItem('rainscaper-theme', this.state.theme);
  }

  private async saveCustomTheme(flipCard: HTMLElement): Promise<void> {
    if (!this.scratchTheme) return;

    // Default name if empty
    if (!this.scratchTheme.name.trim()) {
      this.scratchTheme.name = getRandomThemeName();
    }

    if (this.editingThemeId) {
      // Update existing theme
      const idx = this.customThemes.findIndex(t => t.id === this.editingThemeId);
      if (idx >= 0) {
        this.scratchTheme.id = this.editingThemeId;
        this.customThemes[idx] = JSON.parse(JSON.stringify(this.scratchTheme));
      }
    } else {
      // Find the next available slot ID
      const usedIds = new Set(this.customThemes.map(t => t.id));
      let slotId = '';
      for (let i = 1; i <= 12; i++) {
        if (!usedIds.has(`custom-${i}`)) {
          slotId = `custom-${i}`;
          break;
        }
      }
      if (!slotId) return; // All slots full (shouldn't happen — Randomize is disabled)

      this.scratchTheme.id = slotId;
      this.customThemes.push(JSON.parse(JSON.stringify(this.scratchTheme)));
    }

    // Set as active theme
    this.state.theme = this.scratchTheme.id;
    localStorage.setItem('rainscaper-theme', this.state.theme);

    // Persist to disk
    await this.persistCustomThemes();

    // Close editor and re-render
    this.themeEditorOpen = false;
    this.scratchTheme = null;
    this.editingThemeId = null;
    flipCard.classList.remove('flipped');
    this.render();
  }

  private async deleteCustomTheme(flipCard: HTMLElement): Promise<void> {
    if (!this.editingThemeId) return;

    // Simple confirmation
    const themeToDelete = this.customThemes.find(t => t.id === this.editingThemeId);
    const name = themeToDelete?.name || 'this theme';
    if (!confirm(`Delete "${name}"?`)) return;

    this.customThemes = this.customThemes.filter(t => t.id !== this.editingThemeId);
    await this.persistCustomThemes();

    // Revert to blue
    this.state.theme = 'blue';
    localStorage.setItem('rainscaper-theme', 'blue');
    clearCustomFonts();
    await applyTheme('blue');

    this.themeEditorOpen = false;
    this.scratchTheme = null;
    this.editingThemeId = null;
    flipCard.classList.remove('flipped');
    this.render();
  }

  private async persistCustomThemes(): Promise<void> {
    const data: UserThemesFile = {
      version: 1,
      themes: this.customThemes,
    };
    try {
      await window.rainydesk.saveUserThemes(data);
    } catch (err) {
      console.error('Failed to save custom themes:', err);
    }
  }

  private setupThemeTooltips(container: HTMLElement): void {
    const buttons = container.querySelectorAll('.theme-button[data-tooltip]');
    let tooltip: HTMLElement | null = null;

    const show = (btn: HTMLElement) => {
      const text = btn.dataset.tooltip;
      if (!text) return;

      tooltip = document.createElement('div');
      tooltip.className = 'theme-tooltip';
      tooltip.textContent = text;
      document.body.appendChild(tooltip);

      const rect = btn.getBoundingClientRect();
      const tipRect = tooltip.getBoundingClientRect();
      tooltip.style.left = `${rect.left + rect.width / 2 - tipRect.width / 2}px`;
      tooltip.style.top = `${rect.top - tipRect.height - 6}px`;
    };

    const hide = () => {
      if (tooltip) { tooltip.remove(); tooltip = null; }
    };

    buttons.forEach(btn => {
      btn.addEventListener('mouseenter', () => show(btn as HTMLElement));
      btn.addEventListener('mouseleave', hide);
    });
  }

  private createPhysicsTab(): HTMLElement {
    const container = document.createElement('div');

    // Gravity (Matrix: Fall Speed)
    container.appendChild(
      Slider({
        id: 'gravity',
        label: 'Gravity',
        matrixLabel: 'Fall Speed',
        value: this.state.gravity,
        min: 100,
        max: 2000,
        step: 10,
        unit: '',
        defaultValue: 980,
        onChange: (v) => {
          this.state.gravity = v;
          window.rainydesk.updateRainscapeParam('physics.gravity', v);
        },
      })
    );

    // Chain-link toggle: links splash scale to drop mass
    const chainSvgA = 'width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"';
    const chainLinkedPath = 'M14 12C14 14.7614 11.7614 17 9 17H7C4.23858 17 2 14.7614 2 12C2 9.23858 4.23858 7 7 7H7.5M10 12C10 9.23858 12.2386 7 15 7H17C19.7614 7 22 9.23858 22 12C22 14.7614 19.7614 17 17 17H16.5';
    const chainUnlinkedPath = 'M7 7C4.23858 7 2 9.23858 2 12C2 14.7614 4.23858 17 7 17H9C11.1636 17 13.0062 15.6258 13.7026 13.7026M17 17H16.5M10 12C10 11.4021 10.1049 10.8288 10.2974 10.2974M21 21L13.7026 13.7026M3 3L10.2974 10.2974M10.2974 10.2974L13.7026 13.7026M13.0464 7.39604C13.6466 7.14106 14.3068 7 15 7H17C19.7614 7 22 9.23858 22 12C22 13.2151 21.5665 14.329 20.8458 15.1954';

    // Derive splash scale from drop mass: mass 1-10 -> splashScale 0.5-2.0
    const deriveSplashScale = (dropMass: number): number => 0.5 + (dropMass - 1) * (1.5 / 9);

    // Both chain icons share state; collect them so we can update in sync
    const chainIcons: HTMLElement[] = [];

    const createChainIcon = (): HTMLElement => {
      const btn = document.createElement('button');
      btn.className = 'chain-link-toggle';
      btn.title = this.state.splashLinked ? 'Linked to Drop Mass (click to unlink)' : 'Independent (click to link)';
      btn.innerHTML = `<svg ${chainSvgA}><path d="${this.state.splashLinked ? chainLinkedPath : chainUnlinkedPath}" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
      btn.style.cssText = 'background:none;border:none;cursor:pointer;padding:2px;color:currentColor;opacity:0.7;display:flex;align-items:center;';
      if (this.state.splashLinked) btn.style.opacity = '1';

      btn.addEventListener('click', () => {
        this.state.splashLinked = !this.state.splashLinked;
        window.rainydesk.updateRainscapeParam('physics.splashLinked', this.state.splashLinked);

        // Update all chain icons in sync
        for (const icon of chainIcons) {
          icon.innerHTML = `<svg ${chainSvgA}><path d="${this.state.splashLinked ? chainLinkedPath : chainUnlinkedPath}" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
          icon.title = this.state.splashLinked ? 'Linked to Drop Mass (click to unlink)' : 'Independent (click to link)';
          icon.style.opacity = this.state.splashLinked ? '1' : '0.7';
        }

        // Enable/disable splash slider
        const splashRow = this.root.querySelector('[data-slider-id="splashSize"]') as HTMLElement;
        if (splashRow) {
          const slider = splashRow.querySelector('.slider') as HTMLInputElement;
          if (slider) {
            slider.disabled = this.state.splashLinked;
            slider.style.opacity = this.state.splashLinked ? '0.4' : '';
            slider.style.pointerEvents = this.state.splashLinked ? 'none' : '';
          }
        }

        // When linking, derive splash from current drop mass
        if (this.state.splashLinked) {
          const derived = deriveSplashScale(this.state.dropSize);
          this.state.splashSize = derived;
          window.rainydesk.updateRainscapeParam('physics.splashScale', derived);
          updateSliderValue(this.root, 'splashSize', Math.round(((derived - 0.5) / 1.5) * 100));
        }
      });

      chainIcons.push(btn);
      return btn;
    };

    const splashChainIcon = createChainIcon();
    const dropMassChainIcon = createChainIcon();

    // Splash size (disabled in Matrix Mode)
    // Slider 0-100% maps to splashScale 0.5-2.0 (full valid range)
    // Default 33% ~ splashScale 1.0
    container.appendChild(
      Slider({
        id: 'splashSize',
        label: 'Splash Size',
        value: Math.round(((this.state.splashSize - 0.5) / 1.5) * 100),
        min: 0,
        max: 100,
        unit: '%',
        defaultValue: 33,
        extraElement: splashChainIcon,
        onChange: (v) => {
          const splashScale = 0.5 + (v / 100) * 1.5;
          this.state.splashSize = splashScale;
          window.rainydesk.updateRainscapeParam('physics.splashScale', splashScale);
        },
      })
    );

    // Disable splash slider when linked
    if (this.state.splashLinked) {
      const splashRow = this.root.querySelector('[data-slider-id="splashSize"]') as HTMLElement;
      if (splashRow) {
        const slider = splashRow.querySelector('.slider') as HTMLInputElement;
        if (slider) {
          slider.disabled = true;
          slider.style.opacity = '0.4';
          slider.style.pointerEvents = 'none';
        }
      }
    }

    // Puddle drain (disabled in Matrix Mode)
    container.appendChild(
      Slider({
        id: 'puddleDrain',
        label: 'Puddle Drain',
        value: this.state.puddleDrain * 100,
        min: 0,
        max: 100,
        unit: '%',
        defaultValue: 20,
        onChange: (v) => {
          this.state.puddleDrain = v / 100;
          window.rainydesk.updateRainscapeParam('physics.puddleDrain', v / 100);
        },
      })
    );

    // Turbulence OSC knob (inline with Turbulence slider)
    const turbulenceOscKnob = RotaryKnob({
      value: this.state.turbulenceOsc,
      min: 0,
      max: 100,
      id: 'turbulenceOsc',
      description: 'Turbulence drift (auto-varies chaos level)',
      onChange: (v) => {
        this.state.turbulenceOsc = v;
        window.rainydesk.updateRainscapeParam('physics.turbulenceOsc', v);
      },
    });

    // Turbulence (Matrix: Glitchiness)
    container.appendChild(
      Slider({
        id: 'turbulence',
        label: 'Turbulence',
        matrixLabel: 'Glitchiness',
        value: this.state.turbulence * 100,
        min: 0,
        max: 100,
        unit: '%',
        defaultValue: 30,
        extraElement: turbulenceOscKnob,
        onChange: (v) => {
          this.state.turbulence = v / 100;
          window.rainydesk.updateRainscapeParam('physics.turbulence', v / 100);
        },
      })
    );

    // Drop mass (Matrix: String Length) — chain icon links splash scale
    container.appendChild(
      Slider({
        id: 'dropMass',
        label: 'Max. Drop Mass',
        matrixLabel: 'String Length',
        value: this.state.dropSize,
        min: 1,
        max: 10,
        unit: '',
        defaultValue: 4,
        extraElement: dropMassChainIcon,
        onChange: (v) => {
          this.state.dropSize = v;
          window.rainydesk.updateRainscapeParam('physics.dropMaxSize', v);
          // When linked, derive splash scale from drop mass
          if (this.state.splashLinked) {
            const derived = deriveSplashScale(v);
            this.state.splashSize = derived;
            window.rainydesk.updateRainscapeParam('physics.splashScale', derived);
            updateSliderValue(this.root, 'splashSize', Math.round(((derived - 0.5) / 1.5) * 100));
          }
        },
      })
    );

    // Reverse gravity toggle (Matrix: Reverse Engineer)
    const reverseToggle = Toggle({
      label: 'Reverse Gravity',
      checked: this.state.reverseGravity,
      onChange: (v) => {
        this.state.reverseGravity = v;
        window.rainydesk.updateRainscapeParam('physics.reverseGravity', v);
      },
    });
    reverseToggle.dataset.toggleId = 'reverseGravity';
    reverseToggle.dataset.normalLabel = 'Reverse Gravity';
    reverseToggle.dataset.matrixLabel = 'Reverse Engineer';
    container.appendChild(reverseToggle);

    // Apply Matrix Mode state to slider labels and disabled states
    requestAnimationFrame(() => this.updateMatrixModeSliders());

    return container;
  }

  private updateResetButtonVisibility(): void {
    if (!this.resetRainButton) return;
    // Don't hide when showing "Resume?" — let the resume flow handle it
    if (this.resetRainButton.textContent === 'Resume?') return;
    const gridChanged = Math.abs(this.state.gridScalePending - this.state.gridScale) > 0.01;
    const renderChanged = Math.abs(this.state.renderScalePending - this.state.renderScale) > 0.01;
    this.resetRainButton.style.display = (gridChanged || renderChanged) ? 'block' : 'none';
  }

  private handleResetRain(): void {
    const wasPaused = this.state.paused;

    this.state.appStatus = 'stopped';
    this.updateFooterStatus();
    window.rainydesk.updateRainscapeParam('physics.resetSimulation', {
      gridScale: this.state.gridScalePending,
      renderScale: this.state.renderScalePending,
    });
    this.state.gridScale = this.state.gridScalePending;
    this.state.renderScale = this.state.renderScalePending;

    if (wasPaused && this.resetRainButton) {
      // Reinit while paused: offer to resume
      this.resetRainButton.textContent = 'Resume?';
      this.resetRainButton.style.display = 'block';
      this.resetRainButton.onclick = () => {
        this.state.paused = false;
        window.rainydesk.updateRainscapeParam('system.paused', false);
        this.updatePauseToggle();
        if (this.resetRainButton) {
          this.resetRainButton.textContent = 'Apply Changes';
          this.resetRainButton.style.display = 'none';
          this.resetRainButton.onclick = null;
          this.resetRainButton.addEventListener('click', () => this.handleResetRain());
        }
      };
    } else if (this.resetRainButton) {
      this.resetRainButton.style.display = 'none';
    }
  }

  private flashReinitButton(): void {
    if (!this.reinitButton) return;
    // Clear any active cooldown so the button is immediately usable
    this.reinitCooldownEnd = 0;
    if (this.reinitCooldownTimer) {
      clearInterval(this.reinitCooldownTimer);
      this.reinitCooldownTimer = null;
    }
    this.reinitButton.disabled = false;
    // Restore label (cooldown may have overwritten it with "Cooldown (Ns)")
    const svgA = 'width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"';
    const resetIcon = `<svg ${svgA}><path d="M12 21V11M12 11L9 14M12 11L15 14M7 16.8184C4.69636 16.2074 3 14.1246 3 11.6493C3 9.20008 4.8 6.9375 7.5 6.5C8.34694 4.48637 10.3514 3 12.6893 3C15.684 3 18.1317 5.32251 18.3 8.25C19.8893 8.94488 21 10.6503 21 12.4969C21 14.8148 19.25 16.7236 17 16.9725" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    this.reinitButton.innerHTML = `${resetIcon}Reset RainyDesk`;
    this.reinitButton.classList.add('monitor-alert');
    this.reinitButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const cleanup = () => this.reinitButton?.classList.remove('monitor-alert');
    this.reinitButton.addEventListener('click', cleanup, { once: true });
  }

  private createAudioTab(): HTMLElement {
    const container = document.createElement('div');

    // Master volume
    container.appendChild(
      Slider({
        id: 'masterVolume',
        label: 'Master Volume',
        value: this.state.masterVolume,
        min: 0,
        max: 100,
        unit: '%',
        onChange: (v) => {
          this.applyVolumeChange(v);
        },
      })
    );

    // Rain-mode sliders (hidden in Matrix Mode — Matrix has its own controls)
    const rainAudioSliders = document.createElement('div');
    rainAudioSliders.id = 'rain-audio-sliders';
    if (this.state.matrixMode) rainAudioSliders.style.display = 'none';

    // Impact sound (raindrop impact volume)
    rainAudioSliders.appendChild(
      Slider({
        id: 'impactSound',
        label: 'Impact Sound',
        value: this.state.rainIntensity,
        min: 0,
        max: 100,
        unit: '%',
        defaultValue: 50,
        onChange: (v) => {
          this.state.rainIntensity = v;
          window.rainydesk.updateRainscapeParam('audio.rainIntensity', v);
        },
      })
    );

    // Impact pitch OSC knob (inline with Impact Pitch slider)
    const impactPitchOscKnob = RotaryKnob({
      value: this.state.impactPitchOsc,
      min: 0,
      max: 100,
      id: 'impactPitchOsc',
      description: 'Per-drop pitch variation (randomizes each raindrop)',
      onChange: (v) => {
        this.state.impactPitchOsc = v;
        window.rainydesk.updateRainscapeParam('audio.impactPitchOsc', v);
      },
    });

    // Impact pitch (filter center frequency)
    rainAudioSliders.appendChild(
      Slider({
        id: 'impactPitch',
        label: 'Impact Pitch',
        value: this.state.impactPitch,
        min: 0,
        max: 100,
        unit: '%',
        defaultValue: 50,
        extraElement: impactPitchOscKnob,
        onChange: (v) => {
          this.state.impactPitch = v;
          window.rainydesk.updateRainscapeParam('audio.impactPitch', v);
        },
      })
    );

    // Rain sheet OSC knob (inline with Rain Sheet slider)
    const sheetOscKnob = RotaryKnob({
      value: this.state.sheetOsc,
      min: 0,
      max: 100,
      id: 'sheetOsc',
      description: 'Rain sheet drift (auto-varies background noise level)',
      onChange: (v) => {
        this.state.sheetOsc = v;
        window.rainydesk.updateRainscapeParam('audio.sheetOsc', v);
      },
    });

    // Rain sheet (pink/brown noise bed)
    rainAudioSliders.appendChild(
      Slider({
        id: 'sheetVolume',
        label: 'Rain Sheet',
        value: this.state.sheetVolume,
        min: 0,
        max: 100,
        unit: '%',
        defaultValue: 50,
        extraElement: sheetOscKnob,
        onChange: (v) => {
          this.state.sheetVolume = v;
          window.rainydesk.updateRainscapeParam('audio.sheetVolume', v);
        },
      })
    );

    // Wind volume (Matrix Mode has its own Drone slider)
    rainAudioSliders.appendChild(
      Slider({
        id: 'windSound',
        label: 'Wind',
        value: this.state.windSound,
        min: 0,
        max: 100,
        unit: '%',
        defaultValue: 20,
        onChange: (v) => {
          this.state.windSound = v;
          // 0% = mute (-60dB), 1-100% maps to -24dB to +12dB (36dB range)
          const db = v <= 0 ? -60 : (v / 100 * 36) - 24;
          window.rainydesk.updateRainscapeParam('audio.wind.masterGain', db);
        },
      })
    );

    container.appendChild(rainAudioSliders);

    // Thunder section (hidden in Matrix Mode)
    const thunderSection = document.createElement('div');
    thunderSection.id = 'thunder-audio-section';
    thunderSection.style.display = this.state.matrixMode ? 'none' : 'block';

    const thunderDivider = document.createElement('hr');
    thunderDivider.className = 'panel-separator';
    thunderSection.appendChild(thunderDivider);

    // Header row: mirrors control-row layout so STRIKE aligns with OSC knobs below
    const thunderHeaderRow = document.createElement('div');
    thunderHeaderRow.className = 'thunder-header-row';

    // Left zone (140px, same as control-label-container) holds title + STRIKE btn
    const headerLabelZone = document.createElement('div');
    headerLabelZone.className = 'control-label-container';
    const thunderTitle = document.createElement('span');
    thunderTitle.className = 'section-title';
    thunderTitle.textContent = 'Thunder';
    headerLabelZone.appendChild(thunderTitle);

    // Test strike button — sits where OSC knobs go, aligning with knobs below
    const testStrikeBtn = document.createElement('button');
    testStrikeBtn.className = 'thunder-test-btn';
    testStrikeBtn.id = 'thunder-test-btn';
    testStrikeBtn.appendChild(RainyDeskPanel.createCloudBoltSVG());
    testStrikeBtn.onclick = () => {
      window.rainydesk.updateRainscapeParam('audio.thunder.testStrike', 1);
    };
    let strikeTip: HTMLElement | null = null;
    testStrikeBtn.onmouseenter = () => { strikeTip = showTooltip(testStrikeBtn, 'STRIKE!'); };
    testStrikeBtn.onmouseleave = () => { strikeTip = hideTooltip(strikeTip); };
    headerLabelZone.appendChild(testStrikeBtn);
    thunderHeaderRow.appendChild(headerLabelZone);

    // Right zone holds the toggle, pushed to the far right
    const toggleArea = document.createElement('div');
    toggleArea.className = 'thunder-toggle-area';
    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'toggle';
    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.checked = this.state.thunderEnabled;
    const toggleTrack = document.createElement('span');
    toggleTrack.className = 'toggle-track';
    const toggleThumb = document.createElement('span');
    toggleThumb.className = 'toggle-thumb';
    toggleLabel.appendChild(toggleInput);
    toggleLabel.appendChild(toggleTrack);
    toggleLabel.appendChild(toggleThumb);
    toggleArea.appendChild(toggleLabel);
    thunderHeaderRow.appendChild(toggleArea);

    thunderSection.appendChild(thunderHeaderRow);

    // Collapsible content
    const thunderContent = document.createElement('div');
    thunderContent.className = 'thunder-content';
    if (!this.state.thunderEnabled) thunderContent.classList.add('collapsed');

    toggleInput.onchange = () => {
      this.state.thunderEnabled = toggleInput.checked;
      thunderContent.classList.toggle('collapsed', !toggleInput.checked);
      if (toggleInput.checked) {
        // Ensure storminess is at least 1 before enabling
        const storm = Math.max(1, this.state.thunderStorminess);
        this.state.thunderStorminess = storm;
        updateSliderValue(thunderContent, 'thunderStorminess', storm);
      }
      // Let the enabled handler in renderer.js handle silencing/restoring audio
      window.rainydesk.updateRainscapeParam('audio.thunder.enabled', toggleInput.checked);
    };

    // Storminess OSC knob
    const storminessOscKnob = RotaryKnob({
      value: this.state.thunderStorminessOsc,
      min: 0,
      max: 100,
      id: 'thunderStorminessOsc',
      description: 'Storm drift (auto-varies storminess over minutes)',
      onChange: (v) => {
        this.state.thunderStorminessOsc = v;
        window.rainydesk.updateRainscapeParam('audio.thunder.storminessOsc', v);
      },
    });

    // Storminess slider (1–100, toggle handles the 0 case)
    thunderContent.appendChild(
      Slider({
        id: 'thunderStorminess',
        label: 'Storminess',
        value: this.state.thunderStorminess,
        min: 1,
        max: 100,
        unit: '%',
        defaultValue: 50,
        extraElement: storminessOscKnob,
        onChange: (v) => {
          this.state.thunderStorminess = v;
          window.rainydesk.updateRainscapeParam('audio.thunder.storminess', v);
        },
      })
    );

    // Distance OSC knob
    const distanceOscKnob = RotaryKnob({
      value: this.state.thunderDistanceOsc,
      min: 0,
      max: 100,
      id: 'thunderDistanceOsc',
      description: 'Distance drift (auto-varies thunder distance)',
      onChange: (v) => {
        this.state.thunderDistanceOsc = v;
        window.rainydesk.updateRainscapeParam('audio.thunder.distanceOsc', v);
      },
    });

    // Distance slider (0.5–15 km)
    thunderContent.appendChild(
      Slider({
        id: 'thunderDistance',
        label: 'Distance',
        value: this.state.thunderDistance,
        min: 0.5,
        max: 15,
        step: 0.5,
        unit: ' km',
        defaultValue: 5,
        extraElement: distanceOscKnob,
        formatValue: (v: number) => v.toFixed(1),
        onChange: (v) => {
          this.state.thunderDistance = v;
          window.rainydesk.updateRainscapeParam('audio.thunder.distance', v);
        },
      })
    );

    // Environment dropdown
    const thunderEnvRow = document.createElement('div');
    thunderEnvRow.className = 'control-row';

    const envLabelContainer = document.createElement('div');
    envLabelContainer.className = 'control-label-container';
    const envLabel = document.createElement('span');
    envLabel.className = 'control-label';
    envLabel.textContent = 'Environment';
    envLabelContainer.appendChild(envLabel);

    const envSelect = document.createElement('select');
    envSelect.className = 'preset-select';
    const envOptions = [
      { label: 'Forest', value: 'forest' },
      { label: 'Plains', value: 'plains' },
      { label: 'Mountain', value: 'mountain' },
      { label: 'Coastal', value: 'coastal' },
      { label: 'Suburban', value: 'suburban' },
      { label: 'Urban', value: 'urban' },
    ];
    for (const opt of envOptions) {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      envSelect.appendChild(option);
    }
    envSelect.value = this.state.thunderEnvironment;
    envSelect.onchange = () => {
      this.state.thunderEnvironment = envSelect.value;
      window.rainydesk.updateRainscapeParam('audio.thunder.environment', envSelect.value);
    };

    const envSelectContainer = document.createElement('div');
    envSelectContainer.className = 'slider-container';
    envSelectContainer.appendChild(envSelect);

    thunderEnvRow.appendChild(envLabelContainer);
    thunderEnvRow.appendChild(envSelectContainer);
    thunderContent.appendChild(thunderEnvRow);

    thunderSection.appendChild(thunderContent);
    container.appendChild(thunderSection);

    // Matrix Mode audio sliders (only visible when Matrix Mode is on)
    const matrixAudioSection = document.createElement('div');
    matrixAudioSection.id = 'matrix-audio-section';
    matrixAudioSection.style.display = this.state.matrixMode ? 'block' : 'none';

    const matrixDivider = document.createElement('hr');
    matrixDivider.className = 'panel-separator';
    matrixAudioSection.appendChild(matrixDivider);

    const matrixTitle = document.createElement('div');
    matrixTitle.className = 'section-title';
    matrixTitle.textContent = 'Matrix Synth';
    matrixAudioSection.appendChild(matrixTitle);

    // Key selector dropdown (transposes entire chord progression)
    const keyRow = document.createElement('div');
    keyRow.className = 'control-row';

    const keyLabelContainer = document.createElement('div');
    keyLabelContainer.className = 'control-label-container';
    const keyLabel = document.createElement('span');
    keyLabel.className = 'control-label';
    keyLabel.textContent = 'Key';
    keyLabelContainer.appendChild(keyLabel);

    const keySelect = document.createElement('select');
    keySelect.className = 'preset-select';
    const keyOptions = [
      { label: 'Matrix (G)', semitones: 0 },
      { label: 'Reloaded (Bb)', semitones: -3 },
      { label: 'Revolutions (E)', semitones: 9 },
      { label: 'Resurrections (C#)', semitones: 6 },
    ];
    for (const opt of keyOptions) {
      const option = document.createElement('option');
      option.value = String(opt.semitones);
      option.textContent = opt.label;
      keySelect.appendChild(option);
    }
    // Set initial value from saved state
    keySelect.value = String(this.state.matrixTranspose);

    keySelect.onchange = () => {
      const semitones = parseInt(keySelect.value, 10);
      this.state.matrixTranspose = semitones;
      window.rainydesk.updateRainscapeParam('audio.matrix.transpose', semitones);
    };

    const keySelectContainer = document.createElement('div');
    keySelectContainer.className = 'slider-container';
    keySelectContainer.appendChild(keySelect);

    keyRow.appendChild(keyLabelContainer);
    keyRow.appendChild(keySelectContainer);
    matrixAudioSection.appendChild(keyRow);

    // Bass volume
    matrixAudioSection.appendChild(
      Slider({
        id: 'matrixBass',
        label: 'Bass',
        value: this.state.matrixBassVolume,
        min: 0,
        max: 100,
        unit: '%',
        defaultValue: 50,
        onChange: (v) => {
          this.state.matrixBassVolume = v;
          const db = v <= 0 ? -60 : (v / 100 * 42) - 30; // 0% = -60dB, 43% = -12dB, 100% = +12dB
          window.rainydesk.updateRainscapeParam('audio.matrix.bass', db);
        },
      })
    );

    // Melody volume (collision-triggered arpeggio notes)
    matrixAudioSection.appendChild(
      Slider({
        id: 'matrixCollision',
        label: 'Melody',
        value: this.state.matrixCollisionVolume,
        min: 0,
        max: 100,
        unit: '%',
        defaultValue: 20,
        onChange: (v) => {
          this.state.matrixCollisionVolume = v;
          const db = v <= 0 ? -60 : (v / 100 * 42) - 30;
          window.rainydesk.updateRainscapeParam('audio.matrix.collision', db);
        },
      })
    );

    // Drone volume (OGG sample)
    matrixAudioSection.appendChild(
      Slider({
        id: 'matrixDrone',
        label: 'Drone',
        value: this.state.matrixDroneVolume,
        min: 0,
        max: 100,
        unit: '%',
        defaultValue: 30,
        onChange: (v) => {
          this.state.matrixDroneVolume = v;
          const db = v <= 0 ? -60 : (v / 100 * 42) - 30;
          window.rainydesk.updateRainscapeParam('audio.drone.volume', db);
        },
      })
    );

    container.appendChild(matrixAudioSection);

    // Apply Matrix Mode state to slider labels
    requestAnimationFrame(() => this.updateMatrixModeSliders());

    return container;
  }

  private createVisualTab(): HTMLElement {
    const container = document.createElement('div');

    // Background intensity
    container.appendChild(
      Slider({
        id: 'bgIntensity',
        label: 'BG Intensity',
        value: this.state.backgroundIntensity,
        min: 0,
        max: 100,
        unit: '%',
        defaultValue: 50,
        onChange: (v) => {
          this.state.backgroundIntensity = v;
          window.rainydesk.updateRainscapeParam('backgroundRain.intensity', v);
        },
      })
    );

    // Background layers
    container.appendChild(
      Slider({
        id: 'bgLayers',
        label: 'BG Layers',
        value: this.state.backgroundLayers,
        min: 1,
        max: 5,
        step: 1,
        unit: '',
        defaultValue: 3,
        onChange: (v) => {
          this.state.backgroundLayers = v;
          window.rainydesk.updateRainscapeParam('backgroundRain.layers', v);
        },
      })
    );

    // Rain Color picker (reset uses Matrix green when Matrix Mode is on)
    container.appendChild(
      ColorPicker({
        label: 'Rain Color',
        value: this.state.rainColor,
        defaultValue: () => this.state.matrixMode ? DEFAULT_MATRIX_COLOR : DEFAULT_RAIN_COLOR,
        onChange: (v) => {
          this.state.rainColor = v;
          window.rainydesk.updateRainscapeParam('visual.rainColor', v);
        },
      })
    );

    // Gay Mode toggle (rainbow cycling)
    container.appendChild(
      Toggle({
        label: 'Gay Mode',
        checked: this.state.gayMode,
        onChange: (v) => {
          this.state.gayMode = v;
          window.rainydesk.updateRainscapeParam('visual.gayMode', v);
          v ? this.startGayModeAnimation() : this.stopGayModeAnimation();
          if (rainbowSpeedSlider) rainbowSpeedSlider.style.display = v ? '' : 'none';
          // Update Gaytrix hint visibility
          this.updateGaytrixHint();
        },
      })
    );

    // Only visible when Gay Mode is on
    const rainbowSpeedSlider = Slider({
      id: 'rainbowSpeed',
      label: 'Rainbow Speed',
      value: this.state.rainbowSpeed,
      min: 1,
      max: 10,
      step: 1,
      unit: '\u00d7',
      defaultValue: 1,
      onChange: (v) => {
        this.state.rainbowSpeed = v;
        window.rainydesk.updateRainscapeParam('visual.rainbowSpeed', v);
      },
    });
    rainbowSpeedSlider.style.display = this.state.gayMode ? '' : 'none';
    container.appendChild(rainbowSpeedSlider);

    // Matrix Mode toggle — 2s cooldown prevents async init race conditions
    const matrixToggle = Toggle({
      label: 'Matrix Mode',
      sublabel: 'Digital rain with collision effects',
      checked: this.state.matrixMode,
      onChange: (v) => {
        const now = Date.now();
        if (now - this.lastMatrixToggle < 2000) {
          // Revert the checkbox — still in cooldown
          const input = matrixToggle.querySelector('input') as HTMLInputElement;
          if (input) input.checked = this.state.matrixMode;
          return;
        }
        this.lastMatrixToggle = now;
        this.state.matrixMode = v;
        window.rainydesk.updateRainscapeParam('visual.matrixMode', v);
        localStorage.setItem('rainscaper-matrix-mode', String(v));
        const panelEl = this.root.querySelector('.rainscaper-panel');
        if (panelEl) panelEl.classList.toggle('matrix-font-mode', v);
        this.updateGaytrixHint();
        this.updateMatrixModeSliders();
      },
    });
    container.appendChild(matrixToggle);

    // Data Density (Matrix Mode only — controls column spacing)
    const densitySteps = [42, 28, 20, 14];
    const densityLabels = ['Noob', 'Normie', 'Nerd', 'Neo'];
    const currentDensityIdx = densitySteps.findIndex(s => s === this.state.matrixDensity);
    const safeDensityIdx = currentDensityIdx >= 0 ? currentDensityIdx : 1;

    const densitySlider = Slider({
      id: 'matrixDensity',
      label: 'Data Density',
      value: safeDensityIdx,
      min: 0,
      max: 3,
      step: 1,
      unit: '',
      formatValue: (v: number) => densityLabels[Math.round(v)] || 'Normie',
      onChange: (v) => {
        const idx = Math.round(v);
        const spacing = densitySteps[idx] ?? 20;
        this.state.matrixDensity = spacing;
        window.rainydesk.updateRainscapeParam('visual.matrixDensity', spacing);
      },
    });
    densitySlider.style.display = this.state.matrixMode ? '' : 'none';
    densitySlider.dataset.matrixOnly = 'true';
    container.appendChild(densitySlider);

    // Gaytrix hint (appears when both Gay Mode + Matrix Mode are enabled)
    const gaytrixHint = document.createElement('div');
    gaytrixHint.className = `gaytrix-hint${this.state.transMode ? ' trans-mode' : ''}`;
    gaytrixHint.id = 'gaytrix-hint';
    gaytrixHint.innerHTML = this.waveText(this.state.transMode ? '\u2665 ILY WACHOWSKIS! \u2665' : 'Gaytrix mode activated!');
    gaytrixHint.style.display = (this.state.gayMode && this.state.matrixMode) ? 'block' : 'none';

    // Trans Mode easter egg: click to toggle
    gaytrixHint.addEventListener('click', () => {
      this.state.transMode = !this.state.transMode;

      // Capture old background for wipe transition
      const oldBg = getComputedStyle(gaytrixHint).background;
      const overlay = document.createElement('div');
      overlay.className = 'gaytrix-wipe-overlay';
      overlay.style.background = oldBg;
      overlay.style.clipPath = 'polygon(0% -20%, 110% -20%, 110% 120%, -35% 120%)';
      gaytrixHint.appendChild(overlay);

      // Apply new state underneath overlay
      gaytrixHint.classList.toggle('trans-mode', this.state.transMode);
      // Remove old wave chars (but keep the overlay)
      gaytrixHint.querySelectorAll('.wave-char').forEach(el => el.remove());
      // Re-insert wave text before the overlay
      const newText = this.state.transMode ? '\u2665 ILY WACHOWSKIS! \u2665' : 'Gaytrix mode activated!';
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = this.waveText(newText);
      while (tempDiv.firstChild) {
        gaytrixHint.insertBefore(tempDiv.firstChild, overlay);
      }

      // Animate wipe (left-to-right angled reveal synced with sword gleam)
      gaytrixHint.classList.remove('gleam-click');
      void gaytrixHint.offsetWidth; // Force reflow to restart animation
      gaytrixHint.classList.add('gleam-click');
      requestAnimationFrame(() => {
        // Angled wipe at ~15 deg matching the gleam sweep direction
        overlay.style.clipPath = 'polygon(135% -20%, 170% -20%, 170% 120%, 100% 120%)';
        overlay.addEventListener('transitionend', () => overlay.remove());
        // Fallback: remove overlay after 700ms even if transitionend doesn't fire
        setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 700);
      });
      // Clean up gleam class after animation
      setTimeout(() => gaytrixHint.classList.remove('gleam-click'), 650);

      // Show/hide scroll toggle
      const scrollToggle = this.root.querySelector('#trans-scroll-toggle') as HTMLElement;
      if (scrollToggle) {
        scrollToggle.style.display = this.state.transMode ? '' : 'none';
      }

      // Fire param update
      window.rainydesk.updateRainscapeParam('visual.transMode', this.state.transMode);

      // If turning off, also reset scroll direction
      if (!this.state.transMode) {
        this.state.transScrollDirection = 'off';
        window.rainydesk.updateRainscapeParam('visual.transScrollDirection', 'off');
      }
    });
    container.appendChild(gaytrixHint);

    // Trans Mode scroll direction toggle (hidden until Trans Mode active)
    const scrollToggle = TriToggle({
      label: 'Gradient Scroll',
      value: this.state.transScrollDirection,
      id: 'trans-scroll-toggle',
      onChange: (dir) => {
        this.state.transScrollDirection = dir;
        window.rainydesk.updateRainscapeParam('visual.transScrollDirection', dir);
      },
    });
    scrollToggle.style.display = (this.state.transMode && this.state.gayMode && this.state.matrixMode) ? '' : 'none';
    container.appendChild(scrollToggle);

    return container;
  }

  /* Diagonal clip-path wipe transition between themes */
  private async playThemeWipe(theme: string, btn: HTMLElement, themeSelector: HTMLElement, customApply?: () => void): Promise<void> {
    const panel = this.root.querySelector('.rainscaper-panel') as HTMLElement;
    if (!panel) return;

    const oldBg = getComputedStyle(panel).backgroundColor;
    const overlay = document.createElement('div');
    overlay.className = 'theme-wipe-overlay';
    overlay.style.background = oldBg;

    const wipes = [
      ['polygon(0 0, 300% 0, 0 300%)', 'polygon(0 0, 0 0, 0 0)'],
      ['polygon(100% 0, 100% 300%, -200% 0)', 'polygon(100% 0, 100% 0, 100% 0)'],
      ['polygon(0 100%, 300% 100%, 0 -200%)', 'polygon(0 100%, 0 100%, 0 100%)'],
      ['polygon(100% 100%, -200% 100%, 100% -200%)', 'polygon(100% 100%, 100% 100%, 100% 100%)'],
    ];
    const wipe = wipes[Math.floor(Math.random() * wipes.length)]!;
    overlay.style.clipPath = wipe[0]!;
    panel.appendChild(overlay);

    if (customApply) customApply();
    else await applyTheme(theme);
    themeSelector.querySelectorAll('.theme-button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    requestAnimationFrame(() => {
      overlay.style.clipPath = wipe[1]!;
      overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
      setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 700);
    });
  }

  private createSystemTab(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'debug-tab';

    // Helper: create a collapsible section (title + content wrapper)
    const makeCollapsible = (name: string, startCollapsed = true) => {
      const title = document.createElement('div');
      title.className = 'section-title collapsible';
      title.innerHTML = `<span class="collapse-arrow">${startCollapsed ? '&#9654;' : '&#9660;'}</span> ${name}`;

      const content = document.createElement('div');
      content.className = 'collapsible-section';
      if (startCollapsed) content.classList.add('collapsed');

      title.addEventListener('click', () => {
        const isCollapsed = content.classList.toggle('collapsed');
        const arrow = title.querySelector('.collapse-arrow');
        if (arrow) arrow.innerHTML = isCollapsed ? '&#9654;' : '&#9660;';
      });

      return { title, content };
    };

    // Performance section
    const perf = makeCollapsible('Performance');
    container.appendChild(perf.title);

    // FPS Limiter (stepped: 15/30/60/90/120/144/165/240/360/Uncapped)
    const fpsSteps = [15, 30, 60, 90, 120, 144, 165, 240, 360, 0];
    const fpsLabels = ['15', '30', '60', '90', '120', '144', '165', '240', '360', 'Max'];
    const currentFpsIdx = fpsSteps.indexOf(this.state.fpsLimit);
    const safeFpsIdx = currentFpsIdx >= 0 ? currentFpsIdx : fpsSteps.length - 1;

    perf.content.appendChild(
      Slider({
        id: 'fpsLimit',
        label: 'FPS Limit',
        sublabel: 'Frame rate cap',
        value: safeFpsIdx,
        min: 0,
        max: fpsSteps.length - 1,
        step: 1,
        unit: '',
        formatValue: (v: number) => fpsLabels[Math.round(v)] || 'Max',
        onChange: (v) => {
          const idx = Math.round(v);
          const fps = fpsSteps[idx] ?? 0;
          this.state.fpsLimit = fps;
          window.rainydesk.updateRainscapeParam('physics.fpsLimit', fps);
        },
      })
    );

    // Grid Scale + Render Scale share an Apply button
    const scaleSection = document.createElement('div');
    scaleSection.className = 'slider-with-button';

    // Grid Scale slider (4 discrete steps)
    const gridScaleSteps = [0.0625, 0.125, 0.25, 0.375];
    const gridScaleLabels = ['Potato', 'Chunky', 'Normal', 'Detailed'];
    const currentGridIdx = gridScaleSteps.findIndex(s => Math.abs(s - this.state.gridScalePending) < 0.01);
    const safeGridIdx = currentGridIdx >= 0 ? currentGridIdx : 2;

    scaleSection.appendChild(
      Slider({
        id: 'gridScale',
        label: 'Grid Scale',
        sublabel: 'Collision accuracy',
        value: safeGridIdx,
        min: 0,
        max: 3,
        step: 1,
        unit: '',
        formatValue: (v: number) => gridScaleLabels[Math.round(v)] || 'Normal',
        onChange: (v) => {
          const idx = Math.round(v);
          this.state.gridScalePending = gridScaleSteps[idx] ?? 0.25;
          this.updateResetButtonVisibility();
        },
      })
    );

    // Render Scale slider (4 discrete steps)
    const renderScaleSteps = [0.125, 0.25, 0.5, 1.0];
    const renderScaleLabels = ['Lo-Fi', 'Pixel', 'Clean', 'Full'];
    const currentRenderIdx = renderScaleSteps.findIndex(s => Math.abs(s - this.state.renderScalePending) < 0.01);
    const safeRenderIdx = currentRenderIdx >= 0 ? currentRenderIdx : 1;

    scaleSection.appendChild(
      Slider({
        id: 'renderScale',
        label: 'Render Scale',
        sublabel: 'Visual smoothness',
        value: safeRenderIdx,
        min: 0,
        max: 3,
        step: 1,
        unit: '',
        formatValue: (v: number) => renderScaleLabels[Math.round(v)] || 'Pixel',
        onChange: (v) => {
          const idx = Math.round(v);
          this.state.renderScalePending = renderScaleSteps[idx] ?? 0.25;
          this.updateResetButtonVisibility();
        },
      })
    );

    // Shared Apply Changes button (visible when grid OR render scale changed)
    this.resetRainButton = document.createElement('button');
    this.resetRainButton.className = 'reset-rain-button';
    this.resetRainButton.textContent = 'Apply Changes';
    this.resetRainButton.style.display = 'none';
    this.resetRainButton.addEventListener('click', () => this.handleResetRain());
    scaleSection.appendChild(this.resetRainButton);

    perf.content.appendChild(scaleSection);

    container.appendChild(perf.content);

    // Update button visibility per state
    this.updateResetButtonVisibility();

    // Behavior section
    const behavior = makeCollapsible('Behavior');
    container.appendChild(behavior.title);

    // Window Collision (broadest — affects all rain-window interactions)
    behavior.content.appendChild(
      Toggle({
        label: 'Window Collision',
        sublabel: 'Rain interacts with app windows',
        checked: this.state.windowCollision,
        onChange: (v) => {
          this.state.windowCollision = v;
          window.rainydesk.updateRainscapeParam('system.windowCollision', v);
        },
      })
    );

    // Rain Over Fullscreen (inverted: ON = rain shows, OFF = rain suppressed)
    behavior.content.appendChild(
      Toggle({
        label: 'Rain Over Fullscreen',
        sublabel: 'Show rain over fullscreen apps',
        checked: this.state.rainOverFullscreen,
        onChange: (v) => {
          this.state.rainOverFullscreen = v;
          window.rainydesk.updateRainscapeParam('system.fullscreenDetection', !v);
          this.updateFullscreenMufflingVisibility();
        },
      })
    );

    // Fullscreen muffling sub-toggle (hidden when Rain Over Fullscreen is ON)
    const fsMuffleToggle = Toggle({
      label: 'Audio Muffling',
      sublabel: 'Lower volume behind fullscreen apps',
      checked: this.state.audioMuffling,
      onChange: (v) => {
        this.state.audioMuffling = v;
        window.rainydesk.updateRainscapeParam('system.audioMuffling', v);
      },
    });
    fsMuffleToggle.classList.add('sub-toggle');
    fsMuffleToggle.dataset.fsMuffleToggle = 'true';
    if (!this.state.rainOverFullscreen) fsMuffleToggle.style.display = 'none';
    behavior.content.appendChild(fsMuffleToggle);

    // Rain Over Maximized (inverted: ON = rain shows, OFF = rain suppressed)
    behavior.content.appendChild(
      Toggle({
        label: 'Rain Over Maximized',
        sublabel: 'Show rain over maximized apps',
        checked: this.state.rainOverMaximized,
        onChange: (v) => {
          this.state.rainOverMaximized = v;
          window.rainydesk.updateRainscapeParam('system.maximizedDetection', !v);
          this.updateMaximizedMufflingVisibility();
        },
      })
    );

    // Maximized muffling sub-toggle (hidden when Rain Over Maximized is ON)
    const maxMuffleToggle = Toggle({
      label: 'Audio Muffling',
      sublabel: 'Lower volume behind maximized apps',
      checked: this.state.maximizedMuffling,
      onChange: (v) => {
        this.state.maximizedMuffling = v;
        window.rainydesk.updateRainscapeParam('system.maximizedMuffling', v);
      },
    });
    maxMuffleToggle.classList.add('sub-toggle');
    maxMuffleToggle.dataset.maxMuffleToggle = 'true';
    if (!this.state.rainOverMaximized) maxMuffleToggle.style.display = 'none';
    behavior.content.appendChild(maxMuffleToggle);

    // Background Shader
    behavior.content.appendChild(
      Toggle({
        label: 'Background Shader',
        sublabel: 'Rain effect behind all windows',
        checked: this.state.backgroundShaderEnabled,
        onChange: (v) => {
          this.state.backgroundShaderEnabled = v;
          window.rainydesk.updateRainscapeParam('backgroundRain.enabled', v);
        },
      })
    );

    // 3D Audio (disabled - needs tuning)
    behavior.content.appendChild(
      Toggle({
        label: '3D Audio',
        checked: this.state.spatialAudio,
        disabled: true,
        disabledNote: 'Soon\u2122',
        onChange: (v) => {
          this.state.spatialAudio = v;
          window.rainydesk.updateRainscapeParam('spatial.enabled', v);
        },
      })
    );

    // Start with Windows
    const autostartToggle = Toggle({
      label: 'Start with Windows',
      checked: false,
      onChange: async (v) => {
        try {
          await (v ? enableAutostart() : disableAutostart());
        } catch (err) {
          window.rainydesk.log(`[Autostart] Toggle failed: ${err}`);
        }
      },
    });
    behavior.content.appendChild(autostartToggle);

    isAutostartEnabled().then((enabled) => {
      const checkbox = autostartToggle.querySelector('input[type="checkbox"]') as HTMLInputElement;
      if (checkbox) checkbox.checked = enabled;
    }).catch(() => {});

    container.appendChild(behavior.content);

    // Stats & System Info (single collapsible section)
    const diag = makeCollapsible('Stats & System Info');
    container.appendChild(diag.title);

    const statsGrid = document.createElement('div');
    statsGrid.className = 'debug-stats-grid';
    this.debugStatsElement = statsGrid;
    this.updateDebugStats(statsGrid);
    diag.content.appendChild(statsGrid);

    this.debugUpdateInterval = setInterval(() => {
      if (this.debugStatsElement) {
        this.updateDebugStats(this.debugStatsElement);
      }
    }, 500);

    const sysContent = document.createElement('div');
    sysContent.className = 'debug-sys-info';
    sysContent.textContent = 'Loading...';
    diag.content.appendChild(sysContent);

    this.loadSystemInfo(sysContent);

    container.appendChild(diag.content);

    // Actions section (expanded by default for quick access)
    const actions = makeCollapsible('Actions', false);
    container.appendChild(actions.title);

    const reinitBtn = document.createElement('button');
    reinitBtn.className = 'reinit-button';

    const svgA = 'width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"';
    const resetIcon = `<svg ${svgA}><path d="M12 21V11M12 11L9 14M12 11L15 14M7 16.8184C4.69636 16.2074 3 14.1246 3 11.6493C3 9.20008 4.8 6.9375 7.5 6.5C8.34694 4.48637 10.3514 3 12.6893 3C15.684 3 18.1317 5.32251 18.3 8.25C19.8893 8.94488 21 10.6503 21 12.4969C21 14.8148 19.25 16.7236 17 16.9725" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const resetLabel = `${resetIcon}Reset RainyDesk`;

    const startCooldownTimer = () => {
      if (this.reinitCooldownTimer) clearInterval(this.reinitCooldownTimer);
      this.reinitCooldownTimer = setInterval(() => {
        const remaining = Math.ceil((this.reinitCooldownEnd - Date.now()) / 1000);
        if (remaining <= 0) {
          if (this.reinitCooldownTimer) clearInterval(this.reinitCooldownTimer);
          this.reinitCooldownTimer = null;
          reinitBtn.disabled = false;
          reinitBtn.innerHTML = resetLabel;
        } else {
          reinitBtn.textContent = `Cooldown (${remaining}s)`;
        }
      }, 1000);
    };

    const now = Date.now();
    const cooldownRemaining = Math.ceil((this.reinitCooldownEnd - now) / 1000);
    if (cooldownRemaining > 0) {
      reinitBtn.disabled = true;
      reinitBtn.textContent = `Cooldown (${cooldownRemaining}s)`;
      startCooldownTimer();
    } else {
      reinitBtn.innerHTML = resetLabel;
    }

    reinitBtn.addEventListener('click', () => {
      if (reinitBtn.disabled) return;
      this.state.appStatus = 'stopped';
      this.updateFooterStatus();
      window.rainydesk.updateRainscapeParam('physics.resetSimulation', {
        gridScale: this.state.gridScale,
        renderScale: this.state.renderScale,
      });

      this.reinitCooldownEnd = Date.now() + 30000;
      reinitBtn.disabled = true;
      reinitBtn.textContent = 'Cooldown (30s)';
      startCooldownTimer();
    });

    // Performance Presets heading
    const presetHeading = document.createElement('div');
    presetHeading.className = 'preset-heading';
    presetHeading.innerHTML = '<span class="preset-heading-title">Performance Presets</span><span class="preset-heading-subtitle">Quick-apply performance profiles</span>';
    actions.content.appendChild(presetHeading);

    const presetGrid = document.createElement('div');
    presetGrid.className = 'preset-button-grid';

    // Inline SVG icons for preset buttons (currentColor inherits theme)
    const svgAttr = 'width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"';
    const presetIcons: Record<string, string> = {
      Potato: `<svg ${svgAttr}><path d="M21 14.7C21 18.1794 19.0438 21 15.5 21C11.9562 21 10 18.1794 10 14.7C10 11.2206 15.5 3 15.5 3C15.5 3 21 11.2206 21 14.7Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 8.2C8 9.7464 7.11083 11 5.5 11C3.88917 11 3 9.7464 3 8.2C3 6.6536 5.5 3 5.5 3C5.5 3 8 6.6536 8 8.2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      Light: `<svg ${svgAttr}><path d="M10.5 21L12 18M14.5 21L16 18M6.5 21L8 18M8.8 15C6.14903 15 4 12.9466 4 10.4137C4 8.31435 5.6 6.375 8 6C8.75283 4.27403 10.5346 3 12.6127 3C15.2747 3 17.4504 4.99072 17.6 7.5C19.0127 8.09561 20 9.55741 20 11.1402C20 13.2719 18.2091 15 16 15L8.8 15Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      Balanced: `<svg ${svgAttr}><path d="M16 13V20M4 14.7519C3.37037 13.8768 3 12.8059 3 11.6493C3 9.20008 4.8 6.9375 7.5 6.5C8.34694 4.48637 10.3514 3 12.6893 3C15.684 3 18.1317 5.32251 18.3 8.25C19.8893 8.94488 21 10.6503 21 12.4969C21 13.4232 20.7205 14.2842 20.2413 15M12 14V21M8 13V20" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      Cranked: `<svg ${svgAttr}><path d="M19.3278 16C20.3478 15.1745 21 13.9119 21 12.4969C21 10.6503 19.8893 8.94488 18.3 8.25C18.1317 5.32251 15.684 3 12.6893 3C10.3514 3 8.34694 4.48637 7.5 6.5C4.8 6.9375 3 9.20008 3 11.6493C3 13.1613 3.63296 14.5269 4.65065 15.5M8 18V20M8 12V14M12 19V21M16 18V20M16 12V14M12 13V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      Reset: `<svg ${svgAttr}><path d="M12 21V11M12 11L9 14M12 11L15 14M7 16.8184C4.69636 16.2074 3 14.1246 3 11.6493C3 9.20008 4.8 6.9375 7.5 6.5C8.34694 4.48637 10.3514 3 12.6893 3C15.684 3 18.1317 5.32251 18.3 8.25C19.8893 8.94488 21 10.6503 21 12.4969C21 14.8148 19.25 16.7236 17 16.9725" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    };

    const presets = [
      { name: 'Potato',    gridScale: 0.0625, renderScale: 0.125, fps: 30, intensity: 15, bg: false, collision: false, volume: -30 },
      { name: 'Light',     gridScale: 0.125,  renderScale: 0.25,  fps: 60, intensity: 30, bg: false, collision: true,  volume: -18 },
      { name: 'Balanced',  gridScale: 0.25,   renderScale: 0.25,  fps: 60, intensity: 50, bg: true,  collision: true,  volume: -6 },
      { name: 'Cranked',   gridScale: 0.5,    renderScale: 0.5,   fps: 0,  intensity: 70, bg: true,  collision: true,  volume: -6 },
    ];

    for (const preset of presets) {
      const btn = document.createElement('button');
      btn.className = 'preset-button';
      btn.innerHTML = `${presetIcons[preset.name] || ''}${preset.name}`;
      btn.addEventListener('click', () => {
        const update = window.rainydesk.updateRainscapeParam;
        update('physics.intensity', preset.intensity);
        update('physics.fpsLimit', preset.fps);
        update('physics.renderScale', preset.renderScale);
        update('effects.masterVolume', preset.volume);
        update('backgroundRain.enabled', preset.bg);
        update('system.windowCollision', preset.collision);
        update('physics.resetSimulation', { gridScale: preset.gridScale, renderScale: preset.renderScale });

        // Update local panel state
        this.state.intensity = preset.intensity;
        this.state.fpsLimit = preset.fps;
        this.state.renderScalePending = preset.renderScale;
        this.state.renderScale = preset.renderScale;
        this.state.gridScalePending = preset.gridScale;
        this.state.gridScale = preset.gridScale;
        this.state.backgroundShaderEnabled = preset.bg;
        this.state.windowCollision = preset.collision;
        const volPct = Math.round(Math.max(0, Math.min(100, ((preset.volume + 60) / 60) * 100)));
        this.state.masterVolume = volPct;
        this.state.volume = volPct;

        this.render();
      });
      presetGrid.appendChild(btn);
    }

    actions.content.appendChild(presetGrid);
    actions.content.appendChild(reinitBtn);
    this.reinitButton = reinitBtn;
    container.appendChild(actions.content);

    // Apply Matrix Mode state to relevant sliders
    requestAnimationFrame(() => this.updateMatrixModeSliders());

    return container;
  }

  private updateFullscreenMufflingVisibility(): void {
    const el = this.root.querySelector('[data-fs-muffle-toggle="true"]') as HTMLElement;
    if (el) el.style.display = this.state.rainOverFullscreen ? '' : 'none';
  }

  private updateMaximizedMufflingVisibility(): void {
    const el = this.root.querySelector('[data-max-muffle-toggle="true"]') as HTMLElement;
    if (el) el.style.display = this.state.rainOverMaximized ? '' : 'none';
  }

  private updateDebugStats(element: HTMLElement): void {
    // Get stats from global window object (updated by main renderer)
    const stats = window._debugStats || this.state.debugStats;
    const frameTime = stats.fps > 0 ? (1000 / stats.fps).toFixed(1) : '0.0';
    // Memory from WebView2's performance.memory
    const perf = performance as unknown as { memory?: { usedJSHeapSize: number } };
    const memoryMB = perf.memory ? (perf.memory.usedJSHeapSize / 1048576).toFixed(1) : 'N/A';
    // Uptime since panel init
    const elapsed = Math.floor((Date.now() - this.appStartTime) / 1000);
    const hours = Math.floor(elapsed / 3600);
    const minutes = Math.floor((elapsed % 3600) / 60);
    const seconds = elapsed % 60;
    const uptime = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

    const isMatrix = this.state.matrixMode;
    const dropsLabel = isMatrix ? 'Code Streams' : 'Active Drops';
    const waterDisabled = isMatrix ? ' disabled' : '';
    const waterValue = isMatrix ? '--' : String(stats.waterCount);

    element.innerHTML = `
      <div class="debug-stat">
        <span class="debug-stat-label">FPS</span>
        <span class="debug-stat-value">${Math.round(stats.fps)}</span>
      </div>
      <div class="debug-stat">
        <span class="debug-stat-label">${dropsLabel}</span>
        <span class="debug-stat-value">${stats.activeDrops}</span>
      </div>
      <div class="debug-stat${waterDisabled}">
        <span class="debug-stat-label">Water Cells</span>
        <span class="debug-stat-value">${waterValue}</span>
      </div>
      <div class="debug-stat">
        <span class="debug-stat-label">Frame Time</span>
        <span class="debug-stat-value">${frameTime}ms</span>
      </div>
      <div class="debug-stat">
        <span class="debug-stat-label">Memory</span>
        <span class="debug-stat-value">${memoryMB}MB</span>
      </div>
      <div class="debug-stat">
        <span class="debug-stat-label">Uptime</span>
        <span class="debug-stat-value">${uptime}</span>
      </div>
    `;
  }

  private async loadSystemInfo(element: HTMLElement): Promise<void> {
    try {
      // Get all of Tauri's virtual display info
      const vd = await window.rainydesk.getVirtualDesktop();
      const monitors = vd?.monitors || [];
      const primaryIndex = vd?.primaryIndex ?? 0;

      let html = '<div class="debug-sys-grid">';

      // Virtual desktop size
      html += `
        <div class="debug-sys-item">
          <span class="debug-sys-label">Virtual Display Resolution</span>
          <span class="debug-sys-value">${vd?.width || '?'}\u00D7${vd?.height || '?'}</span>
        </div>
        <div class="debug-sys-item">
          <span class="debug-sys-label">Display Count</span>
          <span class="debug-sys-value">${monitors.length}</span>
        </div>
      `;

      // Per-monitor info with compact format
      for (let i = 0; i < monitors.length; i++) {
        const mon = monitors[i];
        if (!mon) continue;
        const label = mon.index === primaryIndex ? 'Primary' : `Display ${mon.index + 1}`;
        const dims = `${mon.width}\u00D7${mon.height}`;
        const hz = mon.refreshRate ? ` @ ${mon.refreshRate} Hz` : '';
        const scale = mon.scaleFactor !== 1 ? ` @${Math.round(mon.scaleFactor * 100)}%` : '';
        html += `
          <div class="debug-sys-item debug-sys-monitor">
            <span class="debug-sys-label">${label}</span>
            <span class="debug-sys-value">${dims}${hz}${scale}</span>
          </div>
        `;
      }

      // System specs (CPU, GPU, RAM)
      try {
        const specs = await window.rainydesk.getSystemSpecs();
        html += `
          <div class="debug-sys-item">
            <span class="debug-sys-label">CPU</span>
            <span class="debug-sys-value">${specs.cpuModel}</span>
          </div>
          <div class="debug-sys-item">
            <span class="debug-sys-label">GPU</span>
            <span class="debug-sys-value">${specs.gpuModel}${specs.gpuVramGb ? `<br><span class="debug-sys-sub">${specs.gpuVramGb} GB VRAM</span>` : ''}</span>
          </div>
          <div class="debug-sys-item">
            <span class="debug-sys-label">RAM</span>
            <span class="debug-sys-value">${specs.totalRamGb} GB</span>
          </div>
        `;
      } catch {
        html += `
          <div class="debug-sys-item">
            <span class="debug-sys-label">System</span>
            <span class="debug-sys-value">Unavailable</span>
          </div>
        `;
      }

      html += '</div>';
      element.innerHTML = html;
    } catch (err) {
      element.textContent = `Failed to load: ${err}`;
    }
  }

  private getIntensityStatusText(): string {
    const intensity = this.state.intensity;
    if (this.state.paused || intensity === 0) return 'Did you feel that?';
    if (intensity < 10) return 'Misting...';
    if (intensity < 20) return 'Drizzling...';
    if (intensity < 30) return 'Tap-tap-tapping...';
    if (intensity < 40) return 'Raining...';
    if (intensity < 50) return 'Comin\u2019 down now...';
    if (intensity < 60) return 'Cats & dogs...';
    if (intensity < 70) return 'Drenching...';
    if (intensity < 80) return 'Pouring...';
    if (intensity < 90) return 'Storming...';
    return 'Maximum coziness!';
  }

  private updateFooterStatus(): void {
    const intensityEl = this.root.querySelector('.intensity-status');
    if (intensityEl) {
      this.renderIntensityStatus(intensityEl as HTMLElement);
    }

    // Update app status indicator (reuse existing dot element so CSS transitions work)
    const statusIndicator = this.root.querySelector('.status-indicator');
    if (statusIndicator) {
      const status = this.getAppStatus();
      let dot = statusIndicator.querySelector('.status-dot') as HTMLElement;
      if (!dot) {
        dot = document.createElement('span');
        dot.className = 'status-dot';
        statusIndicator.prepend(dot);
      }
      // Replace all state classes with the current one
      dot.className = `status-dot ${status.dot}`;
      // Update post-dot text
      let textNode = dot.nextSibling;
      if (textNode && textNode.nodeType === Node.TEXT_NODE) {
        textNode.textContent = ` ${status.text}`;
      } else {
        statusIndicator.appendChild(document.createTextNode(` ${status.text}`));
      }
    }
  }

  /* Shared volume → dB conversion + auto-mute/unmute logic for Basic and Audio tabs */
  private applyVolumeChange(v: number): void {
    const wasZero = this.state.volume === 0;
    this.state.volume = v;
    this.state.masterVolume = v;
    // Convert percentage to dB; use -1000dB NOT -100 for true silence
    const db = v <= 0 ? -1000 : (v / 100 * 60) - 60;
    window.rainydesk.updateRainscapeParam('effects.masterVolume', db);

    if (v === 0 && !this.state.muted) {
      this.state.muted = true;
      window.rainydesk.updateRainscapeParam('audio.muted', true);
      this.updateMuteToggle();
    }
    if (wasZero && v > 0 && this.state.muted) {
      this.state.muted = false;
      window.rainydesk.updateRainscapeParam('audio.muted', false);
      this.updateMuteToggle();
    }
  }

  private updateMuteToggle(): void {
    const muteRow = this.root.querySelector('[data-control="mute"]');
    if (!muteRow) return;

    const checkbox = muteRow.querySelector('input[type="checkbox"]') as HTMLInputElement;
    if (checkbox) {
      checkbox.checked = this.state.muted;
    }
  }

  private updatePauseToggle(): void {
    const pauseRow = this.root.querySelector('[data-control="pause"]');
    if (!pauseRow) return;

    const checkbox = pauseRow.querySelector('input[type="checkbox"]') as HTMLInputElement;
    if (checkbox) {
      checkbox.checked = this.state.paused;
    }
  }

  /* CSS-only scale — avoids resizing the Tauri window */
  private applyUIScaleCSS(scale: number): void {
    const panel = this.root.querySelector('.rainscaper-panel') as HTMLElement;
    if (panel) {
      panel.style.width = '400px';
      panel.style.height = '500px';
      panel.style.transform = `scale(${scale})`;
      panel.style.transformOrigin = 'top left';
    }
  }

  /* Full UI scale: resize Tauri window + apply CSS transform */
  private applyUIScale(scale: number): void {
    const newWidth = Math.round(400 * scale);
    const newHeight = Math.round(500 * scale);
    window.rainydesk.resizeRainscaper(newWidth, newHeight);
    this.applyUIScaleCSS(scale);
    // Re-snap after resize
    if (!this.isDetached) window.rainydesk.snapPanelToTray();
  }

  /* Inject or update SVG radialGradient for trans mode logo cycling */
  private updateTransLogo(svg: Element): void {
    // One-time setup: inject radialGradient with 9 stops
    if (!svg.querySelector('#trans-grad')) {
      const ns = 'http://www.w3.org/2000/svg';
      const defs = document.createElementNS(ns, 'defs');
      const grad = document.createElementNS(ns, 'radialGradient');
      grad.id = 'trans-grad';
      for (let i = 0; i < 9; i++) {
        const stop = document.createElementNS(ns, 'stop');
        stop.setAttribute('offset', `${(i / 8) * 100}%`);
        grad.appendChild(stop);
      }
      defs.appendChild(grad);
      svg.insertBefore(defs, svg.firstChild);
      svg.querySelector('path')!.setAttribute('fill', 'url(#trans-grad)');
    }
    // Cycle stop colors: W(#FFF) → P(#F5A9B8) → B(#5BCEFA), seamless loop
    const stops = svg.querySelectorAll('#trans-grad stop');
    const phase = (performance.now() / 3000) % 1.0;
    const W = [255, 255, 255], P = [245, 169, 184], B = [91, 206, 250];
    const C = [W, P, B];
    for (let i = 0; i < stops.length; i++) {
      const seg = (((i / 9) - phase + 1) % 1.0) * 3;
      const si = Math.floor(seg) % 3;
      const sf = seg - Math.floor(seg);
      const fr = C[si]!, to = C[(si + 1) % 3]!;
      stops[i]!.setAttribute('stop-color',
        `rgb(${fr[0]! + (to[0]! - fr[0]!) * sf | 0},${fr[1]! + (to[1]! - fr[1]!) * sf | 0},${fr[2]! + (to[2]! - fr[2]!) * sf | 0})`);
    }
  }

  /* Start rainbow cycling on title bar + logo */
  private startGayModeAnimation(): void {
    if (this.gayModeInterval) return;

    this.gayModeInterval = setInterval(() => {
      if (!this.titleElement) return;

      if (this.state.transMode) {
        this.titleElement.style.color = 'transparent';
        this.titleElement.style.backgroundImage = 'linear-gradient(90deg, #5BCEFA, #F5A9B8, #FFFFFF, #F5A9B8, #5BCEFA)';
        this.titleElement.style.backgroundClip = 'text';
        (this.titleElement.style as unknown as Record<string, string>)['-webkit-background-clip'] = 'text';
        const svg = this.logoElement?.querySelector('.panel-logo');
        if (svg) this.updateTransLogo(svg);
      } else {
        this.titleElement.style.backgroundImage = '';
        this.titleElement.style.backgroundClip = '';
        (this.titleElement.style as unknown as Record<string, string>)['-webkit-background-clip'] = '';
        const speed = this.state.rainbowSpeed || 1;
        const hue = ((performance.now() / (60000 / speed)) % 1.0) * 360;
        this.titleElement.style.color = `hsl(${hue}, 80%, 70%)`;
        // Tear down trans gradient if it was active
        const svg = this.logoElement?.querySelector('.panel-logo');
        if (svg?.querySelector('#trans-grad')) {
          svg.querySelector('defs')?.remove();
          svg.querySelector('path')!.setAttribute('fill', 'currentColor');
        }
        if (this.logoElement) this.logoElement.style.color = `hsl(${hue}, 80%, 70%)`;
      }
    }, 50);
  }

  /* Stop rainbow cycling, reset title + logo color */
  private stopGayModeAnimation(): void {
    if (this.gayModeInterval) {
      clearInterval(this.gayModeInterval);
      this.gayModeInterval = null;
    }
    if (this.titleElement) {
      this.titleElement.style.color = '';
      this.titleElement.style.backgroundImage = '';
      this.titleElement.style.backgroundClip = '';
      (this.titleElement.style as unknown as Record<string, string>)['-webkit-background-clip'] = '';
    }
    if (this.logoElement) {
      this.logoElement.style.color = '';
      // Clean up trans gradient if active
      const svg = this.logoElement.querySelector('.panel-logo');
      if (svg?.querySelector('#trans-grad')) {
        svg.querySelector('defs')?.remove();
        svg.querySelector('path')!.setAttribute('fill', 'currentColor');
      }
    }
  }

  /* Easter egg: logo spin sequence on click teehee */
  private handleLogoClick(): void {
    const now = Date.now();
    const svg = this.logoElement?.querySelector('.panel-logo') as SVGElement | null;
    if (!svg) return;

    // Clear settle timer
    if (this.logoSettleTimer) {
      clearTimeout(this.logoSettleTimer);
      this.logoSettleTimer = null;
    }
    // Clear pending particle timers
    this.logoParticleTimers.forEach(t => clearTimeout(t));
    this.logoParticleTimers = [];

    const elapsed = now - this.logoFirstClickTime;

    if (this.logoClickCount >= 3) {
      // Already in rapid mode — repeat step 3
      this.doLogoSpin(svg, 5, 1500, true);
    } else if (this.logoClickCount === 2 && elapsed <= 6000) {
      // Third click within 6s of first
      this.logoClickCount = 3;
      this.doLogoSpin(svg, 5, 1500, true);
    } else if (this.logoClickCount === 1 && elapsed <= 3000) {
      // Second click within 3s of first
      this.logoClickCount = 2;
      this.doLogoSpin(svg, 2, 1000, false);
    } else {
      // First click or sequence expired
      this.logoClickCount = 1;
      this.logoFirstClickTime = now;
      this.doLogoSpin(svg, 1, 500, false);
    }

    // Settle timer: 3s from this click
    this.logoSettleTimer = setTimeout(() => {
      this.logoClickCount = 0;
    }, 3000);
  }

  /* Spin the logo SVG and optionally emit particles */
  private doLogoSpin(svg: SVGElement, spins: number, duration: number, particles: boolean): void {
    this.logoTotalRotation += spins * 360;
    // Bouncy overshoot for gentle spins, smooth deceleration for rapid
    const easing = particles
      ? 'cubic-bezier(0.22, 1, 0.36, 1)'
      : 'cubic-bezier(0.34, 1.56, 0.64, 1)';
    svg.style.transition = `transform ${duration}ms ${easing}`;
    svg.style.transform = `rotate(${this.logoTotalRotation}deg)`;

    if (particles) {
      // Rapid-fire bursts — one per spin, 80ms apart so they're done
      // well before the deceleration settles
      for (let i = 0; i < spins; i++) {
        this.logoParticleTimers.push(
          setTimeout(() => this.emitLogoParticles(), i * 80)
        );
      }
    }
  }

  /* Emit burst of particles from the logo center */
  private emitLogoParticles(): void {
    const logo = this.logoElement;
    if (!logo) return;

    const rect = logo.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const isMatrix = this.state.matrixMode;
    const count = isMatrix ? 8 : 10;
    // Film-authentic glyphs matching the Matrix renderer
    const glyphs = 'アウエオカキケコサシスセソタツテ012345789*+:';

    // Spawn from logo edge. Arc tuned so first particles fly roughly
    // horizontal-right (toward "RainyDesk" title) and last particles
    // angle down toward the Basic tab. With ~72 deg tangential offset:
    // spawn -72 deg → flight 0 deg (horizontal right)
    // spawn   0 deg → flight 72 deg (steep down-right toward tabs)
    const logoRadius = 14;
    const arcStart = -Math.PI * 0.4;  // -72 deg
    const arcSpan = Math.PI * 0.5;    //  90 deg arc (extends 18 deg further clockwise)

    for (let i = 0; i < count; i++) {
      const el = document.createElement('span');
      const sizeMul = 3 + Math.random() * 2; // 3-5x random size multiplier

      if (isMatrix) {
        el.textContent = glyphs[Math.floor(Math.random() * glyphs.length)]!;
        el.style.fontFamily = "'Departure Mono', 'MS Gothic', monospace";
        el.style.fontSize = `${Math.round(7 * sizeMul)}px`;
        el.style.fontWeight = 'bold';
      } else {
        el.textContent = '\u25CF'; // Filled circle
        el.style.fontSize = `${Math.round(6 * sizeMul)}px`;
      }

      // Spawn at edge of logo, evenly distributed across the arc
      const spawnAngle = arcStart + arcSpan * (i + 0.5) / count + (Math.random() - 0.5) * 0.2;
      const startX = cx + Math.cos(spawnAngle) * logoRadius;
      const startY = cy + Math.sin(spawnAngle) * logoRadius;

      // Color hierarchy: trans flag > rainbow > mode-appropriate default/custom
      let color: string;
      if (this.state.transMode) {
        const transColors = ['#5BCEFA', '#F5A9B8', '#FFFFFF'];
        color = transColors[Math.floor(Math.random() * 3)]!;
      } else if (this.state.gayMode) {
        // Match rainbow hue cycle, spread slightly per particle
        const baseHue = ((performance.now() / (60000 / (this.state.rainbowSpeed || 1))) % 1.0) * 360;
        color = `hsl(${baseHue + i * 8}, 80%, 70%)`;
      } else {
        // If color is still at either mode's default, use the current mode's default.
        // If user picked something custom, respect that.
        const modeDefault = this.state.matrixMode ? DEFAULT_MATRIX_COLOR : DEFAULT_RAIN_COLOR;
        const atDefault = this.state.rainColor === DEFAULT_RAIN_COLOR
          || this.state.rainColor === DEFAULT_MATRIX_COLOR;
        color = atDefault ? modeDefault : this.state.rainColor;
      }
      el.style.color = color;
      el.style.position = 'fixed';
      el.style.left = `${startX}px`;
      el.style.top = `${startY}px`;
      el.style.pointerEvents = 'none';
      el.style.zIndex = '99999';
      el.style.opacity = '1';
      el.style.willChange = 'transform, opacity';
      el.style.transition = 'transform 350ms cubic-bezier(0.16, 1, 0.3, 1), opacity 350ms ease-out';
      el.style.transform = 'translate(-50%, -50%) rotate(0deg)';

      document.body.appendChild(el);

      // Tangential fling: ~72 deg from radial (mostly tangential, slightly outward)
      const flightAngle = spawnAngle + Math.PI * 0.4 + (Math.random() - 0.5) * 0.3;
      const dist = 50 + Math.random() * 80;
      const dx = Math.cos(flightAngle) * dist;
      const dy = Math.sin(flightAngle) * dist;
      const spin = 90 + Math.random() * 180; // Tumble 90-270 deg as it flies

      // Force reflow then animate outward with tumble
      el.getBoundingClientRect();
      requestAnimationFrame(() => {
        el.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) rotate(${spin}deg) scale(0.2)`;
        el.style.opacity = '0';
      });

      setTimeout(() => el.remove(), 450);
    }
  }

  /* Wrap each character in a span with staggered sine wave delay */
  private waveText(text: string): string {
    return text.split('').map((ch, i) => {
      if (ch === ' ') return ' ';
      const delay = (i * 0.08).toFixed(2);
      return `<span class="wave-char" style="animation-delay:${delay}s">${ch}</span>`;
    }).join('');
  }

  /* Update Gaytrix hint visibility (shown when both Gay + Matrix are on) */
  private updateGaytrixHint(): void {
    const visible = this.state.gayMode && this.state.matrixMode;
    const hint = this.root.querySelector('#gaytrix-hint') as HTMLElement;
    if (hint) {
      hint.style.display = visible ? 'block' : 'none';
    }

    // When hiding the hint, also deactivate trans mode
    if (!visible && this.state.transMode) {
      this.state.transMode = false;
      this.state.transScrollDirection = 'off';
      window.rainydesk.updateRainscapeParam('visual.transMode', false);
      window.rainydesk.updateRainscapeParam('visual.transScrollDirection', 'off');
      // Update hint styling if it exists
      if (hint) {
        hint.classList.remove('trans-mode');
        hint.innerHTML = this.waveText('Gaytrix mode activated!');
      }
    }

    // Also update scroll toggle visibility
    const scrollToggle = this.root.querySelector('#trans-scroll-toggle') as HTMLElement;
    if (scrollToggle) {
      scrollToggle.style.display = (visible && this.state.transMode) ? '' : 'none';
    }
  }


  /* Update slider labels, disabled states, and toggle labels for Matrix Mode */
  private updateMatrixModeSliders(): void {
    const isMatrix = this.state.matrixMode;

    // Update all slider labels that have matrix alternatives
    const sliders = this.root.querySelectorAll('[data-slider-id]');
    sliders.forEach((row) => {
      const el = row as HTMLElement;
      const normalLabel = el.dataset.normalLabel;
      const matrixLabel = el.dataset.matrixLabel;
      if (normalLabel && matrixLabel) {
        const labelEl = el.querySelector('.control-label') as HTMLElement;
        if (labelEl) {
          labelEl.textContent = isMatrix ? matrixLabel : normalLabel;
        }
      }
    });

    // Disable sliders that have no effect in Matrix Mode
    // (Audio tab rain sliders are handled by #rain-audio-sliders container below)
    const disabledInMatrix = [
      'wind',          // Matrix uses fixed stream patterns
      'splashSize',    // No water splashes
      'puddleDrain',  // No puddles
      'gridScale',    // Matrix uses own grid, not physics grid
    ];
    for (const id of disabledInMatrix) {
      const row = this.root.querySelector(`[data-slider-id="${id}"]`) as HTMLElement;
      if (row) {
        row.classList.toggle('matrix-disabled', isMatrix);
      }
    }

    // Disable OSC knobs on tabs that stay visible (Basic + Physics)
    for (const knobId of ['windOsc']) {
      const knob = this.root.querySelector(`[data-knob-id="${knobId}"]`) as HTMLElement;
      if (knob) {
        knob.style.opacity = isMatrix ? '0.4' : '';
        knob.style.pointerEvents = isMatrix ? 'none' : '';
      }
    }

    // Disable chain-link toggles in Matrix Mode (splash physics disabled)
    const chainToggles = this.root.querySelectorAll('.chain-link-toggle');
    chainToggles.forEach((btn) => {
      const el = btn as HTMLElement;
      el.style.opacity = isMatrix ? '0.4' : (this.state.splashLinked ? '1' : '0.7');
      el.style.pointerEvents = isMatrix ? 'none' : '';
    });

    // Update toggle labels that have matrix alternatives
    const toggles = this.root.querySelectorAll('[data-toggle-id]');
    toggles.forEach((row) => {
      const el = row as HTMLElement;
      const normalLabel = el.dataset.normalLabel;
      const matrixLabel = el.dataset.matrixLabel;
      if (normalLabel && matrixLabel) {
        const labelEl = el.querySelector('.control-label') as HTMLElement;
        if (labelEl) {
          labelEl.textContent = isMatrix ? matrixLabel : normalLabel;
        }
      }
    });

    // Show/hide Matrix-only controls
    const matrixOnlyControls = this.root.querySelectorAll('[data-matrix-only="true"]');
    matrixOnlyControls.forEach((el) => {
      (el as HTMLElement).style.display = isMatrix ? '' : 'none';
    });

    // Show/hide Matrix audio section in Audio tab
    const matrixAudioSection = this.root.querySelector('#matrix-audio-section') as HTMLElement;
    if (matrixAudioSection) {
      matrixAudioSection.style.display = isMatrix ? 'block' : 'none';
    }

    // Hide rain-only Audio tab sections in Matrix Mode
    for (const id of ['rain-audio-sliders', 'thunder-audio-section']) {
      const el = this.root.querySelector(`#${id}`) as HTMLElement;
      if (el) el.style.display = isMatrix ? 'none' : '';
    }
  }

  private getAppStatus(): { dot: string; text: string } {
    // Critical states always win (reset in progress, etc.)
    if (this.state.appStatus === 'stopped') {
      return { dot: 'stopped', text: 'Stopped' };
    }
    if (this.state.appStatus === 'initializing') {
      return { dot: 'initializing', text: 'Initializing' };
    }
    // Persistent user states (pause) win over transient autosave
    if (this.state.paused || this.state.appStatus === 'paused') {
      return { dot: 'paused', text: 'Paused' };
    }
    // Autosave states show during normal operation
    if (this.autosaveState === 'saving') {
      return { dot: 'autosaving', text: 'Saving...' };
    }
    if (this.autosaveState === 'saved') {
      return { dot: 'autosaved', text: 'Saved!' };
    }
    return { dot: 'raining', text: 'Raining' };
  }

  private async checkForUpdates(): Promise<{ name: string; url: string; tag: string } | null> {
    const cacheKey = 'rainydesk-update-check';

    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached === 'none') return null;
      if (cached) return JSON.parse(cached);

      const localVersion = window.rainydesk?.getVersion
        ? await window.rainydesk.getVersion()
        : null;
      if (!localVersion) return null;

      const localMatch = localVersion.match(/\.(\d+)-/);
      if (!localMatch?.[1]) return null;
      const localPatch = parseInt(localMatch[1], 10);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(
        'https://api.github.com/repos/XYAgainAgain/RainyDesk/releases',
        { signal: controller.signal, headers: { Accept: 'application/vnd.github.v3+json' } }
      );
      clearTimeout(timeout);

      if (!res.ok) return null;

      const releases = await res.json();
      if (!Array.isArray(releases) || releases.length === 0) return null;

      const latest = releases[0];
      const tagMatch = latest.tag_name?.match(/alpha(\d+)/);
      if (!tagMatch) {
        sessionStorage.setItem(cacheKey, 'none');
        return null;
      }
      const remotePatch = parseInt(tagMatch[1], 10);

      if (remotePatch > localPatch) {
        const url: string = latest.html_url || '';
        if (!url.startsWith('https://github.com/')) {
          sessionStorage.setItem(cacheKey, 'none');
          return null;
        }
        const result = { name: latest.name || latest.tag_name, url, tag: latest.tag_name };
        sessionStorage.setItem(cacheKey, JSON.stringify(result));
        return result;
      }

      sessionStorage.setItem(cacheKey, 'none');
      return null;
    } catch {
      return null;
    }
  }

  private createFooter(): HTMLElement {
    const footer = document.createElement('div');
    footer.className = 'panel-footer';

    // Left: Status indicator (dynamic based on app state)
    const statusIndicator = document.createElement('div');
    statusIndicator.className = 'status-indicator';
    const status = this.getAppStatus();
    statusIndicator.innerHTML = `<span class="status-dot ${status.dot}"></span> ${status.text}`;

    // Center: Intensity status text
    const intensityStatus = document.createElement('div');
    intensityStatus.className = 'intensity-status';
    this.renderIntensityStatus(intensityStatus);

    // Right: Version button with popup menu
    const versionContainer = document.createElement('div');
    versionContainer.className = 'version-container';

    const versionBtn = document.createElement('button');
    versionBtn.className = 'version-button';
    const versionLabel = document.createElement('span');
    versionLabel.textContent = 'v...';
    versionBtn.appendChild(versionLabel);

    if (window.rainydesk?.getVersion) {
      window.rainydesk.getVersion().then((v: string) => {
        versionLabel.textContent = `v${v}`;
      }).catch(() => {
        versionLabel.textContent = 'v0.9.4-alpha';
      });
    } else {
      versionLabel.textContent = 'v0.9.4-alpha';
    }

    // Build the popup menu (reused across toggles)
    const menu = document.createElement('div');
    menu.className = 'version-menu';

    // Help & FAQ
    const helpItem = document.createElement('button');
    helpItem.className = 'version-menu-item';
    helpItem.innerHTML = '<span class="version-menu-icon">?</span> <span style="flex: 1; text-align: right;">Help Me!</span>';
    helpItem.addEventListener('click', () => {
      window.rainydesk.showHelpWindow();
      hideMenu();
    });
    menu.appendChild(helpItem);

    // View on GitHub
    const githubItem = document.createElement('button');
    githubItem.className = 'version-menu-item';
    githubItem.innerHTML = '<span class="version-menu-icon">&lt;/&gt;</span> <span style="flex: 1; text-align: right;">GitHub</span>';
    githubItem.addEventListener('click', () => {
      window.rainydesk.openUrl('https://github.com/XYAgainAgain/RainyDesk');
      hideMenu();
    });
    menu.appendChild(githubItem);

    // Check for Updates
    const updatesItem = document.createElement('button');
    updatesItem.className = 'version-menu-item disabled';
    updatesItem.innerHTML = '<span class="version-menu-icon">&#8635;</span> <span style="flex: 1; text-align: right;">Update <span class="version-menu-sublabel">(soon!)</span></span>';
    menu.appendChild(updatesItem);

    this.checkForUpdates().then((release) => {
      if (!release) return;
      updatesItem.classList.remove('disabled');

      updatesItem.textContent = '';
      const icon = document.createElement('span');
      icon.className = 'version-menu-icon';
      icon.textContent = '\u2191';
      const label = document.createElement('span');
      label.style.cssText = 'flex: 1; text-align: right;';
      label.textContent = 'Update me? :) ';
      const sublabel = document.createElement('span');
      sublabel.className = 'version-menu-sublabel';
      sublabel.textContent = release.name;
      label.appendChild(sublabel);
      updatesItem.appendChild(icon);
      updatesItem.appendChild(label);

      updatesItem.addEventListener('click', () => {
        window.rainydesk.openUrl(release.url);
        hideMenu();
      });
      const droplet = document.createElement('span');
      droplet.className = 'update-droplet';
      versionBtn.appendChild(droplet);
    }).catch(() => {});

    // Start with Windows toggle
    const autostartItem = document.createElement('button');
    autostartItem.className = 'version-menu-item autostart-toggle';
    const checkmark = document.createElement('span');
    checkmark.className = 'version-menu-icon autostart-check';
    checkmark.textContent = '\u2610'; // Empty checkbox
    const autostartLabel = document.createElement('span');
    autostartLabel.style.cssText = 'flex: 1; text-align: right;';
    autostartLabel.textContent = 'Autostart';
    autostartItem.appendChild(checkmark);
    autostartItem.appendChild(autostartLabel);

    // Check current autostart state and update checkbox
    isAutostartEnabled().then((enabled) => {
      checkmark.textContent = enabled ? '\u2611' : '\u2610';
    }).catch(() => {});

    autostartItem.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const currentlyEnabled = await isAutostartEnabled();
        if (currentlyEnabled) {
          await disableAutostart();
          checkmark.textContent = '\u2610';
        } else {
          await enableAutostart();
          checkmark.textContent = '\u2611';
        }
      } catch (err) {
        window.rainydesk.log(`[Autostart] Toggle failed: ${err}`);
      }
    });
    menu.appendChild(autostartItem);

    versionContainer.appendChild(menu);
    versionContainer.appendChild(versionBtn);

    // Toggle menu
    let menuOpen = false;
    const showMenu = () => {
      menu.classList.add('open');
      menuOpen = true;
    };
    const hideMenu = () => {
      menu.classList.remove('open');
      menuOpen = false;
    };

    versionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menuOpen) {
        hideMenu();
      } else {
        showMenu();
      }
    });

    // Click-outside dismisses menu (stored for cleanup on re-render)
    this.docClickListener = () => { if (menuOpen) hideMenu(); };
    document.addEventListener('click', this.docClickListener);

    // Escape key dismisses menu (stored for cleanup on re-render)
    this.docKeyListener = (e) => { if (e.key === 'Escape' && menuOpen) hideMenu(); };
    document.addEventListener('keydown', this.docKeyListener);

    footer.appendChild(statusIndicator);
    footer.appendChild(intensityStatus);
    footer.appendChild(versionContainer);

    return footer;
  }

  private renderIntensityStatus(element: HTMLElement): void {
    const statusText = this.getIntensityStatusText();

    // Skip re-render if text hasn't changed (preserves running CSS animations)
    if (element.dataset.currentText === statusText) return;
    element.dataset.currentText = statusText;

    const hasEllipsis = statusText.endsWith('...');
    const isSpecial = statusText === 'Did you feel that?' || statusText === 'Maximum coziness!';

    if (hasEllipsis) {
      // Split off ellipsis for sequential dot animation
      const textPart = statusText.slice(0, -3);
      element.innerHTML = `<span class="intensity-text-main">${textPart}</span><span class="ellipsis-dot" style="animation-delay: 0s">.</span><span class="ellipsis-dot" style="animation-delay: 0.15s">.</span><span class="ellipsis-dot" style="animation-delay: 0.3s">.</span>`;
    } else if (isSpecial) {
      // Per-character sine wave (same as Gaytrix banner)
      element.innerHTML = this.waveText(statusText);
    } else {
      element.textContent = statusText;
    }
  }
}
