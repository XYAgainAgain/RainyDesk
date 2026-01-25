/**
 * BubbleSynthPool - Voice pool for rain bubble "plink" resonance
 *
 * Handles the Minnaert resonance - trapped air bubble oscillating underwater.
 * Uses Tone.Synth with sine oscillator and frequency chirp (pitch drop).
 */

import * as Tone from 'tone';
import { VoicePool } from './VoicePool';
import type { VoicePoolConfig, AudioParams, Voice } from '../../types/audio';

export interface BubbleSynthConfig {
  oscillatorType: 'sine' | 'triangle' | 'square' | 'sawtooth';
  attack: number;
  decayMin: number;
  decayMax: number;
  /** How much pitch drops during decay (0.1 = 10%) */
  chirpAmount: number;
  /** How long the pitch ramp takes (seconds) */
  chirpTime: number;
  freqMin: number;
  freqMax: number;
}

const DEFAULT_BUBBLE_CONFIG: BubbleSynthConfig = {
  oscillatorType: 'sine',
  attack: 0.005,
  decayMin: 0.05,
  decayMax: 0.15,
  chirpAmount: 0.1,
  chirpTime: 0.1,
  freqMin: 500,
  freqMax: 4000,
};

/**
 * Voice pool for bubble resonance sounds.
 * Includes frequency chirp to simulate bubble stabilization.
 */
export class BubbleSynthPool extends VoicePool<Tone.Synth> {
  private _synthConfig: BubbleSynthConfig;
  private _output: Tone.Gain;

  constructor(
    poolConfig: Partial<VoicePoolConfig> = {},
    synthConfig: Partial<BubbleSynthConfig> = {}
  ) {
    super(poolConfig);
    this._synthConfig = { ...DEFAULT_BUBBLE_CONFIG, ...synthConfig };
    this._output = new Tone.Gain(1);
    this.initializePool();
  }

  protected createVoice(): Voice<Tone.Synth> {
    const config = this._synthConfig;

    const synth = new Tone.Synth({
      oscillator: { type: config.oscillatorType },
      envelope: {
        attack: config.attack,
        decay: config.decayMin,
        sustain: 0,
        release: 0.01,
      },
    });

    synth.connect(this._output);

    return {
      id: this._nextId++,
      synth,
      busy: false,
      releaseTime: 0,
    };
  }

  /**
   * Trigger a bubble sound. Only fires if params.triggerBubble is true.
   * Returns the voice used, or null if skipped/pool exhausted.
   */
  trigger(params: AudioParams): Voice<Tone.Synth> | null {
    if (!params.triggerBubble) return null;

    const voice = this.acquire();
    if (!voice) return null;

    const config = this._synthConfig;

    const frequency = Math.max(config.freqMin, Math.min(config.freqMax, params.frequency));
    const volumeNormalized = Math.max(0, Math.min(1, (params.volume + 40) / 34));
    const decay = config.decayMin + (config.decayMax - config.decayMin) * volumeNormalized;

    voice.synth.envelope.decay = decay;
    voice.synth.volume.value = params.volume;

    const now = Tone.now();
    const duration = decay + config.attack + 0.02;

    voice.synth.triggerAttackRelease(frequency, duration, now);

    // Apply chirp: ramp frequency down
    const targetFreq = frequency * (1 - config.chirpAmount);
    voice.synth.frequency.setValueAtTime(frequency, now);
    voice.synth.frequency.linearRampToValueAtTime(targetFreq, now + config.chirpTime);

    // Auto-release after sound completes
    const releaseDelay = duration + 0.05;
    voice.releaseTime = performance.now() + releaseDelay * 1000;

    Tone.getTransport().scheduleOnce(() => {
      this.release(voice);
    }, now + releaseDelay);

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

  updateConfig(config: Partial<BubbleSynthConfig>): void {
    this._synthConfig = { ...this._synthConfig, ...config };
  }

  getSynthConfig(): BubbleSynthConfig {
    return { ...this._synthConfig };
  }

  override dispose(): void {
    this._output.dispose();
    super.dispose();
  }
}
