/**
 * BubblePoolSection - Bubble synth voice pool controls (Admin mode)
 *
 * Controls for the Synth pool that produces "plink" resonance sounds.
 */

import { ControlGroup, Slider, Select } from '../components/controls';

export interface BubblePoolConfig {
  poolSize: number;
  oscillatorType: string;
  chirpAmount: number;
  chirpTime: number;
  freqMin: number;
  freqMax: number;
  probability: number;
}

export interface BubblePoolSectionCallbacks {
  onConfigChange?: (config: Partial<BubblePoolConfig>) => void;
}

export class BubblePoolSection {
  private _element: HTMLDivElement | null = null;
  private _config: BubblePoolConfig;
  private _controls: Record<string, Slider | Select> = {};

  constructor(config: BubblePoolConfig, _callbacks: BubblePoolSectionCallbacks = {}) {
    this._config = config;
    // Callbacks reserved for future use
  }

  create(): HTMLDivElement {
    this._element = document.createElement('div');
    this._element.className = 'rs-section';

    // Pool Settings Group
    const poolGroup = new ControlGroup({
      id: 'bubble-pool',
      title: 'Voice Pool',
      variant: 'resonance',
      collapsible: false,
    });
    poolGroup.create();

    this._controls.poolSize = new Slider({
      id: 'bubble-pool-size',
      label: 'Pool Size',
      path: 'voicePools.bubblePoolSize',
      min: 1,
      max: 32,
      step: 1,
      value: this._config.poolSize,
      variant: 'resonance',
      formatValue: (v) => v + ' voices',
    });
    poolGroup.addControl(this._controls.poolSize.create());

    this._controls.oscillatorType = new Select({
      id: 'bubble-osc-type',
      label: 'Oscillator',
      path: 'bubble.oscillatorType',
      options: [
        { value: 'sine', label: 'Sine' },
        { value: 'triangle', label: 'Triangle' },
      ],
      value: this._config.oscillatorType,
    });
    poolGroup.addControl(this._controls.oscillatorType.create());

    this._controls.probability = new Slider({
      id: 'bubble-prob',
      label: 'Probability',
      path: 'bubble.probability',
      min: 0,
      max: 1,
      step: 0.05,
      value: this._config.probability,
      variant: 'resonance',
      formatValue: (v) => Math.round(v * 100) + '%',
    });
    poolGroup.addControl(this._controls.probability.create());

    this._element.appendChild(poolGroup.element!);

    // Chirp Group (frequency modulation)
    const chirpGroup = new ControlGroup({
      id: 'bubble-chirp',
      title: 'Frequency Chirp',
      variant: 'resonance',
    });
    chirpGroup.create();

    this._controls.chirpAmount = new Slider({
      id: 'bubble-chirp-amount',
      label: 'Amount',
      path: 'bubble.chirpAmount',
      min: 0,
      max: 2,
      step: 0.1,
      value: this._config.chirpAmount,
      variant: 'resonance',
      formatValue: (v) => v.toFixed(1) + 'x',
    });
    chirpGroup.addControl(this._controls.chirpAmount.create());

    this._controls.chirpTime = new Slider({
      id: 'bubble-chirp-time',
      label: 'Time',
      path: 'bubble.chirpTime',
      min: 0.01,
      max: 0.2,
      step: 0.01,
      value: this._config.chirpTime,
      unit: 's',
      variant: 'resonance',
      formatValue: (v) => (v * 1000).toFixed(0) + 'ms',
    });
    chirpGroup.addControl(this._controls.chirpTime.create());

    this._element.appendChild(chirpGroup.element!);

    // Frequency Range Group
    const freqGroup = new ControlGroup({
      id: 'bubble-freq',
      title: 'Frequency Range',
      variant: 'resonance',
    });
    freqGroup.create();

    this._controls.freqMin = new Slider({
      id: 'bubble-freq-min',
      label: 'Min Freq',
      path: 'bubble.freqMin',
      min: 100,
      max: 2000,
      step: 50,
      value: this._config.freqMin,
      unit: 'Hz',
      variant: 'resonance',
    });
    freqGroup.addControl(this._controls.freqMin.create());

    this._controls.freqMax = new Slider({
      id: 'bubble-freq-max',
      label: 'Max Freq',
      path: 'bubble.freqMax',
      min: 500,
      max: 8000,
      step: 100,
      value: this._config.freqMax,
      unit: 'Hz',
      variant: 'resonance',
    });
    freqGroup.addControl(this._controls.freqMax.create());

    this._element.appendChild(freqGroup.element!);

    return this._element;
  }

  updateConfig(config: Partial<BubblePoolConfig>): void {
    if (config.poolSize !== undefined) {
      (this._controls.poolSize as Slider)?.setValue(config.poolSize);
    }
    if (config.oscillatorType !== undefined) {
      (this._controls.oscillatorType as Select)?.setValue(config.oscillatorType);
    }
    if (config.probability !== undefined) {
      (this._controls.probability as Slider)?.setValue(config.probability);
    }
    if (config.chirpAmount !== undefined) {
      (this._controls.chirpAmount as Slider)?.setValue(config.chirpAmount);
    }
    if (config.chirpTime !== undefined) {
      (this._controls.chirpTime as Slider)?.setValue(config.chirpTime);
    }
    if (config.freqMin !== undefined) {
      (this._controls.freqMin as Slider)?.setValue(config.freqMin);
    }
    if (config.freqMax !== undefined) {
      (this._controls.freqMax as Slider)?.setValue(config.freqMax);
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
