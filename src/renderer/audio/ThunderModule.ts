/**
 * ThunderModule - Physically-modeled thunder synthesis (Fineberg et al.)
 *
 * Based on "Advances in Thunder Sound Synthesis" (152nd AES Convention, 2022)
 * by Eva Fineberg, Jack Walters, and Joshua Reiss.
 *
 * Four sub-models, each representing a distinct acoustic event:
 * - DeepenerModel:   Sub-bass growl (30–80 Hz), 18.5s tail
 * - AfterimageModel: Secondary shock echo (~333 Hz), 14s tail
 * - LightningModel:  Multi-strike bandpass crack + convolution reverb
 * - RumblerModel:    Granular mid-range texture via AudioWorklet S&H
 *
 * Convolution reverb uses curated EchoThief IRs (ir-manifest.json) grouped
 * into 6 Environment pools. Per-strike IR selection gives natural variation.
 */

import * as Tone from 'tone';
import type {
  ThunderModuleConfig,
  ThunderEnvironment,
  IRManifest,
  SpatialConfig,
} from '../../types/audio';

// Clamp utility
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
// Clamp filter frequencies to safe Web Audio range
const clampFreq = (f: number) => clamp(f, 20, 22050);

const DEFAULT_CONFIG: ThunderModuleConfig = {
  masterGain: 0,
  storminess: 0,
  distance: 5.0,
  environment: 'forest',
  strikeIntensity: 0.85,
  rumbleIntensity: 0.60,
  growlIntensity: 0.75,
  sidechainEnabled: true,
  sidechainRatio: 4,
  sidechainAttack: 0.01,
  sidechainRelease: 0.5,
};

// Signal math helpers — native Web Audio replacements for SignalFunctions.js

/* Connect input + constant value into a summing GainNode */
function addSigVal(input: AudioNode, val: number, ctx: BaseAudioContext): { node: GainNode; source: ConstantSourceNode } {
  const sum = ctx.createGain();
  sum.gain.value = 1;
  input.connect(sum);
  const cs = ctx.createConstantSource();
  cs.offset.value = val;
  cs.connect(sum);
  cs.start();
  return { node: sum, source: cs };
}

/* WaveShaperNode that clamps signal to [lo, hi] */
function createClipShaper(ctx: BaseAudioContext, lo = -1, hi = 1): WaveShaperNode {
  const ws = ctx.createWaveShaper();
  const n = 8192;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.max(lo, Math.min(hi, x));
  }
  ws.curve = curve;
  ws.oversample = 'none';
  return ws;
}

/* WaveShaperNode: max(x, 0) */
function createMaxZeroShaper(ctx: BaseAudioContext): WaveShaperNode {
  const ws = ctx.createWaveShaper();
  const n = 8192;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.max(0, x);
  }
  ws.curve = curve;
  ws.oversample = 'none';
  return ws;
}

/* Schedule a multi-segment gain envelope with per-segment amplitude + time jitter */
function scheduleEnvelope(
  param: AudioParam,
  segments: [number, number][], // [time, value] pairs
  startTime: number,
  jitter = 0.2,
  timeJitter = 0.15,
): void {
  let accumTime = 0;
  for (const [t, v] of segments) {
    const jitteredVal = v * (1 + (Math.random() * 2 - 1) * jitter);
    // Time jitter: offset each segment ±timeJitter, but never go backwards
    const jitteredTime = t === 0 ? 0 : t * (1 + (Math.random() * 2 - 1) * timeJitter);
    const safeTime = Math.max(accumTime + 0.001, jitteredTime);
    accumTime = safeTime;

    if (t === 0) {
      param.setValueAtTime(Math.max(0, jitteredVal), startTime);
    } else {
      param.linearRampToValueAtTime(Math.max(0, jitteredVal), startTime + safeTime);
    }
  }
}

// IRCache — LRU cache for decoded AudioBuffers

class IRCache {
  private _cache = new Map<string, AudioBuffer>();
  private _order: string[] = [];
  private _pending = new Map<string, Promise<AudioBuffer | null>>();
  private _maxSize: number;

  constructor(maxSize = 8) {
    this._maxSize = maxSize;
  }

  async loadIR(name: string, basePath: string): Promise<AudioBuffer | null> {
    // Already cached
    if (this._cache.has(name)) {
      // Move to end (most recently used)
      this._order = this._order.filter(n => n !== name);
      this._order.push(name);
      return this._cache.get(name)!;
    }

    // Dedup concurrent loads for the same IR
    if (this._pending.has(name)) {
      return this._pending.get(name)!;
    }

    const promise = this._doLoad(name, basePath);
    this._pending.set(name, promise);

    try {
      return await promise;
    } finally {
      this._pending.delete(name);
    }
  }

  private async _doLoad(name: string, basePath: string): Promise<AudioBuffer | null> {
    try {
      const url = `${basePath}/${name}.ogg`;
      const resp = await fetch(url);
      if (!resp.ok) {
        console.warn(`[IRCache] Failed to fetch ${url}: ${resp.status}`);
        return null;
      }
      const arrayBuf = await resp.arrayBuffer();
      const ctx = Tone.getContext().rawContext;
      const audioBuf = await ctx.decodeAudioData(arrayBuf);

      // Evict oldest if at capacity
      if (this._cache.size >= this._maxSize) {
        const oldest = this._order.shift();
        if (oldest) this._cache.delete(oldest);
      }

      this._cache.set(name, audioBuf);
      this._order.push(name);
      return audioBuf;
    } catch (err) {
      console.warn(`[IRCache] Decode error for ${name}:`, err);
      return null;
    }
  }

  clear(): void {
    this._cache.clear();
    this._order = [];
  }
}

// DeepenerModel — Sub-bass growl (30–120 Hz, distance-scaled duration)

