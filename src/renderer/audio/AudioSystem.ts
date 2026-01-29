/**
 * AudioSystem v2.0 - Main orchestrator for voice-pooled rain audio synthesis
 *
 * Manages voice pools, sheet layer, effects chain, and physics integration.
 * Now includes Wind, Thunder, and Matrix modules with bus routing.
 * Entry point for all audio operations in RainyDesk.
 */

import * as Tone from 'tone';
import { ImpactSynthPool } from './ImpactSynthPool';
import { BubbleSynthPool } from './BubbleSynthPool';
import { SheetLayer } from './SheetLayer';
import { PhysicsMapper } from './PhysicsMapper';
import { MaterialManager } from './MaterialManager';
import { AudioBus } from './AudioBus';
import { WindModule } from './WindModule';
import { ThunderModule } from './ThunderModule';
import { MatrixModule } from './MatrixModule';
import type {
  AudioSystemState,
  AudioSystemStats,
  RainscapeConfig,
  RainscapeConfigV2,
  CollisionEvent,
  EQSettings,
  ReverbSettings,
  VoicePoolSizes,
  WindModuleConfig,
  ThunderModuleConfig,
  MatrixModuleConfig,
  BusConfig,
} from '../../types/audio';

export interface AudioSystemConfig {
  impactPoolSize: number;
  bubblePoolSize: number;
  enableVoiceStealing: boolean;
  masterVolume: number;
  fadeInTime: number;
  fadeOutTime: number;
}

const DEFAULT_CONFIG: AudioSystemConfig = {
  impactPoolSize: 12,
  bubblePoolSize: 8,
  enableVoiceStealing: true,
  masterVolume: -6,
  fadeInTime: 5,
  fadeOutTime: 0.5,
};

export class AudioSystem {
  private _state: AudioSystemState = 'uninitialized';
  private _config: AudioSystemConfig;

  // Voice pools (rain sounds)
  private _impactPool: ImpactSynthPool | null = null;
  private _bubblePool: BubbleSynthPool | null = null;
  private _sheetLayer: SheetLayer | null = null;

  // v2.0 Modules
  private _windModule: WindModule | null = null;
  private _thunderModule: ThunderModule | null = null;
  private _matrixModule: MatrixModule | null = null;

  // v2.0 Bus routing
  private _rainBus: AudioBus | null = null;
  private _windBus: AudioBus | null = null;
  private _thunderBus: AudioBus | null = null;
  private _matrixBus: AudioBus | null = null;

  // Support systems
  private _physicsMapper: PhysicsMapper;
  private _materialManager: MaterialManager;

  // Master effects chain
  private _masterReverb: Tone.Reverb | null = null;
  private _masterDelay: Tone.FeedbackDelay | null = null;
  private _masterLimiter: Tone.Limiter | null = null;
  private _muffleFilter: Tone.Filter | null = null;
  private _muffleGain: Tone.Gain | null = null;
  private _masterGain: Tone.Gain | null = null;

  // Legacy EQ (for backward compatibility)
  private _eq: Tone.EQ3 | null = null;
  private _reverb: Tone.Reverb | null = null;

  // State tracking
  private _isMuted = false;
  private _isMuffled = false;
  private _matrixModeEnabled = false;
  private _currentRainscape: RainscapeConfig | null = null;
  private _currentRainscapeV2: RainscapeConfigV2 | null = null;
  private _collisionCount = 0;
  private _droppedCollisions = 0;
  private _lastStatsTime = 0;

  constructor(config: Partial<AudioSystemConfig> = {}) {
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._physicsMapper = new PhysicsMapper();
    this._materialManager = new MaterialManager();
  }

  get state(): AudioSystemState {
    return this._state;
  }

