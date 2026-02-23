/**
 * TextureLayer - Looping studio-recorded surface rain samples
 *
 * Plays OGG Opus loops of rain on different surfaces (leaves, metal, wood, etc.)
 * alongside the procedural audio. Two LoopPlayers crossfade between density
 * levels for continuous intensity blending.
 *
 * A/B crossfade loop pattern from GlitchSynth.ts drone.
 * Buffer cache pattern from ThunderModule.ts IRCache.
 */

import * as Tone from 'tone';
import type { TextureLayerConfig } from '../../types/audio';

const DEFAULT_CONFIG: TextureLayerConfig = {
  enabled: false,
  volume: 70,
  intensity: 50,
  intensityLinked: true,
  surface: 'generic',
};

const BASE_PATH = './sounds/textures';

// Surface registry: maps surface ID to label + density level filenames (ascending density)
interface SurfaceEntry {
  label: string;
  levels: string[];  // Filenames without extension, ascending density
}

const SURFACE_REGISTRY: Record<string, SurfaceEntry> = {
  concrete: {
    label: 'Concrete',
    levels: ['concrete-sparse', 'concrete-medium', 'concrete-dense'],
  },
  forest: {
    label: 'Forest Floor',
    levels: ['forest-sparse', 'forest-medium', 'forest-dense'],
  },
  generic: {
    label: 'Generic',
    levels: ['generic-sparse', 'generic-semi-sparse', 'generic-medium', 'generic-dense', 'generic-very-dense'],
  },
  metal: {
    label: 'Metal',
    levels: ['metal-sparse', 'metal-semi-sparse', 'metal-medium', 'metal-dense', 'metal-very-dense'],
  },
  umbrella: {
    label: 'Umbrella',
    levels: ['umbrella-sparse', 'umbrella-medium', 'umbrella-dense', 'umbrella-very-dense'],
  },
};

// LRU buffer cache for decoded AudioBuffers
class BufferCache {
  private _cache = new Map<string, AudioBuffer>();
  private _order: string[] = [];
  private _pending = new Map<string, Promise<AudioBuffer | null>>();
  private _maxSize: number;

  constructor(maxSize = 16) {
    this._maxSize = maxSize;
  }

  async load(name: string): Promise<AudioBuffer | null> {
    if (this._cache.has(name)) {
      this._order = this._order.filter(n => n !== name);
      this._order.push(name);
      return this._cache.get(name)!;
    }

    if (this._pending.has(name)) {
      return this._pending.get(name)!;
    }

    const promise = this._doLoad(name);
    this._pending.set(name, promise);
    try {
      return await promise;
    } finally {
      this._pending.delete(name);
    }
  }

  private async _doLoad(name: string): Promise<AudioBuffer | null> {
    try {
      const url = `${BASE_PATH}/${name}.ogg`;
      const resp = await fetch(url);
      if (!resp.ok) {
        console.warn(`[TextureLayer] Failed to fetch ${url}: ${resp.status}`);
        return null;
      }
      const arrayBuf = await resp.arrayBuffer();
      const ctx = Tone.getContext().rawContext;
      const audioBuf = await ctx.decodeAudioData(arrayBuf);

      if (this._cache.size >= this._maxSize) {
        const oldest = this._order.shift();
        if (oldest) this._cache.delete(oldest);
      }

      this._cache.set(name, audioBuf);
      this._order.push(name);
      return audioBuf;
    } catch (err) {
      console.warn(`[TextureLayer] Decode error for ${name}:`, err);
      return null;
    }
  }

  clear(): void {
    this._cache.clear();
    this._order = [];
  }
}

// LoopPlayer: A/B crossfade gapless looper using raw Web Audio nodes.
// Each source gets its own gain node so outgoing fades out while incoming fades in.
// Scheduling pinned to audio clock; setTimeout is only a wake-up call.
class LoopPlayer {
  private _ctx: BaseAudioContext;
  private _output: GainNode; // External gain control (set by TextureLayer)

  // A/B source pairs with per-source gain for proper crossfade
  private _sourceA: AudioBufferSourceNode | null = null;
  private _sourceB: AudioBufferSourceNode | null = null;
  private _gainA: GainNode;
  private _gainB: GainNode;

