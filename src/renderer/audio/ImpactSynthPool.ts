/**
 * ImpactSynthPool - Voice pool for rain impact "thud" sounds
 *
 * Handles the water hammer shockwave - a sharp, percussive click.
 * Uses Tone.NoiseSynth with pink noise and fast envelope.
 */

import * as Tone from 'tone';
import { VoicePool } from './VoicePool';
import type { VoicePoolConfig, AudioParams, Voice, SpatialConfig } from '../../types/audio';

export interface ImpactSynthConfig {
  noiseType: 'white' | 'pink' | 'brown';
  attack: number;
  decayMin: number;
  decayMax: number;
  filterFreqMin: number;
  filterFreqMax: number;
  filterQ: number;
  pitchCenter: number;    // 0-100: slider position (0 = 500 Hz fat splats, 100 = 6 kHz thin ticks)
  pitchOscAmount: number; // 0-100: per-drop random spread (100 = +/- 2 octaves)
}

const DEFAULT_IMPACT_CONFIG: ImpactSynthConfig = {
  noiseType: 'pink',
  attack: 0.001,
  decayMin: 0.03,
  decayMax: 0.08,
  filterFreqMin: 2000,
  filterFreqMax: 8000,
  filterQ: 1,
  pitchCenter: 50,
  pitchOscAmount: 0,
};

/**
 * Voice pool for impact/click sounds.
 * Each voice has a NoiseSynth routed through a bandpass filter and panner.
 */
export class ImpactSynthPool extends VoicePool<Tone.NoiseSynth> {
  private _synthConfig: ImpactSynthConfig;
  private _filters: Map<number, Tone.Filter> = new Map();
  private _panners: Map<number, Tone.Panner3D> = new Map();
  private _synthToId: Map<Tone.NoiseSynth, number> = new Map();
  private _releaseEventIds: number[] = [];
  private _output: Tone.Gain;
  private _spatialConfig: SpatialConfig = {
    enabled: false,
    panningModel: 'equalpower',
    worldScale: 5,
    fixedDepth: -2,
  };

  constructor(
    poolConfig: Partial<VoicePoolConfig> = {},
    synthConfig: Partial<ImpactSynthConfig> = {}
  ) {
    super(poolConfig);
    this._synthConfig = { ...DEFAULT_IMPACT_CONFIG, ...synthConfig };
    this._output = new Tone.Gain(1);
    this.initializePool();
  }

  protected createVoice(): Voice<Tone.NoiseSynth> {
    const config = this._synthConfig;

    const filter = new Tone.Filter({
      type: 'bandpass',
      frequency: (config.filterFreqMin + config.filterFreqMax) / 2,
      Q: config.filterQ,
    });

    const panner = new Tone.Panner3D({
      panningModel: this._spatialConfig.panningModel,
      rolloffFactor: 0,
      positionX: 0,
      positionY: 0,
      positionZ: this._spatialConfig.fixedDepth,
    });

    const synth = new Tone.NoiseSynth({
      noise: { type: config.noiseType },
      envelope: {
        attack: config.attack,
        decay: config.decayMin,
        sustain: 0,
        release: 0.01,
      },
    });

    synth.connect(filter);
    filter.connect(panner);
    panner.connect(this._output);

    const voice: Voice<Tone.NoiseSynth> = {
      id: this._nextId++,
      synth,
      busy: false,
      acquireTime: 0,
      releaseTime: 0,
    };

    this._filters.set(voice.id, filter);
    this._panners.set(voice.id, panner);
    this._synthToId.set(synth, voice.id);
    return voice;
  }

  /** Clean up side-nodes (filter + panner) when a voice is shrunk from the pool */
  protected override disposeSynth(synth: Tone.NoiseSynth): void {
    const id = this._synthToId.get(synth);
    if (id !== undefined) {
      const filter = this._filters.get(id);
      const panner = this._panners.get(id);
      if (filter) { filter.dispose(); this._filters.delete(id); }
      if (panner) { panner.dispose(); this._panners.delete(id); }
      this._synthToId.delete(synth);
    }
    super.disposeSynth(synth);
  }