class DeepenerModel {
  trigger(
    growlIntensity: number,
    distance: number,
    output: AudioNode,
  ): number {
    const ctx = Tone.getContext().rawContext;
    const now = ctx.currentTime;
    const delay = distance * 0.08;
    const start = now + delay;

    const noise = new Tone.Noise('white');

    // Per-strike filter frequency randomization for tonal variety
    const lp1Freq = 45 + Math.random() * 30;  // 45–75 Hz
    const hpFreq = 20 + Math.random() * 20;   // 20–40 Hz
    const lp2Freq = 90 + Math.random() * 60;  // 90–150 Hz

    const lp1 = ctx.createBiquadFilter();
    lp1.type = 'lowpass'; lp1.frequency.value = clampFreq(lp1Freq); lp1.Q.value = 3;

    const hp1 = ctx.createBiquadFilter();
    hp1.type = 'highpass'; hp1.frequency.value = clampFreq(hpFreq); hp1.Q.value = 3;

    const drive = ctx.createGain();
    drive.gain.value = 3.5;

    const clip = createClipShaper(ctx);

    const lp2 = ctx.createBiquadFilter();
    lp2.type = 'lowpass'; lp2.frequency.value = clampFreq(lp2Freq); lp2.Q.value = 3;

    const envGain = ctx.createGain();
    envGain.gain.value = 0;

    Tone.connect(noise, lp1);
    lp1.connect(hp1);
    hp1.connect(drive);
    drive.connect(clip);
    clip.connect(lp2);
    lp2.connect(envGain);
    envGain.connect(output as any);

    const g = growlIntensity;
    // Close = fast attack/short tail, far = slow build/long tail
    const ts = clamp(0.6 + distance * 0.1, 0.6, 2.0);
    const pk = () => 0.6 + Math.random() * 0.8; // Per-peak random ×0.6–1.4
    scheduleEnvelope(envGain.gain, [
      [0, g * 6 * pk()],
      [2.0 * ts, g * 1.75 * pk()],
      [3.5 * ts, g * 5 * pk()],
      [6.0 * ts, g * 1.5 * pk()],
      [8.0 * ts, g * 4.15 * pk()],
      [12.0 * ts, g * 1.2 * pk()],
      [16.0 * ts, g * 0.3 * pk()],
      [20.0 * ts, g * 0.04],
      [24.0 * ts, g * 0.001],
    ], start, 0.2, 0.2);

    noise.start(start);

    const envDuration = 24.0 * ts;
    const lifetime = delay + envDuration + 0.5;
    setTimeout(() => {
      try {
        noise.stop();
        noise.dispose();
        lp1.disconnect(); hp1.disconnect(); drive.disconnect();
        clip.disconnect(); lp2.disconnect(); envGain.disconnect();
      } catch { /* already disposed */ }
    }, lifetime * 1000);

    return lifetime;
  }
}

// AfterimageModel — Secondary shock echo (333 Hz, 14s)

class AfterimageModel {
  trigger(
    strikeIntensity: number,
    distance: number,
    output: AudioNode,
  ): number {
    const ctx = Tone.getContext().rawContext;
    const now = ctx.currentTime;
    const delay = distance * 0.08;
    const start = now + delay;

    const wn1 = new Tone.Noise('white');
    const wn2 = new Tone.Noise('white');

    // WN1 → LP 33Hz (swept to 0 over 14s) → ×80 boost modulates WN2's gain
    const lp1 = ctx.createBiquadFilter();
    lp1.type = 'lowpass';
    lp1.frequency.setValueAtTime(clampFreq(33), start);
    lp1.frequency.linearRampToValueAtTime(clampFreq(0.01), start + 14);
    lp1.Q.value = 1;

    const boost = ctx.createGain();
    boost.gain.value = 80;

    // WN2 through gain node, boosted WN1 modulates .gain (signal multiplication)
    const mult = ctx.createGain();
    mult.gain.value = 0; // will be modulated
    Tone.connect(wn2, mult);

    Tone.connect(wn1, lp1);
    lp1.connect(boost);
    boost.connect(mult.gain);

    const clip = createClipShaper(ctx);

    // Bandpass 333 Hz Q4 — characteristic afterimage resonance
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = clampFreq(333); bp.Q.value = 4;

    const envGain = ctx.createGain();
    envGain.gain.value = 0;

    const si = strikeIntensity;
    scheduleEnvelope(envGain.gain, [
      [0, si * 2],
      [0.3, si * 0.4],
      [0.8, si * 1.5],
      [1.2, si * 0.25],
      [2.0, si * 1.25],
      [3.0, si * 0.6],
      [5.0, si * 1.15],
      [7.0, si * 0.35],
      [9.5, si * 0.15],
      [14.0, si * 0.001],
    ], start);

    const outScale = ctx.createGain();
    outScale.gain.value = 0.4;

    mult.connect(clip);
    clip.connect(bp);
    bp.connect(envGain);
    envGain.connect(outScale);
    outScale.connect(output as any);

    wn1.start(start);
    wn2.start(start);

    const lifetime = delay + 14.5 + 0.5;
    setTimeout(() => {
      try {
        wn1.stop(); wn1.dispose();
        wn2.stop(); wn2.dispose();
        lp1.disconnect(); boost.disconnect(); mult.disconnect();
        clip.disconnect(); bp.disconnect(); envGain.disconnect();
        outScale.disconnect();
      } catch { /* already disposed */ }
    }, lifetime * 1000);

    return lifetime;
  }
}

// LightningModel — Multi-strike bandpass crack with convolution reverb

class LightningModel {
  private _workletReady = false;

  setWorkletReady(): void {
    this._workletReady = true;
  }

