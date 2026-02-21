/**
 * AudioWorklet processors for thunder synthesis.
 * Three processors in one file — loaded via a single addModule() call.
 *
 * phasor-generator: Sawtooth ramp [0,1) with configurable frequency and duty cycle.
 * sample-and-hold: Samples input on phasor downward zero-crossing, holds between triggers.
 * fbm-noise: Fractal Brownian Motion noise with configurable spectral slope.
 */

// Sawtooth ramp [0,1) at given frequency; drops to 0 past duty cycle (trigger edge for S&H)
class PhasorGenerator extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'frequency', defaultValue: 1, minValue: 0.001, maxValue: 100, automationRate: 'a-rate' },
      { name: 'duty', defaultValue: 0.5, minValue: 0.01, maxValue: 1.0, automationRate: 'a-rate' },
    ];
  }

  constructor() {
    super();
    this.phase = 0;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0][0];
    if (!output) return true;

    const freq = parameters.frequency;
    const duty = parameters.duty;
    const freqConst = freq.length === 1;
    const dutyConst = duty.length === 1;

    for (let i = 0; i < output.length; i++) {
      const f = freqConst ? freq[0] : freq[i];
      const d = dutyConst ? duty[0] : duty[i];

      output[i] = this.phase < d ? this.phase * (1 / d) : 0;
      this.phase += Math.max(f, 0.001) / sampleRate;
      if (this.phase >= 1) this.phase -= Math.floor(this.phase);
    }

    return true;
  }
}

// Samples channel 0 on downward zero-crossing of channel 1 (phasor), holds between triggers
class SampleAndHoldProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.prevTrigger = 0;
    this.held = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0][0];
    if (!output || !input || input.length < 2) return true;

    const signal = input[0];
    const trigger = input[1];
    if (!signal || !trigger) return true;

    for (let i = 0; i < output.length; i++) {
      // Downward zero-crossing: phasor wraps from near-1 back to near-0
      if (this.prevTrigger > 0.5 && trigger[i] < 0.5) {
        this.held = signal[i];
      }
      this.prevTrigger = trigger[i];
      output[i] = this.held;
    }

    return true;
  }
}

// fBm noise: sums multiple octaves of value noise for self-similar texture.
// persistence (gain param) controls spectral slope: 0.3=brownish, 0.5=pinkish, 0.7=whitish.
class FBMNoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gain', defaultValue: 0.5, minValue: 0.1, maxValue: 0.9, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.octaves = 5;
    this.lacunarity = 2.0;
    this.phase = Math.random() * 1000;
    // Ring buffer of random values for value noise interpolation
    this.noiseTable = new Float32Array(256);
    for (let i = 0; i < 256; i++) this.noiseTable[i] = Math.random() * 2 - 1;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0][0];
    if (!output) return true;
    const persistence = parameters.gain[0];
    const baseFreq = 1.0;

    for (let i = 0; i < output.length; i++) {
      let sum = 0;
      let amp = 1.0;
      let freq = baseFreq;
      let maxAmp = 0;

      for (let o = 0; o < this.octaves; o++) {
        const p = this.phase * freq;
        const idx = Math.floor(p) & 255;
        const frac = p - Math.floor(p);
        const a = this.noiseTable[idx];
        const b = this.noiseTable[(idx + 1) & 255];
        // Smoothstep interpolation
        const t = frac * frac * (3 - 2 * frac);
        sum += (a + (b - a) * t) * amp;

        maxAmp += amp;
        amp *= persistence;
        freq *= this.lacunarity;
      }

      output[i] = sum / maxAmp;
      this.phase += 1.0 / sampleRate;
      if (this.phase > 1e6) this.phase -= 1e6;
    }
    return true;
  }
}

registerProcessor('phasor-generator', PhasorGenerator);
registerProcessor('sample-and-hold', SampleAndHoldProcessor);
registerProcessor('fbm-noise', FBMNoiseProcessor);