  /** Initialize audio context and create audio graph. Must be called after user gesture. */
  async init(): Promise<void> {
    if (this._state !== 'uninitialized') return;

    this._state = 'initializing';

    try {
      console.log('[AudioSystem] v2.0 initialization complete');

      this.createMasterChain();
      this.createBuses();
      this.createVoicePools();
      this.createSheetLayer();
      this.createModules();
      this.connectAudioGraph();

      // Start transport for scheduled releases
      Tone.getTransport().start();

      this._state = 'ready';
      console.log('[AudioSystem] v2.0 initialization complete');
    } catch (err) {
      this._state = 'error';
      console.error('[AudioSystem] Initialization failed:', err);
      throw err;
    }
  }

  private createMasterChain(): void {
    // Master send effects
    this._masterReverb = new Tone.Reverb({ decay: 2, wet: 1 });
    this._masterDelay = new Tone.FeedbackDelay({ delayTime: 0.25, feedback: 0.3, wet: 1 });

    // Master output chain
    this._masterLimiter = new Tone.Limiter(-1);

    // Muffle filter: low-pass at 20kHz by default (fully open), drops to 800Hz when muffled
    this._muffleFilter = new Tone.Filter({
      type: 'lowpass',
      frequency: 20000,
      rolloff: -24,
    });

    // Muffle gain: 0 dB by default, drops by 6 dB when muffled
    this._muffleGain = new Tone.Gain(1);

    this._masterGain = new Tone.Gain(Tone.dbToGain(this._config.masterVolume));

    // Legacy EQ for backward compatibility
    this._eq = new Tone.EQ3({ low: 0, mid: 0, high: 0 });
    this._reverb = new Tone.Reverb({ decay: 2, wet: 0.3 });
  }

  private createBuses(): void {
    this._rainBus = new AudioBus('rain', {
      gain: 0,
      reverbSend: 0.3,
      compressorEnabled: true,
      compressorThreshold: -18,
      compressorRatio: 3,
    });

    this._windBus = new AudioBus('wind', {
      gain: -6,
      reverbSend: 0.2,
      compressorEnabled: false,
    });

    this._thunderBus = new AudioBus('thunder', {
      gain: 0,
      reverbSend: 0.4,
      compressorEnabled: false,
    });

    this._matrixBus = new AudioBus('matrix', {
      gain: -12,
      reverbSend: 0.5,
      delaySend: 0.3,
      compressorEnabled: false,
    });
  }

  private createVoicePools(): void {
    const poolConfig = {
      size: this._config.impactPoolSize,
      enableStealing: this._config.enableVoiceStealing,
    };

    this._impactPool = new ImpactSynthPool(poolConfig);
    this._bubblePool = new BubbleSynthPool({
      ...poolConfig,
      size: this._config.bubblePoolSize,
    });
  }

  private createSheetLayer(): void {
    this._sheetLayer = new SheetLayer();
  }

  private createModules(): void {
    this._windModule = new WindModule();
    this._thunderModule = new ThunderModule();
    this._matrixModule = new MatrixModule();
  }

  private connectAudioGraph(): void {
    if (!this._impactPool || !this._bubblePool || !this._sheetLayer) return;
    if (!this._windModule || !this._thunderModule || !this._matrixModule) return;
    if (!this._rainBus || !this._windBus || !this._thunderBus || !this._matrixBus) return;
    if (!this._masterReverb || !this._masterDelay || !this._masterLimiter) return;
    if (!this._muffleFilter || !this._muffleGain || !this._masterGain) return;

    // Connect rain sources to rain bus
    this._impactPool.connect(this._rainBus.input);
    this._bubblePool.connect(this._rainBus.input);
    this._sheetLayer.connect(this._rainBus.input);

    // Connect modules to their buses
    this._windModule.connect(this._windBus.input);
    this._thunderModule.connect(this._thunderBus.input);
    this._matrixModule.connect(this._matrixBus.input);

    // Connect bus outputs to limiter (dry path)
    this._rainBus.connect(this._masterLimiter);
    this._windBus.connect(this._masterLimiter);
    this._thunderBus.connect(this._masterLimiter);
    this._matrixBus.connect(this._masterLimiter);

    // Connect bus sends to master effects
    this._rainBus.connectReverbSend(this._masterReverb);
    this._windBus.connectReverbSend(this._masterReverb);
    this._thunderBus.connectReverbSend(this._masterReverb);
    this._matrixBus.connectReverbSend(this._masterReverb);
    this._matrixBus.connectDelaySend(this._masterDelay);

    // Connect master effects to limiter
    this._masterReverb.connect(this._masterLimiter);
    this._masterDelay.connect(this._masterLimiter);

    // Thunder sidechain: available for ducking other buses during thunder
    // Wind bus dry signal can optionally route through sidechain
    // This is opt-in via config - call getSidechainCompressor() when needed

    // Master output chain
    this._masterLimiter.connect(this._muffleFilter);
    this._muffleFilter.connect(this._muffleGain);
    this._muffleGain.connect(this._masterGain);
    this._masterGain.toDestination();
  }