  trigger(
    strikeIntensity: number,
    distance: number,
    numStrikes: number,
    irBuffer: AudioBuffer | null,
    output: AudioNode,
  ): number {
    const ctx = Tone.getContext().rawContext;
    const now = ctx.currentTime;
    const baseDelay = distance * 0.08;
    let maxLifetime = 0;

    // Wet/dry crossfade: close = mostly dry, far = mostly wet (reverb)
    const wetRatio = clamp(0.2 + (distance / 15) * 0.65, 0.2, 0.85);

    let convolver: ConvolverNode | null = null;
    let dryGain: GainNode;
    let wetGain: GainNode;
    const preConvMix = ctx.createGain(); // All strikes feed here

    if (irBuffer) {
      convolver = ctx.createConvolver();
      convolver.buffer = irBuffer;
      convolver.normalize = true;

      wetGain = ctx.createGain();
      wetGain.gain.value = wetRatio;
      dryGain = ctx.createGain();
      dryGain.gain.value = 1 - wetRatio;

      preConvMix.connect(convolver);
      convolver.connect(wetGain);
      preConvMix.connect(dryGain);
      wetGain.connect(output as any);
      dryGain.connect(output as any);
    } else {
      // No IR — all dry
      dryGain = ctx.createGain();
      dryGain.gain.value = 1;
      preConvMix.connect(dryGain);
      dryGain.connect(output as any);
      wetGain = ctx.createGain();
    }

    for (let s = 0; s < numStrikes; s++) {
      // Return strokes land within auditory fusion window (< 50ms)
      const strikeDelay = s === 0 ? 0 : 0.008 + Math.random() * 0.042;
      const strikeTime = now + baseDelay + strikeDelay;

      const useNoise = s % 2 === 1;

      // Return strokes diminish — first is the main event, each re-strike is weaker
      const strikeOut = ctx.createGain();
      strikeOut.gain.value = s === 0 ? 1.0 : 1.0 / (1 + s * 1.5);

      // Phase 1: White noise snap (25–60ms, LP capped at 2kHz)
      const snapNoise = new Tone.Noise('white');
      const snapLP = ctx.createBiquadFilter();
      snapLP.type = 'lowpass';
      snapLP.frequency.value = clampFreq(2000);
      snapLP.Q.value = 0.7;
      const snapGain = ctx.createGain();
      snapGain.gain.value = strikeIntensity * 6;
      Tone.connect(snapNoise, snapLP);
      snapLP.connect(snapGain);
      snapGain.connect(strikeOut);
      const snapDur = 0.025 + Math.random() * 0.035;
      snapNoise.start(strikeTime);
      snapNoise.stop(strikeTime + snapDur);

      // Phase 2: Brown noise thump (800ms with extended sustain)
      const thumpNoise = new Tone.Noise('brown');
      const thumpLP = ctx.createBiquadFilter();
      thumpLP.type = 'lowpass';
      thumpLP.frequency.setValueAtTime(clampFreq(2000), strikeTime);
      thumpLP.frequency.exponentialRampToValueAtTime(clampFreq(120), strikeTime + 0.8);
      thumpLP.Q.value = 0.5;
      const thumpEnv = ctx.createGain();
      thumpEnv.gain.value = 0;
      thumpEnv.gain.setValueAtTime(strikeIntensity * 4, strikeTime);
      thumpEnv.gain.linearRampToValueAtTime(strikeIntensity * 2.5, strikeTime + 0.03);
      thumpEnv.gain.linearRampToValueAtTime(strikeIntensity * 2.0, strikeTime + 0.3);
      thumpEnv.gain.linearRampToValueAtTime(strikeIntensity * 1.0, strikeTime + 0.6);
      thumpEnv.gain.exponentialRampToValueAtTime(0.01, strikeTime + 0.8);
      Tone.connect(thumpNoise, thumpLP);
      thumpLP.connect(thumpEnv);
      thumpEnv.connect(strikeOut);
      thumpNoise.start(strikeTime);
      thumpNoise.stop(strikeTime + 0.85);

      // Phase 3: Concussive boom (60–300 Hz, 2s sustain)
      const boomNoise = new Tone.Noise('brown');
      const boomLP = ctx.createBiquadFilter();
      boomLP.type = 'lowpass';
      boomLP.frequency.value = clampFreq(200 + Math.random() * 150);
      boomLP.Q.value = 0.7;
      const boomHP = ctx.createBiquadFilter();
      boomHP.type = 'highpass';
      boomHP.frequency.value = clampFreq(40 + Math.random() * 30);
      boomHP.Q.value = 0.7;
      // Closer = tighter crack-to-boom gap, less jitter. Normalized to Lightning's 0.5–5km range.
      const distNorm = clamp((distance - 0.5) / 4.5, 0, 1);
      const boomOffset = 0.2 + distNorm * 0.35 + Math.random() * distNorm * 0.2;
      const boomStart = strikeTime + boomOffset;
      const boomEnv = ctx.createGain();
      boomEnv.gain.value = 0;
      boomEnv.gain.setValueAtTime(0, strikeTime);
      boomEnv.gain.linearRampToValueAtTime(strikeIntensity * 3.5, boomStart);
      boomEnv.gain.linearRampToValueAtTime(strikeIntensity * 2.5, boomStart + 0.08);
      boomEnv.gain.linearRampToValueAtTime(strikeIntensity * 2.0, boomStart + 0.8);
      boomEnv.gain.linearRampToValueAtTime(strikeIntensity * 1.2, boomStart + 1.5);
      boomEnv.gain.linearRampToValueAtTime(strikeIntensity * 0.3, boomStart + 2.5);
      boomEnv.gain.exponentialRampToValueAtTime(0.01, boomStart + 3.5);
      Tone.connect(boomNoise, boomLP);
      boomLP.connect(boomHP);
      boomHP.connect(boomEnv);
      boomEnv.connect(strikeOut);
      boomNoise.start(strikeTime);
      boomNoise.stop(boomStart + 3.6);

      setTimeout(() => {
        try {
          snapNoise.dispose(); snapLP.disconnect(); snapGain.disconnect();
          thumpNoise.dispose(); thumpLP.disconnect(); thumpEnv.disconnect();
          boomNoise.dispose(); boomLP.disconnect(); boomHP.disconnect(); boomEnv.disconnect();
        } catch {}
      }, (baseDelay + strikeDelay + 4.5) * 1000);

      // Subtle multipath echo
      const fbDelay = ctx.createDelay(1);
      fbDelay.delayTime.value = 0.3;
      const fbGain = ctx.createGain();
      fbGain.gain.value = 0.04;

      strikeOut.connect(fbDelay);
      fbDelay.connect(fbGain);
      fbGain.connect(fbDelay);
      strikeOut.connect(preConvMix);
      fbGain.connect(preConvMix);

      // Bandpass channels start 30ms after crack for separation
      const bpOffset = 0.03;
      let longestDecay = 0;

      const bpStart = strikeTime + bpOffset;

      for (let m = 0; m < 4; m++) {
        const r1 = Math.random();
        const r2 = Math.random();

        // Per paper: f = r × 1200 + 80, T = 240 × (1.4 − r)^5 ms
        // Stretched ×2.5 with 150ms floor so mid-freq content overlaps with rumble
        const freq1 = clampFreq(r1 * 1200 + 80);
        const freq2 = clampFreq(r2 * 1200 + 80);
        const decay1 = Math.max(0.15, 240 * Math.pow(1.4 - r1, 5) / 1000 * 2.5);
        const decay2 = Math.max(0.15, 240 * Math.pow(1.4 - r2, 5) / 1000 * 2.5);
        const maxDecay = Math.max(decay1, decay2);
        if (maxDecay > longestDecay) longestDecay = maxDecay + bpOffset;

        const chGain = ctx.createGain();
        chGain.gain.setValueAtTime(strikeIntensity * 2, bpStart);
        chGain.gain.linearRampToValueAtTime(0.001, bpStart + maxDecay);

        const bp1 = ctx.createBiquadFilter();
        bp1.type = 'bandpass'; bp1.Q.value = 3;
        bp1.frequency.setValueAtTime(freq1, bpStart);
        bp1.frequency.linearRampToValueAtTime(clampFreq(freq1 / 2), bpStart + decay1);

        const bp2 = ctx.createBiquadFilter();
        bp2.type = 'bandpass'; bp2.Q.value = 3;
        bp2.frequency.setValueAtTime(freq2, bpStart);
        bp2.frequency.linearRampToValueAtTime(clampFreq(freq2 / 2), bpStart + decay2);

        if (useNoise) {
          // Prefer fBm noise for organic, self-similar crack texture
          if (this._workletReady) {
            try {
              const fbm = new AudioWorkletNode(ctx, 'fbm-noise');
              const gainParam = fbm.parameters.get('gain');
              if (gainParam) gainParam.value = 0.5; // Pinkish spectrum
              fbm.connect(bp1);
              setTimeout(() => { try { fbm.disconnect(); } catch {} }, (strikeDelay + bpOffset + maxDecay + 1) * 1000);
            } catch {
              const noise = new Tone.Noise('white');
              Tone.connect(noise, bp1);
              noise.start(bpStart);
              noise.stop(bpStart + maxDecay + 0.1);
              setTimeout(() => { try { noise.dispose(); } catch {} }, (strikeDelay + bpOffset + maxDecay + 1) * 1000);
            }
          } else {
            const noise = new Tone.Noise('white');
            Tone.connect(noise, bp1);
            noise.start(bpStart);
            noise.stop(bpStart + maxDecay + 0.1);
            setTimeout(() => { try { noise.dispose(); } catch {} }, (strikeDelay + bpOffset + maxDecay + 1) * 1000);
          }
        } else {
          // Crackle: 20 short DC pulses that excite the bandpass filters
          const pulseNodes: ConstantSourceNode[] = [];
          for (let p = 0; p < 20; p++) {
            const pulseTime = bpStart + Math.random() * maxDecay * 0.3;
            const cs = ctx.createConstantSource();
            cs.offset.value = (Math.random() > 0.5 ? 1 : -1) * strikeIntensity;
            cs.connect(bp1);
            cs.start(pulseTime);
            cs.stop(pulseTime + 0.0005);
            pulseNodes.push(cs);
          }
          setTimeout(() => {
            for (const cs of pulseNodes) {
              try { cs.disconnect(); } catch {}
            }
          }, (strikeDelay + bpOffset + maxDecay + 1) * 1000);
        }

        bp1.connect(bp2);
        bp2.connect(chGain);
        chGain.connect(strikeOut);

        setTimeout(() => {
          try {
            bp1.disconnect(); bp2.disconnect(); chGain.disconnect();
          } catch {}
        }, (strikeDelay + maxDecay + 2) * 1000);
      }

      // ~40% stochastic branch: extra overlapping channel pair
      if (Math.random() < 0.4 && s < numStrikes - 1) {
        const branchDelay = Math.random() * 0.3;
        const r = Math.random();
        const bpFreq = clampFreq(r * 1200 + 80);
        const bpDecay = Math.max(0.15, 240 * Math.pow(1.4 - r, 5) / 1000 * 2.5);

        const branchNoise = new Tone.Noise('white');
        const branchBp = ctx.createBiquadFilter();
        branchBp.type = 'bandpass'; branchBp.Q.value = 3;
        branchBp.frequency.setValueAtTime(bpFreq, strikeTime + branchDelay);
        branchBp.frequency.linearRampToValueAtTime(clampFreq(bpFreq / 2), strikeTime + branchDelay + bpDecay);

        const branchGain = ctx.createGain();
        branchGain.gain.setValueAtTime(strikeIntensity * 1.5, strikeTime + branchDelay);
        branchGain.gain.linearRampToValueAtTime(0.001, strikeTime + branchDelay + bpDecay);

        Tone.connect(branchNoise, branchBp);
        branchBp.connect(branchGain);
        branchGain.connect(strikeOut);

        branchNoise.start(strikeTime + branchDelay);
        branchNoise.stop(strikeTime + branchDelay + bpDecay + 0.1);

        setTimeout(() => {
          try { branchNoise.dispose(); branchBp.disconnect(); branchGain.disconnect(); } catch {}
        }, (strikeDelay + branchDelay + bpDecay + 2) * 1000);

        if (branchDelay + bpDecay > longestDecay) longestDecay = branchDelay + bpDecay;
      }

      const strikeLifetime = strikeDelay + longestDecay + 2;
      setTimeout(() => {
        try {
          strikeOut.disconnect(); fbDelay.disconnect(); fbGain.disconnect();
        } catch {}
      }, strikeLifetime * 1000);

      if (strikeLifetime > maxLifetime) maxLifetime = strikeLifetime;
    }

    const totalLifetime = maxLifetime + 3;
    setTimeout(() => {
      try {
        preConvMix.disconnect();
        convolver?.disconnect();
        dryGain?.disconnect();
        wetGain?.disconnect();
      } catch {}
    }, totalLifetime * 1000);

    return totalLifetime;
  }
}

