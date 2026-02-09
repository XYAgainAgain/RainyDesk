/**
 * AudioBus - Configurable audio routing bus with processing
 *
 * Provides gain staging, EQ, compression, and send routing for
 * organizing audio sources into logical groups (rain, wind, thunder, matrix).
 */

import * as Tone from 'tone';
import type { BusConfig } from '../../types/audio';

const DEFAULT_BUS_CONFIG: BusConfig = {
  gain: 0,
  mute: false,
  solo: false,
  pan: 0,
  eqLow: 0,
  eqMid: 0,
  eqHigh: 0,
  compressorEnabled: false,
  compressorThreshold: -24,
  compressorRatio: 4,
  reverbSend: 0.3,
  delaySend: 0,
};

/**
 * Audio bus with gain, EQ, compression, and send routing.
 * Sources connect to input, output goes to master or other destinations.
 */
export class AudioBus {
  private _config: BusConfig;
  private _name: string;

  // Signal chain: input -> panner -> eq -> compressor -> gain -> output
  private _input: Tone.Gain;
  private _panner: Tone.Panner;
  private _eq: Tone.EQ3;
  private _compressor: Tone.Compressor;
  private _gain: Tone.Gain;
  private _output: Tone.Gain;

  // Send outputs (pre-fader)
  private _reverbSend: Tone.Gain;
  private _delaySend: Tone.Gain;

  // Split for sends
  private _preFaderSplit: Tone.Gain;

  constructor(name: string, config: Partial<BusConfig> = {}) {
    this._name = name;
    this._config = { ...DEFAULT_BUS_CONFIG, ...config };

    // Create nodes
    this._input = new Tone.Gain(1);
    this._panner = new Tone.Panner(this._config.pan);
    this._eq = new Tone.EQ3({
      low: this._config.eqLow,
      mid: this._config.eqMid,
      high: this._config.eqHigh,
    });
    this._compressor = new Tone.Compressor({
      threshold: this._config.compressorThreshold,
      ratio: this._config.compressorRatio,
      attack: 0.003,
      release: 0.25,
    });
    this._gain = new Tone.Gain(Tone.dbToGain(this._config.gain));
    this._output = new Tone.Gain(1);

    // Send gains
    this._preFaderSplit = new Tone.Gain(1);
    this._reverbSend = new Tone.Gain(this._config.reverbSend);
    this._delaySend = new Tone.Gain(this._config.delaySend);

    this.connectChain();
    this.applyMuteState();
  }

  private connectChain(): void {
    // Main signal path
    this._input.connect(this._panner);
    this._panner.connect(this._eq);
    this._eq.connect(this._preFaderSplit);

    // Pre-fader split for sends
    this._preFaderSplit.connect(this._reverbSend);
    this._preFaderSplit.connect(this._delaySend);

    // Continue main path through compressor (bypassed if disabled)
    if (this._config.compressorEnabled) {
      this._preFaderSplit.connect(this._compressor);
      this._compressor.connect(this._gain);
    } else {
      this._preFaderSplit.connect(this._gain);
    }

    this._gain.connect(this._output);
  }

  private reconnectCompressor(): void {
    // Disconnect current routing from preFaderSplit onward
    this._preFaderSplit.disconnect(this._compressor);
    this._preFaderSplit.disconnect(this._gain);
    this._compressor.disconnect();

    if (this._config.compressorEnabled) {
      this._preFaderSplit.connect(this._compressor);
      this._compressor.connect(this._gain);
    } else {
      this._preFaderSplit.connect(this._gain);
    }
  }

  private applyMuteState(): void {
    const targetGain = this._config.mute ? 0 : Tone.dbToGain(this._config.gain);
    this._gain.gain.rampTo(targetGain, 0.05);
  }

  get name(): string {
    return this._name;
  }

  get config(): BusConfig {
    return { ...this._config };
  }

  /** Input node - connect sources here */
  get input(): Tone.Gain {
    return this._input;
  }

  /** Main output - connect to master or other destination */
  get output(): Tone.Gain {
    return this._output;
  }

  /** Reverb send output - connect to reverb effect */
  get reverbSend(): Tone.Gain {
    return this._reverbSend;
  }

