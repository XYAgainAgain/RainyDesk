/**
 * AudioSystem - Main orchestrator for voice-pooled rain audio synthesis
 *
 * Manages voice pools, sheet layer, effects chain, and physics integration.
 * Entry point for all audio operations in RainyDesk.
 */

import * as Tone from 'tone';
import { ImpactSynthPool } from './ImpactSynthPool';
import { BubbleSynthPool } from './BubbleSynthPool';
import { SheetLayer } from './SheetLayer';
import { PhysicsMapper } from './PhysicsMapper';
import { MaterialManager } from './MaterialManager';
import type {
  AudioSystemState,
  AudioSystemStats,
  RainscapeConfig,
  CollisionEvent,
  EQSettings,
  ReverbSettings,
  VoicePoolSizes,
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

  // Voice pools
  private _impactPool: ImpactSynthPool | null = null;
  private _bubblePool: BubbleSynthPool | null = null;
  private _sheetLayer: SheetLayer | null = null;

  // Support systems
  private _physicsMapper: PhysicsMapper;
  private _materialManager: MaterialManager;

  // Effects chain
  private _eq: Tone.EQ3 | null = null;
  private _reverb: Tone.Reverb | null = null;
  private _masterGain: Tone.Gain | null = null;

  // State tracking
  private _isMuted = false;
  private _currentRainscape: RainscapeConfig | null = null;
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
      await Tone.start();
      console.log('[AudioSystem] Tone.js context started');

      this.createEffectsChain();
      this.createVoicePools();
      this.createSheetLayer();
      this.connectAudioGraph();

      // Start transport for scheduled releases
      Tone.getTransport().start();

      this._state = 'ready';
      console.log('[AudioSystem] Initialization complete');
    } catch (err) {
      this._state = 'error';
      console.error('[AudioSystem] Initialization failed:', err);
      throw err;
    }
  }

  private createEffectsChain(): void {
    this._eq = new Tone.EQ3({ low: 0, mid: 0, high: 0 });
    this._reverb = new Tone.Reverb({ decay: 2, wet: 0.3 });
    this._masterGain = new Tone.Gain(Tone.dbToGain(this._config.masterVolume));
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

  private connectAudioGraph(): void {
    if (!this._impactPool || !this._bubblePool || !this._sheetLayer) return;
    if (!this._eq || !this._reverb || !this._masterGain) return;

    // Pools → EQ → Reverb → Master → Destination
    this._impactPool.connect(this._eq);
    this._bubblePool.connect(this._eq);
    this._sheetLayer.connect(this._eq);

    this._eq.connect(this._reverb);
    this._reverb.connect(this._masterGain);
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

    this._sheetLayer?.start();
    this._state = 'playing';
    console.log('[AudioSystem] Playback started');
  }

  /** Stop audio playback with optional fade-out. */
  stop(fadeOut = true): void {
    if (this._state !== 'playing') return;

    if (fadeOut && this._masterGain) {
      this._masterGain.gain.rampTo(0, this._config.fadeOutTime);
      setTimeout(() => {
        this._sheetLayer?.stop();
        this._state = 'stopped';
      }, this._config.fadeOutTime * 1000);
    } else {
      this._sheetLayer?.stop();
      this._state = 'stopped';
    }

    console.log('[AudioSystem] Playback stopped');
  }

  /** Process a collision event from Matter.js. */
  handleCollision(event: CollisionEvent): void {
    if (this._state !== 'playing' || this._isMuted) return;
    if (!this._impactPool || !this._bubblePool) return;

    this._collisionCount++;

    const material = this._materialManager.getMaterial(event.surfaceType);
    const params = this._physicsMapper.mapCollision(event, material);

    // Trigger impact sound (always)
    const impactVoice = this._impactPool.trigger(params);
    if (!impactVoice) this._droppedCollisions++;

    // Trigger bubble sound (probabilistic)
    this._bubblePool.trigger(params);
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

  // Volume & Mute

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

  // Effects

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
    if (!this._reverb) return;
    if (settings.decay !== undefined) this._reverb.decay = settings.decay;
    if (settings.wetness !== undefined) this._reverb.wet.value = settings.wetness;
  }

  getReverb(): ReverbSettings {
    if (!this._reverb) return { decay: 2, wetness: 0.3 };
    return {
      decay: Number(this._reverb.decay),
      wetness: this._reverb.wet.value,
    };
  }

  // Rainscape

  /** Load a complete rainscape configuration. */
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

    console.log(`[AudioSystem] Loaded rainscape: ${config.name}`);
  }

  getCurrentRainscape(): RainscapeConfig | null {
    return this._currentRainscape;
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

  dispose(): void {
    this.stop(false);

    this._impactPool?.dispose();
    this._bubblePool?.dispose();
    this._sheetLayer?.dispose();
    this._eq?.dispose();
    this._reverb?.dispose();
    this._masterGain?.dispose();

    this._impactPool = null;
    this._bubblePool = null;
    this._sheetLayer = null;
    this._eq = null;
    this._reverb = null;
    this._masterGain = null;

    this._state = 'uninitialized';
    console.log('[AudioSystem] Disposed');
  }
}
