/**
 * WindModule - Atmospheric wind audio synthesis
 *
 * Comprises multiple layers for realistic wind simulation:
 * - WindBedLayer: Continuous filtered noise bed with LFO modulation
 * - WindGustScheduler: Stochastic gust events with envelopes
 * - AeolianToneGenerator: Wire whistle tones via Strouhal formula
 * - SingingWindSynth: Musical wind with formant filtering
 * - KatabaticLayer: Low-frequency downslope wind surges
 */

import * as Tone from 'tone';
import type {
  WindModuleConfig,
  WindBedConfig,
  WindGustConfig,
  AeolianConfig,
  SingingWindConfig,
  KatabaticConfig,
  NoiseType,
  FormantSet,
} from '../../types/audio';

// ============================================================================
// Default Configurations
// ============================================================================

const DEFAULT_BED_CONFIG: WindBedConfig = {
  enabled: true,
  noiseType: 'pink',
  baseGain: -24,
  lpfFreq: 800,
  hpfFreq: 80,
  lfoRate: 0.15,
  lfoDepth: 0.3,
};

const DEFAULT_GUST_CONFIG: WindGustConfig = {
  enabled: true,
  minInterval: 8,
  maxInterval: 25,
  riseTime: 1.5,
  fallTime: 3,
  intensityRange: [0.3, 0.8],
};

const DEFAULT_AEOLIAN_CONFIG: AeolianConfig = {
  enabled: false,
  strouhalNumber: 0.2,
  wireDiameter: 4,
  baseFreq: 400,
  harmonics: [1, 2, 3],
  gain: -30,
};

const DEFAULT_SINGING_CONFIG: SingingWindConfig = {
  enabled: false,
  mode: 'aeolian',
  rootNote: 'A3',
  vowelFormants: { f1: 730, f2: 1090, f3: 2440, f4: 3400, f5: 4500 },
  gain: -28,
};

const DEFAULT_KATABATIC_CONFIG: KatabaticConfig = {
  enabled: false,
  lowFreqBoost: 6,
  surgeRate: 0.08,
  gain: -30,
};

const DEFAULT_WIND_CONFIG: WindModuleConfig = {
  masterGain: -12,
  bed: DEFAULT_BED_CONFIG,
  interaction: {
    enabled: false,
    cornerWhistleGain: -30,
    eaveDripGain: -36,
    rattleGain: -40,
  },
  gust: DEFAULT_GUST_CONFIG,
  aeolian: DEFAULT_AEOLIAN_CONFIG,
  singing: DEFAULT_SINGING_CONFIG,
  katabatic: DEFAULT_KATABATIC_CONFIG,
};

// ============================================================================
// WindBedLayer - Continuous noise with filter modulation
// ============================================================================

class WindBedLayer {
  private _config: WindBedConfig;
  private _noise: Tone.Noise;
  private _lpf: Tone.Filter;
  private _hpf: Tone.Filter;
  private _lfo: Tone.LFO;
  private _gain: Tone.Gain;
  private _output: Tone.Gain;
  private _isPlaying = false;

  constructor(config: Partial<WindBedConfig> = {}) {
    this._config = { ...DEFAULT_BED_CONFIG, ...config };

    this._noise = new Tone.Noise({
      type: this._config.noiseType,
      volume: this._config.baseGain,
    });

    this._lpf = new Tone.Filter({
      type: 'lowpass',
      frequency: this._config.lpfFreq,
      rolloff: -24,
    });

    this._hpf = new Tone.Filter({
      type: 'highpass',
      frequency: this._config.hpfFreq,
      rolloff: -12,
    });

    this._lfo = new Tone.LFO({
      frequency: this._config.lfoRate,
      min: this._config.lpfFreq * (1 - this._config.lfoDepth),
      max: this._config.lpfFreq * (1 + this._config.lfoDepth),
    });

    this._gain = new Tone.Gain(this._config.enabled ? 1 : 0);
    this._output = new Tone.Gain(1);

    // Connect chain: noise -> hpf -> lpf -> gain -> output
    this._noise.connect(this._hpf);
    this._hpf.connect(this._lpf);
    this._lpf.connect(this._gain);
    this._gain.connect(this._output);

    // LFO modulates LPF frequency for "breathing" effect
    this._lfo.connect(this._lpf.frequency);
  }

