/**
 * RainyDeskPanel - Main panel class
 *
 * Manages the standalone Rainscaper window UI.
 */

import { Slider, Toggle, ColorPicker, TriToggle, RotaryKnob, updateSliderValue } from './components';
import { applyTheme } from './themes';

// Tab definitions
type TabId = 'basic' | 'physics' | 'audio' | 'visual' | 'debug';

interface TabDef {
  id: TabId;
  label: string;
}

const TABS: TabDef[] = [
  { id: 'basic', label: 'Basic' },
  { id: 'physics', label: 'Physics' },
  { id: 'audio', label: 'Audio' },
  { id: 'visual', label: 'Visual' },
  { id: 'debug', label: 'Stats' },
];

// Default colors for different modes
const DEFAULT_RAIN_COLOR = '#8aa8c0';  // Gray-blue for normal rain
const DEFAULT_MATRIX_COLOR = '#008F11'; // Matrix green (body color from spec)

// Debug log entry
interface DebugLogEntry {
  timestamp: Date;
  level: 'info' | 'warn' | 'error';
  message: string;
}

// Declare global window extensions for debug
declare global {
  interface Window {
    _debugLog: DebugLogEntry[];
    _debugStats: {
      fps: number;
      waterCount: number;
      activeDrops: number;
      puddleCells: number;
      frameTime: number;
      memoryMB: number;
      lastUpdate: number;
    };
    _addDebugLog: (level: 'info' | 'warn' | 'error', message: string) => void;
    _updateDebugStats: (stats: Partial<Window['_debugStats']>) => void;
  }
}

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
  puddleDrain: number;
  turbulence: number;
  dropSize: number;
  // Audio
  masterVolume: number;
  rainIntensity: number;
  ambience: number;
  bubbleSound: number;
  thunderEnabled: boolean;
  windSound: number;
  // Matrix Mode audio (E1) — percentages that map to dB via (v/100*42)-30
  matrixBassVolume: number;       // Default 43% = -12 dB (matches GlitchSynth BASS_VOLUME_MAIN)
  matrixCollisionVolume: number;  // Default 14% = -24 dB (matches GlitchSynth initial gain)
  matrixDroneVolume: number;      // Default 43% = -12 dB (matches GlitchSynth targetDroneVolumeDb)
  matrixTranspose: number;
  // Visual
  backgroundShaderEnabled: boolean;
  backgroundIntensity: number;
  backgroundLayers: number;
  rainColor: string;
  gayMode: boolean;
  matrixMode: boolean;
  matrixDensity: number;
  crtIntensity: number;
  uiScale: number;
  // Trans Mode easter egg
  transMode: boolean;
  transScrollDirection: 'left' | 'off' | 'right';
  // FPS Limiter
  fpsLimit: number;
  // Wind Gusts
  windOsc: number;
  // Presets
  presets: string[];
  currentPreset: string;
  // Physics (Phase 2)
  reverseGravity: boolean;
  gridScale: number;
  gridScalePending: number;
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
  private resetRainButton: HTMLButtonElement | null = null;
  private autosaveIndicatorTimer: ReturnType<typeof setTimeout> | null = null;
  private autosaveRevertTimer: ReturnType<typeof setTimeout> | null = null;
  private autosaveState: 'idle' | 'saving' | 'saved' = 'idle';
  private reinitCooldownTimer: ReturnType<typeof setInterval> | null = null;
  private reinitCooldownEnd: number = 0; // timestamp when cooldown expires
  private appStartTime: number = Date.now();
  // Document-level listeners (stored for cleanup on re-render)
  private docClickListener: (() => void) | null = null;
  private docKeyListener: ((e: KeyboardEvent) => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.state = this.getDefaultState();
  }

  private getDefaultState(): PanelState {
    // Restore tab from sessionStorage if available
    const savedTab = sessionStorage.getItem('rainscaper-tab') as TabId | null;

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
      puddleDrain: 0.2,
      turbulence: 0.3,
      dropSize: 4,
      // Audio
      masterVolume: 50,
      rainIntensity: 50,
      ambience: 30,
      bubbleSound: 30,
      thunderEnabled: false,
      windSound: 20,
      // Matrix Mode audio (E1) — percentages matching GlitchSynth default dB values
      matrixBassVolume: 43,       // -12 dB
      matrixCollisionVolume: 14,  // -24 dB
      matrixDroneVolume: 43,      // -12 dB
      matrixTranspose: 0,
      // Visual
      backgroundShaderEnabled: true,
      backgroundIntensity: 50,
      backgroundLayers: 3,
      rainColor: '#8aa8c0',
      gayMode: false,
      matrixMode: false,
      matrixDensity: 28,
      crtIntensity: 0,
      uiScale: parseFloat(localStorage.getItem('rainscaper-ui-scale') || '1.0'),
      // Trans Mode easter egg
      transMode: false,
      transScrollDirection: 'off',
      // FPS Limiter
      fpsLimit: 0,
      // Wind Gusts
      windOsc: 0,
      // Presets
      presets: [],
      currentPreset: '',
      // Physics (Phase 2)
      reverseGravity: false,
      gridScale: 0.25,
      gridScalePending: 0.25,
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

    // Hook param updates to flash the autosave indicator (skip non-saveable commands)
    const originalUpdateParam = window.rainydesk.updateRainscapeParam;
    window.rainydesk.updateRainscapeParam = (path: string, value: unknown) => {
      originalUpdateParam(path, value);
      // Skip autosave flash for commands and state toggles (not saveable param changes)
      if (path !== 'physics.resetSimulation' && path !== 'system.paused' && path !== 'audio.muted') {
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
      // Update global stats object so the debug tab can display them
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
  }

  private applyRainscapeData(data: Record<string, unknown>): void {
    // Apply rain settings (stored in data.rain.*)
    if (data.rain && typeof data.rain === 'object') {
      const rain = data.rain as Record<string, unknown>;
      if (typeof rain.intensity === 'number') this.state.intensity = rain.intensity;
      if (typeof rain.wind === 'number') this.state.wind = rain.wind;
      if (typeof rain.turbulence === 'number') this.state.turbulence = rain.turbulence;

      // Drop size stored in rain.dropSize.max
      if (rain.dropSize && typeof rain.dropSize === 'object') {
        const dropSize = rain.dropSize as Record<string, unknown>;
        if (typeof dropSize.max === 'number') this.state.dropSize = dropSize.max;
      }
    }

    // Apply physics settings (stored in data.physics.*)
    if (data.physics && typeof data.physics === 'object') {
      const physics = data.physics as Record<string, unknown>;
      if (typeof physics.reverseGravity === 'boolean') {
        this.state.reverseGravity = physics.reverseGravity;
      }
      if (typeof physics.gravity === 'number') this.state.gravity = physics.gravity;
    }

    // Apply audio settings (stored in data.audio.*)
    if (data.audio && typeof data.audio === 'object') {
      const audio = data.audio as Record<string, unknown>;
      if (typeof audio.masterVolume === 'number') {
        // Convert from dB to percentage (roughly -60 to 0 dB -> 0 to 100%)
        const dbValue = audio.masterVolume as number;
        this.state.masterVolume = Math.round(Math.max(0, Math.min(100, ((dbValue + 60) / 60) * 100)));
        this.state.volume = this.state.masterVolume;
      }

      // Thunder settings
      if (audio.thunder && typeof audio.thunder === 'object') {
        // Thunder is "enabled" if minInterval < 1000 (i.e., auto-trigger is active)
        // We'll just leave it false by default since it's a toggle
      }

      // Wind settings
      if (audio.wind && typeof audio.wind === 'object') {
        const wind = audio.wind as Record<string, unknown>;
        if (typeof wind.masterGain === 'number') {
          // Convert from dB to percentage
          const dbValue = wind.masterGain as number;
          this.state.windSound = Math.round(Math.max(0, Math.min(100, ((dbValue + 48) / 48) * 100)));
        }
      }

      // Matrix synth volumes (dB → percentage via reverse of (v/100*42)-30)
      if (typeof audio.matrixBass === 'number') {
        this.state.matrixBassVolume = Math.round(Math.max(0, Math.min(100, ((audio.matrixBass as number) + 30) / 42 * 100)));
      }
      if (typeof audio.matrixCollision === 'number') {
        this.state.matrixCollisionVolume = Math.round(Math.max(0, Math.min(100, ((audio.matrixCollision as number) + 30) / 42 * 100)));
      }
      if (typeof audio.matrixDrone === 'number') {
        this.state.matrixDroneVolume = Math.round(Math.max(0, Math.min(100, ((audio.matrixDrone as number) + 30) / 42 * 100)));
      }
    }

    // Apply physics extras
    if (data.physics && typeof data.physics === 'object') {
      const physics = data.physics as Record<string, unknown>;
      if (typeof physics.fpsLimit === 'number') {
        this.state.fpsLimit = physics.fpsLimit;
      }
    }

    // Apply rain extras
    if (data.rain && typeof data.rain === 'object') {
      const rain = data.rain as Record<string, unknown>;
      if (typeof rain.windOsc === 'number') {
        this.state.windOsc = rain.windOsc;
      }
    }

    // Apply visual settings
    if (data.visual && typeof data.visual === 'object') {
      const visual = data.visual as Record<string, unknown>;
      if (typeof visual.matrixMode === 'boolean') {
        this.state.matrixMode = visual.matrixMode;
        localStorage.setItem('rainscaper-matrix-mode', String(visual.matrixMode));
      }
      if (typeof visual.gayMode === 'boolean') {
        this.state.gayMode = visual.gayMode;
      }
      if (typeof visual.matrixDensity === 'number') {
        this.state.matrixDensity = visual.matrixDensity;
      }
      if (typeof visual.matrixTranspose === 'number') {
        this.state.matrixTranspose = visual.matrixTranspose;
      }
      if (typeof visual.transMode === 'boolean') {
        this.state.transMode = visual.transMode;
      }
      if (typeof visual.transScrollDirection === 'string') {
        this.state.transScrollDirection = visual.transScrollDirection as 'left' | 'off' | 'right';
      }
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

    const title = document.createElement('div');
    title.className = 'panel-title';
    title.innerHTML = '<span class="panel-title-icon">&#9730;</span> RainyDesk Rainscaper';
    this.titleElement = title; // Store reference for Gay Mode color sync

    const closeBtn = document.createElement('button');
    closeBtn.className = 'panel-close';
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    closeBtn.onclick = () => this.hide();

    header.appendChild(title);
    header.appendChild(closeBtn);

    return header;
  }

  /** Flash autosave state through the footer status dot */
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
        this.state.activeTab = tab.id;
        sessionStorage.setItem('rainscaper-tab', tab.id);
        this.switchTab(tab.id);  // Targeted swap instead of full render()
      };
      tabBar.appendChild(btn);
    }

    return tabBar;
  }

  /**
   * Switch tab content without rebuilding entire panel (smoother UX)
   */
  private switchTab(tabId: TabId): void {
    // Update tab button states
    const tabBar = this.root.querySelector('.tab-bar');
    if (tabBar) {
      tabBar.querySelectorAll('.tab-button').forEach((btn, i) => {
        btn.classList.toggle('active', TABS[i]?.id === tabId);
      });
    }

    // Stop debug interval if leaving debug tab
    if (this.debugUpdateInterval && tabId !== 'debug') {
      clearInterval(this.debugUpdateInterval);
      this.debugUpdateInterval = null;
    }

    // Replace content only
    const content = this.root.querySelector('.panel-content');
    if (content) {
      content.innerHTML = '';
      content.appendChild(this.createTabContent(tabId));
    }
  }

  private createTabContent(tabId: TabId): HTMLElement {
    // Stop debug updates when leaving debug tab
    if (this.debugUpdateInterval && tabId !== 'debug') {
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
      case 'debug':
        return this.createDebugTab();
    }
  }

  private createBasicTab(): HTMLElement {
    const container = document.createElement('div');

    // Intensity (min 1 — intensity 0 was confusing since Matrix still showed streams)
    container.appendChild(
      Slider({
        id: 'intensity',
        label: 'Intensity',
        value: this.state.intensity,
        min: 1,
        max: 100,
        unit: '%',
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

    // Wind (disabled in Matrix Mode -- Matrix uses fixed stream patterns)
    container.appendChild(
      Slider({
        id: 'wind',
        label: 'Wind',
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
        label: 'Volume',
        value: this.state.volume,
        min: 0,
        max: 100,
        unit: '%',
        onChange: (v) => {
          const wasZero = this.state.volume === 0;
          this.state.volume = v;
          this.state.masterVolume = v;
          // Convert to dB: 0% = -100dB (effectively silent), 100% = 0dB
          const db = v <= 0 ? -1000 : (v / 100 * 60) - 60;
          window.rainydesk.updateRainscapeParam('effects.masterVolume', db);
          // Auto-toggle mute when volume hits 0
          if (v === 0 && !this.state.muted) {
            this.state.muted = true;
            window.rainydesk.updateRainscapeParam('audio.muted', true);
            this.updateMuteToggle();
          }
          // Auto-unmute when volume goes from 0 to any positive value
          if (wasZero && v > 0 && this.state.muted) {
            this.state.muted = false;
            window.rainydesk.updateRainscapeParam('audio.muted', false);
            this.updateMuteToggle();
          }
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
          this.render();
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
    toggleRow.appendChild(pauseToggle);

    container.appendChild(toggleRow);

    // Panel Appearance section (scale slider + centered theme grid)
    const themeSection = document.createElement('div');
    themeSection.className = 'section';

    const themeTitle = document.createElement('div');
    themeTitle.className = 'section-title';
    themeTitle.textContent = 'Panel Appearance';
    themeSection.appendChild(themeTitle);

    // UI Scale as horizontal slider (same style as Intensity/Wind/Volume)
    const scaleSteps = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5];
    const foundIndex = scaleSteps.findIndex((s) => Math.abs(s - this.state.uiScale) < 0.01);
    const currentStepIndex = foundIndex >= 0 ? foundIndex : 2;

    themeSection.appendChild(
      Slider({
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

    // Centered theme grid
    const themeSelector = document.createElement('div');
    themeSelector.className = 'theme-selector';

    const themeOptions = ['blue', 'purple', 'warm', 'sakura', 'forest', 'midnight', 'lavender', 'gothic', 'ocean', 'ember', 'windows', 'custom'];
    for (const theme of themeOptions) {
      const btn = document.createElement('button');
      btn.className = `theme-button${this.state.theme === theme ? ' active' : ''}`;
      btn.dataset.theme = theme;
      btn.onclick = async () => {
        if (this.state.theme === theme) return;
        this.state.theme = theme;
        localStorage.setItem('rainscaper-theme', theme);

        // Diagonal wipe transition from a random corner
        const panel = this.root.querySelector('.rainscaper-panel') as HTMLElement;
        if (panel) {
          // Capture old background color before applying new theme
          const oldBg = getComputedStyle(panel).backgroundColor;

          // Create overlay with old colors
          const overlay = document.createElement('div');
          overlay.className = 'theme-wipe-overlay';
          overlay.style.background = oldBg;

          // Pick a random corner: triangle starts oversized, collapses to corner point
          const wipes = [
            ['polygon(0 0, 300% 0, 0 300%)', 'polygon(0 0, 0 0, 0 0)'],
            ['polygon(100% 0, 100% 300%, -200% 0)', 'polygon(100% 0, 100% 0, 100% 0)'],
            ['polygon(0 100%, 300% 100%, 0 -200%)', 'polygon(0 100%, 0 100%, 0 100%)'],
            ['polygon(100% 100%, -200% 100%, 100% -200%)', 'polygon(100% 100%, 100% 100%, 100% 100%)'],
          ];
          const wipe = wipes[Math.floor(Math.random() * wipes.length)]!;
          overlay.style.clipPath = wipe[0]!;
          panel.appendChild(overlay);

          // Apply new theme (colors change instantly under the overlay)
          await applyTheme(theme);

          // Update active button without full re-render
          themeSelector.querySelectorAll('.theme-button').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');

          // Trigger the wipe animation
          requestAnimationFrame(() => {
            overlay.style.clipPath = wipe[1]!;
            overlay.addEventListener('transitionend', () => overlay.remove());
          });
        }
      };
      themeSelector.appendChild(btn);
    }

    themeSection.appendChild(themeSelector);
    container.appendChild(themeSection);

    // Apply Matrix Mode disabled states after DOM is ready
    requestAnimationFrame(() => this.updateMatrixModeSliders());

    return container;
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
        unit: '',
        defaultValue: 980,
        onChange: (v) => {
          this.state.gravity = v;
          window.rainydesk.updateRainscapeParam('physics.gravity', v);
        },
      })
    );

    // Splash size (disabled in Matrix Mode)
    // Slider 0-100% maps to splashScale 0.5-2.0 (full valid range)
    // Default 33% ≈ splashScale 1.0
    container.appendChild(
      Slider({
        id: 'splashSize',
        label: 'Splash Size',
        value: Math.round(((this.state.splashSize - 0.5) / 1.5) * 100),
        min: 0,
        max: 100,
        unit: '%',
        defaultValue: 33,
        onChange: (v) => {
          // Map 0-100 slider → 0.5-2.0 splashScale
          const splashScale = 0.5 + (v / 100) * 1.5;
          this.state.splashSize = splashScale;
          window.rainydesk.updateRainscapeParam('physics.splashScale', splashScale);
        },
      })
    );

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
        onChange: (v) => {
          this.state.turbulence = v / 100;
          window.rainydesk.updateRainscapeParam('physics.turbulence', v / 100);
        },
      })
    );

    // Drop mass (Matrix: String Length)
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
        onChange: (v) => {
          this.state.dropSize = v;
          window.rainydesk.updateRainscapeParam('physics.dropMaxSize', v);
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

    // --- Performance section divider ---
    const perfDivider = document.createElement('hr');
    perfDivider.className = 'panel-separator';
    container.appendChild(perfDivider);

    // FPS Limiter (stepped: 15/30/60/90/120/144/165/240/360/Uncapped)
    const fpsSteps = [15, 30, 60, 90, 120, 144, 165, 240, 360, 0]; // 0 = uncapped
    const fpsLabels = ['15', '30', '60', '90', '120', '144', '165', '240', '360', 'Max'];
    const currentFpsIdx = fpsSteps.indexOf(this.state.fpsLimit);
    const safeFpsIdx = currentFpsIdx >= 0 ? currentFpsIdx : fpsSteps.length - 1;

    container.appendChild(
      Slider({
        id: 'fpsLimit',
        label: 'FPS Limit',
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

    // Grid Scale section
    const gridScaleSection = document.createElement('div');
    gridScaleSection.className = 'slider-with-button';

    // Grid Scale slider (3 discrete steps: Chunky/Normal/Detailed)
    const gridScaleSteps = [0.125, 0.25, 0.375]; // Chunky, Normal, Detailed
    const gridScaleLabels = ['Chunky', 'Normal', 'Detailed'];
    const currentIndex = gridScaleSteps.findIndex(s => Math.abs(s - this.state.gridScalePending) < 0.01);
    const safeIndex = currentIndex >= 0 ? currentIndex : 1; // Default to Normal

    gridScaleSection.appendChild(
      Slider({
        id: 'gridScale',
        label: 'Grid Scale',
        value: safeIndex,
        min: 0,
        max: 2,
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

    // Apply Changes button (only visible when scale changed)
    this.resetRainButton = document.createElement('button');
    this.resetRainButton.className = 'reset-rain-button';
    this.resetRainButton.textContent = 'Apply Changes';
    this.resetRainButton.style.display = 'none';
    this.resetRainButton.addEventListener('click', () => this.handleResetRain());
    gridScaleSection.appendChild(this.resetRainButton);

    container.appendChild(gridScaleSection);

    // Data Density (Matrix Mode only — adjusts column spacing, font stays 28px)
    const densitySteps = [42, 28, 20, 14]; // Noob → Neo
    const densityLabels = ['Noob', 'Normie', 'Nerd', 'Neo'];
    const currentDensityIdx = densitySteps.findIndex(s => s === this.state.matrixDensity);
    const safeDensityIdx = currentDensityIdx >= 0 ? currentDensityIdx : 1; // Default to Normie

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
    // Only show when Matrix Mode is on
    densitySlider.style.display = this.state.matrixMode ? '' : 'none';
    densitySlider.dataset.matrixOnly = 'true';
    container.appendChild(densitySlider);

    // Update button visibility based on current state
    this.updateResetButtonVisibility();

    // Apply Matrix Mode state to slider labels and disabled states
    // (deferred to next frame so DOM is ready)
    requestAnimationFrame(() => this.updateMatrixModeSliders());

    return container;
  }

  private updateResetButtonVisibility(): void {
    if (!this.resetRainButton) return;
    const changed = Math.abs(this.state.gridScalePending - this.state.gridScale) > 0.01;
    this.resetRainButton.style.display = changed ? 'block' : 'none';
  }

  private handleResetRain(): void {
    if (this.resetRainButton) {
      this.resetRainButton.style.display = 'none';
    }
    this.state.appStatus = 'stopped';
    this.updateFooterStatus();
    window.rainydesk.updateRainscapeParam('physics.resetSimulation', this.state.gridScalePending);
    this.state.gridScale = this.state.gridScalePending;
  }

  private createAudioTab(): HTMLElement {
    const container = document.createElement('div');

    // Master volume
    container.appendChild(
      Slider({
        label: 'Master Volume',
        value: this.state.masterVolume,
        min: 0,
        max: 100,
        unit: '%',
        onChange: (v) => {
          this.state.masterVolume = v;
          // Sync with Basic tab's volume
          this.state.volume = v;
          const db = v <= 0 ? -1000 : (v / 100 * 60) - 60;
          window.rainydesk.updateRainscapeParam('effects.masterVolume', db);
          // Auto-toggle mute when volume hits 0
          if (v === 0 && !this.state.muted) {
            this.state.muted = true;
            window.rainydesk.updateRainscapeParam('audio.muted', true);
            this.render();
          }
        },
      })
    );

    // Impact sound (raindrop impact volume — Rain Mode only, irrelevant in Matrix)
    container.appendChild(
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

    // Wind volume (Rain Mode only — Matrix Mode has its own Drone slider)
    container.appendChild(
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

    // Thunder toggle (disabled - not yet implemented)
    container.appendChild(
      Toggle({
        label: 'Thunder',
        checked: this.state.thunderEnabled,
        disabled: true,
        disabledNote: 'rolling in soon...',
        onChange: (v) => {
          this.state.thunderEnabled = v;
          window.rainydesk.updateRainscapeParam('audio.thunder.enabled', v);
        },
      })
    );

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
        defaultValue: 43,
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
        defaultValue: 14,
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
        defaultValue: 43,
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

    // Background shader toggle
    container.appendChild(
      Toggle({
        label: 'Background Shader',
        checked: this.state.backgroundShaderEnabled,
        onChange: (v) => {
          this.state.backgroundShaderEnabled = v;
          window.rainydesk.updateRainscapeParam('backgroundRain.enabled', v);
        },
      })
    );

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
          // Sync title bar color
          if (v) {
            this.startGayModeAnimation();
          } else {
            this.stopGayModeAnimation();
          }
          // Update Gaytrix hint visibility
          this.updateGaytrixHint();
        },
      })
    );

    // Matrix Mode toggle (digital rain)
    container.appendChild(
      Toggle({
        label: 'Matrix Mode',
        sublabel: 'Digital rain with collision effects',
        checked: this.state.matrixMode,
        onChange: (v) => {
          this.state.matrixMode = v;
          window.rainydesk.updateRainscapeParam('visual.matrixMode', v);
          // Persist for cross-window sync (help window reads this)
          localStorage.setItem('rainscaper-matrix-mode', String(v));
          // Toggle Matrix font mode on the panel
          const panelEl = this.root.querySelector('.rainscaper-panel');
          if (panelEl) panelEl.classList.toggle('matrix-font-mode', v);
          // Update Gaytrix hint visibility
          this.updateGaytrixHint();
          // Update Physics tab slider labels and disabled states
          this.updateMatrixModeSliders();
        },
      })
    );

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
      overlay.style.clipPath = 'polygon(0 0, 100% 0, 100% 100%, 0 100%)';
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
      gaytrixHint.classList.add('gleam-click');
      requestAnimationFrame(() => {
        // Angled wipe at ~15 deg matching the gleam sweep direction
        overlay.style.clipPath = 'polygon(120% -20%, 140% -20%, 140% 120%, 120% 120%)';
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

  private createDebugTab(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'debug-tab';

    // Stats section
    const statsSection = document.createElement('div');
    statsSection.className = 'section';

    const statsTitle = document.createElement('div');
    statsTitle.className = 'section-title';
    statsTitle.textContent = 'Real-time Stats';
    statsSection.appendChild(statsTitle);

    const statsGrid = document.createElement('div');
    statsGrid.className = 'debug-stats-grid';
    this.debugStatsElement = statsGrid;

    // Initial stats render
    this.updateDebugStats(statsGrid);
    statsSection.appendChild(statsGrid);
    container.appendChild(statsSection);

    // Start real-time updates
    this.debugUpdateInterval = setInterval(() => {
      if (this.debugStatsElement) {
        this.updateDebugStats(this.debugStatsElement);
      }
    }, 500);

    // Reinitialize button with 30s cooldown (persists across tab switches)
    const reinitSection = document.createElement('div');
    reinitSection.className = 'section';

    const reinitBtn = document.createElement('button');
    reinitBtn.className = 'reinit-button';

    // Helper: start a countdown timer that updates THIS button instance
    const startCooldownTimer = () => {
      if (this.reinitCooldownTimer) clearInterval(this.reinitCooldownTimer);
      this.reinitCooldownTimer = setInterval(() => {
        const remaining = Math.ceil((this.reinitCooldownEnd - Date.now()) / 1000);
        if (remaining <= 0) {
          if (this.reinitCooldownTimer) clearInterval(this.reinitCooldownTimer);
          this.reinitCooldownTimer = null;
          reinitBtn.disabled = false;
          reinitBtn.textContent = 'Reset RainyDesk';
        } else {
          reinitBtn.textContent = `Cooldown (${remaining}s)`;
        }
      }, 1000);
    };

    // Restore cooldown state if still active from a previous tab visit
    const now = Date.now();
    const cooldownRemaining = Math.ceil((this.reinitCooldownEnd - now) / 1000);
    if (cooldownRemaining > 0) {
      reinitBtn.disabled = true;
      reinitBtn.textContent = `Cooldown (${cooldownRemaining}s)`;
      startCooldownTimer(); // Attach timer to THIS button, replacing the old one
    } else {
      reinitBtn.textContent = 'Reset RainyDesk';
    }

    reinitBtn.addEventListener('click', () => {
      if (reinitBtn.disabled) return;
      this.state.appStatus = 'stopped';
      this.updateFooterStatus();
      window.rainydesk.updateRainscapeParam('physics.resetSimulation', this.state.gridScale);

      // Start 30s cooldown
      this.reinitCooldownEnd = Date.now() + 30000;
      reinitBtn.disabled = true;
      reinitBtn.textContent = 'Cooldown (30s)';
      startCooldownTimer();
    });

    reinitSection.appendChild(reinitBtn);
    container.appendChild(reinitSection);

    // Collapsible system info section
    const sysSection = document.createElement('div');
    sysSection.className = 'section';

    const sysHeader = document.createElement('div');
    sysHeader.className = 'section-title collapsible';
    sysHeader.innerHTML = '<span class="collapse-arrow">&#9654;</span> System Info';
    sysSection.appendChild(sysHeader);

    const sysContent = document.createElement('div');
    sysContent.className = 'debug-sys-info collapsed';
    sysContent.textContent = 'Loading...';
    sysSection.appendChild(sysContent);

    // Toggle collapse
    sysHeader.addEventListener('click', () => {
      const isCollapsed = sysContent.classList.toggle('collapsed');
      const arrow = sysHeader.querySelector('.collapse-arrow');
      if (arrow) arrow.innerHTML = isCollapsed ? '&#9654;' : '&#9660;';
    });

    // Load system info
    this.loadSystemInfo(sysContent);

    container.appendChild(sysSection);

    return container;
  }

  private updateDebugStats(element: HTMLElement): void {
    // Get stats from global window object (updated by main renderer)
    const stats = window._debugStats || this.state.debugStats;
    const frameTime = stats.fps > 0 ? (1000 / stats.fps).toFixed(1) : '0.0';
    // Memory from performance.memory (WebView2/Chromium only)
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
      // Get virtual desktop info from Tauri (includes all monitors)
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
        const scale = mon.scaleFactor !== 1 ? ` @${Math.round(mon.scaleFactor * 100)}%` : '';
        html += `
          <div class="debug-sys-item debug-sys-monitor">
            <span class="debug-sys-label">${label}</span>
            <span class="debug-sys-value">${dims}${scale}</span>
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
    // Update intensity status
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
      // Update text node (the text after the dot)
      let textNode = dot.nextSibling;
      if (textNode && textNode.nodeType === Node.TEXT_NODE) {
        textNode.textContent = ` ${status.text}`;
      } else {
        statusIndicator.appendChild(document.createTextNode(` ${status.text}`));
      }
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

  /** Apply CSS transform only — used by render() to restore scale without moving the window */
  private applyUIScaleCSS(scale: number): void {
    const panel = this.root.querySelector('.rainscaper-panel') as HTMLElement;
    if (panel) {
      panel.style.width = '400px';
      panel.style.height = '500px';
      panel.style.transform = `scale(${scale})`;
      panel.style.transformOrigin = 'top left';
    }
  }

  /** Full UI scale: resize Tauri window + apply CSS transform */
  private applyUIScale(scale: number): void {
    const newWidth = Math.round(400 * scale);
    const newHeight = Math.round(500 * scale);
    window.rainydesk.resizeRainscaper(newWidth, newHeight);
    this.applyUIScaleCSS(scale);
  }

  /** Start rainbow color cycling on the title bar (synced with rain Gay Mode) */
  private startGayModeAnimation(): void {
    if (this.gayModeInterval) return; // Already running

    this.gayModeInterval = setInterval(() => {
      if (!this.titleElement) return;
      if (this.state.transMode) {
        // Trans mode: gradient text matching the flag
        this.titleElement.style.color = 'transparent';
        this.titleElement.style.backgroundImage = 'linear-gradient(90deg, #5BCEFA, #F5A9B8, #FFFFFF, #F5A9B8, #5BCEFA)';
        this.titleElement.style.backgroundClip = 'text';
        (this.titleElement.style as unknown as Record<string, string>)['-webkit-background-clip'] = 'text';
      } else {
        // Rainbow: cycle hue over 60 seconds
        this.titleElement.style.backgroundImage = '';
        this.titleElement.style.backgroundClip = '';
        (this.titleElement.style as unknown as Record<string, string>)['-webkit-background-clip'] = '';
        const hue = ((performance.now() / 60000) % 1.0) * 360;
        this.titleElement.style.color = `hsl(${hue}, 80%, 70%)`;
      }
    }, 50); // Update every 50ms for smooth animation
  }

  /** Stop rainbow color cycling and reset title color */
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
  }

  /** Wrap each character in a span with staggered sine wave animation delay */
  private waveText(text: string): string {
    return text.split('').map((ch, i) => {
      if (ch === ' ') return ' ';
      const delay = (i * 0.08).toFixed(2);
      return `<span class="wave-char" style="animation-delay:${delay}s">${ch}</span>`;
    }).join('');
  }

  /** Update Gaytrix hint visibility (shown when both Gay Mode + Matrix Mode are on) */
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


  /**
   * Update sliders for Matrix Mode (Physics + Audio tabs).
   * - Swap labels between normal/matrix versions
   * - Disable splashSize and puddleDrain (no puddles/splashes in Matrix)
   * - Update toggle labels (Reverse Gravity → Reverse Engineer)
   */
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
    const disabledInMatrix = [
      'wind',          // Matrix uses fixed stream patterns
      'splashSize',    // No water splashes
      'puddleDrain',  // No puddles
      'gridScale',    // Matrix uses own grid, not physics grid
      'impactSound',  // Rain impact sounds (Rain Mode only)
      'windSound',    // Wind ambient (Rain Mode only, Matrix has Drone slider)
    ];
    for (const id of disabledInMatrix) {
      const row = this.root.querySelector(`[data-slider-id="${id}"]`) as HTMLElement;
      if (row) {
        row.classList.toggle('matrix-disabled', isMatrix);
      }
    }

    // Disable wind OSC knob in Matrix Mode
    const windOscKnob = this.root.querySelector('[data-knob-id="windOsc"]') as HTMLElement;
    if (windOscKnob) {
      windOscKnob.style.opacity = isMatrix ? '0.4' : '';
      windOscKnob.style.pointerEvents = isMatrix ? 'none' : '';
    }

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
    versionBtn.textContent = 'v...';

    // Load version from Tauri app config
    if (window.rainydesk?.getVersion) {
      window.rainydesk.getVersion().then((v: string) => {
        versionBtn.textContent = `v${v}-alpha`;
      }).catch(() => {
        versionBtn.textContent = 'v0.7.0-alpha';
      });
    } else {
      versionBtn.textContent = 'v0.7.0-alpha';
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

    // Check for Updates (disabled)
    const updatesItem = document.createElement('button');
    updatesItem.className = 'version-menu-item disabled';
    updatesItem.innerHTML = '<span class="version-menu-icon">&#8635;</span> <span style="flex: 1; text-align: right;">Update <span class="version-menu-sublabel">(soon!)</span></span>';
    menu.appendChild(updatesItem);

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