  /** Start audio playback with optional fade-in. */
  async start(fadeIn = true): Promise<void> {
    if (this._state === 'uninitialized') {
      await this.init();
    }

    if (this._state !== 'ready' && this._state !== 'stopped') return;

    if (fadeIn && this._masterGain) {
      this._masterGain.gain.value = 0;
      this._masterGain.gain.rampTo(
        Tone.dbToGain(this._config.masterVolume),
        this._config.fadeInTime
      );
    }

    // Start all layers
    this._sheetLayer?.start();
    this._windModule?.start();
    if (this._matrixModeEnabled) {
      this._matrixModule?.start();
    }

    this._state = 'playing';
    console.log('[AudioSystem] Playback started');
  }

  /** Stop audio playback with optional fade-out. */
  stop(fadeOut = true): void {
    if (this._state !== 'playing') return;

    if (fadeOut && this._masterGain) {
      this._masterGain.gain.rampTo(0, this._config.fadeOutTime);
      setTimeout(() => {
        this.stopAllLayers();
        this._state = 'stopped';
      }, this._config.fadeOutTime * 1000);
    } else {
      this.stopAllLayers();
      this._state = 'stopped';
    }

    console.log('[AudioSystem] Playback stopped');
  }

  private stopAllLayers(): void {
    this._sheetLayer?.stop();
    this._windModule?.stop();
    this._thunderModule?.stopAuto();
    this._matrixModule?.stop();
  }

  /** Process a collision event from Matter.js. */
  handleCollision(event: CollisionEvent): void {
    if (this._state !== 'playing' || this._isMuted) return;
    if (!this._impactPool || !this._bubblePool) return;

    this._collisionCount++;

    const material = this._materialManager.getMaterial(event.surfaceType);
    const params = this._physicsMapper.mapCollision(event, material);

    // Calculate stereo pan from X position (-1 = left, 0 = center, 1 = right)
    const normalizedX = event.position.x / window.innerWidth;
    params.pan = (normalizedX * 2) - 1;

    // Trigger impact sound (always)
    const impactVoice = this._impactPool.trigger(params);
    if (!impactVoice) this._droppedCollisions++;

    // Trigger bubble sound (probabilistic)
    this._bubblePool.trigger(params);

    // If matrix mode is enabled, also trigger matrix drops
    if (this._matrixModeEnabled && this._matrixModule) {
      const velocity = Math.min(1, event.velocity / 10);
      this._matrixModule.triggerDrop(normalizedX, velocity);
    }
  }

  /** Batch process collision events from Matter.js collisionStart. */
  handleCollisions(events: CollisionEvent[]): void {
    for (const event of events) {
      this.handleCollision(event);
    }
  }

  /** Update particle count for sheet layer modulation. */
  setParticleCount(count: number): void {
    this._sheetLayer?.setParticleCount(count);
  }

  // ============================================================================
  // v2.0 Module Controls
  // ============================================================================