  start(): void {
    if (!this._isPlaying) {
      this._noise.start();
      this._lfo.start();
      this._isPlaying = true;
    }
  }

  stop(): void {
    if (this._isPlaying) {
      this._noise.stop();
      this._lfo.stop();
      this._isPlaying = false;
    }
  }

  setEnabled(enabled: boolean): void {
    this._config.enabled = enabled;
    this._gain.gain.rampTo(enabled ? 1 : 0, 0.5);
  }

  setNoiseType(type: NoiseType): void {
    this._config.noiseType = type;
    const wasPlaying = this._isPlaying;
    if (wasPlaying) this.stop();
    this._noise.type = type;
    if (wasPlaying) this.start();
  }

  setBaseGain(db: number): void {
    this._config.baseGain = db;
    this._noise.volume.rampTo(db, 0.1);
  }

  setLPFFreq(freq: number): void {
    this._config.lpfFreq = freq;
    this._lpf.frequency.rampTo(freq, 0.1);
    // Update LFO range
    this._lfo.min = freq * (1 - this._config.lfoDepth);
    this._lfo.max = freq * (1 + this._config.lfoDepth);
  }

  setHPFFreq(freq: number): void {
    this._config.hpfFreq = freq;
    this._hpf.frequency.rampTo(freq, 0.1);
  }

  setLFO(rate: number, depth: number): void {
    this._config.lfoRate = rate;
    this._config.lfoDepth = depth;
    this._lfo.frequency.rampTo(rate, 0.5);
    this._lfo.min = this._config.lpfFreq * (1 - depth);
    this._lfo.max = this._config.lpfFreq * (1 + depth);
  }

  updateConfig(config: Partial<WindBedConfig>): void {
    if (config.enabled !== undefined) this.setEnabled(config.enabled);
    if (config.noiseType !== undefined) this.setNoiseType(config.noiseType);
    if (config.baseGain !== undefined) this.setBaseGain(config.baseGain);
    if (config.lpfFreq !== undefined) this.setLPFFreq(config.lpfFreq);
    if (config.hpfFreq !== undefined) this.setHPFFreq(config.hpfFreq);
    if (config.lfoRate !== undefined || config.lfoDepth !== undefined) {
      this.setLFO(
        config.lfoRate ?? this._config.lfoRate,
        config.lfoDepth ?? this._config.lfoDepth
      );
    }
  }

  get output(): Tone.Gain {
    return this._output;
  }

  dispose(): void {
    this.stop();
    this._noise.dispose();
    this._lpf.dispose();
    this._hpf.dispose();
    this._lfo.dispose();
    this._gain.dispose();
    this._output.dispose();
  }
}

// ============================================================================
// WindGustScheduler - Stochastic gust events
// ============================================================================

class WindGustScheduler {
  private _config: WindGustConfig;
  private _noise: Tone.Noise;
  private _filter: Tone.Filter;
  private _envelope: Tone.AmplitudeEnvelope;
  private _gain: Tone.Gain;
  private _output: Tone.Gain;
  private _scheduledEvent: number | null = null;
  private _isRunning = false;

  constructor(config: Partial<WindGustConfig> = {}) {
    this._config = { ...DEFAULT_GUST_CONFIG, ...config };

    this._noise = new Tone.Noise({ type: 'brown', volume: -6 });

    this._filter = new Tone.Filter({
      type: 'lowpass',
      frequency: 600,
      rolloff: -24,
    });

    this._envelope = new Tone.AmplitudeEnvelope({
      attack: this._config.riseTime,
      decay: 0.5,
      sustain: 0.7,
      release: this._config.fallTime,
    });

    this._gain = new Tone.Gain(this._config.enabled ? 1 : 0);
    this._output = new Tone.Gain(1);

    this._noise.connect(this._filter);
    this._filter.connect(this._envelope);
    this._envelope.connect(this._gain);
    this._gain.connect(this._output);
  }

