/**
 * PhysicsMapperSection - Physics-to-audio mapping controls (Admin mode)
 *
 * Controls how physics properties (velocity, radius) translate to audio
 * parameters (volume, frequency, decay).
 */

import { ControlGroup, Slider } from '../components/controls';

export interface PhysicsMapperConfig {
  velocityMin: number;
  velocityMax: number;
  volumeMin: number;
  volumeMax: number;
  minnaertBase: number;
  freqMin: number;
  freqMax: number;
  decayBase: number;
  decayRadiusScale: number;
}

export interface PhysicsMapperSectionCallbacks {
  onConfigChange?: (config: Partial<PhysicsMapperConfig>) => void;
}

export class PhysicsMapperSection {
  private _element: HTMLDivElement | null = null;
  private _config: PhysicsMapperConfig;
  private _controls: Record<string, Slider> = {};

  constructor(config: PhysicsMapperConfig, _callbacks: PhysicsMapperSectionCallbacks = {}) {
    this._config = config;
  }

  create(): HTMLDivElement {
    this._element = document.createElement('div');
    this._element.className = 'rs-section';

    // Velocity Mapping Group
    const velocityGroup = new ControlGroup({
      id: 'mapper-velocity',
      title: 'Velocity to Volume',
      variant: 'earth',
      collapsible: false,
    });
    velocityGroup.create();

    this._controls.velocityMin = new Slider({
      id: 'mapper-vel-min',
      label: 'Vel Min',
      path: 'physicsMapper.velocityMin',
      min: 0.1,
      max: 5,
      step: 0.1,
      value: this._config.velocityMin,
      variant: 'earth',
      formatValue: (v) => v.toFixed(1) + ' m/s',
    });
    velocityGroup.addControl(this._controls.velocityMin.create());

    this._controls.velocityMax = new Slider({
      id: 'mapper-vel-max',
      label: 'Vel Max',
      path: 'physicsMapper.velocityMax',
      min: 5,
      max: 50,
      step: 1,
      value: this._config.velocityMax,
      variant: 'earth',
      formatValue: (v) => v.toFixed(0) + ' m/s',
    });
    velocityGroup.addControl(this._controls.velocityMax.create());

    this._controls.volumeMin = new Slider({
      id: 'mapper-vol-min',
      label: 'Vol Min',
      path: 'physicsMapper.volumeMin',
      min: -60,
      max: -20,
      step: 1,
      value: this._config.volumeMin,
      unit: 'dB',
      variant: 'positive',
    });
    velocityGroup.addControl(this._controls.volumeMin.create());

    this._controls.volumeMax = new Slider({
      id: 'mapper-vol-max',
      label: 'Vol Max',
      path: 'physicsMapper.volumeMax',
      min: -20,
      max: 0,
      step: 1,
      value: this._config.volumeMax,
      unit: 'dB',
      variant: 'positive',
    });
    velocityGroup.addControl(this._controls.volumeMax.create());

    this._element.appendChild(velocityGroup.element!);

    // Frequency Mapping Group (Minnaert)
    const freqGroup = new ControlGroup({
      id: 'mapper-freq',
      title: 'Radius to Frequency (Minnaert)',
      variant: 'resonance',
    });
    freqGroup.create();

    this._controls.minnaertBase = new Slider({
      id: 'mapper-minnaert',
      label: 'Base Freq',
      path: 'physicsMapper.minnaertBase',
      min: 1000,
      max: 6000,
      step: 100,
      value: this._config.minnaertBase,
      unit: 'Hz',
      variant: 'resonance',
    });
    freqGroup.addControl(this._controls.minnaertBase.create());

    this._controls.freqMin = new Slider({
      id: 'mapper-freq-min',
      label: 'Freq Min',
      path: 'physicsMapper.freqMin',
      min: 50,
      max: 500,
      step: 10,
      value: this._config.freqMin,
      unit: 'Hz',
      variant: 'resonance',
    });
    freqGroup.addControl(this._controls.freqMin.create());

    this._controls.freqMax = new Slider({
      id: 'mapper-freq-max',
      label: 'Freq Max',
      path: 'physicsMapper.freqMax',
      min: 1000,
      max: 8000,
      step: 100,
      value: this._config.freqMax,
      unit: 'Hz',
      variant: 'resonance',
    });
    freqGroup.addControl(this._controls.freqMax.create());

    this._element.appendChild(freqGroup.element!);

    // Decay Mapping Group
    const decayGroup = new ControlGroup({
      id: 'mapper-decay',
      title: 'Radius to Decay',
      variant: 'neutral',
    });
    decayGroup.create();

    this._controls.decayBase = new Slider({
      id: 'mapper-decay-base',
      label: 'Base Decay',
      path: 'physicsMapper.decayBase',
      min: 0.01,
      max: 0.2,
      step: 0.01,
      value: this._config.decayBase,
      unit: 's',
      variant: 'neutral',
      formatValue: (v) => (v * 1000).toFixed(0) + 'ms',
    });
    decayGroup.addControl(this._controls.decayBase.create());

    this._controls.decayRadiusScale = new Slider({
      id: 'mapper-decay-scale',
      label: 'Radius Scale',
      path: 'physicsMapper.decayRadiusScale',
      min: 0,
      max: 0.1,
      step: 0.005,
      value: this._config.decayRadiusScale,
      variant: 'neutral',
      formatValue: (v) => v.toFixed(3),
    });
    decayGroup.addControl(this._controls.decayRadiusScale.create());

    this._element.appendChild(decayGroup.element!);

    return this._element;
  }

  updateConfig(config: Partial<PhysicsMapperConfig>): void {
    if (config.velocityMin !== undefined) {
      this._controls.velocityMin?.setValue(config.velocityMin);
    }
    if (config.velocityMax !== undefined) {
      this._controls.velocityMax?.setValue(config.velocityMax);
    }
    if (config.volumeMin !== undefined) {
      this._controls.volumeMin?.setValue(config.volumeMin);
    }
    if (config.volumeMax !== undefined) {
      this._controls.volumeMax?.setValue(config.volumeMax);
    }
    if (config.minnaertBase !== undefined) {
      this._controls.minnaertBase?.setValue(config.minnaertBase);
    }
    if (config.freqMin !== undefined) {
      this._controls.freqMin?.setValue(config.freqMin);
    }
    if (config.freqMax !== undefined) {
      this._controls.freqMax?.setValue(config.freqMax);
    }
    if (config.decayBase !== undefined) {
      this._controls.decayBase?.setValue(config.decayBase);
    }
    if (config.decayRadiusScale !== undefined) {
      this._controls.decayRadiusScale?.setValue(config.decayRadiusScale);
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
