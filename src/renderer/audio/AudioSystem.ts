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
import { TextureLayer } from './TextureLayer';
import type {
  AudioSystemState,
  AudioSystemStats,
  AudioChannelTier,
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
  SpatialConfig,
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
  private _textureLayer: TextureLayer | null = null;

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

  // 3D spatial audio
  private _spatialConfig: SpatialConfig = {
    enabled: false,
    panningModel: 'equalpower', // Cheap default; switches to HRTF when spatial enabled
    worldScale: 5,
    fixedDepth: -2,
  };

  // Audio channel tier (performance scaling)
  private _audioTier: AudioChannelTier = 3;

  // State tracking
  private _isMuted = false;
  private _isMuffled = false;
  private _fadeInActive = false; // Guard: prevents setMasterVolume/setMuted from cancelling startup fade
  private _stopTimer: ReturnType<typeof setTimeout> | null = null;
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
      // Resume AudioContext FIRST — prevents "suspended" warnings from every new Tone node
      await Tone.start();

      this.createMasterChain();
      this.createBuses();
      this.createVoicePools();
      this.createSheetLayer();
      this.createModules();
      await this.initWorklets();
      this.connectAudioGraph();
      await this._thunderModule?.init();

      // Configure 3D listener at origin, facing -Z
      Tone.Listener.positionX.value = 0;
      Tone.Listener.positionY.value = 0;
      Tone.Listener.positionZ.value = 0;
      Tone.Listener.forwardX.value = 0;
      Tone.Listener.forwardY.value = 0;
      Tone.Listener.forwardZ.value = -1;
      Tone.Listener.upX.value = 0;
      Tone.Listener.upY.value = 1;
      Tone.Listener.upZ.value = 0;

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
      gain: 0,
      reverbSend: 0.2,
      compressorEnabled: false,
    });

    this._thunderBus = new AudioBus('thunder', {
      gain: 0,
      reverbSend: 0.1,
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
    this._thunderModule.setDuckCallback((amount, attackSec, releaseSec) => {
      this._rainBus?.duck(amount, attackSec, releaseSec);
      this._windBus?.duck(amount * 0.5, attackSec, releaseSec);
    });
    this._matrixModule = new MatrixModule();
    this._textureLayer = new TextureLayer();
  }

  private async initWorklets(): Promise<void> {
    try {
      // Path is relative to the document root, not the bundle location
      // (esbuild flattens audio/AudioSystem.ts → audio.bundle.js at root)
      await Tone.getContext().rawContext.audioWorklet.addModule('./audio/worklets/SampleAndHoldProcessor.js');
      this._thunderModule?.setWorkletReady();
      console.warn('[AudioSystem] AudioWorklet processors registered');
    } catch (err) {
      // Rumbler gracefully degrades (skipped) if worklet unavailable
      console.warn('[AudioSystem] Worklet registration failed, Rumbler disabled:', err);
    }
  }

  private connectAudioGraph(): void {
    if (!this._impactPool || !this._bubblePool || !this._sheetLayer) return;
    if (!this._windModule || !this._thunderModule || !this._matrixModule || !this._textureLayer) return;
    if (!this._rainBus || !this._windBus || !this._thunderBus || !this._matrixBus) return;
    if (!this._masterReverb || !this._masterDelay || !this._masterLimiter) return;
    if (!this._muffleFilter || !this._muffleGain || !this._masterGain) return;

    // Connect rain sources to rain bus
    this._impactPool.connect(this._rainBus.input);
    this._bubblePool.connect(this._rainBus.input);
    // SheetLayer and TextureLayer bypass the rain bus (own volume controls, continuous audio)
    this._sheetLayer.connect(this._masterLimiter);
    // Limiter.input → Compressor, Compressor.input → raw DynamicsCompressorNode
    this._textureLayer.output.connect((this._masterLimiter as any).input.input);

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

  /**
   * Start audio playback with optional fade-in.
   * @param fadeIn Whether to fade in (true) or start at full volume (false)
   * @param resumeFade If true, use a short 0.5s fade instead of full startup fade (for pause/resume)
   */
  async start(fadeIn = true, resumeFade = false): Promise<void> {
    if (this._state === 'uninitialized') {
      await this.init();
    }

    if (this._state !== 'ready' && this._state !== 'stopped') return;

    // Cancel any pending deferred stopAllLayers from a previous stop() fade-out
    if (this._stopTimer) {
      clearTimeout(this._stopTimer);
      this._stopTimer = null;
    }

    if (fadeIn && this._masterGain) {
      const fadeTime = resumeFade ? 0.5 : this._config.fadeInTime;
      this._masterGain.gain.value = 0;
      this._masterGain.gain.rampTo(
        Tone.dbToGain(this._config.masterVolume),
        fadeTime
      );
      // Guard: block setMasterVolume/setMuted from cancelling this ramp
      // Only use full guard for startup fade, not resume
      if (!resumeFade) {
        this._fadeInActive = true;
        setTimeout(() => {
          this._fadeInActive = false;
        }, fadeTime * 1000);
      }
    }

    // Start layers based on current mode — zero bleed between modes
    if (this._matrixModeEnabled) {
      this._matrixModule?.start();
      // Explicitly stop rain-mode layers (belt AND suspenders)
      this._windModule?.stop();
      this._sheetLayer?.stop();
    } else {
      this._sheetLayer?.start();
      // Wind requires tier 2+
      if (this._audioTier >= 2) this._windModule?.start();
      else this._windModule?.stop();
      // Explicitly stop matrix-mode layers
      this._matrixModule?.stop();
    }

    this._state = 'playing';
    console.log('[AudioSystem] Playback started');
  }

  /** Stop audio playback with optional fade-out. */
  stop(fadeOut = true): void {
    if (this._state !== 'playing') return;

    // Set state immediately so start() can be called during fade-out
    this._state = 'stopped';

    if (fadeOut && this._masterGain) {
      this._masterGain.gain.rampTo(0, this._config.fadeOutTime);
      this._stopTimer = setTimeout(() => {
        this._stopTimer = null;
        this.stopAllLayers();
      }, this._config.fadeOutTime * 1000);
    } else {
      this.stopAllLayers();
    }

    console.log('[AudioSystem] Playback stopped');
  }

  private stopAllLayers(): void {
    this._sheetLayer?.stop();
    this._windModule?.stop();
    this._thunderModule?.stopAuto();
    this._matrixModule?.stop();
    this._textureLayer?.setEnabled(false);
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
    params.pan = Math.max(-1, Math.min(1, (normalizedX * 2) - 1));

    // Compute 3D position when spatial mode is on
    if (this._spatialConfig.enabled) {
      params.position3d = this.pixelToAudio(event.position.x, event.position.y);
    }

    // Trigger impact sound (always)
    const impactVoice = this._impactPool.trigger(params);
    if (!impactVoice) this._droppedCollisions++;

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

  // v2.0 Module Controls

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

  triggerThunderStrike(): void {
    this._thunderModule?.triggerStrike().catch(err =>
      console.warn('[AudioSystem] Thunder test strike failed:', err)
    );
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

  // Audio Channel Tiers

  /**
   * Set audio processing tier for CPU scaling.
   * Tier 1 (Lite): 4 impact voices, sheet + texture
   * Tier 2 (Standard): 8 impact voices, sheet + texture + wind
   * Tier 3 (Full): 12 impact voices, all modules including thunder
   */
  setAudioTier(tier: AudioChannelTier): void {
    this._audioTier = tier;

    // Resize impact pool
    const impactSizes: Record<AudioChannelTier, number> = { 1: 4, 2: 8, 3: 12 };
    this._impactPool?.resize(impactSizes[tier]);

    // Wind module: off for Lite, on for Standard+Full
    if (this._windModule) {
      if (tier === 1) {
        this._windModule.stop();
      } else if (this._state === 'playing' && !this._matrixModeEnabled) {
        this._windModule.start();
      }
    }

    // Thunder: only Full tier
    if (tier < 3) {
      this._thunderModule?.stopAuto();
    } else if (this._thunderModule && this._state === 'playing' && !this._matrixModeEnabled) {
      // Re-enable thunder if storminess > 0 and we just upgraded to Full
      if (this._thunderModule.getConfig().storminess > 0) this._thunderModule.startAuto();
    }

    // Texture layer: available on all tiers (CPU-light, fills sonic gap on Lite)

    console.log(`[AudioSystem] Audio tier set to ${tier} (${['', 'Lite', 'Standard', 'Full'][tier]})`);
  }

  getAudioTier(): AudioChannelTier {
    return this._audioTier;
  }

  // Bus Controls

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

  // Module Config Updates

  updateWindConfig(config: Partial<WindModuleConfig>): void {
    this._windModule?.updateConfig(config);
  }

  updateThunderConfig(config: Partial<ThunderModuleConfig>): void {
    this._thunderModule?.updateConfig(config);
  }

  updateMatrixConfig(config: Partial<MatrixModuleConfig>): void {
    this._matrixModule?.updateConfig(config);
  }

  // Volume & Mute

  setMasterVolume(db: number): void {
    this._config.masterVolume = db;
    // Don't interrupt startup fade-in ramp
    if (this._fadeInActive) return;
    if (this._masterGain && !this._isMuted) {
      this._masterGain.gain.rampTo(Tone.dbToGain(db), 0.1);
    }
  }

  /** Set impact pitch center (0-100: 0 = fat splats, 100 = thin ticks) */
  setImpactPitch(value: number): void {
    this._impactPool?.setPitchCenter(value);
  }

  /** Set impact pitch OSC amount (0-100: per-drop random spread) */
  setImpactPitchOsc(value: number): void {
    this._impactPool?.setPitchOscAmount(value);
  }

  /**
   * Set combined rain audio intensity (sheet + impacts + bubbles).
   * @param intensity 0-100 percentage
   */
  setRainMix(intensity: number): void {
    const scale = Math.max(0, Math.min(1, intensity / 100));
    // Scale the rain bus gain
    if (this._rainBus) {
      // Convert scale to dB: 0 = -60dB (muted), 1 = 0dB (full)
      const db = scale <= 0 ? -60 : (scale * 12) - 12; // -12dB at 0%, 0dB at 100%
      this._rainBus.updateConfig({ gain: db });
    }
  }

  getMasterVolume(): number {
    return this._config.masterVolume;
  }

  setMuted(muted: boolean): void {
    this._isMuted = muted;
    // Don't interrupt startup fade-in ramp (except for explicit muting)
    if (this._fadeInActive && !muted) return;
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
   * When muffled, applies gentle high-frequency rolloff to simulate rain
   * heard through a layer of insulation without killing the audio.
   * @deprecated Use setMuffleAmount() for spatial muffling
   */
  setMuffled(muffled: boolean): void {
    // Convert boolean to amount (0 = off, 1 = full muffle)
    this.setMuffleAmount(muffled ? 1.0 : 0.0);
  }

  /**
   * Set spatial muffle amount based on fullscreen coverage.
   * @param amount 0.0 = no muffling, 1.0 = full muffling (still gentle)
   *
   * Muffling is designed to be subtle:
   * - Cutoff: 20kHz → 3kHz (gentle high-freq rolloff, not 800Hz which kills audio)
   * - Gain: 0dB → -3dB (slight reduction, not -6dB which nearly mutes)
   */
  setMuffleAmount(amount: number): void {
    const clampedAmount = Math.max(0, Math.min(1, amount));
    const wasFullyOff = this._isMuffled === false && clampedAmount === 0;
    const isFullyOff = clampedAmount === 0;

    this._isMuffled = clampedAmount > 0;

    if (this._muffleFilter) {
      // Interpolate: 20kHz (open) → 3kHz (muffled) — gentler than 800Hz
      const targetFreq = 20000 - (17000 * clampedAmount);
      const currentFreq = this._muffleFilter.frequency.value as number;
      // Asymmetric ramps: slow duck (1.5s) feels less jarring, snappy recovery (0.5s)
      const freqRamp = targetFreq < currentFreq ? 1.5 : 0.5;
      this._muffleFilter.frequency.rampTo(targetFreq, freqRamp);
    }

    if (this._muffleGain) {
      // Interpolate: 0dB → -3dB — gentler than -6dB
      const targetGain = Tone.dbToGain(-3 * clampedAmount);
      const currentGain = this._muffleGain.gain.value;
      const gainRamp = targetGain < currentGain ? 1.5 : 0.5;
      this._muffleGain.gain.rampTo(targetGain, gainRamp);
    }

    // Only log state changes, not every adjustment
    if (wasFullyOff !== isFullyOff) {
      console.log(`[AudioSystem] Muffle ${isFullyOff ? 'OFF' : `ON (${Math.round(clampedAmount * 100)}%)`}`);
    }
  }

  get isMuffled(): boolean {
    return this._isMuffled;
  }

  // 3D Spatial Audio

  /** Toggle 3D spatial audio on/off. Propagates panning model to all modules. */
  setSpatialMode(enabled: boolean): void {
    this._spatialConfig.enabled = enabled;
    if (enabled) {
      this._spatialConfig.panningModel = 'HRTF';
    }

    // Propagate enabled, panningModel, and worldScale — but NOT fixedDepth,
    // because modules like WindModule have their own intentional depth values
    const shared: Partial<SpatialConfig> = {
      enabled,
      panningModel: enabled ? 'HRTF' : 'equalpower',
      worldScale: this._spatialConfig.worldScale,
    };

    this._impactPool?.setSpatialConfig(shared);
    this._bubblePool?.setSpatialConfig(shared);
    this._windModule?.setSpatialConfig(shared);
    this._thunderModule?.setSpatialConfig(shared);
    this._sheetLayer?.setSpatialConfig(shared);

    console.log(`[AudioSystem] Spatial audio ${enabled ? 'ON (HRTF)' : 'OFF'}`);
  }

  setSpatialConfig(config: Partial<SpatialConfig>): void {
    Object.assign(this._spatialConfig, config);
    // Re-propagate full config to all modules
    this.setSpatialMode(this._spatialConfig.enabled);
  }

  get isSpatialEnabled(): boolean {
    return this._spatialConfig.enabled;
  }

  /** Map pixel coordinates to 3D audio space. Uses live window dimensions (mega window = virtual desktop). */
  pixelToAudio(pixelX: number, pixelY: number): { x: number; y: number; z: number } {
    const ws = this._spatialConfig.worldScale;
    // Use live window size — mega window spans the full virtual desktop
    const w = window.innerWidth || 1920;
    const h = window.innerHeight || 1080;
    const halfW = w / 2;
    const halfH = h / 2;

    return {
      x: ((pixelX - halfW) / halfW) * ws,
      y: -((pixelY - halfH) / halfH) * ws, // Inverted: screen Y down, audio Y up
      z: this._spatialConfig.fixedDepth,
    };
  }

  // Effects (Legacy API)

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

  // Rainscape Loading

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

    // Texture layer
    if (config.audio.texture && this._textureLayer) {
      const tex = config.audio.texture;
      if (tex.surface !== undefined) this._textureLayer.setSurface(tex.surface);
      if (tex.volume !== undefined) this._textureLayer.setVolume(tex.volume);
      if (tex.intensity !== undefined) this._textureLayer.setIntensity(tex.intensity);
      if (tex.intensityLinked !== undefined) this._textureLayer.setIntensityLinked(tex.intensityLinked);
      if (tex.enabled !== undefined) this._textureLayer.setEnabled(tex.enabled);
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
        } else if (sysKey === 'audioChannels') {
          this.setAudioTier(Number(value) as AudioChannelTier);
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
        if (thunderKey === 'storminess') {
          const storm = Number(value);
          this._thunderModule?.setStorminess(storm);
          // Only auto-schedule thunder on Full tier
          if (storm > 0 && this._audioTier >= 3) this._thunderModule?.startAuto();
          else this._thunderModule?.stopAuto();
        } else if (thunderKey === 'distance') {
          this._thunderModule?.setDistance(Number(value));
        } else if (thunderKey === 'environment') {
          this._thunderModule?.setEnvironment(String(value));
        } else if (thunderKey === 'masterGain') {
          this._thunderModule?.setMasterGain(Number(value));
        } else if (thunderKey === 'enabled') {
          // Backward compat: boolean → storminess
          const s = value ? 30 : 0;
          this._thunderModule?.setStorminess(s);
          if (s > 0 && this._audioTier >= 3) this._thunderModule?.startAuto();
          else this._thunderModule?.stopAuto();
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

      case 'texture': {
        const textureKey = getPart(1);
        if (!textureKey || !this._textureLayer) break;

        if (textureKey === 'enabled') {
          this._textureLayer.setEnabled(Boolean(value)).catch(err =>
            console.warn('[AudioSystem] TextureLayer enable failed:', err)
          );
        } else if (textureKey === 'volume') {
          this._textureLayer.setVolume(Number(value));
        } else if (textureKey === 'intensity') {
          this._textureLayer.setIntensity(Number(value));
        } else if (textureKey === 'intensityLinked') {
          this._textureLayer.setIntensityLinked(Boolean(value));
        } else if (textureKey === 'surface') {
          this._textureLayer.setSurface(String(value));
        }
        break;
      }

      case 'spatial': {
        const spatialKey = getPart(1);
        if (!spatialKey) break;

        if (spatialKey === 'enabled') {
          this.setSpatialMode(Boolean(value));
        } else if (spatialKey === 'panningModel') {
          const model = value === 'equalpower' ? 'equalpower' : 'HRTF';
          this.setSpatialConfig({ panningModel: model });
        } else if (spatialKey === 'worldScale') {
          this.setSpatialConfig({ worldScale: Number(value) });
        }
        break;
      }

      default:
        break;
    }
  }

  // Voice Pools

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

  // Component Access

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

  getTextureLayer(): TextureLayer | null {
    return this._textureLayer;
  }

  /** Get the entry point of the master chain (limiter) for external audio routing */
  getMasterInput(): Tone.ToneAudioNode | null {
    return this._masterLimiter;
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

  // Stats & Cleanup

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
    this._textureLayer?.dispose();

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
    this._textureLayer = null;
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