  start(): void {
    if (!this._isRunning) {
      this._noise.start();
      this._isRunning = true;
      if (this._config.enabled) {
        this.scheduleNextGust();
      }
    }
  }

  stop(): void {
    if (this._isRunning) {
      this._noise.stop();
      this._isRunning = false;
      if (this._scheduledEvent !== null) {
        Tone.getTransport().clear(this._scheduledEvent);
        this._scheduledEvent = null;
      }
    }
  }

  private scheduleNextGust(): void {
    if (!this._isRunning || !this._config.enabled) return;

    const interval = this._config.minInterval +
      Math.random() * (this._config.maxInterval - this._config.minInterval);

    this._scheduledEvent = Tone.getTransport().scheduleOnce(() => {
      this.triggerGust();
      this.scheduleNextGust();
    }, `+${interval}`);
  }

  /** Trigger a single gust - can be called manually for testing */
  triggerGust(intensity?: number): void {
    const [minInt, maxInt] = this._config.intensityRange;
    const gustIntensity = intensity ?? (minInt + Math.random() * (maxInt - minInt));

    // Scale envelope times based on intensity
    this._envelope.attack = this._config.riseTime * (0.7 + gustIntensity * 0.6);
    this._envelope.release = this._config.fallTime * (0.8 + gustIntensity * 0.4);

    // Scale filter for more high-frequency content in stronger gusts
    this._filter.frequency.rampTo(400 + gustIntensity * 400, 0.1);

    // Trigger envelope
    const duration = this._config.riseTime + 0.5 + this._config.fallTime * 0.5;
    this._envelope.triggerAttackRelease(duration);
  }

  setEnabled(enabled: boolean): void {
    this._config.enabled = enabled;
    this._gain.gain.rampTo(enabled ? 1 : 0, 0.3);
    if (enabled && this._isRunning && this._scheduledEvent === null) {
      this.scheduleNextGust();
    }
  }

  updateConfig(config: Partial<WindGustConfig>): void {
    if (config.enabled !== undefined) this.setEnabled(config.enabled);
    if (config.minInterval !== undefined) this._config.minInterval = config.minInterval;
    if (config.maxInterval !== undefined) this._config.maxInterval = config.maxInterval;
    if (config.riseTime !== undefined) this._config.riseTime = config.riseTime;
    if (config.fallTime !== undefined) this._config.fallTime = config.fallTime;
    if (config.intensityRange !== undefined) this._config.intensityRange = config.intensityRange;
  }

  get output(): Tone.Gain {
    return this._output;
  }

  dispose(): void {
    this.stop();
    this._noise.dispose();
    this._filter.dispose();
    this._envelope.dispose();
    this._gain.dispose();
    this._output.dispose();
  }
}

// ============================================================================
// AeolianToneGenerator - Wire whistle via Strouhal formula
// ============================================================================

class AeolianToneGenerator {
  private _config: AeolianConfig;
  private _oscillators: Tone.Oscillator[] = [];
  private _gains: Tone.Gain[] = [];
  private _masterGain: Tone.Gain;
  private _output: Tone.Gain;
  private _windSpeed = 0;
  private _isPlaying = false;

  constructor(config: Partial<AeolianConfig> = {}) {
    this._config = { ...DEFAULT_AEOLIAN_CONFIG, ...config };

    this._masterGain = new Tone.Gain(Tone.dbToGain(this._config.gain));
    this._output = new Tone.Gain(this._config.enabled ? 1 : 0);

    this._masterGain.connect(this._output);
    this.createOscillators();
  }