// RumblerModel — Granular mid-range texture via S&H worklet

class RumblerModel {
  private _workletReady = false;

  setWorkletReady(): void {
    this._workletReady = true;
  }

  trigger(
    rumbleIntensity: number,
    distance: number,
    output: AudioNode,
  ): number {
    if (!this._workletReady) return 0;

    const ctx = Tone.getContext().rawContext;
    const now = ctx.currentTime;
    const delay = distance * 0.08;
    const start = now + delay;

    // Path A: fBm noise → LP sweep 1000→0Hz/12s → max(x,0) → envelope → +1 → phasor frequency
    // fBm with persistence 0.3 = brownish (low-freq heavy, richer sub-harmonics than flat white)
    let wn1: Tone.Noise | null = null;
    let fbm1: AudioWorkletNode | null = null;
    try {
      fbm1 = new AudioWorkletNode(ctx, 'fbm-noise');
      const gainParam = fbm1.parameters.get('gain');
      if (gainParam) gainParam.value = 0.3;
    } catch {
      wn1 = new Tone.Noise('white');
    }

    // Close = punchy/short rumble, far = stretched/rolling rumble
    const ts = clamp(0.4 + distance * 0.12, 0.4, 1.5);

    const lpA = ctx.createBiquadFilter();
    lpA.type = 'lowpass';
    lpA.frequency.setValueAtTime(clampFreq(1000), start);
    lpA.frequency.linearRampToValueAtTime(clampFreq(0.1), start + 14 * ts);
    lpA.Q.value = 1;

    const maxZeroA = createMaxZeroShaper(ctx);

    const envGainA = ctx.createGain();
    envGainA.gain.value = 0;
    const ri = rumbleIntensity;
    scheduleEnvelope(envGainA.gain, [
      [0, ri * 2.5],
      [0.5 * ts, ri * 0.15],
      [0.8 * ts, ri * 1.7],
      [1.0 * ts, ri * 0.12],
      [1.3 * ts, ri * 0.8],
      [2.0 * ts, ri * 0.25],
      [6.0 * ts, ri * 0.08],
      [9.0 * ts, ri * 0.03],
      [13.0 * ts, ri * 0.00001],
    ], start);

    // +1 offset prevents zero-frequency phasor stall
    const { node: freqSignal, source: offsetSource } = addSigVal(envGainA, 1, ctx);

    let phasor: AudioWorkletNode;
    try {
      phasor = new AudioWorkletNode(ctx, 'phasor-generator');
    } catch {
      if (wn1) wn1.dispose();
      if (fbm1) fbm1.disconnect();
      offsetSource.stop(); offsetSource.disconnect();
      return 0;
    }

    const phasorFreqParam = phasor.parameters.get('frequency');
    if (phasorFreqParam) {
      freqSignal.connect(phasorFreqParam);
    }

    // Path B: fBm noise → LP sweep → S&H → ×0.4 → HP 300Hz → envelope → output
    let wn2: Tone.Noise | null = null;
    let fbm2: AudioWorkletNode | null = null;
    try {
      fbm2 = new AudioWorkletNode(ctx, 'fbm-noise');
      const gainParam = fbm2.parameters.get('gain');
      if (gainParam) gainParam.value = 0.3;
    } catch {
      wn2 = new Tone.Noise('white');
    }

    const lpB = ctx.createBiquadFilter();
    lpB.type = 'lowpass';
    lpB.frequency.setValueAtTime(clampFreq(1000), start);
    lpB.frequency.linearRampToValueAtTime(clampFreq(0.1), start + 14 * ts);
    lpB.Q.value = 1;

    // S&H: channel 0 = filtered noise, channel 1 = phasor trigger
    let sah: AudioWorkletNode;
    try {
      sah = new AudioWorkletNode(ctx, 'sample-and-hold', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: 'explicit',
      });
    } catch {
      if (wn1) wn1.dispose();
      if (wn2) wn2.dispose();
      if (fbm1) fbm1.disconnect();
      if (fbm2) fbm2.disconnect();
      offsetSource.stop(); offsetSource.disconnect();
      phasor.disconnect();
      return 0;
    }

