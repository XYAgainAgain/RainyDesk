/**
 * Rainscaper - Main orchestrator for the Rainscaper UI
 *
 * Coordinates all components, manages rendering, and handles AudioSystem integration.
 */

import { state, RainscaperTab, RainscaperStateData } from './RainscaperState';
import { sync } from './StateSync';
import { Panel } from './components/Panel';
import { Header } from './components/Header';
import { TabBar } from './components/TabBar';
import { StatsDisplay } from './components/StatsDisplay';
import { PresetSelector } from './components/PresetSelector';
import {
  UserPresets,
  EffectsSection,
  PhysicsSection,
  MaterialSection,
  ImpactPoolSection,
  BubblePoolSection,
  SheetLayerSection,
  PhysicsMapperSection,
  SystemSection,
} from './sections';
import type { RainscapeConfig, AudioSystemStats, MaterialConfig, SheetLayerConfig } from '../../types/audio';

declare global {
  interface Window {
    rainydesk: {
      log: (msg: string) => void;
      setIgnoreMouseEvents: (ignore: boolean, options?: { forward: boolean }) => void;
      updateRainscapeParam: (path: string, value: unknown) => void;
      onUpdateRainscapeParam: (callback: (path: string, value: unknown) => void) => void;
      saveRainscape: (name: string, data: unknown) => Promise<void>;
      readRainscape: (name: string) => Promise<unknown>;
      loadRainscapes: () => Promise<string[]>;
      getConfig: () => Promise<{ rainEnabled: boolean; intensity: number; volume: number; wind: number }>;
    };
  }
}

export interface RainscaperConfig {
  physicsSystem?: {
    config: {
      gravity: number;
      terminalVelocity: number;
    };
    scaleFactor?: number;
    setGravity: (g: number) => void;
    setWind: (w: number) => void;
  };
  rendererConfig?: {
    intensity: number;
    wind: number;
    dropMinSize: number;
    dropMaxSize: number;
    renderScale?: number;
  };
  audioSystem?: {
    getStats: () => AudioSystemStats;
    getMaterialManager: () => {
      getMaterial: (id: string) => MaterialConfig;
      getAllMaterials: () => MaterialConfig[];
    };
    getSheetLayer: () => {
      getConfig: () => SheetLayerConfig;
    } | null;
    getVoicePoolSizes: () => { impactPoolSize: number; bubblePoolSize: number };
    getEQ: () => { low: number; mid: number; high: number };
    getReverb: () => { decay: number; wetness: number };
    getMasterVolume: () => number;
    loadRainscape: (config: RainscapeConfig) => void;
    getPhysicsMapper: () => {
      getConfig: () => {
        velocityMin: number;
        velocityMax: number;
        volumeMin: number;
        volumeMax: number;
        minnaertBase: number;
        freqMin: number;
        freqMax: number;
        decayBase: number;
        decayRadiusScale: number;
      };
    };
    getSystemConfig: () => {
      fadeInTime: number;
      fadeOutTime: number;
      enableVoiceStealing: boolean;
      fpsLimit?: number;
    };
    getImpactPool: () => {
      getSynthConfig?: () => {
        noiseType: string;
        attack: number;
        decayMin: number;
        decayMax: number;
        filterFreqMin: number;
        filterFreqMax: number;
        filterQ: number;
      };
    } | null;
    getBubblePool: () => {
      getSynthConfig: () => {
        oscillatorType: string;
        attack: number;
        decayMin: number;
        decayMax: number;
        chirpAmount: number;
        chirpTime: number;
        freqMin: number;
        freqMax: number;
      };
    } | null;
  };
}

export class Rainscaper {
  private _panel: Panel;
  private _header: Header;
  private _tabs: TabBar;
  private _stats: StatsDisplay;
  private _presetSelector: PresetSelector;
  private _config: RainscaperConfig | null = null;
  private _lastState: RainscaperStateData | null = null;

  // Active section reference (for future use)

  // Stats polling
  private _statsInterval: ReturnType<typeof setInterval> | null = null;

  // Fade-out timeout for click-outside-to-close
  private _fadeTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this._panel = new Panel();
    this._header = new Header({
      onClose: () => this.hide(),
      onModeChange: () => this.renderActiveTab(),
    });
    this._tabs = new TabBar({
      onTabChange: () => this.renderActiveTab(),
    });
    this._stats = new StatsDisplay();
    this._presetSelector = new PresetSelector({
      onPresetSelect: (name) => this.loadPreset(name),
      onSave: () => this.savePreset(),
      onImport: () => this.importPreset(),
      onExport: () => this.exportPreset(),
    });