  private createOscillators(): void {
    // Dispose existing
    for (const osc of this._oscillators) osc.dispose();
    for (const gain of this._gains) gain.dispose();
    this._oscillators = [];
    this._gains = [];

    // Create oscillator for each harmonic
    for (const harmonic of this._config.harmonics) {
      const freq = this._config.baseFreq * harmonic;
      const osc = new Tone.Oscillator({
        type: 'sine',
        frequency: freq,
      });

      // Higher harmonics are quieter
      const harmonicGain = new Tone.Gain(1 / harmonic);

      osc.connect(harmonicGain);
      harmonicGain.connect(this._masterGain);

      this._oscillators.push(osc);
      this._gains.push(harmonicGain);
    }
  }

  start(): void {
    if (!this._isPlaying) {
      for (const osc of this._oscillators) osc.start();
      this._isPlaying = true;
    }
  }

  stop(): void {
    if (this._isPlaying) {
      for (const osc of this._oscillators) osc.stop();
      this._isPlaying = false;
    }
  }

  /**
   * Update wind speed, which changes aeolian frequency via Strouhal formula.
   * @param speed Wind speed in m/s
   */
  setWindSpeed(speed: number): void {
    this._windSpeed = speed;
    // Strouhal formula: f = St * V / D
    // D is in mm, convert to meters
    const diameter = this._config.wireDiameter / 1000;
    const baseFreq = (this._config.strouhalNumber * speed) / diameter;

    // Update all oscillators
    for (let i = 0; i < this._oscillators.length; i++) {
      const harmonic = this._config.harmonics[i] ?? 1;
      this._oscillators[i]?.frequency.rampTo(baseFreq * harmonic, 0.2);
    }

    // Scale volume with wind speed (quieter at low speeds)
    const speedScale = Math.min(1, speed / 15);
    this._masterGain.gain.rampTo(Tone.dbToGain(this._config.gain) * speedScale, 0.2);
  }

  setEnabled(enabled: boolean): void {
    this._config.enabled = enabled;
    this._output.gain.rampTo(enabled ? 1 : 0, 0.3);
  }

  updateConfig(config: Partial<AeolianConfig>): void {
    if (config.enabled !== undefined) this.setEnabled(config.enabled);
    if (config.strouhalNumber !== undefined) this._config.strouhalNumber = config.strouhalNumber;
    if (config.wireDiameter !== undefined) this._config.wireDiameter = config.wireDiameter;
    if (config.baseFreq !== undefined) this._config.baseFreq = config.baseFreq;
    if (config.gain !== undefined) {
      this._config.gain = config.gain;
      this._masterGain.gain.rampTo(Tone.dbToGain(config.gain), 0.1);
    }
    if (config.harmonics !== undefined) {
      this._config.harmonics = config.harmonics;
      const wasPlaying = this._isPlaying;
      if (wasPlaying) this.stop();
      this.createOscillators();
      if (wasPlaying) this.start();
    }
    // Recalculate frequencies if wind speed is set
    if (this._windSpeed > 0) this.setWindSpeed(this._windSpeed);
  }

  get output(): Tone.Gain {
    return this._output;
  }

  dispose(): void {
    this.stop();
    for (const osc of this._oscillators) osc.dispose();
    for (const gain of this._gains) gain.dispose();
    this._masterGain.dispose();
    this._output.dispose();
  }
}

// ============================================================================
// SingingWindSynth - Musical wind with formant filtering
// ============================================================================

// Mode intervals (semitones from root) - for future pitch quantization
// const MODE_INTERVALS: Record<MusicalMode, number[]> = {
//   ionian: [0, 2, 4, 5, 7, 9, 11],
//   dorian: [0, 2, 3, 5, 7, 9, 10],
//   phrygian: [0, 1, 3, 5, 7, 8, 10],
//   lydian: [0, 2, 4, 6, 7, 9, 11],
//   mixolydian: [0, 2, 4, 5, 7, 9, 10],
//   aeolian: [0, 2, 3, 5, 7, 8, 10],
//   locrian: [0, 1, 3, 5, 6, 8, 10],
//   pentatonic: [0, 2, 4, 7, 9],
//   blues: [0, 3, 5, 6, 7, 10],
// };