    const merger = ctx.createChannelMerger(2);
    if (fbm2) {
      fbm2.connect(lpB);
    } else if (wn2) {
      Tone.connect(wn2, lpB);
    }
    lpB.connect(merger, 0, 0);   // signal → channel 0
    phasor.connect(merger, 0, 1); // trigger → channel 1
    merger.connect(sah);

    // Post-S&H: scale down then highpass to remove mud
    const scaleDown = ctx.createGain();
    scaleDown.gain.value = 0.4;
    sah.connect(scaleDown);

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = clampFreq(300); hp.Q.value = 9;
    scaleDown.connect(hp);

    // Mirrors Path A's undulating envelope shape
    const envGainB = ctx.createGain();
    envGainB.gain.value = 0;
    scheduleEnvelope(envGainB.gain, [
      [0, ri * 2.5],
      [0.5 * ts, ri * 0.15],
      [0.8 * ts, ri * 1.7],
      [1.0 * ts, ri * 0.12],
      [1.3 * ts, ri * 0.8],
      [2.0 * ts, ri * 0.25],
      [6.0 * ts, ri * 0.08],
      [9.0 * ts, ri * 0.03],
      [13.0 * ts, ri * 0.00001],
    ], start);

    hp.connect(envGainB);
    envGainB.connect(output as any);

    if (fbm1) {
      fbm1.connect(lpA);
    } else if (wn1) {
      Tone.connect(wn1, lpA);
    }
    lpA.connect(maxZeroA);
    maxZeroA.connect(envGainA);

