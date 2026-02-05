/**
 * RainyDeskPanel - Main panel class
 *
 * Manages the standalone Rainscaper window UI.
 */

import { Slider, Toggle, ColorPicker } from './components';
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
  // Visual
  backgroundShaderEnabled: boolean;
  backgroundIntensity: number;
  backgroundLayers: number;
  rainColor: string;
  gayMode: boolean;
  matrixMode: boolean;
  uiScale: number;
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
      puddleDrain: 0.5,
      turbulence: 0.3,
      dropSize: 4,
      // Audio
      masterVolume: 50,
      rainIntensity: 50,
      ambience: 30,
      bubbleSound: 30,
      thunderEnabled: false,
      windSound: 20,
      // Visual
      backgroundShaderEnabled: true,
      backgroundIntensity: 50,
      backgroundLayers: 3,
      rainColor: '#8aa8c0',
      gayMode: false,
      matrixMode: false,
      uiScale: parseFloat(localStorage.getItem('rainscaper-ui-scale') || '1.0'),
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

    // Build UI
    this.render();

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
    }

  }

  private handleExternalParamUpdate(path: string, value: unknown): void {
    // Update local state when parameters change from other sources
    if (path === 'physics.intensity' && typeof value === 'number') {
      this.state.intensity = value;
    } else if (path === 'physics.wind' && typeof value === 'number') {
      this.state.wind = value;
    }
    // Could trigger a re-render here if needed
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

    this.root.innerHTML = '';

    const panel = document.createElement('div');
    panel.className = 'rainscaper-panel';

    // Header
    panel.appendChild(this.createHeader());

    // Preset bar (dropdown + save)
    panel.appendChild(this.createPresetBar());

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

  private createPresetBar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'preset-bar';

    // Dropdown
    const select = document.createElement('select');
    select.className = 'preset-select';

    if (this.state.presets.length === 0) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '(no presets)';
      placeholder.disabled = true;
      placeholder.selected = true;
      select.appendChild(placeholder);
    } else {
      for (const preset of this.state.presets) {
        const option = document.createElement('option');
        option.value = preset;
        option.textContent = preset;
        if (preset === this.state.currentPreset) {
          option.selected = true;
        }
        select.appendChild(option);
      }
    }

    select.onchange = async () => {
      const presetName = select.value;
      if (!presetName) return;
      const filename = `${presetName}.rain`;
      try {
        const data = await window.rainydesk.readRainscape(filename);
        if (data) {
          this.applyRainscapeData(data);
          this.state.currentPreset = presetName;
          this.render(); // Refresh UI with new values
        }
      } catch (err) {
        window.rainydesk.log(`[RainyDeskPanel] Failed to load preset: ${err}`);
      }
    };

    // Save button
    const saveBtn = document.createElement('button');
    saveBtn.className = 'preset-save-btn';
    saveBtn.textContent = 'Save';
    saveBtn.onclick = async () => {
      // Prompt for name (default to current preset)
      const name = prompt('Save preset as:', this.state.currentPreset || 'MyPreset');
      if (!name) return;

      // Collect current settings
      const data = this.collectCurrentSettings();
      const filename = `Custom/${name}.rain`;

      try {
        await window.rainydesk.saveRainscape(filename, data);
        this.state.currentPreset = `Custom/${name}`;
        // Refresh presets list
        const result = await window.rainydesk.loadRainscapes();
        const rootPresets = (result?.root || []).map((f: string) => f.replace('.rain', ''));
        const customPresets = (result?.custom || []).map((f: string) => `Custom/${f.replace('.rain', '')}`);
        this.state.presets = [...rootPresets, ...customPresets];
        this.render();
      } catch (err) {
        window.rainydesk.log(`[RainyDeskPanel] Failed to save preset: ${err}`);
      }
    };

    bar.appendChild(select);
    bar.appendChild(saveBtn);

    return bar;
  }

  private collectCurrentSettings(): object {
    return {
      rain: {
        intensity: this.state.intensity,
        wind: this.state.wind,
      },
      physics: {
        gravity: this.state.gravity,
        splashSize: this.state.splashSize,
        puddleDrain: this.state.puddleDrain,
        turbulence: this.state.turbulence,
        dropSize: this.state.dropSize,
      },
      audio: {
        masterVolume: this.state.masterVolume,
        rainIntensity: this.state.rainIntensity,
        ambience: this.state.ambience,
        bubbleSound: this.state.bubbleSound,
        thunderEnabled: this.state.thunderEnabled,
        windSound: this.state.windSound,
        muted: this.state.muted,
      },
      visual: {
        backgroundShaderEnabled: this.state.backgroundShaderEnabled,
        backgroundIntensity: this.state.backgroundIntensity,
        backgroundLayers: this.state.backgroundLayers,
        rainColor: this.state.rainColor,
        gayMode: this.state.gayMode,
      },
    };
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

    // Intensity
    container.appendChild(
      Slider({
        label: 'Intensity',
        value: this.state.intensity,
        min: 0,
        max: 100,
        unit: '%',
        onChange: (v) => {
          this.state.intensity = v;
          window.rainydesk.updateRainscapeParam('physics.intensity', v);
          this.updateFooterStatus();
        },
      })
    );

    // Wind
    container.appendChild(
      Slider({
        label: 'Wind',
        value: this.state.wind,
        min: -100,
        max: 100,
        unit: '',
        defaultValue: 0,
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

    // Theme selector section
    const themeSection = document.createElement('div');
    themeSection.className = 'section';

    const themeTitle = document.createElement('div');
    themeTitle.className = 'section-title';
    themeTitle.textContent = 'Theme';
    themeSection.appendChild(themeTitle);

    const themeSelector = document.createElement('div');
    themeSelector.className = 'theme-selector';

    const themeOptions = ['blue', 'purple', 'warm', 'sakura', 'forest', 'midnight', 'lavender', 'gothic', 'ocean', 'ember', 'windows', 'custom'];
    for (const theme of themeOptions) {
      const btn = document.createElement('button');
      btn.className = `theme-button${this.state.theme === theme ? ' active' : ''}`;
      btn.dataset.theme = theme;
      btn.onclick = async () => {
        this.state.theme = theme;
        localStorage.setItem('rainscaper-theme', theme);
        await applyTheme(theme);
        this.render();
      };
      themeSelector.appendChild(btn);
    }

    themeSection.appendChild(themeSelector);
    container.appendChild(themeSection);

    return container;
  }

  private createPhysicsTab(): HTMLElement {
    const container = document.createElement('div');

    // Gravity
    container.appendChild(
      Slider({
        label: 'Gravity',
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

    // Splash size
    container.appendChild(
      Slider({
        label: 'Splash Size',
        value: this.state.splashSize * 100,
        min: 0,
        max: 200,
        unit: '%',
        defaultValue: 100,
        onChange: (v) => {
          this.state.splashSize = v / 100;
          window.rainydesk.updateRainscapeParam('physics.splashScale', v / 100);
        },
      })
    );

    // Puddle drain
    container.appendChild(
      Slider({
        label: 'Puddle Drain',
        value: this.state.puddleDrain * 100,
        min: 0,
        max: 100,
        unit: '%',
        defaultValue: 50,
        onChange: (v) => {
          this.state.puddleDrain = v / 100;
          window.rainydesk.updateRainscapeParam('physics.puddleDrain', v / 100);
        },
      })
    );

    // Turbulence
    container.appendChild(
      Slider({
        label: 'Turbulence',
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

    // Drop mass (max)
    container.appendChild(
      Slider({
        label: 'Max. Drop Mass',
        value: this.state.dropSize,
        min: 1,
        max: 10,
        unit: 'px',
        defaultValue: 4,
        onChange: (v) => {
          this.state.dropSize = v;
          window.rainydesk.updateRainscapeParam('physics.dropMaxSize', v);
        },
      })
    );

    // Reverse gravity toggle
    container.appendChild(
      Toggle({
        label: 'Reverse Gravity',
        checked: this.state.reverseGravity,
        onChange: (v) => {
          this.state.reverseGravity = v;
          window.rainydesk.updateRainscapeParam('physics.reverseGravity', v);
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

    // Update button visibility based on current state
    this.updateResetButtonVisibility();

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

    // Impact sound (formerly "Rain Intensity" - controls raindrop impact volume)
    container.appendChild(
      Slider({
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

    // Bubble/plink sound
    container.appendChild(
      Slider({
        label: 'Bubble/Plink',
        value: this.state.bubbleSound,
        min: 0,
        max: 100,
        unit: '%',
        defaultValue: 30,
        onChange: (v) => {
          this.state.bubbleSound = v;
          window.rainydesk.updateRainscapeParam('audio.bubble.gain', (v / 100 * 24) - 12);
        },
      })
    );

    // Wind sound
    container.appendChild(
      Slider({
        label: 'Wind Sound',
        value: this.state.windSound,
        min: 0,
        max: 100,
        unit: '%',
        defaultValue: 20,
        onChange: (v) => {
          this.state.windSound = v;
          const db = v <= 0 ? -60 : (v / 100 * 48) - 48;
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

    // Rain Color picker
    container.appendChild(
      ColorPicker({
        label: 'Rain Color',
        value: this.state.rainColor,
        defaultValue: '#8aa8c0',
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
          // Update Gaytrix hint visibility
          this.updateGaytrixHint();
        },
      })
    );

    // Gaytrix hint (appears when both Gay Mode + Matrix Mode are enabled)
    const gaytrixHint = document.createElement('div');
    gaytrixHint.className = 'gaytrix-hint';
    gaytrixHint.id = 'gaytrix-hint';
    gaytrixHint.textContent = 'Gaytrix mode activated!';
    gaytrixHint.style.display = (this.state.gayMode && this.state.matrixMode) ? 'block' : 'none';
    container.appendChild(gaytrixHint);

    // Separator before UI Scale
    const separator = document.createElement('hr');
    separator.className = 'panel-separator';
    container.appendChild(separator);

    // UI Scale slider (stepped: 50%, 75%, 100%, 125%, 150%, 175%, 200%)
    const scaleSteps = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
    const foundIndex = scaleSteps.findIndex((s) => Math.abs(s - this.state.uiScale) < 0.01);
    const currentStepIndex = foundIndex >= 0 ? foundIndex : 2; // Default to 100% if not found

    const scaleRow = document.createElement('div');
    scaleRow.className = 'control-row';

    const labelContainer = document.createElement('div');
    labelContainer.className = 'control-label-container';
    const scaleLabel = document.createElement('span');
    scaleLabel.className = 'control-label';
    scaleLabel.textContent = 'UI Scale';
    labelContainer.appendChild(scaleLabel);

    // Reset button for UI Scale (default 100%)
    const scaleResetBtn = document.createElement('button');
    scaleResetBtn.className = 'reset-button';
    scaleResetBtn.title = 'Reset to 100%';
    scaleResetBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
    labelContainer.appendChild(scaleResetBtn);

    const scaleValue = document.createElement('span');
    scaleValue.className = 'control-value';
    scaleValue.textContent = `${Math.round(this.state.uiScale * 100)}%`;

    const scaleSlider = document.createElement('input');
    scaleSlider.type = 'range';
    scaleSlider.className = 'slider';
    scaleSlider.min = '0';
    scaleSlider.max = '6';
    scaleSlider.step = '1';
    scaleSlider.value = String(currentStepIndex);

    // Update display during drag (input event)
    scaleSlider.addEventListener('input', () => {
      const stepIndex = parseInt(scaleSlider.value, 10);
      const scale = scaleSteps[stepIndex] ?? 1.0;
      scaleValue.textContent = `${Math.round(scale * 100)}%`;
    });

    // Apply scale on release (change event)
    scaleSlider.addEventListener('change', () => {
      const stepIndex = parseInt(scaleSlider.value, 10);
      const scale = scaleSteps[stepIndex] ?? 1.0;
      this.state.uiScale = scale;
      localStorage.setItem('rainscaper-ui-scale', String(scale));
      this.applyUIScale(scale);
    });

    // Reset button handler
    scaleResetBtn.onclick = (e) => {
      e.preventDefault();
      scaleSlider.value = '2'; // Index 2 = 100%
      scaleValue.textContent = '100%';
      this.state.uiScale = 1.0;
      localStorage.setItem('rainscaper-ui-scale', '1.0');
      this.applyUIScale(1.0);
    };

    const sliderContainer = document.createElement('div');
    sliderContainer.className = 'slider-container';
    sliderContainer.appendChild(scaleSlider);
    sliderContainer.appendChild(scaleValue);

    scaleRow.appendChild(labelContainer);
    scaleRow.appendChild(sliderContainer);
    container.appendChild(scaleRow);

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

    // System info section
    const sysSection = document.createElement('div');
    sysSection.className = 'section';

    const sysTitle = document.createElement('div');
    sysTitle.className = 'section-title';
    sysTitle.textContent = 'System Info';
    sysSection.appendChild(sysTitle);

    // System info will be populated asynchronously
    const sysInfo = document.createElement('div');
    sysInfo.className = 'debug-sys-info';
    sysInfo.textContent = 'Loading...';
    sysSection.appendChild(sysInfo);

    // Load system info
    this.loadSystemInfo(sysInfo);

    container.appendChild(sysSection);

    return container;
  }

  private updateDebugStats(element: HTMLElement): void {
    // Get stats from global window object (updated by main renderer)
    const stats = window._debugStats || this.state.debugStats;
    element.innerHTML = `
      <div class="debug-stat">
        <span class="debug-stat-label">FPS</span>
        <span class="debug-stat-value">${Math.round(stats.fps)}</span>
      </div>
      <div class="debug-stat">
        <span class="debug-stat-label">Water Cells</span>
        <span class="debug-stat-value">${stats.waterCount}</span>
      </div>
      <div class="debug-stat">
        <span class="debug-stat-label">Active Drops</span>
        <span class="debug-stat-value">${stats.activeDrops}</span>
      </div>
      <div class="debug-stat">
        <span class="debug-stat-label">Puddle Cells</span>
        <span class="debug-stat-value">${stats.puddleCells}</span>
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
          <span class="debug-sys-value">${vd?.width || '?'}x${vd?.height || '?'}</span>
        </div>
        <div class="debug-sys-item">
          <span class="debug-sys-label">Display Count</span>
          <span class="debug-sys-value">${monitors.length}</span>
        </div>
      `;

      // Per-monitor info
      for (let i = 0; i < monitors.length; i++) {
        const mon = monitors[i];
        if (!mon) continue;
        const isPrimary = (mon.index === primaryIndex) ? ' *' : '';
        const dims = `${mon.width}x${mon.height}`;
        const pos = `(${mon.x}, ${mon.y})`;
        html += `
          <div class="debug-sys-item debug-sys-monitor">
            <span class="debug-sys-label">Monitor ${mon.index}${isPrimary}</span>
            <span class="debug-sys-value">${dims} @ ${pos}</span>
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
    if (intensity < 50) return 'Really comin\u2019 down...';
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

    // Update app status indicator
    const statusIndicator = this.root.querySelector('.status-indicator');
    if (statusIndicator) {
      const status = this.getAppStatus();
      statusIndicator.innerHTML = `<span class="status-dot ${status.dot}"></span> ${status.text}`;
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

  private applyUIScale(scale: number): void {
    // Base panel size is 400x500
    const baseWidth = 400;
    const baseHeight = 500;
    const newWidth = Math.round(baseWidth * scale);
    const newHeight = Math.round(baseHeight * scale);

    // Resize the Tauri window
    window.rainydesk.resizeRainscaper(newWidth, newHeight);

    // Scale the panel content (top-left origin matches window growth direction)
    const panel = this.root.querySelector('.rainscaper-panel') as HTMLElement;
    if (panel) {
      // Fix panel to base size so transform works correctly
      panel.style.width = `${baseWidth}px`;
      panel.style.height = `${baseHeight}px`;
      panel.style.transform = `scale(${scale})`;
      panel.style.transformOrigin = 'top left';
    }
  }

  /** Start rainbow color cycling on the title bar (synced with rain Gay Mode) */
  private startGayModeAnimation(): void {
    if (this.gayModeInterval) return; // Already running

    this.gayModeInterval = setInterval(() => {
      if (!this.titleElement) return;
      // Use performance.now() for sync with rain (60-second cycle)
      const hue = ((performance.now() / 60000) % 1.0) * 360;
      this.titleElement.style.color = `hsl(${hue}, 80%, 70%)`;
    }, 50); // Update every 50ms for smooth animation
  }

  /** Stop rainbow color cycling and reset title color */
  private stopGayModeAnimation(): void {
    if (this.gayModeInterval) {
      clearInterval(this.gayModeInterval);
      this.gayModeInterval = null;
    }
    if (this.titleElement) {
      this.titleElement.style.color = ''; // Reset to CSS default
    }
  }

  /** Update Gaytrix hint visibility (shown when both Gay Mode + Matrix Mode are on) */
  private updateGaytrixHint(): void {
    const hint = this.root.querySelector('#gaytrix-hint') as HTMLElement;
    if (hint) {
      hint.style.display = (this.state.gayMode && this.state.matrixMode) ? 'block' : 'none';
    }
  }

  private getAppStatus(): { dot: string; text: string } {
    if (this.state.appStatus === 'stopped') {
      return { dot: 'stopped', text: 'Stopped' };
    }
    if (this.state.appStatus === 'initializing') {
      return { dot: 'initializing', text: 'Initializing' };
    }
    if (this.state.paused || this.state.appStatus === 'paused') {
      return { dot: 'paused', text: 'Paused' };
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

    // Right: Version
    const version = document.createElement('span');
    version.className = 'version-text';
    version.textContent = 'v0.6.0-alpha';

    footer.appendChild(statusIndicator);
    footer.appendChild(intensityStatus);
    footer.appendChild(version);

    return footer;
  }

  private renderIntensityStatus(element: HTMLElement): void {
    const statusText = this.getIntensityStatusText();
    const hasEllipsis = statusText.endsWith('...');
    const isSpecial = statusText === 'Did you feel that?' || statusText === 'Maximum coziness!';

    if (hasEllipsis) {
      // Split off ellipsis for sequential dot animation
      const textPart = statusText.slice(0, -3);
      element.innerHTML = `<span class="intensity-text-main">${textPart}</span><span class="ellipsis-dot" style="animation-delay: 0s">.</span><span class="ellipsis-dot" style="animation-delay: 0.15s">.</span><span class="ellipsis-dot" style="animation-delay: 0.3s">.</span>`;
    } else if (isSpecial) {
      // Wave animation for special states
      element.innerHTML = `<span class="intensity-text-wave">${statusText}</span>`;
    } else {
      element.textContent = statusText;
    }
  }
}