class SingingWindSynth {
  private _config: SingingWindConfig;
  private _noise: Tone.Noise;
  private _formants: Tone.Filter[] = [];
  private _formantGains: Tone.Gain[] = [];
  private _masterGain: Tone.Gain;
  private _output: Tone.Gain;
  private _isPlaying = false;

  constructor(config: Partial<SingingWindConfig> = {}) {
    this._config = { ...DEFAULT_SINGING_CONFIG, ...config };

    this._noise = new Tone.Noise({ type: 'pink', volume: -12 });
    this._masterGain = new Tone.Gain(Tone.dbToGain(this._config.gain));
    this._output = new Tone.Gain(this._config.enabled ? 1 : 0);

    this._masterGain.connect(this._output);
    this.createFormantFilters();
  }

  private createFormantFilters(): void {
    // Dispose existing
    for (const f of this._formants) f.dispose();
    for (const g of this._formantGains) g.dispose();
    this._formants = [];
    this._formantGains = [];

    const formants = this._config.vowelFormants;
    const frequencies = [formants.f1, formants.f2, formants.f3, formants.f4, formants.f5];

    for (let i = 0; i < frequencies.length; i++) {
      const filter = new Tone.Filter({
        type: 'bandpass',
        frequency: frequencies[i],
        Q: 8 + i * 2,
      });

      // Lower formants are louder
      const gain = new Tone.Gain(1 / (1 + i * 0.3));

      this._noise.connect(filter);
      filter.connect(gain);
      gain.connect(this._masterGain);

      this._formants.push(filter);
      this._formantGains.push(gain);
    }
  }

  start(): void {
    if (!this._isPlaying) {
      this._noise.start();
      this._isPlaying = true;
    }
  }

  stop(): void {
    if (this._isPlaying) {
      this._noise.stop();
      this._isPlaying = false;
    }
  }

  /**
   * Set wind speed to modulate the "singing" pitch.
   * Higher speeds = higher formant shifts.
   */
  setWindSpeed(speed: number): void {
    // Shift formants up with wind speed
    const shiftRatio = 1 + (speed / 30) * 0.3;
    const formants = this._config.vowelFormants;
    const baseFreqs = [formants.f1, formants.f2, formants.f3, formants.f4, formants.f5];

    for (let i = 0; i < this._formants.length; i++) {
      const shifted = (baseFreqs[i] ?? 1000) * shiftRatio;
      this._formants[i]?.frequency.rampTo(shifted, 0.5);
    }
  }

  setEnabled(enabled: boolean): void {
    this._config.enabled = enabled;
    this._output.gain.rampTo(enabled ? 1 : 0, 0.5);
  }

  setVowelFormants(formants: FormantSet): void {
    this._config.vowelFormants = formants;
    const frequencies = [formants.f1, formants.f2, formants.f3, formants.f4, formants.f5];
    for (let i = 0; i < this._formants.length; i++) {
      this._formants[i]?.frequency.rampTo(frequencies[i] ?? 1000, 0.3);
    }
  }

  updateConfig(config: Partial<SingingWindConfig>): void {
    if (config.enabled !== undefined) this.setEnabled(config.enabled);
    if (config.mode !== undefined) this._config.mode = config.mode;
    if (config.rootNote !== undefined) this._config.rootNote = config.rootNote;
    if (config.vowelFormants !== undefined) this.setVowelFormants(config.vowelFormants);
    if (config.gain !== undefined) {
      this._config.gain = config.gain;
      this._masterGain.gain.rampTo(Tone.dbToGain(config.gain), 0.1);
    }
  }

  get output(): Tone.Gain {
    return this._output;
  }

  dispose(): void {
    this.stop();
    this._noise.dispose();
    for (const f of this._formants) f.dispose();
    for (const g of this._formantGains) g.dispose();
    this._masterGain.dispose();
    this._output.dispose();
  }
}

// ============================================================================
// KatabaticLayer - Low-frequency downslope wind
// ============================================================================

