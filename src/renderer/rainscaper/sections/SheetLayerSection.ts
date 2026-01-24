/**
 * SheetLayerSection - Background noise layer controls (Admin mode)
 *
 * Controls for the continuous background rain noise layer.
 */

import { ControlGroup, Slider, Select } from '../components/controls';
import type { SheetLayerConfig } from '../../../types/audio';

export interface SheetLayerSectionCallbacks {
  onConfigChange?: (config: Partial<SheetLayerConfig>) => void;
}

export class SheetLayerSection {
  private _element: HTMLDivElement | null = null;
  private _config: SheetLayerConfig;
  private _controls: Record<string, Slider | Select> = {};

  constructor(config: SheetLayerConfig, _callbacks: SheetLayerSectionCallbacks = {}) {
    this._config = config;
    // Callbacks reserved for future use
  }

  create(): HTMLDivElement {
    this._element = document.createElement('div');
    this._element.className = 'rs-section';

    // Noise Settings Group
    const noiseGroup = new ControlGroup({
      id: 'sheet-noise',
      title: 'Noise Generator',
      variant: 'air',
      collapsible: false,
    });
    noiseGroup.create();

    this._controls.noiseType = new Select({
      id: 'sheet-noise-type',
      label: 'Noise Type',
      path: 'sheetLayer.noiseType',
      options: [
        { value: 'white', label: 'White' },
        { value: 'pink', label: 'Pink' },
        { value: 'brown', label: 'Brown' },
      ],
      value: this._config.noiseType,
    });
    noiseGroup.addControl(this._controls.noiseType.create());

    this._element.appendChild(noiseGroup.element!);

    // Filter Group
    const filterGroup = new ControlGroup({
      id: 'sheet-filter',
      title: 'Filter',
      variant: 'air',
    });
    filterGroup.create();

    this._controls.filterType = new Select({
      id: 'sheet-filter-type',
      label: 'Filter Type',
      path: 'sheetLayer.filterType',
      options: [
        { value: 'lowpass', label: 'Lowpass' },
        { value: 'highpass', label: 'Highpass' },
        { value: 'bandpass', label: 'Bandpass' },
      ],
      value: this._config.filterType,
    });
    filterGroup.addControl(this._controls.filterType.create());

    this._controls.filterFreq = new Slider({
      id: 'sheet-filter-freq',
      label: 'Frequency',
      path: 'sheetLayer.filterFreq',
      min: 100,
      max: 10000,
      step: 100,
      value: this._config.filterFreq,
      unit: 'Hz',
      variant: 'air',
    });
    filterGroup.addControl(this._controls.filterFreq.create());

    this._controls.filterQ = new Slider({
      id: 'sheet-filter-q',
      label: 'Q',
      path: 'sheetLayer.filterQ',
      min: 0.1,
      max: 10,
      step: 0.1,
      value: this._config.filterQ,
      variant: 'air',
    });
    filterGroup.addControl(this._controls.filterQ.create());

    this._element.appendChild(filterGroup.element!);

    // Volume Group
    const volumeGroup = new ControlGroup({
      id: 'sheet-volume',
      title: 'Volume Modulation',
      variant: 'air',
    });
    volumeGroup.create();

    this._controls.minVolume = new Slider({
      id: 'sheet-vol-min',
      label: 'Min Volume',
      path: 'sheetLayer.minVolume',
      min: -60,
      max: 0,
      step: 1,
      value: this._config.minVolume,
      unit: 'dB',
      variant: 'air',
      formatValue: (v) => v <= -60 ? 'Mute' : String(v),
    });
    volumeGroup.addControl(this._controls.minVolume.create());

    this._controls.maxVolume = new Slider({
      id: 'sheet-vol-max',
      label: 'Max Volume',
      path: 'sheetLayer.maxVolume',
      min: -40,
      max: 6,
      step: 1,
      value: this._config.maxVolume,
      unit: 'dB',
      variant: 'air',
    });
    volumeGroup.addControl(this._controls.maxVolume.create());

    this._controls.maxParticleCount = new Slider({
      id: 'sheet-max-particles',
      label: 'Max Particles',
      path: 'sheetLayer.maxParticleCount',
      min: 100,
      max: 2000,
      step: 50,
      value: this._config.maxParticleCount,
      variant: 'air',
      formatValue: (v) => v + ' drops',
    });
    volumeGroup.addControl(this._controls.maxParticleCount.create());

    this._controls.rampTime = new Slider({
      id: 'sheet-ramp-time',
      label: 'Ramp Time',
      path: 'sheetLayer.rampTime',
      min: 0.1,
      max: 2,
      step: 0.1,
      value: this._config.rampTime,
      unit: 's',
      variant: 'air',
    });
    volumeGroup.addControl(this._controls.rampTime.create());

    this._element.appendChild(volumeGroup.element!);

    return this._element;
  }

  updateConfig(config: Partial<SheetLayerConfig>): void {
    if (config.noiseType !== undefined) {
      (this._controls.noiseType as Select)?.setValue(config.noiseType);
    }
    if (config.filterType !== undefined) {
      (this._controls.filterType as Select)?.setValue(config.filterType);
    }
    if (config.filterFreq !== undefined) {
      (this._controls.filterFreq as Slider)?.setValue(config.filterFreq);
    }
    if (config.filterQ !== undefined) {
      (this._controls.filterQ as Slider)?.setValue(config.filterQ);
    }
    if (config.minVolume !== undefined) {
      (this._controls.minVolume as Slider)?.setValue(config.minVolume);
    }
    if (config.maxVolume !== undefined) {
      (this._controls.maxVolume as Slider)?.setValue(config.maxVolume);
    }
    if (config.maxParticleCount !== undefined) {
      (this._controls.maxParticleCount as Slider)?.setValue(config.maxParticleCount);
    }
    if (config.rampTime !== undefined) {
      (this._controls.rampTime as Slider)?.setValue(config.rampTime);
    }
  }

  get element(): HTMLDivElement | null {
    return this._element;
  }

  dispose(): void {
    for (const control of Object.values(this._controls)) {
      control?.dispose();
    }
    this._controls = {};
    this._element = null;
  }
}
