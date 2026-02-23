/**
 * BubbleSynthPool - Voice pool for rain bubble "plink" resonance
 *
 * Handles the Minnaert resonance - trapped air bubble oscillating underwater.
 * Uses Tone.Synth with sine oscillator and frequency chirp (pitch drop).
 */

import * as Tone from 'tone';
import { VoicePool } from './VoicePool';
import type { VoicePoolConfig, AudioParams, Voice, SpatialConfig } from '../../types/audio';

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
  private _panners: Map<number, Tone.Panner3D> = new Map();
  private _synthToId: Map<Tone.Synth, number> = new Map();
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
    synthConfig: Partial<BubbleSynthConfig> = {}
  ) {
    super(poolConfig);
    this._synthConfig = { ...DEFAULT_BUBBLE_CONFIG, ...synthConfig };
    this._output = new Tone.Gain(1);
    this.initializePool();
  }

  protected createVoice(): Voice<Tone.Synth> {
    const config = this._synthConfig;

    const panner = new Tone.Panner3D({
      panningModel: this._spatialConfig.panningModel,
      rolloffFactor: 0,
      positionX: 0,
      positionY: 0,
      positionZ: this._spatialConfig.fixedDepth,
    });

    const synth = new Tone.Synth({
      oscillator: { type: config.oscillatorType },
      envelope: {
        attack: config.attack,
        decay: config.decayMin,
        sustain: 0,
        release: 0.01,
      },
    });

    synth.connect(panner);
    panner.connect(this._output);

    const voice: Voice<Tone.Synth> = {
      id: this._nextId++,
      synth,
      busy: false,
      acquireTime: 0,
      releaseTime: 0,
    };

    this._panners.set(voice.id, panner);
    this._synthToId.set(synth, voice.id);
    return voice;
  }

  /** Clean up side-nodes (panner) when a voice is shrunk from the pool */
  protected override disposeSynth(synth: Tone.Synth): void {
    const id = this._synthToId.get(synth);
    if (id !== undefined) {
      const panner = this._panners.get(id);
      if (panner) { panner.dispose(); this._panners.delete(id); }
      this._synthToId.delete(synth);
    }
    super.disposeSynth(synth);
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
    const panner = this._panners.get(voice.id);

    const frequency = Math.max(config.freqMin, Math.min(config.freqMax, params.frequency));
    const volumeNormalized = Math.max(0, Math.min(1, (params.volume + 40) / 34));
    const decay = config.decayMin + (config.decayMax - config.decayMin) * volumeNormalized;

    voice.synth.envelope.decay = decay;
    voice.synth.volume.value = params.volume;

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

    this._releaseEventIds.push(Tone.getTransport().scheduleOnce(() => {
      this.release(voice);
    }, now + releaseDelay));

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
    for (const panner of this._panners.values()) {
      panner.dispose();
    }
    this._panners.clear();
    this._synthToId.clear();
    this._output.dispose();
    super.dispose();
  }
}