  /** Trigger an impact sound. Returns the voice used, or null if pool exhausted. */
  trigger(params: AudioParams): Voice<Tone.NoiseSynth> | null {
    const voice = this.acquire();
    if (!voice) return null;

    const config = this._synthConfig;
    const filter = this._filters.get(voice.id);
    const panner = this._panners.get(voice.id);

    // Map volume to decay time (louder = longer decay)
    const volumeNormalized = Math.max(0, Math.min(1, (params.volume + 40) / 34));
    const decay = config.decayMin + (config.decayMax - config.decayMin) * volumeNormalized;

    voice.synth.envelope.decay = decay;

    if (filter) {
      // Logarithmic mapping: pitchCenter 0-100 -> 500-6000 Hz
      // 0% = 500 Hz (fat splats), 50% = ~1730 Hz (geometric midpoint), 100% = 6000 Hz (thin ticks)
      const t = config.pitchCenter / 100;
      let freq = 500 * Math.pow(6000 / 500, t);

      // Per-drop random offset when OSC amount > 0
      if (config.pitchOscAmount > 0) {
        const maxOctaves = 2 * (config.pitchOscAmount / 100);
        const octaveOffset = (Math.random() * 2 - 1) * maxOctaves;
        freq *= Math.pow(2, octaveOffset);
      }

      // Clamp to audible range
      freq = Math.max(200, Math.min(12000, freq));
      filter.frequency.value = freq;

      // Boost Q at lower frequencies for more resonant body character
      // ~1 at 6 kHz, ~4 at 500 Hz (inverse log relationship)
      const qScale = Math.max(1, 4 * (1 - Math.log(freq / 500) / Math.log(6000 / 500)));
      filter.Q.value = qScale;
    }

    // Apply spatial position
    if (panner) {
      if (params.position3d) {
        panner.positionX.value = params.position3d.x;
        panner.positionY.value = params.position3d.y;
        panner.positionZ.value = params.position3d.z;
      } else {
        panner.positionX.value = params.pan * this._spatialConfig.worldScale;
        panner.positionY.value = 0;
        panner.positionZ.value = this._spatialConfig.fixedDepth;
      }
    }

    voice.synth.volume.value = params.volume;
    voice.synth.triggerAttackRelease(decay + 0.01);

    // Auto-release after sound completes
    const releaseTime = Tone.now() + decay + 0.05;
    voice.releaseTime = performance.now() + (decay + 0.05) * 1000;

    this._releaseEventIds.push(Tone.getTransport().scheduleOnce(() => {
      this.release(voice);
    }, releaseTime));

    return voice;
  }

  connect(destination: Tone.InputNode): this {
    this._output.disconnect();
    this._output.connect(destination);
    return this;
  }

  get output(): Tone.Gain {
    return this._output;
  }

  setPitchCenter(value: number): void {
    this._synthConfig.pitchCenter = Math.max(0, Math.min(100, value));
  }

  setPitchOscAmount(value: number): void {
    this._synthConfig.pitchOscAmount = Math.max(0, Math.min(100, value));
  }

  updateConfig(config: Partial<ImpactSynthConfig>): void {
    this._synthConfig = { ...this._synthConfig, ...config };
  }

  getSynthConfig(): ImpactSynthConfig {
    return { ...this._synthConfig };
  }

  setSpatialConfig(config: Partial<SpatialConfig>): void {
    if (config.enabled !== undefined) this._spatialConfig.enabled = config.enabled;
    if (config.panningModel !== undefined) {
      this._spatialConfig.panningModel = config.panningModel;
      for (const panner of this._panners.values()) {
        panner.panningModel = config.panningModel;
      }
    }
    if (config.worldScale !== undefined) this._spatialConfig.worldScale = config.worldScale;
    if (config.fixedDepth !== undefined) this._spatialConfig.fixedDepth = config.fixedDepth;
  }

  override dispose(): void {
    // Clear pending release callbacks before disposing nodes
    for (const id of this._releaseEventIds) {
      Tone.getTransport().clear(id);
    }
    this._releaseEventIds = [];
    for (const filter of this._filters.values()) {
      filter.dispose();
    }
    for (const panner of this._panners.values()) {
      panner.dispose();
    }
    this._filters.clear();
    this._panners.clear();
    this._synthToId.clear();
    this._output.dispose();
    super.dispose();
  }
}