  /** Delay send output - connect to delay effect */
  get delaySend(): Tone.Gain {
    return this._delaySend;
  }

  /** Compressor node - for sidechain input from other sources */
  get compressor(): Tone.Compressor {
    return this._compressor;
  }

  // Config methods

  setGain(db: number): void {
    this._config.gain = db;
    if (!this._config.mute) {
      this._gain.gain.rampTo(Tone.dbToGain(db), 0.05);
    }
  }

  setMute(muted: boolean): void {
    this._config.mute = muted;
    this.applyMuteState();
  }

  setSolo(solo: boolean): void {
    this._config.solo = solo;
    // Solo logic is handled at the mixer level
  }

  setPan(pan: number): void {
    this._config.pan = Math.max(-1, Math.min(1, pan));
    this._panner.pan.rampTo(this._config.pan, 0.05);
  }

  setEQ(low?: number, mid?: number, high?: number): void {
    if (low !== undefined) {
      this._config.eqLow = low;
      this._eq.low.value = low;
    }
    if (mid !== undefined) {
      this._config.eqMid = mid;
      this._eq.mid.value = mid;
    }
    if (high !== undefined) {
      this._config.eqHigh = high;
      this._eq.high.value = high;
    }
  }

  setCompressorEnabled(enabled: boolean): void {
    if (this._config.compressorEnabled === enabled) return;
    this._config.compressorEnabled = enabled;
    this.reconnectCompressor();
  }

  setCompressorThreshold(db: number): void {
    this._config.compressorThreshold = db;
    this._compressor.threshold.value = db;
  }

  setCompressorRatio(ratio: number): void {
    this._config.compressorRatio = ratio;
    this._compressor.ratio.value = ratio;
  }

  setReverbSend(level: number): void {
    this._config.reverbSend = Math.max(0, Math.min(1, level));
    this._reverbSend.gain.rampTo(this._config.reverbSend, 0.05);
  }

  setDelaySend(level: number): void {
    this._config.delaySend = Math.max(0, Math.min(1, level));
    this._delaySend.gain.rampTo(this._config.delaySend, 0.05);
  }

  /** Apply a complete config object */
  updateConfig(config: Partial<BusConfig>): void {
    if (config.gain !== undefined) this.setGain(config.gain);
    if (config.mute !== undefined) this.setMute(config.mute);
    if (config.solo !== undefined) this.setSolo(config.solo);
    if (config.pan !== undefined) this.setPan(config.pan);
    if (config.eqLow !== undefined || config.eqMid !== undefined || config.eqHigh !== undefined) {
      this.setEQ(config.eqLow, config.eqMid, config.eqHigh);
    }
    if (config.compressorEnabled !== undefined) this.setCompressorEnabled(config.compressorEnabled);
    if (config.compressorThreshold !== undefined) this.setCompressorThreshold(config.compressorThreshold);
    if (config.compressorRatio !== undefined) this.setCompressorRatio(config.compressorRatio);
    if (config.reverbSend !== undefined) this.setReverbSend(config.reverbSend);
    if (config.delaySend !== undefined) this.setDelaySend(config.delaySend);
  }

  /** Connect a source to this bus */
  connectSource(source: Tone.ToneAudioNode): void {
    source.connect(this._input);
  }

  /** Connect output to a destination */
  connect(destination: Tone.InputNode): this {
    this._output.disconnect();
    this._output.connect(destination);
    return this;
  }

  /** Connect reverb send to a reverb effect */
  connectReverbSend(reverb: Tone.InputNode): this {
    this._reverbSend.connect(reverb);
    return this;
  }

  /** Connect delay send to a delay effect */
  connectDelaySend(delay: Tone.InputNode): this {
    this._delaySend.connect(delay);
    return this;
  }

  getStats(): {
    name: string;
    gain: number;
    muted: boolean;
    solo: boolean;
  } {
    return {
      name: this._name,
      gain: this._config.gain,
      muted: this._config.mute,
      solo: this._config.solo,
    };
  }

  dispose(): void {
    this._input.dispose();
    this._panner.dispose();
    this._eq.dispose();
    this._compressor.dispose();
    this._gain.dispose();
    this._output.dispose();
    this._preFaderSplit.dispose();
    this._reverbSend.dispose();
    this._delaySend.dispose();
  }
}
