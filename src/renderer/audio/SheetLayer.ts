/**
 * SheetLayer - Background noise layer for aggregate rain sound
 *
 * The "bed" of sound from thousands of tiny impacts blending together.
 * Volume modulated by active particle count with smooth ramping.
 */

import * as Tone from 'tone';
import type { SheetLayerConfig, NoiseType, FilterType, SpatialConfig } from '../../types/audio';

const DEFAULT_CONFIG: SheetLayerConfig = {
  noiseType: 'brown',
  filterType: 'lowpass',
  filterFreq: 6000,
  filterQ: 1,
  minVolume: -30,
  maxVolume: -16,
  maxParticleCount: 50,
  rampTime: 0.1,
};

/**
 * Background noise that responds to particle density.
 * Creates ambient "rain sheet" sound filling gaps between discrete impacts.
 */
export class SheetLayer {
  private _config: SheetLayerConfig;
  private _noise: Tone.Noise;
  private _filter: Tone.Filter;
  private _panner3d: Tone.Panner3D;
  private _output: Tone.Gain;
  private _currentParticleCount = 0;
  private _isPlaying = false;
  private _spatialConfig: SpatialConfig = {
    enabled: false,
    panningModel: 'equalpower',
    worldScale: 5,
    fixedDepth: -2,
  };

  constructor(config: Partial<SheetLayerConfig> = {}) {
    this._config = { ...DEFAULT_CONFIG, ...config };

    this._noise = new Tone.Noise({
      type: this._config.noiseType,
      volume: this._config.minVolume,
    });

    this._filter = new Tone.Filter({
      type: this._config.filterType,
      frequency: this._config.filterFreq,
      Q: this._config.filterQ,
    });

    this._panner3d = new Tone.Panner3D({
      panningModel: this._spatialConfig.panningModel,
      rolloffFactor: 0,
      positionX: 0,
      positionY: 0,
      positionZ: this._spatialConfig.fixedDepth,
    });

    this._output = new Tone.Gain(1);

    this._noise.connect(this._filter);
    this._filter.connect(this._panner3d);
    this._panner3d.connect(this._output);
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

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  /** Update particle count, which modulates volume with smooth ramping. */
  setParticleCount(count: number): void {
    this._currentParticleCount = Math.max(0, count);
    this.updateVolume();
  }

  get particleCount(): number {
    return this._currentParticleCount;
  }

  private updateVolume(): void {
    const { minVolume, maxVolume, maxParticleCount, rampTime } = this._config;
    const normalized = Math.min(1, this._currentParticleCount / maxParticleCount);
    // Use -Infinity (true silence) when no particles, otherwise interpolate
    const targetVolume = normalized < 0.001 ? -Infinity : minVolume + (maxVolume - minVolume) * normalized;
    this._noise.volume.rampTo(targetVolume, rampTime);
  }

  updateConfig(config: Partial<SheetLayerConfig>): void {
    this._config = { ...this._config, ...config };

    if (config.noiseType !== undefined) {
      const wasPlaying = this._isPlaying;
      if (wasPlaying) this.stop();
      this._noise.type = config.noiseType;
      if (wasPlaying) this.start();
    }

    if (config.filterType !== undefined) {
      this._filter.type = config.filterType;
    }
    if (config.filterFreq !== undefined) {
      this._filter.frequency.value = config.filterFreq;
    }
    if (config.filterQ !== undefined) {
      this._filter.Q.value = config.filterQ;
    }

    this.updateVolume();
  }

  getConfig(): SheetLayerConfig {
    return { ...this._config };
  }

  setNoiseType(type: NoiseType): void {
    this.updateConfig({ noiseType: type });
  }

  setFilter(type: FilterType, freq: number, q: number): void {
    this.updateConfig({ filterType: type, filterFreq: freq, filterQ: q });
  }

  setVolumeRange(minDb: number, maxDb: number): void {
    this.updateConfig({ minVolume: minDb, maxVolume: maxDb });
  }

  connect(destination: Tone.InputNode): this {
    this._output.disconnect();
    this._output.connect(destination);
    return this;
  }

  get output(): Tone.Gain {
    return this._output;
  }

  setSpatialConfig(config: Partial<SpatialConfig>): void {
    if (config.enabled !== undefined) this._spatialConfig.enabled = config.enabled;
    if (config.panningModel !== undefined) {
      this._spatialConfig.panningModel = config.panningModel;
      this._panner3d.panningModel = config.panningModel;
    }
    if (config.worldScale !== undefined) this._spatialConfig.worldScale = config.worldScale;
    if (config.fixedDepth !== undefined) {
      this._spatialConfig.fixedDepth = config.fixedDepth;
      this._panner3d.positionZ.value = config.fixedDepth;
    }
  }

  dispose(): void {
    this.stop();
    this._noise.dispose();
    this._filter.dispose();
    this._panner3d.dispose();
    this._output.dispose();
  }

  getStats(): {
    isPlaying: boolean;
    particleCount: number;
    currentVolume: number;
    config: SheetLayerConfig;
  } {
    return {
      isPlaying: this._isPlaying,
      particleCount: this._currentParticleCount,
      currentVolume: this._noise.volume.value,
      config: this.getConfig(),
    };
  }
}