  /**
   * Set wind speed (0-100). Affects wind module intensity.
   */
  setWindSpeed(speed: number): void {
    this._windModule?.setWindSpeed(speed);
  }

  /**
   * Trigger a thunder strike at optional distance (km).
   * If no distance specified, uses random distance within configured range.
   */
  triggerThunder(distance?: number): void {
    this._thunderModule?.triggerStrike(distance);
  }

  /**
   * Start automatic thunder scheduling.
   */
  startAutoThunder(): void {
    this._thunderModule?.startAuto();
  }

  /**
   * Stop automatic thunder scheduling.
   */
  stopAutoThunder(): void {
    this._thunderModule?.stopAuto();
  }

  /**
   * Enable or disable matrix mode (sci-fi rain).
   * When enabled, collisions also trigger matrix drops.
   */
  setMatrixMode(enabled: boolean): void {
    this._matrixModeEnabled = enabled;
    if (enabled && this._state === 'playing') {
      this._matrixModule?.start();
    } else {
      this._matrixModule?.stop();
    }
    console.log(`[AudioSystem] Matrix mode ${enabled ? 'ON' : 'OFF'}`);
  }

  get isMatrixModeEnabled(): boolean {
    return this._matrixModeEnabled;
  }

  /**
   * Trigger a manual wind gust for UI testing.
   */
  triggerGust(intensity?: number): void {
    this._windModule?.triggerGust(intensity);
  }

  /**
   * Trigger a matrix glitch burst for UI testing.
   */
  triggerMatrixGlitch(): void {
    this._matrixModule?.triggerGlitch();
  }

  /**
   * Trigger a single matrix drop for UI testing.
   */
  triggerMatrixDrop(): void {
    this._matrixModule?.triggerDrop(0.5, 0.7);
  }

  // ============================================================================
  // Bus Controls
  // ============================================================================

  setRainBusConfig(config: Partial<BusConfig>): void {
    this._rainBus?.updateConfig(config);
  }

  setWindBusConfig(config: Partial<BusConfig>): void {
    this._windBus?.updateConfig(config);
  }

  setThunderBusConfig(config: Partial<BusConfig>): void {
    this._thunderBus?.updateConfig(config);
  }

  setMatrixBusConfig(config: Partial<BusConfig>): void {
    this._matrixBus?.updateConfig(config);
  }

  // ============================================================================
  // Module Config Updates
  // ============================================================================

  updateWindConfig(config: Partial<WindModuleConfig>): void {
    this._windModule?.updateConfig(config);
  }

  updateThunderConfig(config: Partial<ThunderModuleConfig>): void {
    this._thunderModule?.updateConfig(config);
  }

  updateMatrixConfig(config: Partial<MatrixModuleConfig>): void {
    this._matrixModule?.updateConfig(config);
  }

  // ============================================================================
  // Volume & Mute
  // ============================================================================

  setMasterVolume(db: number): void {
    this._config.masterVolume = db;
    if (this._masterGain && !this._isMuted) {
      this._masterGain.gain.rampTo(Tone.dbToGain(db), 0.1);
    }
  }

  getMasterVolume(): number {
    return this._config.masterVolume;
  }

  setMuted(muted: boolean): void {
    this._isMuted = muted;
    if (this._masterGain) {
      const target = muted ? 0 : Tone.dbToGain(this._config.masterVolume);
      this._masterGain.gain.rampTo(target, 0.1);
    }
  }

  get isMuted(): boolean {
    return this._isMuted;
  }

