/**
 * MatrixModule - Digital/sci-fi rain audio synthesis
 *
 * Provides an alternative "Matrix-style" soundscape:
 * - MatrixDropPool: FM synthesis voice pool for digital rain drops
 * - MatrixDrone: Binaural beat background with phaser
 * - MatrixGlitchProcessor: BitCrusher and sample rate reduction
 */

import * as Tone from 'tone';
import type {
  MatrixModuleConfig,
  MatrixDropConfig,
  MatrixDroneConfig,
  MatrixGlitchConfig,
} from '../../types/audio';

// ============================================================================
// Default Configurations
// ============================================================================

const DEFAULT_DROP_CONFIG: MatrixDropConfig = {
  enabled: true,
  carrierFreq: 800,
  modulatorRatio: 2,
  modulationIndex: 5,
  glideTime: 0.15,
  attackTime: 0.005,
  decayTime: 0.2,
  gain: -12,
};

const DEFAULT_DRONE_CONFIG: MatrixDroneConfig = {
  enabled: true,
  baseFreq: 60,
  beatFreq: 4,
  phaserRate: 0.2,
  phaserDepth: 0.5,
  gain: -24,
};

const DEFAULT_GLITCH_CONFIG: MatrixGlitchConfig = {
  enabled: false,
  bitDepth: 8,
  sampleRateReduction: 4,
  probability: 0.1,
  gain: -18,
};

const DEFAULT_MATRIX_CONFIG: MatrixModuleConfig = {
  masterGain: -12,
  drop: DEFAULT_DROP_CONFIG,
  drone: DEFAULT_DRONE_CONFIG,
  glitch: DEFAULT_GLITCH_CONFIG,
};

// ============================================================================
// FM Voice for Matrix Drops
// ============================================================================

interface FMVoice {
  id: number;
  carrier: Tone.Oscillator;
  modulator: Tone.Oscillator;
  modulatorGain: Tone.Gain;
  envelope: Tone.AmplitudeEnvelope;
  output: Tone.Gain;
  busy: boolean;
  releaseTime: number;
}

// ============================================================================
// MatrixDropPool - FM synthesis voice pool
// ============================================================================

class MatrixDropPool {
  private _config: MatrixDropConfig;
  private _voices: FMVoice[] = [];
  private _poolSize = 8;
  private _nextId = 0;
  private _output: Tone.Gain;

  constructor(config: Partial<MatrixDropConfig> = {}, poolSize = 8) {
    this._config = { ...DEFAULT_DROP_CONFIG, ...config };
    this._poolSize = poolSize;
    this._output = new Tone.Gain(this._config.enabled ? Tone.dbToGain(this._config.gain) : 0);
    this.initializePool();
  }

  private initializePool(): void {
    for (let i = 0; i < this._poolSize; i++) {
      this._voices.push(this.createVoice());
    }
  }

  private createVoice(): FMVoice {
    // FM synthesis: modulator -> modulatorGain -> carrier.frequency
    const modulator = new Tone.Oscillator({
      type: 'sine',
      frequency: this._config.carrierFreq * this._config.modulatorRatio,
    });

    const modulatorGain = new Tone.Gain(this._config.modulationIndex * this._config.carrierFreq);

    const carrier = new Tone.Oscillator({
      type: 'sine',
      frequency: this._config.carrierFreq,
    });

    const envelope = new Tone.AmplitudeEnvelope({
      attack: this._config.attackTime,
      decay: this._config.decayTime,
      sustain: 0,
      release: 0.05,
    });

    const output = new Tone.Gain(1);

    // Connect FM chain
    modulator.connect(modulatorGain);
    modulatorGain.connect(carrier.frequency);
    carrier.connect(envelope);
    envelope.connect(output);
    output.connect(this._output);

    modulator.start();
    carrier.start();

    return {
      id: this._nextId++,
      carrier,
      modulator,
      modulatorGain,
      envelope,
      output,
      busy: false,
      releaseTime: 0,
    };
  }

