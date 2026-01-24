/**
 * MaterialSection - Full material property controls (Admin mode)
 *
 * Allows editing all material configuration properties.
 */

import { ControlGroup, Slider, Select } from '../components/controls';
import type { MaterialConfig } from '../../../types/audio';

export interface MaterialSectionCallbacks {
  onMaterialChange?: (config: Partial<MaterialConfig>) => void;
}

export class MaterialSection {
  private _element: HTMLDivElement | null = null;
  private _config: MaterialConfig;
  private _controls: Record<string, Slider | Select> = {};

  constructor(config: MaterialConfig, _callbacks: MaterialSectionCallbacks = {}) {
    this._config = config;
    // Callbacks reserved for future use (e.g., onMaterialChange events)
  }

  create(): HTMLDivElement {
    this._element = document.createElement('div');
    this._element.className = 'rs-section';

    // Material Properties Group
    const propsGroup = new ControlGroup({
      id: 'material-props',
      title: 'Material Properties',
      variant: 'resonance',
      collapsible: false,
    });
    propsGroup.create();

    // Bubble Probability
    this._controls.bubbleProbability = new Slider({
      id: 'mat-bubble-prob',
      label: 'Bubble Prob',
      path: 'material.bubbleProbability',
      min: 0,
      max: 1,
      step: 0.05,
      value: this._config.bubbleProbability,
      variant: 'resonance',
      formatValue: (v) => Math.round(v * 100) + '%',
    });
    propsGroup.addControl(this._controls.bubbleProbability.create());

    // Impact Synth Type
    this._controls.impactSynthType = new Select({
      id: 'mat-impact-type',
      label: 'Impact Type',
      path: 'material.impactSynthType',
      options: [
        { value: 'noise', label: 'Noise' },
        { value: 'membrane', label: 'Membrane' },
        { value: 'metal', label: 'Metal' },
      ],
      value: this._config.impactSynthType,
    });
    propsGroup.addControl(this._controls.impactSynthType.create());

    // Bubble Oscillator Type
    this._controls.bubbleOscType = new Select({
      id: 'mat-bubble-osc',
      label: 'Bubble Osc',
      path: 'material.bubbleOscillatorType',
      options: [
        { value: 'sine', label: 'Sine' },
        { value: 'triangle', label: 'Triangle' },
      ],
      value: this._config.bubbleOscillatorType,
    });
    propsGroup.addControl(this._controls.bubbleOscType.create());

    this._element.appendChild(propsGroup.element!);

    // Filter Group
    const filterGroup = new ControlGroup({
      id: 'material-filter',
      title: 'Filter',
      variant: 'water',
    });
    filterGroup.create();

    this._controls.filterFreq = new Slider({
      id: 'mat-filter-freq',
      label: 'Frequency',
      path: 'material.filterFreq',
      min: 100,
      max: 10000,
      step: 100,
      value: this._config.filterFreq,
      unit: 'Hz',
      variant: 'water',
    });
    filterGroup.addControl(this._controls.filterFreq.create());

    this._controls.filterQ = new Slider({
      id: 'mat-filter-q',
      label: 'Q (Resonance)',
      path: 'material.filterQ',
      min: 0.1,
      max: 10,
      step: 0.1,
      value: this._config.filterQ,
      variant: 'water',
    });
    filterGroup.addControl(this._controls.filterQ.create());

    this._element.appendChild(filterGroup.element!);

    // Envelope Group
    const envGroup = new ControlGroup({
      id: 'material-envelope',
      title: 'Decay Envelope',
      variant: 'neutral',
    });
    envGroup.create();

    this._controls.decayMin = new Slider({
      id: 'mat-decay-min',
      label: 'Decay Min',
      path: 'material.decayMin',
      min: 0.01,
      max: 0.5,
      step: 0.01,
      value: this._config.decayMin,
      unit: 's',
      variant: 'neutral',
    });
    envGroup.addControl(this._controls.decayMin.create());

    this._controls.decayMax = new Slider({
      id: 'mat-decay-max',
      label: 'Decay Max',
      path: 'material.decayMax',
      min: 0.01,
      max: 0.5,
      step: 0.01,
      value: this._config.decayMax,
      unit: 's',
      variant: 'neutral',
    });
    envGroup.addControl(this._controls.decayMax.create());

    this._element.appendChild(envGroup.element!);

    // Pitch & Gain Group
    const pitchGroup = new ControlGroup({
      id: 'material-pitch',
      title: 'Pitch & Gain',
      variant: 'resonance',
    });
    pitchGroup.create();

    this._controls.pitchMultiplier = new Slider({
      id: 'mat-pitch-mult',
      label: 'Pitch Mult',
      path: 'material.pitchMultiplier',
      min: 0.1,
      max: 3,
      step: 0.1,
      value: this._config.pitchMultiplier,
      variant: 'resonance',
      formatValue: (v) => v.toFixed(1) + 'x',
    });
    pitchGroup.addControl(this._controls.pitchMultiplier.create());

    this._controls.gainOffset = new Slider({
      id: 'mat-gain-offset',
      label: 'Gain Offset',
      path: 'material.gainOffset',
      min: -12,
      max: 12,
      step: 1,
      value: this._config.gainOffset,
      unit: 'dB',
      variant: 'positive',
    });
    pitchGroup.addControl(this._controls.gainOffset.create());

    this._element.appendChild(pitchGroup.element!);

    return this._element;
  }

  updateConfig(config: Partial<MaterialConfig>): void {
    if (config.bubbleProbability !== undefined) {
      (this._controls.bubbleProbability as Slider)?.setValue(config.bubbleProbability);
    }
    if (config.impactSynthType !== undefined) {
      (this._controls.impactSynthType as Select)?.setValue(config.impactSynthType);
    }
    if (config.bubbleOscillatorType !== undefined) {
      (this._controls.bubbleOscType as Select)?.setValue(config.bubbleOscillatorType);
    }
    if (config.filterFreq !== undefined) {
      (this._controls.filterFreq as Slider)?.setValue(config.filterFreq);
    }
    if (config.filterQ !== undefined) {
      (this._controls.filterQ as Slider)?.setValue(config.filterQ);
    }
    if (config.decayMin !== undefined) {
      (this._controls.decayMin as Slider)?.setValue(config.decayMin);
    }
    if (config.decayMax !== undefined) {
      (this._controls.decayMax as Slider)?.setValue(config.decayMax);
    }
    if (config.pitchMultiplier !== undefined) {
      (this._controls.pitchMultiplier as Slider)?.setValue(config.pitchMultiplier);
    }
    if (config.gainOffset !== undefined) {
      (this._controls.gainOffset as Slider)?.setValue(config.gainOffset);
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