  /**
   * Set muffled state (for fullscreen detection).
   * When muffled, reduces volume by 6 dB and applies low-pass filter at 800 Hz
   * to simulate rain heard through a layer of insulation.
   */
  setMuffled(muffled: boolean): void {
    if (this._isMuffled === muffled) return;
    this._isMuffled = muffled;

    const rampTime = 0.5;

    if (this._muffleFilter) {
      const targetFreq = muffled ? 800 : 20000;
      this._muffleFilter.frequency.rampTo(targetFreq, rampTime);
    }

    if (this._muffleGain) {
      const targetGain = muffled ? Tone.dbToGain(-6) : 1;
      this._muffleGain.gain.rampTo(targetGain, rampTime);
    }

    console.log(`[AudioSystem] Muffle ${muffled ? 'ON' : 'OFF'}`);
  }

  get isMuffled(): boolean {
    return this._isMuffled;
  }

  // ============================================================================
  // Effects (Legacy API)
  // ============================================================================

  setEQ(settings: Partial<EQSettings>): void {
    if (!this._eq) return;
    if (settings.low !== undefined) this._eq.low.value = settings.low;
    if (settings.mid !== undefined) this._eq.mid.value = settings.mid;
    if (settings.high !== undefined) this._eq.high.value = settings.high;
  }

  getEQ(): EQSettings {
    if (!this._eq) return { low: 0, mid: 0, high: 0 };
    return {
      low: this._eq.low.value,
      mid: this._eq.mid.value,
      high: this._eq.high.value,
    };
  }

  setReverb(settings: Partial<ReverbSettings>): void {
    if (!this._masterReverb) return;
    if (settings.decay !== undefined) this._masterReverb.decay = settings.decay;
    if (settings.wetness !== undefined) {
      // Scale bus sends based on wetness
      this._rainBus?.setReverbSend(settings.wetness);
      this._windBus?.setReverbSend(settings.wetness * 0.7);
    }
  }

  getReverb(): ReverbSettings {
    if (!this._masterReverb) return { decay: 2, wetness: 0.3 };
    return {
      decay: Number(this._masterReverb.decay),
      wetness: this._rainBus?.config.reverbSend ?? 0.3,
    };
  }

  // ============================================================================
  // Rainscape Loading
  // ============================================================================

  /** Load a v1.0 rainscape configuration (backward compatible). */
  loadRainscape(config: RainscapeConfig): void {
    this._currentRainscape = config;

    // Apply material
    this._materialManager.setDefaultMaterial(config.material.id);
    if (!this._materialManager.hasMaterial(config.material.id)) {
      this._materialManager.registerMaterial(config.material);
    }

    // Apply sheet layer config
    this._sheetLayer?.updateConfig(config.sheetLayer);

    // Apply effects
    this.setEQ(config.effects.eq);
    this.setReverb(config.effects.reverb);
    this.setMasterVolume(config.effects.masterVolume);

    // Resize pools if needed
    this.setVoicePoolSizes(config.voicePools);

    console.log(`[AudioSystem] Loaded v1.0 rainscape: ${config.name}`);
  }