  private acquire(): FMVoice | null {
    const idle = this._voices.find(v => !v.busy);
    if (idle) {
      idle.busy = true;
      return idle;
    }
    // Voice stealing: take the first busy voice
    const stolen = this._voices[0];
    if (stolen) return stolen;
    return null;
  }

  private release(voice: FMVoice): void {
    const poolVoice = this._voices.find(v => v.id === voice.id);
    if (poolVoice) {
      poolVoice.busy = false;
      poolVoice.releaseTime = performance.now();
    }
  }

  /**
   * Trigger a matrix drop sound.
   * @param x Normalized x position (0-1) for pitch variation
   * @param velocity Impact velocity (0-1) for intensity
   */
  triggerDrop(x: number = 0.5, velocity: number = 0.5): void {
    if (!this._config.enabled) return;

    const voice = this.acquire();
    if (!voice) return;

    // Vary pitch based on position (creates spatial effect)
    const pitchOffset = (x - 0.5) * 400;
    const targetFreq = this._config.carrierFreq + pitchOffset;

    // Set initial frequency higher, then glide down
    const startFreq = targetFreq * (1.2 + velocity * 0.3);
    voice.carrier.frequency.setValueAtTime(startFreq, Tone.now());
    voice.carrier.frequency.linearRampToValueAtTime(
      targetFreq * 0.7,
      Tone.now() + this._config.glideTime
    );

    // Update modulator to match
    voice.modulator.frequency.setValueAtTime(
      startFreq * this._config.modulatorRatio,
      Tone.now()
    );
    voice.modulator.frequency.linearRampToValueAtTime(
      targetFreq * 0.7 * this._config.modulatorRatio,
      Tone.now() + this._config.glideTime
    );

    // Scale decay with velocity
    const decay = this._config.decayTime * (0.5 + velocity);
    voice.envelope.decay = decay;

    // Scale modulation index with velocity (more FM = more "digital" sound)
    voice.modulatorGain.gain.value = this._config.modulationIndex * targetFreq * (0.5 + velocity);

    voice.envelope.triggerAttackRelease(this._config.attackTime + decay);

    // Auto-release
    const releaseDelay = this._config.attackTime + decay + 0.1;
    Tone.getTransport().scheduleOnce(() => {
      this.release(voice);
    }, `+${releaseDelay}`);
  }

  setEnabled(enabled: boolean): void {
    this._config.enabled = enabled;
    this._output.gain.rampTo(enabled ? Tone.dbToGain(this._config.gain) : 0, 0.1);
  }

  updateConfig(config: Partial<MatrixDropConfig>): void {
    if (config.enabled !== undefined) this.setEnabled(config.enabled);
    if (config.carrierFreq !== undefined) this._config.carrierFreq = config.carrierFreq;
    if (config.modulatorRatio !== undefined) this._config.modulatorRatio = config.modulatorRatio;
    if (config.modulationIndex !== undefined) this._config.modulationIndex = config.modulationIndex;
    if (config.glideTime !== undefined) this._config.glideTime = config.glideTime;
    if (config.attackTime !== undefined) this._config.attackTime = config.attackTime;
    if (config.decayTime !== undefined) this._config.decayTime = config.decayTime;
    if (config.gain !== undefined) {
      this._config.gain = config.gain;
      if (this._config.enabled) {
        this._output.gain.rampTo(Tone.dbToGain(config.gain), 0.1);
      }
    }
  }

  get output(): Tone.Gain {
    return this._output;
  }

  getActiveCount(): number {
    return this._voices.filter(v => v.busy).length;
  }

  dispose(): void {
    for (const voice of this._voices) {
      voice.carrier.dispose();
      voice.modulator.dispose();
      voice.modulatorGain.dispose();
      voice.envelope.dispose();
      voice.output.dispose();
    }
    this._voices = [];
    this._output.dispose();
  }
}

// ============================================================================
// MatrixDrone - Binaural beat background
// ============================================================================

