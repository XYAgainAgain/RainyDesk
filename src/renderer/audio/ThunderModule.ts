/**
 * ThunderModule - Realistic thunder synthesis with layered components
 *
 * Thunder is synthesized from four components that arrive at different times
 * based on distance (speed of sound ~343 m/s):
 * - TearingLayer: Initial high-frequency crack/tear (arrives first)
 * - CrackLayer: N-wave pressure spike (sharp attack)
 * - BodyLayer: Main rumble body (filtered noise + reverb)
 * - RumbleLayer: Sub-bass tail (long decay)
 *
 * Also includes sidechain compressor for ducking rain/wind during strikes.
 */

import * as Tone from 'tone';
import type {
  ThunderModuleConfig,
  ThunderTearingConfig,
  ThunderCrackConfig,
  ThunderBodyConfig,
  ThunderRumbleConfig,
  SpatialConfig,
} from '../../types/audio';

// Default Configurations

const DEFAULT_TEARING_CONFIG: ThunderTearingConfig = {
  enabled: true,
  noiseType: 'white',
  hpfFreq: 4000,
  attackTime: 0.005,
  decayTime: 0.15,
  gain: -12,
};

const DEFAULT_CRACK_CONFIG: ThunderCrackConfig = {
  enabled: true,
  frequency: 80,
  harmonics: 6,
  attackTime: 0.002,
  decayTime: 0.3,
  gain: -6,
};

const DEFAULT_BODY_CONFIG: ThunderBodyConfig = {
  enabled: true,
  noiseType: 'brown',
  lpfFreq: 400,
  reverbDecay: 4,
  gain: -8,
};

const DEFAULT_RUMBLE_CONFIG: ThunderRumbleConfig = {
  enabled: true,
  frequency: 35,
  lfoRate: 0.3,
  duration: 8,
  gain: -10,
};

const DEFAULT_THUNDER_CONFIG: ThunderModuleConfig = {
  masterGain: -6,
  minInterval: 30,
  maxInterval: 120,
  distanceRange: [1, 15],
  sidechainEnabled: true,
  sidechainRatio: 4,
  sidechainAttack: 0.01,
  sidechainRelease: 0.5,
  tearing: DEFAULT_TEARING_CONFIG,
  crack: DEFAULT_CRACK_CONFIG,
  body: DEFAULT_BODY_CONFIG,
  rumble: DEFAULT_RUMBLE_CONFIG,
};

// Speed of sound in m/s (for potential future distance-based delay calculations)
// const SPEED_OF_SOUND = 343;

// TearingLayer - Initial high-frequency crack

class TearingLayer {
  private _config: ThunderTearingConfig;
  private _noise: Tone.Noise;
  private _hpf: Tone.Filter;
  private _envelope: Tone.AmplitudeEnvelope;
  private _gain: Tone.Gain;
  private _output: Tone.Gain;

  constructor(config: Partial<ThunderTearingConfig> = {}) {
    this._config = { ...DEFAULT_TEARING_CONFIG, ...config };

    this._noise = new Tone.Noise({
      type: this._config.noiseType,
      volume: 0,
    });

    this._hpf = new Tone.Filter({
      type: 'highpass',
      frequency: this._config.hpfFreq,
      rolloff: -24,
    });

    this._envelope = new Tone.AmplitudeEnvelope({
      attack: this._config.attackTime,
      decay: this._config.decayTime,
      sustain: 0,
      release: 0.05,
    });

    this._gain = new Tone.Gain(Tone.dbToGain(this._config.gain));
    this._output = new Tone.Gain(this._config.enabled ? 1 : 0);

    this._noise.connect(this._hpf);
    this._hpf.connect(this._envelope);
    this._envelope.connect(this._gain);
    this._gain.connect(this._output);

    this._noise.start();
  }

  trigger(intensity: number = 1): void {
    if (!this._config.enabled) return;

    // Scale decay with intensity
    this._envelope.decay = this._config.decayTime * (0.7 + intensity * 0.6);

    // Scale filter - closer strikes have more high frequencies
    this._hpf.frequency.value = this._config.hpfFreq * (1 - intensity * 0.3);

    this._envelope.triggerAttackRelease(this._config.attackTime + this._config.decayTime);
  }

  setEnabled(enabled: boolean): void {
    this._config.enabled = enabled;
    this._output.gain.rampTo(enabled ? 1 : 0, 0.1);
  }