  /** Load a v2.0 rainscape configuration with full module support. */
  loadRainscapeV2(config: RainscapeConfigV2): void {
    this._currentRainscapeV2 = config;

    // Master volume
    this.setMasterVolume(config.audio.masterVolume);

    // Sheet layer
    if (config.audio.sheet) {
      this._sheetLayer?.updateConfig(config.audio.sheet);
    }

    // Impact config
    if (config.audio.impact) {
      this._impactPool?.updateConfig({
        noiseType: config.audio.impact.noiseType,
        attack: config.audio.impact.attack,
        decayMin: config.audio.impact.decayMin,
        decayMax: config.audio.impact.decayMax,
        filterFreqMin: config.audio.impact.filterFreqMin,
        filterFreqMax: config.audio.impact.filterFreqMax,
        filterQ: config.audio.impact.filterQ,
      });
    }

    // Bubble config
    if (config.audio.bubble) {
      this._bubblePool?.updateConfig({
        oscillatorType: config.audio.bubble.oscillatorType,
        attack: config.audio.bubble.attack,
        decayMin: config.audio.bubble.decayMin,
        decayMax: config.audio.bubble.decayMax,
        chirpAmount: config.audio.bubble.chirpAmount,
        chirpTime: config.audio.bubble.chirpTime,
        freqMin: config.audio.bubble.freqMin,
        freqMax: config.audio.bubble.freqMax,
      });
    }

    // Wind module
    if (config.audio.wind) {
      this._windModule?.updateConfig(config.audio.wind);
    }

    // Thunder module
    if (config.audio.thunder) {
      this._thunderModule?.updateConfig(config.audio.thunder);
    }

    // Matrix module
    if (config.audio.matrix) {
      this._matrixModule?.updateConfig(config.audio.matrix);
    }

    // Bus routing (SFX config)
    if (config.audio.sfx) {
      if (config.audio.sfx.rainBus) this._rainBus?.updateConfig(config.audio.sfx.rainBus);
      if (config.audio.sfx.windBus) this._windBus?.updateConfig(config.audio.sfx.windBus);
      if (config.audio.sfx.thunderBus) this._thunderBus?.updateConfig(config.audio.sfx.thunderBus);
      if (config.audio.sfx.matrixBus) this._matrixBus?.updateConfig(config.audio.sfx.matrixBus);

      // Master bus settings
      if (config.audio.sfx.masterBus) {
        this.setMasterVolume(config.audio.sfx.masterBus.gain);
        if (this._masterLimiter && config.audio.sfx.masterBus.limiterThreshold !== undefined) {
          this._masterLimiter.threshold.value = config.audio.sfx.masterBus.limiterThreshold;
        }
      }
    }

    console.log(`[AudioSystem] Loaded v2.0 rainscape: ${config.name}`);
  }

  getCurrentRainscape(): RainscapeConfig | null {
    return this._currentRainscape;
  }

  getCurrentRainscapeV2(): RainscapeConfigV2 | null {
    return this._currentRainscapeV2;
  }

