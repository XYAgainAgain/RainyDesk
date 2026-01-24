/**
 * ImpactPoolSection - Impact synth voice pool controls (Admin mode)
 *
 * Controls for the NoiseSynth pool that produces "thud" impact sounds.
 */

import { ControlGroup, Slider, Select } from '../components/controls';

export interface ImpactPoolConfig {
  poolSize: number;
  noiseType: string;
  attackTime: number;
  decayMin: number;
  decayMax: number;
  filterFreq: number;
  filterQ: number;
}

export interface ImpactPoolSectionCallbacks {
  onConfigChange?: (config: Partial<ImpactPoolConfig>) => void;
}

export class ImpactPoolSection {
  private _element: HTMLDivElement | null = null;
  private _config: ImpactPoolConfig;
  private _controls: Record<string, Slider | Select> = {};

  constructor(config: ImpactPoolConfig, _callbacks: ImpactPoolSectionCallbacks = {}) {
    this._config = config;
    // Callbacks reserved for future use
  }

  create(): HTMLDivElement {
    this._element = document.createElement('div');
    this._element.className = 'rs-section';

    // Pool Settings Group
    const poolGroup = new ControlGroup({
      id: 'impact-pool',
      title: 'Voice Pool',
      variant: 'water',
      collapsible: false,
    });
    poolGroup.create();

    this._controls.poolSize = new Slider({
      id: 'impact-pool-size',
      label: 'Pool Size',
      path: 'voicePools.impactPoolSize',
      min: 1,
      max: 32,
      step: 1,
      value: this._config.poolSize,
      variant: 'water',
      formatValue: (v) => v + ' voices',
    });
    poolGroup.addControl(this._controls.poolSize.create());

    this._controls.noiseType = new Select({
      id: 'impact-noise-type',
      label: 'Noise Type',
      path: 'impact.noiseType',
      options: [
        { value: 'white', label: 'White' },
        { value: 'pink', label: 'Pink' },
        { value: 'brown', label: 'Brown' },
      ],
      value: this._config.noiseType,
    });
    poolGroup.addControl(this._controls.noiseType.create());

    this._element.appendChild(poolGroup.element!);

    // Envelope Group
    const envGroup = new ControlGroup({
      id: 'impact-envelope',
      title: 'Envelope',
      variant: 'water',
    });
    envGroup.create();

    this._controls.attackTime = new Slider({
      id: 'impact-attack',
      label: 'Attack',
      path: 'impact.attackTime',
      min: 0.001,
      max: 0.05,
      step: 0.001,
      value: this._config.attackTime,
      unit: 's',
      variant: 'water',
      formatValue: (v) => (v * 1000).toFixed(0) + 'ms',
    });
    envGroup.addControl(this._controls.attackTime.create());

    this._controls.decayMin = new Slider({
      id: 'impact-decay-min',
      label: 'Decay Min',
      path: 'impact.decayMin',
      min: 0.01,
      max: 0.2,
      step: 0.005,
      value: this._config.decayMin,
      unit: 's',
      variant: 'water',
      formatValue: (v) => (v * 1000).toFixed(0) + 'ms',
    });
    envGroup.addControl(this._controls.decayMin.create());

    this._controls.decayMax = new Slider({
      id: 'impact-decay-max',
      label: 'Decay Max',
      path: 'impact.decayMax',
      min: 0.01,
      max: 0.3,
      step: 0.005,
      value: this._config.decayMax,
      unit: 's',
      variant: 'water',
      formatValue: (v) => (v * 1000).toFixed(0) + 'ms',
    });
    envGroup.addControl(this._controls.decayMax.create());

    this._element.appendChild(envGroup.element!);

    // Filter Group
    const filterGroup = new ControlGroup({
      id: 'impact-filter',
      title: 'Filter',
      variant: 'water',
    });
    filterGroup.create();

    this._controls.filterFreq = new Slider({
      id: 'impact-filter-freq',
      label: 'Frequency',
      path: 'impact.filterFreq',
      min: 500,
      max: 8000,
      step: 100,
      value: this._config.filterFreq,
      unit: 'Hz',
      variant: 'water',
    });
    filterGroup.addControl(this._controls.filterFreq.create());

    this._controls.filterQ = new Slider({
      id: 'impact-filter-q',
      label: 'Q',
      path: 'impact.filterQ',
      min: 0.5,
      max: 10,
      step: 0.5,
      value: this._config.filterQ,
      variant: 'water',
    });
    filterGroup.addControl(this._controls.filterQ.create());

    this._element.appendChild(filterGroup.element!);

    return this._element;
  }

  updateConfig(config: Partial<ImpactPoolConfig>): void {
    if (config.poolSize !== undefined) {
      (this._controls.poolSize as Slider)?.setValue(config.poolSize);
    }
    if (config.noiseType !== undefined) {
      (this._controls.noiseType as Select)?.setValue(config.noiseType);
    }
    if (config.attackTime !== undefined) {
      (this._controls.attackTime as Slider)?.setValue(config.attackTime);
    }
    if (config.decayMin !== undefined) {
      (this._controls.decayMin as Slider)?.setValue(config.decayMin);
    }
    if (config.decayMax !== undefined) {
      (this._controls.decayMax as Slider)?.setValue(config.decayMax);
    }
    if (config.filterFreq !== undefined) {
      (this._controls.filterFreq as Slider)?.setValue(config.filterFreq);
    }
    if (config.filterQ !== undefined) {
      (this._controls.filterQ as Slider)?.setValue(config.filterQ);
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