  updateConfig(config: Partial<ThunderTearingConfig>): void {
    if (config.enabled !== undefined) this.setEnabled(config.enabled);
    if (config.noiseType !== undefined) {
      this._config.noiseType = config.noiseType;
      this._noise.type = config.noiseType;
    }
    if (config.hpfFreq !== undefined) {
      this._config.hpfFreq = config.hpfFreq;
      this._hpf.frequency.value = config.hpfFreq;
    }
    if (config.attackTime !== undefined) {
      this._config.attackTime = config.attackTime;
      this._envelope.attack = config.attackTime;
    }
    if (config.decayTime !== undefined) this._config.decayTime = config.decayTime;
    if (config.gain !== undefined) {
      this._config.gain = config.gain;
      this._gain.gain.rampTo(Tone.dbToGain(config.gain), 0.1);
    }
  }

  get output(): Tone.Gain {
    return this._output;
  }

  dispose(): void {
    this._noise.dispose();
    this._hpf.dispose();
    this._envelope.dispose();
    this._gain.dispose();
    this._output.dispose();
  }
}

// CrackLayer - N-wave pressure spike using FM synthesis

class CrackLayer {
  private _config: ThunderCrackConfig;
  private _oscillators: Tone.Oscillator[] = [];
  private _oscillatorGains: Tone.Gain[] = [];
  private _envelope: Tone.AmplitudeEnvelope;
  private _masterGain: Tone.Gain;
  private _output: Tone.Gain;

  constructor(config: Partial<ThunderCrackConfig> = {}) {
    this._config = { ...DEFAULT_CRACK_CONFIG, ...config };

    this._envelope = new Tone.AmplitudeEnvelope({
      attack: this._config.attackTime,
      decay: this._config.decayTime,
      sustain: 0,
      release: 0.1,
    });

    this._masterGain = new Tone.Gain(Tone.dbToGain(this._config.gain));
    this._output = new Tone.Gain(this._config.enabled ? 1 : 0);

    this._envelope.connect(this._masterGain);
    this._masterGain.connect(this._output);

    this.createOscillators();
  }

  private createOscillators(): void {
    // Clean up existing
    for (const osc of this._oscillators) osc.dispose();
    for (const gain of this._oscillatorGains) gain.dispose();
    this._oscillators = [];
    this._oscillatorGains = [];

    // Create harmonics for rich crack tone
    for (let i = 1; i <= this._config.harmonics; i++) {
      const freq = this._config.frequency * i;
      const osc = new Tone.Oscillator({
        type: 'sine',
        frequency: freq,
      });

      // Odd harmonics louder for more aggressive sound
      const harmonicGain = new Tone.Gain(i % 2 === 1 ? 1 / i : 0.5 / i);

      osc.connect(harmonicGain);
      harmonicGain.connect(this._envelope);

      this._oscillators.push(osc);
      this._oscillatorGains.push(harmonicGain);

      osc.start();
    }
  }

  trigger(intensity: number = 1): void {
    if (!this._config.enabled) return;

    // Scale decay with distance (closer = shorter, sharper crack)
    this._envelope.decay = this._config.decayTime * (0.5 + (1 - intensity) * 0.5);

    // Pitch shift based on intensity (closer = lower, more ominous)
    const pitchMult = 1 - intensity * 0.2;
    for (let i = 0; i < this._oscillators.length; i++) {
      const baseFreq = this._config.frequency * (i + 1);
      this._oscillators[i]?.frequency.setValueAtTime(baseFreq * pitchMult, Tone.now());
    }

    this._envelope.triggerAttackRelease(this._config.attackTime + this._config.decayTime * 1.5);
  }

  setEnabled(enabled: boolean): void {
    this._config.enabled = enabled;
    this._output.gain.rampTo(enabled ? 1 : 0, 0.1);
  }

  updateConfig(config: Partial<ThunderCrackConfig>): void {
    if (config.enabled !== undefined) this.setEnabled(config.enabled);
    if (config.frequency !== undefined) this._config.frequency = config.frequency;
    if (config.harmonics !== undefined) {
      this._config.harmonics = config.harmonics;
      this.createOscillators();
    }
    if (config.attackTime !== undefined) {
      this._config.attackTime = config.attackTime;
      this._envelope.attack = config.attackTime;
    }
    if (config.decayTime !== undefined) this._config.decayTime = config.decayTime;
    if (config.gain !== undefined) {
      this._config.gain = config.gain;
      this._masterGain.gain.rampTo(Tone.dbToGain(config.gain), 0.1);
    }
  }