  /** Update a single parameter by path (e.g. "effects.reverb.decay"). */
  updateParam(path: string, value: unknown): void {
    const parts = path.split('.');
    const category = parts[0];

    const getPart = (index: number): string | undefined => parts[index];

    const isValidEQKey = (key: string): key is keyof EQSettings =>
      ['low', 'mid', 'high'].includes(key);
    const isValidReverbKey = (key: string): key is keyof ReverbSettings =>
      ['decay', 'wetness'].includes(key);
    const isValidOscillatorType = (v: unknown): v is 'sine' | 'triangle' | 'square' | 'sawtooth' =>
      v === 'sine' || v === 'triangle' || v === 'square' || v === 'sawtooth';
    const isValidNoiseType = (v: unknown): v is 'white' | 'pink' | 'brown' =>
      v === 'white' || v === 'pink' || v === 'brown';

    switch (category) {
      case 'effects': {
        const subKey = getPart(1);
        if (!subKey) break;

        if (subKey === 'masterVolume') {
          this.setMasterVolume(Number(value));
        } else if (subKey === 'eq') {
          const eqKey = getPart(2);
          if (eqKey && isValidEQKey(eqKey)) {
            this.setEQ({ [eqKey]: Number(value) });
          }
        } else if (subKey === 'reverb') {
          const reverbKey = getPart(2);
          if (reverbKey && isValidReverbKey(reverbKey)) {
            this.setReverb({ [reverbKey]: Number(value) });
          }
        }
        break;
      }

      case 'material': {
        const matKey = getPart(1);
        if (!matKey) break;

        if (matKey === 'id') {
          this._materialManager.setDefaultMaterial(String(value));
        } else {
          const currentMat = this._materialManager.getDefaultMaterial();
          this._materialManager.updateMaterial(currentMat.id, { [matKey]: value });
        }
        break;
      }

      case 'sheetLayer': {
        const sheetKey = getPart(1);
        if (sheetKey) {
          this._sheetLayer?.updateConfig({ [sheetKey]: value });
        }
        break;
      }

      case 'bubble': {
        const bubbleKey = getPart(1);
        if (!bubbleKey) break;

        if (bubbleKey === 'probability') {
          const currentMat = this._materialManager.getDefaultMaterial();
          this._materialManager.updateMaterial(currentMat.id, { bubbleProbability: Number(value) });
        } else if (bubbleKey === 'oscillatorType') {
          if (isValidOscillatorType(value)) {
            const currentMat = this._materialManager.getDefaultMaterial();
            this._materialManager.updateMaterial(currentMat.id, { bubbleOscillatorType: value });
            this._bubblePool?.updateConfig({ oscillatorType: value });
          }
        } else {
          this._bubblePool?.updateConfig({ [bubbleKey]: Number(value) });
        }
        break;
      }

      case 'impact': {
        const impactKey = getPart(1);
        if (!impactKey) break;

        if (impactKey === 'noiseType') {
          if (isValidNoiseType(value)) {
            this._impactPool?.updateConfig({ noiseType: value });
          }
        } else {
          this._impactPool?.updateConfig({ [impactKey]: Number(value) });
        }
        break;
      }

      case 'voicePools': {
        const poolKey = getPart(1);
        if (poolKey === 'impactPoolSize' || poolKey === 'bubblePoolSize') {
          this.setVoicePoolSizes({ [poolKey]: Number(value) });
        }
        break;
      }

      case 'physicsMapper': {
        const mapperKey = getPart(1);
        if (mapperKey) {
          this._physicsMapper.updateConfig({ [mapperKey]: Number(value) });
        }
        break;
      }

      case 'system': {
        const sysKey = getPart(1);
        if (!sysKey) break;

        if (sysKey === 'fadeInTime') {
          this._config.fadeInTime = Number(value);
        } else if (sysKey === 'fadeOutTime') {
          this._config.fadeOutTime = Number(value);
        } else if (sysKey === 'enableVoiceStealing') {
          const enabled = Boolean(value);
          this._config.enableVoiceStealing = enabled;
          this._impactPool?.setVoiceStealing(enabled);
          this._bubblePool?.setVoiceStealing(enabled);
        }
        break;
      }

      // v2.0 paths
      case 'wind': {
        const windKey = getPart(1);
        if (windKey === 'masterGain') {
          this._windModule?.setMasterGain(Number(value));
        } else if (windKey) {
          this._windModule?.updateConfig({ [windKey]: value } as Partial<WindModuleConfig>);
        }
        break;
      }

      case 'thunder': {
        const thunderKey = getPart(1);
        if (thunderKey === 'masterGain') {
          this._thunderModule?.setMasterGain(Number(value));
        } else if (thunderKey) {
          this._thunderModule?.updateConfig({ [thunderKey]: value } as Partial<ThunderModuleConfig>);
        }
        break;
      }

      case 'matrix': {
        const matrixKey = getPart(1);
        if (matrixKey === 'masterGain') {
          this._matrixModule?.setMasterGain(Number(value));
        } else if (matrixKey) {
          this._matrixModule?.updateConfig({ [matrixKey]: value } as Partial<MatrixModuleConfig>);
        }
        break;
      }

      default:
        break;
    }
  }

  // ============================================================================
  // Voice Pools
  // ============================================================================

  setVoicePoolSizes(sizes: Partial<VoicePoolSizes>): void {
    if (sizes.impactPoolSize !== undefined && this._impactPool) {
      this._impactPool.resize(sizes.impactPoolSize);
    }
    if (sizes.bubblePoolSize !== undefined && this._bubblePool) {
      this._bubblePool.resize(sizes.bubblePoolSize);
    }
  }

  getVoicePoolSizes(): VoicePoolSizes {
    return {
      impactPoolSize: this._impactPool?.config.size ?? this._config.impactPoolSize,
      bubblePoolSize: this._bubblePool?.config.size ?? this._config.bubblePoolSize,
    };
  }