  private _buffer: AudioBuffer | null = null;
  private _playing = false;
  private _useA = true;
  private _scheduleTimer: ReturnType<typeof setTimeout> | null = null;
  private _crossfadeTime = 2;
  private _nextStartTime = 0;

  constructor(ctx: BaseAudioContext, output: AudioNode) {
    this._ctx = ctx;
    this._output = ctx.createGain();
    this._output.gain.value = 0;
    this._output.connect(output);

    this._gainA = ctx.createGain();
    this._gainA.gain.value = 1;
    this._gainA.connect(this._output);

    this._gainB = ctx.createGain();
    this._gainB.gain.value = 0;
    this._gainB.connect(this._output);
  }

  async load(name: string, cache: BufferCache): Promise<boolean> {
    const buf = await cache.load(name);
    if (!buf) return false;
    this._buffer = buf;
    return true;
  }

  start(offsetFraction = 0): void {
    if (this._playing || !this._buffer) return;
    this._playing = true;
    this._useA = true;

    this._output.gain.cancelScheduledValues(0);
    this._gainA.gain.cancelScheduledValues(0);
    this._gainB.gain.cancelScheduledValues(0);

    const now = this._ctx.currentTime;
    this._gainA.gain.setValueAtTime(1, now);
    this._gainB.gain.setValueAtTime(0, now);

    const duration = this._buffer.duration;
    const maxOffset = Math.max(0, duration - this._crossfadeTime - 0.5);
    const clampedFraction = maxOffset > 0
      ? Math.min(offsetFraction, maxOffset / duration)
      : 0;
    const offset = clampedFraction * duration;

    this._sourceA = this._createSource(this._buffer, this._gainA);
    this._sourceA.start(now, offset);
    this._nextStartTime = now - offset;
    this._scheduleNext();
  }

  stop(fadeTime = 0.3): void {
    this._playing = false;
    if (this._scheduleTimer) {
      clearTimeout(this._scheduleTimer);
      this._scheduleTimer = null;
    }

    if (fadeTime <= 0) {
      this._output.gain.cancelScheduledValues(this._ctx.currentTime);
      try { this._sourceA?.stop(); } catch {}
      try { this._sourceB?.stop(); } catch {}
      this._sourceA = null;
      this._sourceB = null;
      return;
    }

    const now = this._ctx.currentTime;
    this._output.gain.cancelScheduledValues(now);
    this._output.gain.setValueAtTime(this._output.gain.value, now);
    this._output.gain.linearRampToValueAtTime(0, now + fadeTime);

    const a = this._sourceA;
    const b = this._sourceB;
    setTimeout(() => {
      try { a?.stop(); } catch {}
      try { b?.stop(); } catch {}
    }, (fadeTime + 0.1) * 1000);
    this._sourceA = null;
    this._sourceB = null;
  }

  setGain(value: number): void {
    const now = this._ctx.currentTime;
    this._output.gain.cancelScheduledValues(now);
    this._output.gain.setValueAtTime(this._output.gain.value, now);
    this._output.gain.linearRampToValueAtTime(Math.max(0, value), now + 0.5);
  }

  get isPlaying(): boolean {
    return this._playing;
  }

  dispose(): void {
    this.stop(0);
    try { this._gainA.disconnect(); } catch {}
    try { this._gainB.disconnect(); } catch {}
    try { this._output.disconnect(); } catch {}
  }

  private _createSource(buffer: AudioBuffer, gainNode: GainNode): AudioBufferSourceNode {
    const src = this._ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(gainNode);
    return src;
  }

  private _scheduleNext(): void {
    if (!this._playing || !this._buffer) return;

    const duration = this._buffer.duration;
    const crossfadeStart = this._nextStartTime + duration - this._crossfadeTime;
    const wallDelay = Math.max(0, (crossfadeStart - this._ctx.currentTime - 0.1) * 1000);

    this._scheduleTimer = setTimeout(() => {
      if (!this._playing || !this._buffer) return;

      const inGain = this._useA ? this._gainB : this._gainA;
      const outGain = this._useA ? this._gainA : this._gainB;

      const next = this._createSource(this._buffer, inGain);
      next.start(crossfadeStart);

      // Crossfade: outgoing fades out, incoming fades in
      outGain.gain.setValueAtTime(1, crossfadeStart);
      outGain.gain.linearRampToValueAtTime(0, crossfadeStart + this._crossfadeTime);
      inGain.gain.setValueAtTime(0, crossfadeStart);
      inGain.gain.linearRampToValueAtTime(1, crossfadeStart + this._crossfadeTime);

      // Stop old source after crossfade completes
      const oldSource = this._useA ? this._sourceA : this._sourceB;
      const oldEndTime = crossfadeStart + this._crossfadeTime;
      setTimeout(() => { try { oldSource?.stop(); } catch {} },
        Math.max(0, (oldEndTime - this._ctx.currentTime + 0.5) * 1000));

      // Swap references
      if (this._useA) {
        this._sourceB = next;
      } else {
        this._sourceA = next;
      }

      this._nextStartTime = crossfadeStart;
      this._useA = !this._useA;
      this._scheduleNext();
    }, wallDelay);
  }
}