  get output(): Tone.Gain {
    return this._output;
  }

  dispose(): void {
    for (const osc of this._oscillators) osc.dispose();
    for (const gain of this._oscillatorGains) gain.dispose();
    this._envelope.dispose();
    this._masterGain.dispose();
    this._output.dispose();
  }
}

// BodyLayer - Main rumble with reverb

class BodyLayer {
  private _config: ThunderBodyConfig;
  private _noise: Tone.Noise;
  private _lpf: Tone.Filter;
  private _envelope: Tone.AmplitudeEnvelope;
  private _reverb: Tone.Reverb;
  private _gain: Tone.Gain;
  private _output: Tone.Gain;

  constructor(config: Partial<ThunderBodyConfig> = {}) {
    this._config = { ...DEFAULT_BODY_CONFIG, ...config };

    this._noise = new Tone.Noise({
      type: this._config.noiseType,
      volume: 0,
    });

    this._lpf = new Tone.Filter({
      type: 'lowpass',
      frequency: this._config.lpfFreq,
      rolloff: -24,
    });

    this._envelope = new Tone.AmplitudeEnvelope({
      attack: 0.1,
      decay: 2,
      sustain: 0.3,
      release: this._config.reverbDecay,
    });

    this._reverb = new Tone.Reverb({
      decay: this._config.reverbDecay,
      wet: 0.6,
    });

    this._gain = new Tone.Gain(Tone.dbToGain(this._config.gain));
    this._output = new Tone.Gain(this._config.enabled ? 1 : 0);

    this._noise.connect(this._lpf);
    this._lpf.connect(this._envelope);
    this._envelope.connect(this._reverb);
    this._reverb.connect(this._gain);
    this._gain.connect(this._output);

    this._noise.start();
  }

  trigger(intensity: number = 1, duration: number = 3): void {
    if (!this._config.enabled) return;

    // Scale filter - closer strikes have more mid-range
    this._lpf.frequency.value = this._config.lpfFreq * (1 + intensity * 0.5);

    // Longer envelope for distant thunder
    this._envelope.release = this._config.reverbDecay * (0.5 + (1 - intensity) * 0.5);

    this._envelope.triggerAttackRelease(duration);
  }

  setEnabled(enabled: boolean): void {
    this._config.enabled = enabled;
    this._output.gain.rampTo(enabled ? 1 : 0, 0.1);
  }

  updateConfig(config: Partial<ThunderBodyConfig>): void {
    if (config.enabled !== undefined) this.setEnabled(config.enabled);
    if (config.noiseType !== undefined) {
      this._config.noiseType = config.noiseType;
      this._noise.type = config.noiseType;
    }
    if (config.lpfFreq !== undefined) {
      this._config.lpfFreq = config.lpfFreq;
      this._lpf.frequency.value = config.lpfFreq;
    }
    if (config.reverbDecay !== undefined) {
      this._config.reverbDecay = config.reverbDecay;
      this._reverb.decay = config.reverbDecay;
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
    this._noise.dispose();
    this._lpf.dispose();
    this._envelope.dispose();
    this._reverb.dispose();
    this._gain.dispose();
    this._output.dispose();
  }
}

// RumbleLayer - Sub-bass tail

class RumbleLayer {
  private _config: ThunderRumbleConfig;
  private _oscillator: Tone.Oscillator;
  private _lfo: Tone.LFO;
  private _lfoGain: Tone.Gain;
  private _envelope: Tone.AmplitudeEnvelope;
  private _lpf: Tone.Filter;
  private _gain: Tone.Gain;
  private _output: Tone.Gain;