  // ============================================================================
  // Component Access
  // ============================================================================

  getImpactPool(): ImpactSynthPool | null {
    return this._impactPool;
  }

  getBubblePool(): BubbleSynthPool | null {
    return this._bubblePool;
  }

  getSheetLayer(): SheetLayer | null {
    return this._sheetLayer;
  }

  getMaterialManager(): MaterialManager {
    return this._materialManager;
  }

  getPhysicsMapper(): PhysicsMapper {
    return this._physicsMapper;
  }

  getWindModule(): WindModule | null {
    return this._windModule;
  }

  getThunderModule(): ThunderModule | null {
    return this._thunderModule;
  }

  getMatrixModule(): MatrixModule | null {
    return this._matrixModule;
  }

  getSystemConfig(): {
    fadeInTime: number;
    fadeOutTime: number;
    enableVoiceStealing: boolean;
  } {
    return {
      fadeInTime: this._config.fadeInTime,
      fadeOutTime: this._config.fadeOutTime,
      enableVoiceStealing: this._config.enableVoiceStealing,
    };
  }

  // ============================================================================
  // Stats & Cleanup
  // ============================================================================

  getStats(): AudioSystemStats {
    const now = performance.now();
    const elapsed = (now - this._lastStatsTime) / 1000;
    const collisionsPerSecond = elapsed > 0 ? this._collisionCount / elapsed : 0;

    const stats: AudioSystemStats = {
      state: this._state,
      activeImpactVoices: this._impactPool?.getActiveCount() ?? 0,
      activeBubbleVoices: this._bubblePool?.getActiveCount() ?? 0,
      particleCount: this._sheetLayer?.particleCount ?? 0,
      collisionsPerSecond: Math.round(collisionsPerSecond),
      droppedCollisions: this._droppedCollisions,
    };

    // Reset counters
    this._collisionCount = 0;
    this._lastStatsTime = now;

    return stats;
  }

  /** Get extended stats including v2.0 modules */
  getExtendedStats(): {
    base: AudioSystemStats;
    wind: ReturnType<WindModule['getStats']> | null;
    thunder: ReturnType<ThunderModule['getStats']> | null;
    matrix: ReturnType<MatrixModule['getStats']> | null;
  } {
    return {
      base: this.getStats(),
      wind: this._windModule?.getStats() ?? null,
      thunder: this._thunderModule?.getStats() ?? null,
      matrix: this._matrixModule?.getStats() ?? null,
    };
  }

  dispose(): void {
    this.stop(false);

    // Dispose rain sources
    this._impactPool?.dispose();
    this._bubblePool?.dispose();
    this._sheetLayer?.dispose();

    // Dispose v2.0 modules
    this._windModule?.dispose();
    this._thunderModule?.dispose();
    this._matrixModule?.dispose();

    // Dispose buses
    this._rainBus?.dispose();
    this._windBus?.dispose();
    this._thunderBus?.dispose();
    this._matrixBus?.dispose();

    // Dispose master chain
    this._masterReverb?.dispose();
    this._masterDelay?.dispose();
    this._masterLimiter?.dispose();
    this._eq?.dispose();
    this._reverb?.dispose();
    this._muffleFilter?.dispose();
    this._muffleGain?.dispose();
    this._masterGain?.dispose();

    // Clear references
    this._impactPool = null;
    this._bubblePool = null;
    this._sheetLayer = null;
    this._windModule = null;
    this._thunderModule = null;
    this._matrixModule = null;
    this._rainBus = null;
    this._windBus = null;
    this._thunderBus = null;
    this._matrixBus = null;
    this._masterReverb = null;
    this._masterDelay = null;
    this._masterLimiter = null;
    this._eq = null;
    this._reverb = null;
    this._muffleFilter = null;
    this._muffleGain = null;
    this._masterGain = null;

    this._state = 'uninitialized';
    console.log('[AudioSystem] Disposed');
  }
}