    // Set up sync callback for autosave
    sync.setRainscaperGetter(() => this);
  }

  /** Initialize the Rainscaper UI */
  async init(physicsSystem?: RainscaperConfig['physicsSystem'], config?: RainscaperConfig['rendererConfig']): Promise<void> {
    this._config = {
      physicsSystem,
      rendererConfig: config,
    };

    // Load stylesheet
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'rainscaper/styles/rainscaper.css';
    document.head.appendChild(link);

    // Build UI
    this._panel.create();
    this._panel.setHeader(this._header.create());
    this._panel.setTabs(this._tabs.create());
    this._panel.setPresetBar(this._presetSelector.create());
    this._panel.createContent();
    this._panel.setStatsBar(this._stats.create());

    // Mount to DOM
    this._panel.mount();

    // Click-outside-to-close: fade out over 2 seconds when clicking outside panel
    const panelEl = this._panel.element;
    if (panelEl) {
      document.addEventListener('mousedown', (e) => {
        if (state.data.isVisible && !panelEl.contains(e.target as Node)) {
          // Clicked outside panel - start fade out
          this.fadeOutAndHide();
        }
      });
    }

    // Load presets list
    await this.refreshPresets();

    // Subscribe to state changes
    this._lastState = { ...state.data };
    state.subscribe((newState) => {
      if (this.shouldRender(newState)) {
        this.renderActiveTab();
      }
      this._lastState = { ...newState };
    });

    // Initial render
    this.renderActiveTab();

    window.rainydesk?.log?.('[Rainscaper] Initialized');
  }

  /** Set the AudioSystem reference (called after audio is ready) */
  setAudioSystem(audioSystem: RainscaperConfig['audioSystem']): void {
    if (this._config) {
      this._config.audioSystem = audioSystem;
    } else {
      this._config = { audioSystem };
    }

    // Start stats polling
    this.startStatsPolling();

    // Re-render with audio data
    this.renderActiveTab();
  }

  /** Refresh presets list from filesystem */
  async refreshPresets(): Promise<void> {
    try {
      const files = await window.rainydesk?.loadRainscapes?.() ?? [];
      state.setPresets(files);
    } catch (err) {
      console.error('[Rainscaper] Failed to load presets:', err);
    }
  }

  /** Show the panel */
  show(): void {
    // Cancel any pending fade-out
    if (this._fadeTimeout) {
      clearTimeout(this._fadeTimeout);
      this._fadeTimeout = null;
    }
    // Remove fade class and show
    this._panel.element?.classList.remove('fading-out');
    state.setVisible(true);
    window.rainydesk?.setIgnoreMouseEvents?.(false);
    window.rainydesk?.updateRainscapeParam?.('manualMode', true);
  }

  /** Hide the panel immediately */
  hide(): void {
    if (this._fadeTimeout) {
      clearTimeout(this._fadeTimeout);
      this._fadeTimeout = null;
    }
    this._panel.element?.classList.remove('fading-out');
    state.setVisible(false);
    window.rainydesk?.setIgnoreMouseEvents?.(true);
  }

  /** Fade out over 2 seconds, then hide */
  fadeOutAndHide(): void {
    if (this._fadeTimeout) return; // Already fading
    this._panel.element?.classList.add('fading-out');
    this._fadeTimeout = setTimeout(() => {
      this._fadeTimeout = null;
      this.hide();
    }, 2000);
  }

  /** Toggle panel visibility */
  toggle(): void {
    if (state.data.isVisible) {
      this.hide();
    } else {
      this.show();
      this.refresh();
    }
  }

  /** Refresh UI with current values */
  refresh(): void {
    this.renderActiveTab();
  }

  get isVisible(): boolean {
    return state.data.isVisible;
  }

  private shouldRender(newState: RainscaperStateData): boolean {
    if (!this._lastState) return true;
    if (newState.mode !== this._lastState.mode) return true;
    if (newState.activeTab !== this._lastState.activeTab) return true;
    if (newState.currentMaterialId !== this._lastState.currentMaterialId) return true;
    // Use reference equality for currentRainscape.
    // Loading a new preset creates a new object.
    if (newState.currentRainscape !== this._lastState.currentRainscape) return true;
    return false;
  }

  /** Render the active tab content */
  private renderActiveTab(): void {
    const content = this._panel.content;
    if (!content) return;

    // Clear previous section
    content.innerHTML = '';

    const tab = state.data.activeTab;
    const mode = state.data.mode;

    // Create section based on mode and tab
    let section: HTMLElement | null = null;

    if (mode === 'user') {
      section = this.createUserSection(tab);
    } else {
      section = this.createAdminSection(tab);
    }

    if (section) {
      content.appendChild(section);
    }
  }

  private createUserSection(tab: RainscaperTab): HTMLElement | null {
    switch (tab) {
      case 'presets':
        return new UserPresets({
          onMaterialSelect: (id) => this.handleMaterialSelect(id),
        }).create();

      case 'effects':
        return new EffectsSection(this.getEffectsConfig()).create();

      case 'physics':
        return new PhysicsSection(this.getPhysicsConfig(), {}, false).create();

      default:
        return null;
    }
  }

  private createAdminSection(tab: RainscaperTab): HTMLElement | null {
    switch (tab) {
      case 'material':
        return new MaterialSection(this.getMaterialConfig()).create();

      case 'impact':
        return new ImpactPoolSection(this.getImpactPoolConfig()).create();

      case 'bubble':
        return new BubblePoolSection(this.getBubblePoolConfig()).create();

      case 'sheet':
        return new SheetLayerSection(this.getSheetLayerConfig()).create();

      case 'mapper':
        return new PhysicsMapperSection(this.getPhysicsMapperConfig()).create();

      case 'effects':
        return new EffectsSection(this.getEffectsConfig()).create();

      case 'physics':
        return new PhysicsSection(this.getPhysicsConfig(), {}, true).create();

      case 'system':
        return new SystemSection(this.getSystemConfig()).create();

      default:
        return null;
    }
  }

  // Config getters

  private getEffectsConfig() {
    const audio = this._config?.audioSystem;
    return {
      masterVolume: audio?.getMasterVolume?.() ?? -6,
      eq: audio?.getEQ?.() ?? { low: 0, mid: 0, high: 0 },
      reverb: audio?.getReverb?.() ?? { decay: 2, wetness: 0.3 },
    };
  }

  private getPhysicsConfig() {
    const physics = this._config?.physicsSystem;
    const renderer = this._config?.rendererConfig;
    return {
      intensity: renderer?.intensity ?? 50,
      wind: renderer?.wind ?? 0,
      gravity: physics?.config?.gravity ?? 980,
      dropMinSize: renderer?.dropMinSize ?? 2,
      dropMaxSize: renderer?.dropMaxSize ?? 6,
      terminalVelocity: physics?.config?.terminalVelocity ?? 800,
      renderScale: renderer?.renderScale ?? physics?.scaleFactor ?? 0.25,
      // Background rain shader defaults
      backgroundRainEnabled: true,
      backgroundRainLayers: 3,
      backgroundRainSpeed: 1.0,
    };
  }

  private getMaterialConfig(): MaterialConfig {
    const audio = this._config?.audioSystem;
    const materialId = state.data.currentMaterialId;
    return audio?.getMaterialManager?.().getMaterial(materialId) ?? {
      id: 'default',
      name: 'Default',
      bubbleProbability: 0.4,
      impactSynthType: 'noise',
      bubbleOscillatorType: 'sine',
      filterFreq: 3000,
      filterQ: 1.0,
      decayMin: 0.03,
      decayMax: 0.1,
      pitchMultiplier: 1.0,
      gainOffset: 0,
    };
  }

  private getImpactPoolConfig() {
    const audio = this._config?.audioSystem;
    const synthConfig = audio?.getImpactPool?.()?.getSynthConfig?.();
    return {
      poolSize: audio?.getVoicePoolSizes?.().impactPoolSize ?? 12,
      noiseType: synthConfig?.noiseType ?? 'pink',
      attack: synthConfig?.attack ?? 0.001,
      decayMin: synthConfig?.decayMin ?? 0.03,
      decayMax: synthConfig?.decayMax ?? 0.08,
      filterFreqMin: synthConfig?.filterFreqMin ?? 2000,
      filterFreqMax: synthConfig?.filterFreqMax ?? 8000,
      filterQ: synthConfig?.filterQ ?? 1,
    };
  }

  private getBubblePoolConfig() {
    const audio = this._config?.audioSystem;
    const material = this.getMaterialConfig();
    const synthConfig = audio?.getBubblePool?.()?.getSynthConfig?.();
    return {
      poolSize: audio?.getVoicePoolSizes?.().bubblePoolSize ?? 8,
      oscillatorType: synthConfig?.oscillatorType ?? material.bubbleOscillatorType,
      attack: synthConfig?.attack ?? 0.005,
      decayMin: synthConfig?.decayMin ?? 0.05,
      decayMax: synthConfig?.decayMax ?? 0.15,
      chirpAmount: synthConfig?.chirpAmount ?? 0.1,
      chirpTime: synthConfig?.chirpTime ?? 0.1,
      freqMin: synthConfig?.freqMin ?? 500,
      freqMax: synthConfig?.freqMax ?? 4000,
      probability: material.bubbleProbability,
    };
  }

  private getSheetLayerConfig(): SheetLayerConfig {
    const audio = this._config?.audioSystem;
    return audio?.getSheetLayer?.()?.getConfig?.() ?? {
      noiseType: 'pink',
      filterType: 'lowpass',
      filterFreq: 2000,
      filterQ: 1.0,
      minVolume: -40,
      maxVolume: -12,
      maxParticleCount: 500,
      rampTime: 0.5,
    };
  }

  private getPhysicsMapperConfig() {
    const audio = this._config?.audioSystem;
    const config = audio?.getPhysicsMapper?.()?.getConfig?.();
    return {
      velocityMin: config?.velocityMin ?? 0.5,
      velocityMax: config?.velocityMax ?? 20,
      volumeMin: config?.volumeMin ?? -40,
      volumeMax: config?.volumeMax ?? -6,
      minnaertBase: config?.minnaertBase ?? 3000,
      freqMin: config?.freqMin ?? 200,
      freqMax: config?.freqMax ?? 4000,
      decayBase: config?.decayBase ?? 0.05,
      decayRadiusScale: config?.decayRadiusScale ?? 0.02,
    };
  }

  private getSystemConfig() {
    const audio = this._config?.audioSystem;
    const config = audio?.getSystemConfig?.();
    return {
      fadeInTime: config?.fadeInTime ?? 5,
      fadeOutTime: config?.fadeOutTime ?? 0.5,
      enableVoiceStealing: config?.enableVoiceStealing ?? true,
      fpsLimit: config?.fpsLimit ?? 0,  // 0 = uncapped
      usePixiPhysics: (this._config as any)?.usePixiPhysics ?? true,
    };
  }

  // Event handlers

  private handleMaterialSelect(materialId: string): void {
    window.rainydesk?.log?.(`[Rainscaper] Material selected: ${materialId}`);
    // Material change is handled via StateSync
  }

  private async loadPreset(filename: string): Promise<void> {
    try {
      const data = await window.rainydesk?.readRainscape?.(filename);
      if (data) {
        this.applyPreset(data as Record<string, unknown>);
        window.rainydesk?.log?.(`[Rainscaper] Loaded preset: ${filename}`);
      }
    } catch (err) {
      console.error('[Rainscaper] Failed to load preset:', err);
    }
  }

  private async savePreset(): Promise<void> {
    const name = prompt('Enter rainscape name:');
    if (!name) return;

    try {
      const data = this.gatherPresetData();
      await window.rainydesk?.saveRainscape?.(name + '.json', data);
      await this.refreshPresets();
      state.markClean();
      window.rainydesk?.log?.(`[Rainscaper] Saved preset: ${name}`);
    } catch (err) {
      console.error('[Rainscaper] Failed to save preset:', err);
    }
  }

  private importPreset(): void {
    // Create hidden file input
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const data = JSON.parse(text);
        this.applyPreset(data);
        window.rainydesk?.log?.(`[Rainscaper] Imported preset: ${file.name}`);
      } catch (err) {
        console.error('[Rainscaper] Failed to import preset:', err);
        alert('Failed to import preset. Invalid JSON file.');
      }
    };
    input.click();
  }

  private exportPreset(): void {
    const data = this.gatherPresetData();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = (data.name || 'rainscape') + '.json';
    a.click();

    URL.revokeObjectURL(url);
    window.rainydesk?.log?.('[Rainscaper] Exported preset');
  }

  /** Gather current settings into a preset object (for save/export) */
  gatherPresetData(): Record<string, unknown> {
    const audio = this._config?.audioSystem;
    const physics = this._config?.physicsSystem;
    const renderer = this._config?.rendererConfig;

    return {
      name: state.data.currentRainscape?.name ?? 'Custom Rainscape',
      material: this.getMaterialConfig(),
      sheetLayer: this.getSheetLayerConfig(),
      effects: this.getEffectsConfig(),
      voicePools: audio?.getVoicePoolSizes?.() ?? { impactPoolSize: 12, bubblePoolSize: 8 },
      physics: {
        intensity: renderer?.intensity ?? 50,
        wind: renderer?.wind ?? 0,
        gravity: physics?.config?.gravity ?? 980,
        dropMinSize: renderer?.dropMinSize ?? 2,
        dropMaxSize: renderer?.dropMaxSize ?? 6,
        terminalVelocity: physics?.config?.terminalVelocity ?? 800,
        renderScale: renderer?.renderScale ?? physics?.scaleFactor ?? 0.25,
      },
    };
  }

  /** Apply a preset to all systems */
  applyPreset(data: Record<string, unknown>): void {
    if (!data) return;

    window.rainydesk?.log?.(`[Rainscaper] Applying preset: ${data.name}`);

    const sendParam = (path: string, value: unknown) => {
      if (value !== undefined) {
        window.rainydesk?.updateRainscapeParam?.(path, value);
      }
    };

    // Material
    if (data.material && typeof data.material === 'object') {
      const mat = data.material as Record<string, unknown>;
      sendParam('material.id', mat.id);
      sendParam('material.bubbleProbability', mat.bubbleProbability);
      sendParam('material.filterFreq', mat.filterFreq);
      sendParam('material.filterQ', mat.filterQ);
      sendParam('material.decayMin', mat.decayMin);
      sendParam('material.decayMax', mat.decayMax);
      sendParam('material.pitchMultiplier', mat.pitchMultiplier);
      sendParam('material.gainOffset', mat.gainOffset);
    }

    // Effects
    if (data.effects && typeof data.effects === 'object') {
      const fx = data.effects as Record<string, unknown>;
      sendParam('effects.masterVolume', fx.masterVolume);
      if (fx.eq && typeof fx.eq === 'object') {
        const eq = fx.eq as Record<string, unknown>;
        sendParam('effects.eq.low', eq.low);
        sendParam('effects.eq.mid', eq.mid);
        sendParam('effects.eq.high', eq.high);
      }
      if (fx.reverb && typeof fx.reverb === 'object') {
        const rv = fx.reverb as Record<string, unknown>;
        sendParam('effects.reverb.decay', rv.decay);
        sendParam('effects.reverb.wetness', rv.wetness);
      }
    }

    // Physics
    if (data.physics && typeof data.physics === 'object') {
      const phys = data.physics as Record<string, unknown>;
      sendParam('physics.intensity', phys.intensity);
      sendParam('physics.wind', phys.wind);
      sendParam('physics.gravity', phys.gravity);
      sendParam('physics.dropMinSize', phys.dropMinSize);
      sendParam('physics.dropMaxSize', phys.dropMaxSize);
      sendParam('physics.terminalVelocity', phys.terminalVelocity);
      sendParam('physics.renderScale', phys.renderScale);
    }

    // Sheet Layer (background noise)
    if (data.sheetLayer && typeof data.sheetLayer === 'object') {
      const sheet = data.sheetLayer as Record<string, unknown>;
      sendParam('sheetLayer.noiseType', sheet.noiseType);
      sendParam('sheetLayer.filterType', sheet.filterType);
      sendParam('sheetLayer.filterFreq', sheet.filterFreq);
      sendParam('sheetLayer.filterQ', sheet.filterQ);
      sendParam('sheetLayer.minVolume', sheet.minVolume);
      sendParam('sheetLayer.maxVolume', sheet.maxVolume);
      sendParam('sheetLayer.maxParticleCount', sheet.maxParticleCount);
      sendParam('sheetLayer.rampTime', sheet.rampTime);
    }

    // Update state
    state.markClean();
    setTimeout(() => this.refresh(), 100);
  }

  // Stats polling

  private startStatsPolling(): void {
    if (this._statsInterval) return;

    this._statsInterval = setInterval(() => {
      if (!state.data.isVisible) return;

      const audio = this._config?.audioSystem;
      if (audio?.getStats) {
        const stats = audio.getStats();
        state.setStats(stats);
      }
    }, 500);
  }

  private stopStatsPolling(): void {
    if (this._statsInterval) {
      clearInterval(this._statsInterval);
      this._statsInterval = null;
    }
  }

  dispose(): void {
    this.stopStatsPolling();
    sync.dispose();
    this._panel.dispose();
  }
}