  constructor(config: Partial<ThunderRumbleConfig> = {}) {
    this._config = { ...DEFAULT_RUMBLE_CONFIG, ...config };

    this._oscillator = new Tone.Oscillator({
      type: 'sine',
      frequency: this._config.frequency,
    });

    this._lfo = new Tone.LFO({
      frequency: this._config.lfoRate,
      min: 0.5,
      max: 1,
    });

    this._lfoGain = new Tone.Gain(1);

    this._envelope = new Tone.AmplitudeEnvelope({
      attack: 0.5,
      decay: this._config.duration * 0.3,
      sustain: 0.4,
      release: this._config.duration * 0.5,
    });

    this._lpf = new Tone.Filter({
      type: 'lowpass',
      frequency: 80,
      rolloff: -24,
    });

    this._gain = new Tone.Gain(Tone.dbToGain(this._config.gain));
    this._output = new Tone.Gain(this._config.enabled ? 1 : 0);

    this._oscillator.connect(this._lfoGain);
    this._lfoGain.connect(this._envelope);
    this._envelope.connect(this._lpf);
    this._lpf.connect(this._gain);
    this._gain.connect(this._output);

    this._lfo.connect(this._lfoGain.gain);

    this._oscillator.start();
    this._lfo.start();
  }

  trigger(intensity: number = 1): void {
    if (!this._config.enabled) return;

    // Scale duration with distance
    const duration = this._config.duration * (0.5 + (1 - intensity) * 0.8);
    this._envelope.release = duration * 0.5;

    // Pitch varies slightly with intensity
    this._oscillator.frequency.value = this._config.frequency * (0.9 + intensity * 0.2);

    this._envelope.triggerAttackRelease(duration);
  }

  setEnabled(enabled: boolean): void {
    this._config.enabled = enabled;
    this._output.gain.rampTo(enabled ? 1 : 0, 0.1);
  }

  updateConfig(config: Partial<ThunderRumbleConfig>): void {
    if (config.enabled !== undefined) this.setEnabled(config.enabled);
    if (config.frequency !== undefined) {
      this._config.frequency = config.frequency;
      this._oscillator.frequency.value = config.frequency;
    }
    if (config.lfoRate !== undefined) {
      this._config.lfoRate = config.lfoRate;
      this._lfo.frequency.value = config.lfoRate;
    }
    if (config.duration !== undefined) this._config.duration = config.duration;
    if (config.gain !== undefined) {
      this._config.gain = config.gain;
      this._gain.gain.rampTo(Tone.dbToGain(config.gain), 0.1);
    }
  }

  get output(): Tone.Gain {
    return this._output;
  }

  dispose(): void {
    this._oscillator.dispose();
    this._lfo.dispose();
    this._lfoGain.dispose();
    this._envelope.dispose();
    this._lpf.dispose();
    this._gain.dispose();
    this._output.dispose();
  }
}

// ThunderModule - Main orchestrator

export class ThunderModule {
  private _config: ThunderModuleConfig;
  private _tearing: TearingLayer;
  private _crack: CrackLayer;
  private _body: BodyLayer;
  private _rumble: RumbleLayer;
  private _masterGain: Tone.Gain;
  private _panner3d: Tone.Panner3D;
  private _output: Tone.Gain;

  // Sidechain compressor for ducking other audio
  private _sidechain: Tone.Compressor;
  private _sidechainEnvelope: Tone.Gain;

  // Auto-scheduling
  private _autoScheduleId: number | null = null;
  private _isAutoMode = false;

  // Strike event IDs (cleared on stopAuto/dispose to prevent orphan callbacks)
  private _strikeEventIds: number[] = [];

  private _spatialConfig: SpatialConfig = {
    enabled: false,
    panningModel: 'equalpower',
    worldScale: 5,
    fixedDepth: -2,
  };