class KatabaticLayer {
  private _config: KatabaticConfig;
  private _noise: Tone.Noise;
  private _lpf: Tone.Filter;
  private _lfo: Tone.LFO;
  private _lfoGain: Tone.Gain;
  private _masterGain: Tone.Gain;
  private _output: Tone.Gain;
  private _isPlaying = false;

  constructor(config: Partial<KatabaticConfig> = {}) {
    this._config = { ...DEFAULT_KATABATIC_CONFIG, ...config };

    this._noise = new Tone.Noise({ type: 'brown', volume: -6 });

    this._lpf = new Tone.Filter({
      type: 'lowpass',
      frequency: 150,
      rolloff: -48,
    });

    // LFO creates surge effect
    this._lfo = new Tone.LFO({
      frequency: this._config.surgeRate,
      min: 0.3,
      max: 1,
    });

    this._lfoGain = new Tone.Gain(1);
    this._masterGain = new Tone.Gain(Tone.dbToGain(this._config.gain));
    this._output = new Tone.Gain(this._config.enabled ? 1 : 0);

    // Connect: noise -> lpf -> lfoGain -> masterGain -> output
    this._noise.connect(this._lpf);
    this._lpf.connect(this._lfoGain);
    this._lfoGain.connect(this._masterGain);
    this._masterGain.connect(this._output);

    // LFO modulates the gain
    this._lfo.connect(this._lfoGain.gain);
  }

  start(): void {
    if (!this._isPlaying) {
      this._noise.start();
      this._lfo.start();
      this._isPlaying = true;
    }
  }

  stop(): void {
    if (this._isPlaying) {
      this._noise.stop();
      this._lfo.stop();
      this._isPlaying = false;
    }
  }

  setEnabled(enabled: boolean): void {
    this._config.enabled = enabled;
    this._output.gain.rampTo(enabled ? 1 : 0, 0.5);
  }

  updateConfig(config: Partial<KatabaticConfig>): void {
    if (config.enabled !== undefined) this.setEnabled(config.enabled);
    if (config.lowFreqBoost !== undefined) {
      this._config.lowFreqBoost = config.lowFreqBoost;
      // Adjust filter based on boost
      this._lpf.frequency.rampTo(100 + config.lowFreqBoost * 10, 0.2);
    }
    if (config.surgeRate !== undefined) {
      this._config.surgeRate = config.surgeRate;
      this._lfo.frequency.rampTo(config.surgeRate, 0.5);
    }
    if (config.gain !== undefined) {
      this._config.gain = config.gain;
      this._masterGain.gain.rampTo(Tone.dbToGain(config.gain), 0.1);
    }
  }

  get output(): Tone.Gain {
    return this._output;
  }

  dispose(): void {
    this.stop();
    this._noise.dispose();
    this._lpf.dispose();
    this._lfo.dispose();
    this._lfoGain.dispose();
    this._masterGain.dispose();
    this._output.dispose();
  }
}

// ============================================================================
// WindModule - Main orchestrator
// ============================================================================

export class WindModule {
  private _config: WindModuleConfig;
  private _bed: WindBedLayer;
  private _gust: WindGustScheduler;
  private _aeolian: AeolianToneGenerator;
  private _singing: SingingWindSynth;
  private _katabatic: KatabaticLayer;
  private _masterGain: Tone.Gain;
  private _output: Tone.Gain;
  private _windSpeed = 0;
  private _isPlaying = false;