    // fBm AudioWorkletNodes produce output immediately; Tone.Noise needs start()
    if (wn1) wn1.start(start);
    if (wn2) wn2.start(start);

    const lifetime = delay + 13.5 * ts + 0.5;
    setTimeout(() => {
      try {
        if (wn1) { wn1.stop(); wn1.dispose(); }
        if (wn2) { wn2.stop(); wn2.dispose(); }
        if (fbm1) fbm1.disconnect();
        if (fbm2) fbm2.disconnect();
        offsetSource.stop(); offsetSource.disconnect();
        lpA.disconnect(); maxZeroA.disconnect(); envGainA.disconnect();
        freqSignal.disconnect(); phasor.disconnect();
        lpB.disconnect(); merger.disconnect(); sah.disconnect();
        scaleDown.disconnect(); hp.disconnect(); envGainB.disconnect();
      } catch { /* already disposed */ }
    }, lifetime * 1000);

    return lifetime;
  }
}

// PreStrikeCrackleModel — Escalating HP noise bursts before the main crack (< 3 km only)

class PreStrikeCrackleModel {
  private _workletReady = false;

  setWorkletReady(): void {
    this._workletReady = true;
  }

  trigger(
    intensity: number,
    distance: number,
    output: AudioNode,
  ): number {
    // High-freq crackle only survives atmospheric absorption within ~3 km
    if (distance >= 3) return 0;

    const ctx = Tone.getContext().rawContext;
    const now = ctx.currentTime;

    const preRollDuration = 0.2 + Math.random() * 0.6;
    const startTime = now;
    const nodes: AudioNode[] = [];

    // Shared noise source — fBm for organic fractal texture, pink as fallback.
    // One source fans out to all impulse filter chains; gain gates provide timing.
    let fbmNode: AudioWorkletNode | null = null;
    let toneNoise: Tone.Noise | null = null;

    if (this._workletReady) {
      try {
        fbmNode = new AudioWorkletNode(ctx, 'fbm-noise');
        const gainParam = fbmNode.parameters.get('gain');
        if (gainParam) gainParam.value = 0.6; // Between pink and white
      } catch {
        toneNoise = new Tone.Noise('pink');
      }
    } else {
      toneNoise = new Tone.Noise('pink');
    }

    const connectSource = (dest: AudioNode) => {
      if (fbmNode) fbmNode.connect(dest);
      else if (toneNoise) Tone.connect(toneNoise, dest);
    };

    // Gain-gated impulse with per-impulse stereo position
    const addImpulse = (t: number, dur: number, amp: number) => {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = clampFreq(800 + Math.random() * 2200);
      hp.Q.value = 2 + Math.random() * 3;

      const gate = ctx.createGain();
      gate.gain.value = 0;
      gate.gain.setValueAtTime(amp, startTime + t);
      gate.gain.setValueAtTime(0, startTime + t + dur);

      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.random() * 2 - 1;

      connectSource(hp);
      hp.connect(gate);
      gate.connect(panner);
      panner.connect(output as any);

      nodes.push(hp, gate, panner);
    };

    // Poisson process with escalating density: 4 quarters, each 2× the previous rate.
    // baseRate scales inversely with duration to keep total around 25 impulses.
    const baseRate = Math.round(100 / (15 * preRollDuration));
    const quarterDur = preRollDuration / 4;
    let t = 0;
    let impulseCount = 0;
    const maxImpulses = 40;

    for (let q = 0; q < 4; q++) {
      const rate = baseRate * Math.pow(2, q);
      const quarterEnd = (q + 1) * quarterDur;

      while (t < quarterEnd && impulseCount < maxImpulses) {
        const gap = -Math.log(Math.max(0.001, Math.random())) / rate;
        t += gap;
        if (t >= preRollDuration) break;

        const progress = t / preRollDuration;
        const impulseDur = 0.0005 + Math.random() * 0.0025;
        addImpulse(t, impulseDur, intensity * (0.1 + 0.3 * progress));
        impulseCount++;
      }
    }
    if (impulseCount >= maxImpulses) t = preRollDuration;

    // Final burst: 8–12 tightly clustered impulses in the last 100ms
    const burstCount = Math.min(8 + Math.floor(Math.random() * 5), maxImpulses - impulseCount);
    const burstStart = preRollDuration - 0.1;
    for (let b = 0; b < burstCount; b++) {
      const bt = burstStart + Math.random() * 0.1;
      const impulseDur = 0.0005 + Math.random() * 0.002;
      addImpulse(bt, impulseDur, intensity * (0.3 + Math.random() * 0.2));
    }

    if (toneNoise) {
      toneNoise.start(startTime);
      toneNoise.stop(startTime + preRollDuration + 0.1);
    }

    const lifetime = preRollDuration + 0.5;
    setTimeout(() => {
      if (toneNoise) {
        try { toneNoise.dispose(); } catch {}
      }
      if (fbmNode) {
        try { fbmNode.disconnect(); } catch {}
      }
      for (const node of nodes) {
        try { node.disconnect(); } catch {}
      }
    }, lifetime * 1000);

    return preRollDuration;
  }
}

// ThunderModule — Main orchestrator

export class ThunderModule {
  private _config: ThunderModuleConfig;
  private _deepener = new DeepenerModel();
  private _afterimage = new AfterimageModel();
  private _lightning = new LightningModel();
  private _rumbler = new RumblerModel();
  private _crackle = new PreStrikeCrackleModel();

  private _irCache = new IRCache(8);
  private _irManifest: IRManifest | null = null;
  private _irBasePath = './sounds/irs';

  private _masterGain: Tone.Gain;
  private _panner3d: Tone.Panner3D;
  private _output: Tone.Gain;

  // Sidechain: duck rain/wind buses during thunder
  private _sidechain: Tone.Compressor;
  private _sidechainEnvelope: Tone.Gain;

  // Auto-scheduling
  private _autoScheduleId: ReturnType<typeof setTimeout> | null = null;
  private _isAutoMode = false;