  constructor(config: Partial<ThunderModuleConfig> = {}) {
    this._config = {
      ...DEFAULT_THUNDER_CONFIG,
      ...config,
      tearing: { ...DEFAULT_TEARING_CONFIG, ...config.tearing },
      crack: { ...DEFAULT_CRACK_CONFIG, ...config.crack },
      body: { ...DEFAULT_BODY_CONFIG, ...config.body },
      rumble: { ...DEFAULT_RUMBLE_CONFIG, ...config.rumble },
    };

    // Create layers
    this._tearing = new TearingLayer(this._config.tearing);
    this._crack = new CrackLayer(this._config.crack);
    this._body = new BodyLayer(this._config.body);
    this._rumble = new RumbleLayer(this._config.rumble);

    // Master output
    this._masterGain = new Tone.Gain(Tone.dbToGain(this._config.masterGain));
    this._panner3d = new Tone.Panner3D({
      panningModel: this._spatialConfig.panningModel,
      rolloffFactor: 0,
      positionX: 0,
      positionY: this._spatialConfig.worldScale * 0.5,
      positionZ: this._spatialConfig.fixedDepth,
    });
    this._output = new Tone.Gain(1);

    // Connect layers to master, then through 3D panner
    this._tearing.output.connect(this._masterGain);
    this._crack.output.connect(this._masterGain);
    this._body.output.connect(this._masterGain);
    this._rumble.output.connect(this._masterGain);
    this._masterGain.connect(this._panner3d);
    this._panner3d.connect(this._output);

    // Sidechain compressor for other buses to duck during thunder
    this._sidechain = new Tone.Compressor({
      threshold: -24,
      ratio: this._config.sidechainRatio,
      attack: this._config.sidechainAttack,
      release: this._config.sidechainRelease,
    });

    // Envelope to trigger sidechain
    this._sidechainEnvelope = new Tone.Gain(0);
    this._sidechainEnvelope.connect(this._sidechain);
  }

  /**
   * Trigger a thunder strike at the specified distance.
   * @param distance Distance in km (affects timing and intensity)
   */
  triggerStrike(distance?: number): void {
    const [minDist, maxDist] = this._config.distanceRange;
    const dist = distance ?? (minDist + Math.random() * (maxDist - minDist));

    // Calculate intensity (inverse of distance, normalized)
    const intensity = 1 - (dist - minDist) / (maxDist - minDist);

    // Randomize spatial position per-strike
    if (this._spatialConfig.enabled) {
      const ws = this._spatialConfig.worldScale;
      const strikeX = (Math.random() * 2 - 1) * ws;
      const strikeY = ws * 0.5; // Above — thunder comes from the sky
      const strikeZ = this._spatialConfig.fixedDepth - (dist * 0.5); // Farther strikes are farther back
      this._panner3d.positionX.value = strikeX;
      this._panner3d.positionY.value = strikeY;
      this._panner3d.positionZ.value = strikeZ;
    }

    // Schedule layers with appropriate delays
    // Distance affects timing offsets between layers
    // Tearing arrives first (light travels faster than sound, but this simulates
    // the initial crack reaching us before the main rumble builds)
    const now = Tone.now();

    // Trigger sidechain ducking if enabled
    if (this._config.sidechainEnabled) {
      this._sidechainEnvelope.gain.setValueAtTime(1, now);
      this._sidechainEnvelope.gain.linearRampToValueAtTime(0, now + 3 + dist);
    }

    // Tearing: immediate sharp crack
    this._strikeEventIds.push(Tone.getTransport().scheduleOnce(() => {
      this._tearing.trigger(intensity);
    }, now + 0.01));

    // Crack: follows shortly after
    this._strikeEventIds.push(Tone.getTransport().scheduleOnce(() => {
      this._crack.trigger(intensity);
    }, now + 0.05));

    // Body: main rumble with slight delay for distant thunder
    this._strikeEventIds.push(Tone.getTransport().scheduleOnce(() => {
      this._body.trigger(intensity, 2 + dist * 0.3);
    }, now + 0.1 + dist * 0.02));

    // Rumble: sub-bass tail comes last
    this._strikeEventIds.push(Tone.getTransport().scheduleOnce(() => {
      this._rumble.trigger(intensity);
    }, now + 0.3 + dist * 0.05));

    console.log(`[ThunderModule] Strike triggered at ${dist.toFixed(1)}km (intensity: ${intensity.toFixed(2)})`);
  }

  /**
   * Start automatic thunder scheduling.
   */
  startAuto(): void {
    if (this._isAutoMode) return;
    this._isAutoMode = true;
    this.scheduleNextStrike();
  }

  /**
   * Stop automatic thunder scheduling.
   */
  stopAuto(): void {
    this._isAutoMode = false;
    if (this._autoScheduleId !== null) {
      Tone.getTransport().clear(this._autoScheduleId);
      this._autoScheduleId = null;
    }
    // Clear any pending strike layer callbacks
    for (const id of this._strikeEventIds) {
      Tone.getTransport().clear(id);
    }
    this._strikeEventIds = [];
    // Reset sidechain to prevent lingering ducking after thunder stops
    this._sidechainEnvelope.gain.cancelScheduledValues(Tone.now());
    this._sidechainEnvelope.gain.setValueAtTime(0, Tone.now());
  }

