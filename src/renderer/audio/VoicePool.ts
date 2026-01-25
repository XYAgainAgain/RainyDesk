/**
 * VoicePool - Generic voice pool for managing synth instances
 *
 * Provides acquire/release semantics with optional voice stealing.
 * Subclasses implement createVoice() to provide specific synth types.
 */

import type { Voice, VoicePoolConfig, IVoicePool, SynthType } from '../../types/audio';

const DEFAULT_CONFIG: VoicePoolConfig = {
  size: 12,
  enableStealing: true,
};

/**
 * Abstract base class for voice pools.
 *
 * Subclasses must call initializePool() in their constructor AFTER
 * setting up their own state (synth config, output nodes, etc).
 */
export abstract class VoicePool<T extends SynthType> implements IVoicePool<T> {
  protected _voices: Voice<T>[] = [];
  protected _config: VoicePoolConfig;
  protected _nextId = 0;

  constructor(config: Partial<VoicePoolConfig> = {}) {
    this._config = { ...DEFAULT_CONFIG, ...config };
    // Subclasses call initializePool() after their own setup
  }

  /** Create a new voice. Subclasses implement this. */
  protected abstract createVoice(): Voice<T>;

  /** Dispose of a synth instance. Override for custom cleanup. */
  protected disposeSynth(synth: T): void {
    if (synth && typeof synth.dispose === 'function') {
      synth.dispose();
    }
  }

  get voices(): ReadonlyArray<Voice<T>> {
    return this._voices;
  }

  get config(): VoicePoolConfig {
    return { ...this._config };
  }

  /**
   * Acquire an idle voice from the pool.
   * If all busy and stealing enabled, steals the first busy voice.
   */
  acquire(): Voice<T> | null {
    const idleVoice = this._voices.find(v => !v.busy);
    if (idleVoice) {
      idleVoice.busy = true;
      idleVoice.releaseTime = 0;
      return idleVoice;
    }

    if (this._config.enableStealing && this._voices.length > 0) {
      const stolen = this._voices.find(v => v.busy);
      if (stolen) return stolen;
    }

    return null;
  }

  /** Release a voice back to the pool. */
  release(voice: Voice<T>): void {
    const poolVoice = this._voices.find(v => v.id === voice.id);
    if (poolVoice) {
      poolVoice.busy = false;
      poolVoice.releaseTime = performance.now();
    }
  }

  getActiveCount(): number {
    return this._voices.filter(v => v.busy).length;
  }

  /** Resize the pool. Prefers disposing idle voices when shrinking. */
  resize(newSize: number): void {
    newSize = Math.max(1, newSize);
    const currentSize = this._voices.length;

    if (newSize === currentSize) return;

    if (newSize < currentSize) {
      this.shrinkPool(currentSize - newSize);
    } else {
      this.growPool(newSize - currentSize);
    }

    this._config.size = newSize;
  }

  dispose(): void {
    for (const voice of this._voices) {
      this.disposeSynth(voice.synth);
    }
    this._voices = [];
    this._nextId = 0;
  }

  protected initializePool(): void {
    for (let i = 0; i < this._config.size; i++) {
      this._voices.push(this.createVoice());
    }
  }

  private shrinkPool(count: number): void {
    let removed = 0;

    // Remove idle voices first
    while (removed < count) {
      const idleIndex = this._voices.findIndex(v => !v.busy);
      if (idleIndex === -1) break;

      const [voice] = this._voices.splice(idleIndex, 1);
      if (voice) this.disposeSynth(voice.synth);
      removed++;
    }

    // If still need more, take busy voices from the end
    while (removed < count && this._voices.length > 0) {
      const voice = this._voices.pop();
      if (voice) this.disposeSynth(voice.synth);
      removed++;
    }
  }

  private growPool(count: number): void {
    for (let i = 0; i < count; i++) {
      this._voices.push(this.createVoice());
    }
  }

  getStats(): { total: number; active: number; idle: number } {
    const active = this.getActiveCount();
    return {
      total: this._voices.length,
      active,
      idle: this._voices.length - active,
    };
  }

  /** Enable or disable voice stealing. */
  setVoiceStealing(enabled: boolean): void {
    this._config.enableStealing = enabled;
  }
}