class MatrixDrone {
  private _config: MatrixDroneConfig;
  private _oscLeft: Tone.Oscillator;
  private _oscRight: Tone.Oscillator;
  private _panLeft: Tone.Panner;
  private _panRight: Tone.Panner;
  private _phaser: Tone.Phaser;
  private _gain: Tone.Gain;
  private _output: Tone.Gain;
  private _isPlaying = false;

  constructor(config: Partial<MatrixDroneConfig> = {}) {
    this._config = { ...DEFAULT_DRONE_CONFIG, ...config };

    // Left ear oscillator
    this._oscLeft = new Tone.Oscillator({
      type: 'sine',
      frequency: this._config.baseFreq,
    });

    // Right ear oscillator (offset by beat frequency for binaural effect)
    this._oscRight = new Tone.Oscillator({
      type: 'sine',
      frequency: this._config.baseFreq + this._config.beatFreq,
    });

    this._panLeft = new Tone.Panner(-1);
    this._panRight = new Tone.Panner(1);

    this._phaser = new Tone.Phaser({
      frequency: this._config.phaserRate,
      octaves: 3,
      baseFrequency: 200,
    });

    this._gain = new Tone.Gain(Tone.dbToGain(this._config.gain));
    this._output = new Tone.Gain(this._config.enabled ? 1 : 0);

    // Connect stereo routing
    this._oscLeft.connect(this._panLeft);
    this._oscRight.connect(this._panRight);
    this._panLeft.connect(this._phaser);
    this._panRight.connect(this._phaser);
    this._phaser.connect(this._gain);
    this._gain.connect(this._output);
  }

  start(): void {
    if (!this._isPlaying) {
      this._oscLeft.start();
      this._oscRight.start();
      this._isPlaying = true;
    }
  }

  stop(): void {
    if (this._isPlaying) {
      this._oscLeft.stop();
      this._oscRight.stop();
      this._isPlaying = false;
    }
  }

  setEnabled(enabled: boolean): void {
    this._config.enabled = enabled;
    this._output.gain.rampTo(enabled ? 1 : 0, 0.5);
  }

  updateConfig(config: Partial<MatrixDroneConfig>): void {
    if (config.enabled !== undefined) this.setEnabled(config.enabled);
    if (config.baseFreq !== undefined) {
      this._config.baseFreq = config.baseFreq;
      this._oscLeft.frequency.rampTo(config.baseFreq, 0.5);
      this._oscRight.frequency.rampTo(config.baseFreq + this._config.beatFreq, 0.5);
    }
    if (config.beatFreq !== undefined) {
      this._config.beatFreq = config.beatFreq;
      this._oscRight.frequency.rampTo(this._config.baseFreq + config.beatFreq, 0.5);
    }
    if (config.phaserRate !== undefined) {
      this._config.phaserRate = config.phaserRate;
      this._phaser.frequency.rampTo(config.phaserRate, 0.5);
    }
    if (config.phaserDepth !== undefined) {
      this._config.phaserDepth = config.phaserDepth;
      this._phaser.octaves = 1 + config.phaserDepth * 4;
    }
    if (config.gain !== undefined) {
      this._config.gain = config.gain;
      this._gain.gain.rampTo(Tone.dbToGain(config.gain), 0.1);
    }
  }

  get output(): Tone.Gain {
    return this._output;
  }

  dispose(): void {
    this.stop();
    this._oscLeft.dispose();
    this._oscRight.dispose();
    this._panLeft.dispose();
    this._panRight.dispose();
    this._phaser.dispose();
    this._gain.dispose();
    this._output.dispose();
  }
}

// ============================================================================
// MatrixGlitchProcessor - BitCrusher and sample rate reduction
// ============================================================================

class MatrixGlitchProcessor {
  private _config: MatrixGlitchConfig;
  private _bitCrusher: Tone.BitCrusher;
  private _noise: Tone.Noise;
  private _noiseEnvelope: Tone.AmplitudeEnvelope;
  private _glitchGain: Tone.Gain;
  private _input: Tone.Gain;
  private _output: Tone.Gain;
  private _scheduleId: number | null = null;
  private _isRunning = false;