  private _disposeTimeouts: ReturnType<typeof setTimeout>[] = [];
  private _duckCallback: ((amount: number, attackSec: number, releaseSec: number) => void) | null = null;

  private _spatialConfig: SpatialConfig = {
    enabled: false,
    panningModel: 'equalpower',
    worldScale: 5,
    fixedDepth: -2,
  };

  constructor(config: Partial<ThunderModuleConfig> = {}) {
    this._config = { ...DEFAULT_CONFIG, ...config };

    this._masterGain = new Tone.Gain(Tone.dbToGain(this._config.masterGain));
    this._panner3d = new Tone.Panner3D({
      panningModel: this._spatialConfig.panningModel,
      rolloffFactor: 0,
      positionX: 0,
      positionY: this._spatialConfig.worldScale * 0.5,
      positionZ: this._spatialConfig.fixedDepth,
    });
    this._output = new Tone.Gain(1);

    this._masterGain.connect(this._panner3d);
    this._panner3d.connect(this._output);

    this._sidechain = new Tone.Compressor({
      threshold: -24,
      ratio: this._config.sidechainRatio,
      attack: this._config.sidechainAttack,
      release: this._config.sidechainRelease,
    });
    this._sidechainEnvelope = new Tone.Gain(0);
    this._sidechainEnvelope.connect(this._sidechain);
  }

  /* Load IR manifest (async, called after construction) */
  async init(): Promise<void> {
    try {
      const resp = await fetch(`${this._irBasePath}/ir-manifest.json`);
      if (resp.ok) {
        this._irManifest = await resp.json();
        console.warn('[ThunderModule] IR manifest loaded:', Object.keys(this._irManifest!.pools).join(', '));
      }
    } catch (err) {
      console.warn('[ThunderModule] Failed to load IR manifest:', err);
    }
  }

  setDuckCallback(fn: (amount: number, attackSec: number, releaseSec: number) => void): void {
    this._duckCallback = fn;
  }

  setWorkletReady(): void {
    this._rumbler.setWorkletReady();
    this._lightning.setWorkletReady();
    this._crackle.setWorkletReady();
    console.warn('[ThunderModule] AudioWorklet processors available (phasor, S&H, fBm)');
  }

  /* Pick a random IR from the active environment pool */
  private async _getRandomIR(): Promise<AudioBuffer | null> {
    if (!this._irManifest) return null;

    const env = this._config.environment;
    const pool = this._irManifest.pools[env];
    if (!pool || pool.irs.length === 0) {
      // Pool empty or missing — use fallback
      return this._irCache.loadIR(this._irManifest.fallback_ir, this._irBasePath);
    }

    const name = pool.irs[Math.floor(Math.random() * pool.irs.length)] ?? this._irManifest.fallback_ir;
    const buf = await this._irCache.loadIR(name, this._irBasePath);
    if (buf) return buf;

    return this._irCache.loadIR(this._irManifest.fallback_ir, this._irBasePath);
  }

  /* Trigger a thunder strike with distance-based sub-model culling */
  async triggerStrike(distance?: number): Promise<void> {
    // Distance with ±15% jitter
    const baseDist = distance ?? this._config.distance;
    const jitter = baseDist * 0.15 * (Math.random() * 2 - 1);
    const dist = clamp(baseDist + jitter, 0.5, 15);

    // Randomize spatial origin per strike
    if (this._spatialConfig.enabled) {
      const ws = this._spatialConfig.worldScale;
      this._panner3d.positionX.value = (Math.random() * 2 - 1) * ws;
      this._panner3d.positionY.value = ws * 0.5;
      this._panner3d.positionZ.value = this._spatialConfig.fixedDepth - (dist * 0.5);
    }

    // Duck rain/wind buses during strike
    if (this._config.sidechainEnabled && this._duckCallback) {
      const duckAmount = dist < 2 ? 0.85 : dist < 5 ? 0.6 : 0.3;
      const duckRelease = 1.5 + dist * 0.3;
      console.warn(`[ThunderModule] Ducking: amount=${duckAmount}, attack=0.003s, release=${duckRelease.toFixed(1)}s`);
      this._duckCallback(duckAmount, 0.003, duckRelease);
    }

    // Strike count scales with storminess, capped by distance
    const storm = this._config.storminess;
    let maxStrikes: number;
    if (storm <= 25) maxStrikes = 2;
    else if (storm <= 50) maxStrikes = 3;
    else if (storm <= 75) maxStrikes = 4;
    else maxStrikes = 5;
    if (dist > 5) maxStrikes = Math.min(maxStrikes, 3);
    if (dist > 10) maxStrikes = 1;
    const numStrikes = Math.max(1, Math.floor(Math.random() * maxStrikes) + 1);

    const irBuffer = await this._getRandomIR();

    const si = this._config.strikeIntensity;
    const ri = this._config.rumbleIntensity;
    const gi = this._config.growlIntensity;

    const distAtten = 1 / (1 + dist * 0.3);

    // All sub-models feed into recOut → master LPF sweep → output
    const ctx = Tone.getContext().rawContext;
    const recOut = ctx.createGain();
    recOut.gain.value = 1;

    // Sweeps high→low, simulating high-freq air absorption over time
    const masterLPF = ctx.createBiquadFilter();
    masterLPF.type = 'lowpass';
    const lpfStart = clampFreq(14000 / (1 + dist * 0.5));
    const sweepTime = dist < 2 ? 16.2 : clamp(16.2 - dist * 0.5, 8, 16.2);
    masterLPF.frequency.setValueAtTime(lpfStart, ctx.currentTime);
    masterLPF.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + sweepTime);
    masterLPF.Q.value = 0.5;

    // Per-strike volume variation: ×0.5–1.5 for natural loudness range
    const strikeVolume = 0.5 + Math.random() * 1.0;
    const masterScale = ctx.createGain();
    masterScale.gain.value = 3.0 * strikeVolume;

    recOut.connect(masterLPF);
    masterLPF.connect(masterScale);
    Tone.connect(masterScale, this._masterGain);

    let maxLifetime = 0;