  constructor(config: Partial<WindModuleConfig> = {}) {
    this._config = {
      ...DEFAULT_WIND_CONFIG,
      ...config,
      bed: { ...DEFAULT_BED_CONFIG, ...config.bed },
      gust: { ...DEFAULT_GUST_CONFIG, ...config.gust },
      aeolian: { ...DEFAULT_AEOLIAN_CONFIG, ...config.aeolian },
      singing: { ...DEFAULT_SINGING_CONFIG, ...config.singing },
      katabatic: { ...DEFAULT_KATABATIC_CONFIG, ...config.katabatic },
    };

    // Create layers
    this._bed = new WindBedLayer(this._config.bed);
    this._gust = new WindGustScheduler(this._config.gust);
    this._aeolian = new AeolianToneGenerator(this._config.aeolian);
    this._singing = new SingingWindSynth(this._config.singing);
    this._katabatic = new KatabaticLayer(this._config.katabatic);

    // Master output
    this._masterGain = new Tone.Gain(Tone.dbToGain(this._config.masterGain));
    this._output = new Tone.Gain(1);

    // Connect all layers to master
    this._bed.output.connect(this._masterGain);
    this._gust.output.connect(this._masterGain);
    this._aeolian.output.connect(this._masterGain);
    this._singing.output.connect(this._masterGain);
    this._katabatic.output.connect(this._masterGain);
    this._masterGain.connect(this._output);
  }

  start(): void {
    if (!this._isPlaying) {
      this._bed.start();
      this._gust.start();
      this._aeolian.start();
      this._singing.start();
      this._katabatic.start();
      this._isPlaying = true;
    }
  }

  stop(): void {
    if (this._isPlaying) {
      this._bed.stop();
      this._gust.stop();
      this._aeolian.stop();
      this._singing.stop();
      this._katabatic.stop();
      this._isPlaying = false;
    }
  }

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  /**
   * Set wind speed (0-100 scale). Affects all wind-responsive layers.
   */
  setWindSpeed(speed: number): void {
    this._windSpeed = Math.max(0, Math.min(100, speed));

    // Convert 0-100 scale to m/s (0-30 m/s range)
    const speedMs = (this._windSpeed / 100) * 30;

    // Update wind-responsive layers
    this._aeolian.setWindSpeed(speedMs);
    this._singing.setWindSpeed(speedMs);

    // Scale bed intensity with wind speed
    const bedBoost = (this._windSpeed / 100) * 12;
    this._bed.setBaseGain(this._config.bed.baseGain + bedBoost);
  }

  get windSpeed(): number {
    return this._windSpeed;
  }

  setMasterGain(db: number): void {
    this._config.masterGain = db;
    this._masterGain.gain.rampTo(Tone.dbToGain(db), 0.1);
  }

  /** Trigger a manual gust - for UI testing */
  triggerGust(intensity?: number): void {
    this._gust.triggerGust(intensity);
  }

  updateConfig(config: Partial<WindModuleConfig>): void {
    if (config.masterGain !== undefined) this.setMasterGain(config.masterGain);
    if (config.bed) this._bed.updateConfig(config.bed);
    if (config.gust) this._gust.updateConfig(config.gust);
    if (config.aeolian) this._aeolian.updateConfig(config.aeolian);
    if (config.singing) this._singing.updateConfig(config.singing);
    if (config.katabatic) this._katabatic.updateConfig(config.katabatic);

    // Merge into stored config
    this._config = {
      ...this._config,
      ...config,
      bed: { ...this._config.bed, ...config.bed },
      gust: { ...this._config.gust, ...config.gust },
      aeolian: { ...this._config.aeolian, ...config.aeolian },
      singing: { ...this._config.singing, ...config.singing },
      katabatic: { ...this._config.katabatic, ...config.katabatic },
    };
  }

  getConfig(): WindModuleConfig {
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
    windSpeed: number;
    layersEnabled: {
      bed: boolean;
      gust: boolean;
      aeolian: boolean;
      singing: boolean;
      katabatic: boolean;
    };
  } {
    return {
      isPlaying: this._isPlaying,
      windSpeed: this._windSpeed,
      layersEnabled: {
        bed: this._config.bed.enabled,
        gust: this._config.gust.enabled,
        aeolian: this._config.aeolian.enabled,
        singing: this._config.singing.enabled,
        katabatic: this._config.katabatic.enabled,
      },
    };
  }

  dispose(): void {
    this.stop();
    this._bed.dispose();
    this._gust.dispose();
    this._aeolian.dispose();
    this._singing.dispose();
    this._katabatic.dispose();
    this._masterGain.dispose();
    this._output.dispose();
  }
}