  constructor(config: Partial<MatrixGlitchConfig> = {}) {
    this._config = { ...DEFAULT_GLITCH_CONFIG, ...config };

    this._bitCrusher = new Tone.BitCrusher(this._config.bitDepth);

    // Glitch noise burst
    this._noise = new Tone.Noise({ type: 'white', volume: -6 });
    this._noiseEnvelope = new Tone.AmplitudeEnvelope({
      attack: 0.001,
      decay: 0.05,
      sustain: 0,
      release: 0.02,
    });

    this._glitchGain = new Tone.Gain(Tone.dbToGain(this._config.gain));
    this._input = new Tone.Gain(1);
    this._output = new Tone.Gain(this._config.enabled ? 1 : 0);

    // Main signal path (bitcrushed)
    this._input.connect(this._bitCrusher);
    this._bitCrusher.connect(this._output);

    // Glitch noise path
    this._noise.connect(this._noiseEnvelope);
    this._noiseEnvelope.connect(this._glitchGain);
    this._glitchGain.connect(this._output);
  }

  start(): void {
    if (!this._isRunning) {
      this._noise.start();
      this._isRunning = true;
      if (this._config.enabled) {
        this.scheduleGlitch();
      }
    }
  }

  stop(): void {
    if (this._isRunning) {
      this._noise.stop();
      this._isRunning = false;
      if (this._scheduleId !== null) {
        Tone.getTransport().clear(this._scheduleId);
        this._scheduleId = null;
      }
    }
  }

  private scheduleGlitch(): void {
    if (!this._isRunning || !this._config.enabled) return;

    // Random interval based on probability
    const baseInterval = 0.5 / Math.max(0.01, this._config.probability);
    const interval = baseInterval * (0.5 + Math.random());

    this._scheduleId = Tone.getTransport().scheduleOnce(() => {
      this.triggerGlitch();
      this.scheduleGlitch();
    }, `+${interval}`);
  }

  /** Trigger a glitch burst - for manual testing */
  triggerGlitch(): void {
    if (!this._config.enabled) return;

    // BitCrusher.bits is read-only, so just trigger the noise burst for glitch effect
    this._noiseEnvelope.triggerAttackRelease(0.03 + Math.random() * 0.05);
  }

  setEnabled(enabled: boolean): void {
    this._config.enabled = enabled;
    this._output.gain.rampTo(enabled ? 1 : 0, 0.1);
    if (enabled && this._isRunning && this._scheduleId === null) {
      this.scheduleGlitch();
    }
  }

  updateConfig(config: Partial<MatrixGlitchConfig>): void {
    if (config.enabled !== undefined) this.setEnabled(config.enabled);
    if (config.bitDepth !== undefined) {
      this._config.bitDepth = config.bitDepth;
      // BitCrusher.bits is read-only after construction
      // To change, would need to recreate the bitcrusher
    }
    if (config.sampleRateReduction !== undefined) {
      this._config.sampleRateReduction = config.sampleRateReduction;
    }
    if (config.probability !== undefined) this._config.probability = config.probability;
    if (config.gain !== undefined) {
      this._config.gain = config.gain;
      this._glitchGain.gain.rampTo(Tone.dbToGain(config.gain), 0.1);
    }
  }

  get input(): Tone.Gain {
    return this._input;
  }

  get output(): Tone.Gain {
    return this._output;
  }

  dispose(): void {
    this.stop();
    this._bitCrusher.dispose();
    this._noise.dispose();
    this._noiseEnvelope.dispose();
    this._glitchGain.dispose();
    this._input.dispose();
    this._output.dispose();
  }
}

// ============================================================================
// MatrixModule - Main orchestrator
// ============================================================================

export class MatrixModule {
  private _config: MatrixModuleConfig;
  private _dropPool: MatrixDropPool;
  private _drone: MatrixDrone;
  private _glitch: MatrixGlitchProcessor;
  private _masterGain: Tone.Gain;
  private _output: Tone.Gain;
  private _isPlaying = false;
  private _matrixIntensity = 0;