// TextureLayer: orchestrator with two LoopPlayers for intensity blending
export class TextureLayer {
  private _config: TextureLayerConfig;
  private _cache = new BufferCache(16);
  private _masterGain: GainNode;
  private _output: GainNode;

  // Two players for crossfading between adjacent density levels
  private _playerA: LoopPlayer | null = null;
  private _playerB: LoopPlayer | null = null;
  private _ctx: BaseAudioContext | null = null;
  private _mixNode: GainNode | null = null;  // Both players connect here

  // Track which levels are loaded in each player
  private _levelA = -1;
  private _levelB = -1;
  private _currentSurface: SurfaceEntry | null = null;
  private _active = false;
  private _loadGeneration = 0;
  private _updateInProgress = false;

  constructor(config: Partial<TextureLayerConfig> = {}) {
    this._config = { ...DEFAULT_CONFIG, ...config };

    const ctx = Tone.getContext().rawContext;
    this._ctx = ctx;

    this._mixNode = ctx.createGain();
    this._mixNode.gain.value = 1;

    this._masterGain = ctx.createGain();
    this._masterGain.gain.value = this._volumeToGain(this._config.volume);

    this._output = ctx.createGain();
    this._output.gain.value = 1;

    this._mixNode.connect(this._masterGain);
    this._masterGain.connect(this._output);

    this._playerA = new LoopPlayer(ctx, this._mixNode);
    this._playerB = new LoopPlayer(ctx, this._mixNode);
  }

  // Volume: 0–100 percentage to linear gain
  private _volumeToGain(volume: number): number {
    if (volume <= 0) return 0;
    // dB range: -40dB (1%) to 0dB (100%)
    const db = (volume / 100) * 40 - 40;
    return Math.pow(10, db / 20);
  }

  // Intensity (1–100) maps to zone math across the surface's density levels
  private _getIntensityZone(intensity: number): { levelA: number; levelB: number; blend: number } {
    const surface = this._currentSurface;
    if (!surface || surface.levels.length === 0) {
      return { levelA: 0, levelB: 0, blend: 0 };
    }

    const numLevels = surface.levels.length;
    if (numLevels === 1) {
      return { levelA: 0, levelB: 0, blend: 0 };
    }

    // Map intensity 1–100 to 0.0–1.0 across the level range
    const t = Math.max(0, Math.min(1, (intensity - 1) / 99));
    const pos = t * (numLevels - 1);
    const lower = Math.floor(pos);
    const upper = Math.min(lower + 1, numLevels - 1);
    const blend = pos - lower;

    return { levelA: lower, levelB: upper, blend };
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this._config.enabled = enabled;
    console.warn(`[TextureLayer] ${enabled ? 'Enabling' : 'Disabling'}, surface=${this._config.surface}, volume=${this._config.volume}`);
    if (enabled) {
      await this._startPlayback();
    } else {
      this._stopPlayback();
    }
  }

  setVolume(volume: number): void {
    this._config.volume = Math.max(0, Math.min(100, volume));
    const gain = this._volumeToGain(this._config.volume);
    if (this._ctx) {
      this._masterGain.gain.linearRampToValueAtTime(gain, this._ctx.currentTime + 0.1);
    }
  }