    // Deepener always fires (sub-bass travels farthest)
    const deepLife = this._deepener.trigger(gi * distAtten, dist, recOut);
    if (deepLife > maxLifetime) maxLifetime = deepLife;

    // Afterimage: gain increases with distance (reflections more prominent far away)
    const afterGain = dist > 5 ? 1.0 : 0.6 + (dist / 5) * 0.4;
    const afterLife = this._afterimage.trigger(si * distAtten * afterGain, dist, recOut);
    if (afterLife > maxLifetime) maxLifetime = afterLife;

    // Rumbler: <= 10 km
    if (dist <= 10) {
      const rumbLife = this._rumbler.trigger(ri * distAtten, dist, recOut);
      if (rumbLife > maxLifetime) maxLifetime = rumbLife;
    }

    // Pre-strike crackle: < 3 km only (high-freq content doesn't survive farther)
    if (dist < 3) {
      this._crackle.trigger(si * distAtten, dist, recOut);
    }

    // Lightning: <= 5 km (attenuated 2–5 km, full below 2 km, min 20%)
    if (dist <= 5) {
      const lightAtten = dist < 2 ? 1.0 : Math.max(0.2, 1.0 - (dist - 2) / 4);
      const lightLife = this._lightning.trigger(
        si * lightAtten, dist, numStrikes, irBuffer, recOut,
      );
      if (lightLife > maxLifetime) maxLifetime = lightLife;
    }

    const cleanupTime = maxLifetime + 1;
    const t = setTimeout(() => {
      try {
        recOut.disconnect();
        masterLPF.disconnect();
        masterScale.disconnect();
      } catch {}
    }, cleanupTime * 1000);
    this._disposeTimeouts.push(t);

    console.warn(
      `[ThunderModule] Strike: ${dist.toFixed(1)}km, ${numStrikes} strikes, ` +
      `vol=${strikeVolume.toFixed(2)}, env=${this._config.environment}, IR=${irBuffer ? 'loaded' : 'none'}`,
    );
  }

  setStorminess(value: number): void {
    this._config.storminess = clamp(value, 0, 100);
  }

  setDistance(km: number): void {
    this._config.distance = clamp(km, 0.5, 15);
  }

  setEnvironment(pool: string): void {
    if (['forest', 'plains', 'mountain', 'coastal', 'suburban', 'urban'].includes(pool)) {
      this._config.environment = pool as ThunderEnvironment;
    }
  }

  startAuto(): void {
    if (this._isAutoMode) return;
    if (this._config.storminess <= 0) return;
    this._isAutoMode = true;
    console.warn(`[ThunderModule] Auto mode started, storminess=${this._config.storminess}`);
    this._scheduleNextStrike();
  }

  stopAuto(): void {
    this._isAutoMode = false;
    if (this._autoScheduleId !== null) {
      clearTimeout(this._autoScheduleId);
      this._autoScheduleId = null;
    }
  }

  private _scheduleNextStrike(): void {
    if (!this._isAutoMode || this._config.storminess <= 0) return;

    const interval = this._getInterval();
    console.warn(`[ThunderModule] Next strike in ${interval.toFixed(1)}s`);
    this._autoScheduleId = setTimeout(() => {
      this.triggerStrike().catch(err =>
        console.warn('[ThunderModule] Strike failed:', err)
      );
      this._scheduleNextStrike();
    }, interval * 1000);
  }

  private _getInterval(): number {
    const s = this._config.storminess;
    let min: number, max: number;

    if (s <= 25) { min = 90; max = 180; }
    else if (s <= 50) { min = 45; max = 120; }
    else if (s <= 75) { min = 20; max = 60; }
    else { min = 10; max = 30; }

    const base = min + Math.random() * (max - min);
    // ±30% jitter
    const jitter = base * 0.3 * (Math.random() * 2 - 1);
    return Math.max(5, base + jitter);
  }

  get isAutoMode(): boolean {
    return this._isAutoMode;
  }

  getSidechainCompressor(): Tone.Compressor {
    return this._sidechain;
  }

  setSidechainEnabled(enabled: boolean): void {
    this._config.sidechainEnabled = enabled;
  }

  setMasterGain(db: number): void {
    this._config.masterGain = db;
    this._masterGain.gain.rampTo(Tone.dbToGain(db), 0.1);
  }

  updateConfig(config: Partial<ThunderModuleConfig>): void {
    if (config.masterGain !== undefined) this.setMasterGain(config.masterGain);
    if (config.storminess !== undefined) this.setStorminess(config.storminess);
    if (config.distance !== undefined) this.setDistance(config.distance);
    if (config.environment !== undefined) this.setEnvironment(config.environment);
    if (config.strikeIntensity !== undefined) this._config.strikeIntensity = config.strikeIntensity;
    if (config.rumbleIntensity !== undefined) this._config.rumbleIntensity = config.rumbleIntensity;
    if (config.growlIntensity !== undefined) this._config.growlIntensity = config.growlIntensity;
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
  }

  setSpatialConfig(config: Partial<SpatialConfig>): void {
    if (config.enabled !== undefined) this._spatialConfig.enabled = config.enabled;
    if (config.panningModel !== undefined) {
      this._spatialConfig.panningModel = config.panningModel;
      this._panner3d.panningModel = config.panningModel;
    }
    if (config.worldScale !== undefined) this._spatialConfig.worldScale = config.worldScale;
    if (config.fixedDepth !== undefined) this._spatialConfig.fixedDepth = config.fixedDepth;
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
    storminess: number;
    distance: number;
    environment: string;
  } {
    return {
      isAutoMode: this._isAutoMode,
      storminess: this._config.storminess,
      distance: this._config.distance,
      environment: this._config.environment,
    };
  }

  dispose(): void {
    this.stopAuto();
    // Cancel all pending strike cleanups
    for (const t of this._disposeTimeouts) clearTimeout(t);
    this._disposeTimeouts = [];
    this._irCache.clear();
    this._masterGain.dispose();
    this._panner3d.dispose();
    this._output.dispose();
    this._sidechain.dispose();
    this._sidechainEnvelope.dispose();
  }
}