  constructor(config: Partial<MatrixModuleConfig> = {}) {
    this._config = {
      ...DEFAULT_MATRIX_CONFIG,
      ...config,
      drop: { ...DEFAULT_DROP_CONFIG, ...config.drop },
      drone: { ...DEFAULT_DRONE_CONFIG, ...config.drone },
      glitch: { ...DEFAULT_GLITCH_CONFIG, ...config.glitch },
    };

    this._dropPool = new MatrixDropPool(this._config.drop);
    this._drone = new MatrixDrone(this._config.drone);
    this._glitch = new MatrixGlitchProcessor(this._config.glitch);

    this._masterGain = new Tone.Gain(Tone.dbToGain(this._config.masterGain));
    this._output = new Tone.Gain(1);

    // Connect: drops -> glitch processor -> master
    this._dropPool.output.connect(this._glitch.input);
    this._glitch.output.connect(this._masterGain);
    this._drone.output.connect(this._masterGain);
    this._masterGain.connect(this._output);
  }

  start(): void {
    if (!this._isPlaying) {
      this._drone.start();
      this._glitch.start();
      this._isPlaying = true;
    }
  }

  stop(): void {
    if (this._isPlaying) {
      this._drone.stop();
      this._glitch.stop();
      this._isPlaying = false;
    }
  }

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  /**
   * Trigger a single matrix drop.
   * @param x Normalized x position (0-1)
   * @param velocity Impact velocity (0-1)
   */
  triggerDrop(x?: number, velocity?: number): void {
    this._dropPool.triggerDrop(x, velocity);
  }

  /**
   * Set overall matrix intensity (0-1).
   * Affects drone volume and glitch probability.
   */
  setMatrixIntensity(intensity: number): void {
    this._matrixIntensity = Math.max(0, Math.min(1, intensity));

    // Scale drone volume with intensity
    const droneGain = this._config.drone.gain + (this._matrixIntensity - 0.5) * 6;
    this._drone.updateConfig({ gain: droneGain });

    // Scale glitch probability with intensity
    const glitchProb = this._config.glitch.probability * (0.5 + this._matrixIntensity);
    this._glitch.updateConfig({ probability: glitchProb });
  }

  get matrixIntensity(): number {
    return this._matrixIntensity;
  }

  setMasterGain(db: number): void {
    this._config.masterGain = db;
    this._masterGain.gain.rampTo(Tone.dbToGain(db), 0.1);
  }

  /** Trigger a glitch burst - for UI testing */
  triggerGlitch(): void {
    this._glitch.triggerGlitch();
  }

  updateConfig(config: Partial<MatrixModuleConfig>): void {
    if (config.masterGain !== undefined) this.setMasterGain(config.masterGain);
    if (config.drop) this._dropPool.updateConfig(config.drop);
    if (config.drone) this._drone.updateConfig(config.drone);
    if (config.glitch) this._glitch.updateConfig(config.glitch);

    this._config = {
      ...this._config,
      ...config,
      drop: { ...this._config.drop, ...config.drop },
      drone: { ...this._config.drone, ...config.drone },
      glitch: { ...this._config.glitch, ...config.glitch },
    };
  }

  getConfig(): MatrixModuleConfig {
    return { ...this._config };
  }

  connect(destination: Tone.InputNode): this {
    this._output.disconnect();
    this._output.connect(destination);
    return this;
  }

  get output(): Tone.Gain {
    return this._output;
  }

  getStats(): {
    isPlaying: boolean;
    matrixIntensity: number;
    activeDropVoices: number;
    layersEnabled: {
      drop: boolean;
      drone: boolean;
      glitch: boolean;
    };
  } {
    return {
      isPlaying: this._isPlaying,
      matrixIntensity: this._matrixIntensity,
      activeDropVoices: this._dropPool.getActiveCount(),
      layersEnabled: {
        drop: this._config.drop.enabled,
        drone: this._config.drone.enabled,
        glitch: this._config.glitch.enabled,
      },
    };
  }

  dispose(): void {
    this.stop();
    this._dropPool.dispose();
    this._drone.dispose();
    this._glitch.dispose();
    this._masterGain.dispose();
    this._output.dispose();
  }
}
