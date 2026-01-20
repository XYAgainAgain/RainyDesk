/**
 * ImpactSynthPool - Voice pool for rain impact "thud" sounds
 *
 * Handles the water hammer shockwave - a sharp, percussive click.
 * Uses Tone.NoiseSynth with pink noise and fast envelope.
 */

import * as Tone from 'tone';
import { VoicePool } from './VoicePool';
import type { VoicePoolConfig, AudioParams, Voice } from '../../types/audio';

export interface ImpactSynthConfig {
  noiseType: 'white' | 'pink' | 'brown';
  attack: number;
  decayMin: number;
  decayMax: number;
  filterFreqMin: number;
  filterFreqMax: number;
  filterQ: number;
}

const DEFAULT_IMPACT_CONFIG: ImpactSynthConfig = {
  noiseType: 'pink',
  attack: 0.001,
  decayMin: 0.03,
  decayMax: 0.08,
  filterFreqMin: 2000,
  filterFreqMax: 8000,
  filterQ: 1,
};

/**
 * Voice pool for impact/click sounds.
 * Each voice has a NoiseSynth routed through a bandpass filter.
 */
export class ImpactSynthPool extends VoicePool<Tone.NoiseSynth> {
  private _synthConfig: ImpactSynthConfig;
  private _filters: Map<number, Tone.Filter> = new Map();
  private _output: Tone.Gain;

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
    filter.connect(this._output);

    const voice: Voice<Tone.NoiseSynth> = {
      id: this._nextId++,
      synth,
      busy: false,
      releaseTime: 0,
    };

    this._filters.set(voice.id, filter);
    return voice;
  }

  /** Trigger an impact sound. Returns the voice used, or null if pool exhausted. */
  trigger(params: AudioParams): Voice<Tone.NoiseSynth> | null {
    const voice = this.acquire();
    if (!voice) return null;

    const config = this._synthConfig;
    const filter = this._filters.get(voice.id);

    // Map volume to decay time (louder = longer decay)
    const volumeNormalized = Math.max(0, Math.min(1, (params.volume + 40) / 34));
    const decay = config.decayMin + (config.decayMax - config.decayMin) * volumeNormalized;

    voice.synth.envelope.decay = decay;

    if (filter) {
      const filterFreq = config.filterFreqMin +
        (config.filterFreqMax - config.filterFreqMin) *
        Math.min(1, params.filterFreq / 8000);
      filter.frequency.value = filterFreq;
    }

    voice.synth.volume.value = params.volume;
    voice.synth.triggerAttackRelease(decay + 0.01);

    // Auto-release after sound completes
    const releaseTime = Tone.now() + decay + 0.05;
    voice.releaseTime = performance.now() + (decay + 0.05) * 1000;

    Tone.getTransport().scheduleOnce(() => {
      this.release(voice);
    }, releaseTime);

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

  updateConfig(config: Partial<ImpactSynthConfig>): void {
    this._synthConfig = { ...this._synthConfig, ...config };
  }

  override dispose(): void {
    for (const filter of this._filters.values()) {
      filter.dispose();
    }
    this._filters.clear();
    this._output.dispose();
    super.dispose();
  }
}