  private scheduleNextStrike(): void {
    if (!this._isAutoMode) return;

    const interval = this._config.minInterval +
      Math.random() * (this._config.maxInterval - this._config.minInterval);

    this._autoScheduleId = Tone.getTransport().scheduleOnce(() => {
      this.triggerStrike();
      this.scheduleNextStrike();
    }, `+${interval}`);
  }

  get isAutoMode(): boolean {
    return this._isAutoMode;
  }

  /**
   * Get the sidechain compressor input for ducking other buses.
   * Connect rain/wind buses through this compressor to duck during thunder.
   */
  getSidechainCompressor(): Tone.Compressor {
    return this._sidechain;
  }

  setMasterGain(db: number): void {
    this._config.masterGain = db;
    this._masterGain.gain.rampTo(Tone.dbToGain(db), 0.1);
  }

  setSidechainEnabled(enabled: boolean): void {
    this._config.sidechainEnabled = enabled;
  }

  updateConfig(config: Partial<ThunderModuleConfig>): void {
    if (config.masterGain !== undefined) this.setMasterGain(config.masterGain);
    if (config.minInterval !== undefined) this._config.minInterval = config.minInterval;
    if (config.maxInterval !== undefined) this._config.maxInterval = config.maxInterval;
    if (config.distanceRange !== undefined) this._config.distanceRange = config.distanceRange;
    if (config.sidechainEnabled !== undefined) this.setSidechainEnabled(config.sidechainEnabled);
    if (config.sidechainRatio !== undefined) {
      this._config.sidechainRatio = config.sidechainRatio;
      this._sidechain.ratio.value = config.sidechainRatio;
    }
    if (config.sidechainAttack !== undefined) {
      this._config.sidechainAttack = config.sidechainAttack;
      this._sidechain.attack.value = config.sidechainAttack;
    }
    if (config.sidechainRelease !== undefined) {
      this._config.sidechainRelease = config.sidechainRelease;
      this._sidechain.release.value = config.sidechainRelease;
    }
    if (config.tearing) this._tearing.updateConfig(config.tearing);
    if (config.crack) this._crack.updateConfig(config.crack);
    if (config.body) this._body.updateConfig(config.body);
    if (config.rumble) this._rumble.updateConfig(config.rumble);

    // Merge into stored config
    this._config = {
      ...this._config,
      ...config,
      tearing: { ...this._config.tearing, ...config.tearing },
      crack: { ...this._config.crack, ...config.crack },
      body: { ...this._config.body, ...config.body },
      rumble: { ...this._config.rumble, ...config.rumble },
    };
  }

  setSpatialConfig(config: Partial<SpatialConfig>): void {
    if (config.enabled !== undefined) this._spatialConfig.enabled = config.enabled;
    if (config.panningModel !== undefined) {
      this._spatialConfig.panningModel = config.panningModel;
      this._panner3d.panningModel = config.panningModel;
    }
    if (config.worldScale !== undefined) this._spatialConfig.worldScale = config.worldScale;
    if (config.fixedDepth !== undefined) this._spatialConfig.fixedDepth = config.fixedDepth;
    // Reset to default position when spatial is disabled
    if (!this._spatialConfig.enabled) {
      this._panner3d.positionX.value = 0;
      this._panner3d.positionY.value = 0;
      this._panner3d.positionZ.value = this._spatialConfig.fixedDepth;
    }
  }

  getConfig(): ThunderModuleConfig {
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
    isAutoMode: boolean;
    distanceRange: [number, number];
    layersEnabled: {
      tearing: boolean;
      crack: boolean;
      body: boolean;
      rumble: boolean;
    };
  } {
    return {
      isAutoMode: this._isAutoMode,
      distanceRange: this._config.distanceRange,
      layersEnabled: {
        tearing: this._config.tearing.enabled,
        crack: this._config.crack.enabled,
        body: this._config.body.enabled,
        rumble: this._config.rumble.enabled,
      },
    };
  }

  dispose(): void {
    this.stopAuto();
    this._tearing.dispose();
    this._crack.dispose();
    this._body.dispose();
    this._rumble.dispose();
    this._masterGain.dispose();
    this._panner3d.dispose();
    this._output.dispose();
    this._sidechain.dispose();
    this._sidechainEnvelope.dispose();
  }
}