  async setIntensity(intensity: number): Promise<void> {
    this._config.intensity = Math.max(1, Math.min(100, intensity));
    if (!this._active) return;

    const { levelA: needLower, levelB: needUpper, blend } = this._getIntensityZone(this._config.intensity);

    const haveLower = this._levelA === needLower || this._levelB === needLower;
    const haveUpper = this._levelA === needUpper || this._levelB === needUpper;

    if (haveLower && (needLower === needUpper || haveUpper)) {
      this._applyGains(needLower, needUpper, blend);
      return;
    }

    if (this._updateInProgress) return;
    this._updateInProgress = true;
    try {
      await this._updateLevels();
    } finally {
      this._updateInProgress = false;
    }
  }

  private _applyGains(needLower: number, needUpper: number, blend: number): void {
    if (needLower === needUpper) {
      const hasIt = this._levelA === needLower ? this._playerA : this._playerB;
      const other = hasIt === this._playerA ? this._playerB : this._playerA;
      hasIt?.setGain(1);
      other?.setGain(0);
    } else {
      const aIsLower = this._levelA === needLower;
      this._playerA?.setGain(aIsLower ? 1 - blend : blend);
      this._playerB?.setGain(aIsLower ? blend : 1 - blend);
    }
  }

  async setSurface(id: string): Promise<void> {
    if (!SURFACE_REGISTRY[id]) {
      console.warn(`[TextureLayer] Unknown surface: ${id}`);
      return;
    }
    this._config.surface = id;
    this._currentSurface = SURFACE_REGISTRY[id]!;

    if (this._active) {
      // Fade out, reload, fade in
      this._loadGeneration++;
      this._stopPlayback();
      await this._startPlayback();
    }
  }

  setIntensityLinked(linked: boolean): void {
    this._config.intensityLinked = linked;
  }

  getConfig(): TextureLayerConfig {
    return { ...this._config };
  }

  get output(): GainNode {
    return this._output;
  }

  connect(destination: AudioNode): this {
    this._output.disconnect();
    this._output.connect(destination);
    return this;
  }

  dispose(): void {
    this._stopPlayback();
    this._playerA?.dispose();
    this._playerB?.dispose();
    this._playerA = null;
    this._playerB = null;
    try { this._mixNode?.disconnect(); } catch {}
    try { this._masterGain.disconnect(); } catch {}
    try { this._output.disconnect(); } catch {}
    this._cache.clear();
  }

  private async _startPlayback(): Promise<void> {
    if (!this._config.enabled) return;

    this._currentSurface = SURFACE_REGISTRY[this._config.surface] ?? SURFACE_REGISTRY['generic']!;
    this._active = true;

    const gen = ++this._loadGeneration;
    await this._updateLevels(gen);
  }

  private _stopPlayback(): void {
    this._active = false;
    this._updateInProgress = false;
    this._playerA?.stop(0.5);
    this._playerB?.stop(0.5);
    this._levelA = -1;
    this._levelB = -1;
  }

  private async _updateLevels(gen?: number): Promise<void> {
    const currentGen = gen ?? this._loadGeneration;
    if (!this._currentSurface || !this._playerA || !this._playerB) return;

    const { levelA: needLower, levelB: needUpper, blend } = this._getIntensityZone(this._config.intensity);
    const levels = this._currentSurface.levels;
    const needed = needLower === needUpper ? [needLower] : [needLower, needUpper];
    const loaded = new Set([this._levelA, this._levelB]);
    const missing = needed.filter(n => !loaded.has(n));

    for (const level of missing) {
      if (!levels[level]) continue;
      // Pick whichever player doesn't hold a still-needed level
      const aStillNeeded = needed.includes(this._levelA);
      const target = aStillNeeded ? this._playerB : this._playerA;
      const isA = target === this._playerA;

      const ok = await target.load(levels[level]!, this._cache);
      if (currentGen !== this._loadGeneration || !this._active) return;
      if (ok) {
        target.stop(0);
        target.start(Math.random());
        if (isA) this._levelA = level;
        else this._levelB = level;
      } else {
        console.warn(`[TextureLayer] Load failed for ${levels[level]}, skipping level update`);
        return;
      }
    }

    this._applyGains(needLower, needUpper, blend);

    if (needLower === needUpper) {
      const unused = this._levelA === needLower ? this._playerB : this._playerA;
      if (unused?.isPlaying) unused.stop(0.3);
    }
  }

  // Static accessors for the surface registry (used by panel dropdown)
  static getSurfaces(): { id: string; label: string }[] {
    return Object.entries(SURFACE_REGISTRY).map(([id, entry]) => ({
      id,
      label: entry.label,
    }));
  }
}
