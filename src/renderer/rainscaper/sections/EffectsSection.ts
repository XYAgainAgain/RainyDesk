/**
 * EffectsSection - EQ, Reverb, and Master Volume controls
 *
 * Available in both User and Admin modes.
 */

import { ControlGroup, Slider } from '../components/controls';
import { sync } from '../StateSync';

interface EQPreset {
  id: string;
  name: string;
  low: number;
  mid: number;
  high: number;
}

const EQ_PRESETS: EQPreset[] = [
  { id: 'flat', name: 'Flat', low: 0, mid: 0, high: 0 },
  { id: 'warm', name: 'Warm', low: 3, mid: -1, high: -2 },
  { id: 'bright', name: 'Bright', low: -2, mid: 0, high: 3 },
  { id: 'deep', name: 'Deep', low: 4, mid: -2, high: -3 },
];

export interface EffectsSectionConfig {
  masterVolume: number;
  eq: { low: number; mid: number; high: number };
  reverb: { decay: number; wetness: number };
}

export interface EffectsSectionCallbacks {
  onMasterVolumeChange?: (volume: number) => void;
  onEQChange?: (eq: { low: number; mid: number; high: number }) => void;
  onReverbChange?: (reverb: { decay: number; wetness: number }) => void;
}

export class EffectsSection {
  private _element: HTMLDivElement | null = null;
  private _config: EffectsSectionConfig;
  private _callbacks: EffectsSectionCallbacks;
  private _controls: {
    masterVolume?: Slider;
    eqLow?: Slider;
    eqMid?: Slider;
    eqHigh?: Slider;
    reverbDecay?: Slider;
    reverbWet?: Slider;
  } = {};
  private _activeEQPreset: string = 'flat';

  constructor(config: EffectsSectionConfig, callbacks: EffectsSectionCallbacks = {}) {
    this._config = config;
    this._callbacks = callbacks;
  }

  create(): HTMLDivElement {
    this._element = document.createElement('div');
    this._element.className = 'rs-section';

    // Master Volume Group
    const masterGroup = new ControlGroup({
      id: 'effects-master',
      title: 'Master',
      variant: 'positive',
      collapsible: false,
    });
    masterGroup.create();

    this._controls.masterVolume = new Slider({
      id: 'master-volume',
      label: 'Volume',
      path: 'effects.masterVolume',
      min: -60,
      max: 6,
      step: 1,
      value: this._config.masterVolume,
      unit: 'dB',
      variant: 'positive',
      formatValue: (v) => v <= -60 ? 'Mute' : String(v),
      transformValue: (v) => v <= -60 ? -Infinity : v,
    });
    masterGroup.addControl(this._controls.masterVolume.create());

    // EQ Group
    const eqGroup = new ControlGroup({
      id: 'effects-eq',
      title: 'Equalizer',
      variant: 'neutral',
    });
    eqGroup.create();

    // EQ Presets
    const presetRow = this.createEQPresets();
    eqGroup.addControl(presetRow);

    this._controls.eqLow = new Slider({
      id: 'eq-low',
      label: 'Low',
      path: 'effects.eq.low',
      min: -12,
      max: 12,
      step: 1,
      value: this._config.eq.low,
      unit: 'dB',
      variant: 'neutral',
    });
    eqGroup.addControl(this._controls.eqLow.create());

    this._controls.eqMid = new Slider({
      id: 'eq-mid',
      label: 'Mid',
      path: 'effects.eq.mid',
      min: -12,
      max: 12,
      step: 1,
      value: this._config.eq.mid,
      unit: 'dB',
      variant: 'neutral',
    });
    eqGroup.addControl(this._controls.eqMid.create());

    this._controls.eqHigh = new Slider({
      id: 'eq-high',
      label: 'High',
      path: 'effects.eq.high',
      min: -12,
      max: 12,
      step: 1,
      value: this._config.eq.high,
      unit: 'dB',
      variant: 'neutral',
    });
    eqGroup.addControl(this._controls.eqHigh.create());

    // Reverb Group
    const reverbGroup = new ControlGroup({
      id: 'effects-reverb',
      title: 'Reverb',
      variant: 'air',
    });
    reverbGroup.create();

    this._controls.reverbDecay = new Slider({
      id: 'reverb-decay',
      label: 'Decay',
      path: 'effects.reverb.decay',
      min: 0.1,
      max: 10,
      step: 0.1,
      value: this._config.reverb.decay,
      unit: 's',
      variant: 'air',
    });
    reverbGroup.addControl(this._controls.reverbDecay.create());

    this._controls.reverbWet = new Slider({
      id: 'reverb-wet',
      label: 'Wetness',
      path: 'effects.reverb.wetness',
      min: 0,
      max: 1,
      step: 0.05,
      value: this._config.reverb.wetness,
      variant: 'air',
      formatValue: (v) => Math.round(v * 100) + '%',
    });
    reverbGroup.addControl(this._controls.reverbWet.create());

    this._element.appendChild(masterGroup.element!);
    this._element.appendChild(eqGroup.element!);
    this._element.appendChild(reverbGroup.element!);

    return this._element;
  }

  private createEQPresets(): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'rs-control-row';

    const label = document.createElement('div');
    label.className = 'rs-control-row__label';
    label.textContent = 'Preset';

    const presets = document.createElement('div');
    presets.className = 'rs-eq-presets';
    presets.style.flex = '1';

    for (const preset of EQ_PRESETS) {
      const btn = document.createElement('button');
      btn.className = 'rs-eq-preset';
      btn.textContent = preset.name;
      btn.dataset.preset = preset.id;

      if (preset.id === this._activeEQPreset) {
        btn.classList.add('active');
      }

      btn.addEventListener('click', () => {
        this.applyEQPreset(preset);
        // Update active state
        presets.querySelectorAll('.rs-eq-preset').forEach((b) => {
          b.classList.toggle('active', b === btn);
        });
      });

      presets.appendChild(btn);
    }

    row.appendChild(label);
    row.appendChild(presets);

    return row;
  }

  private applyEQPreset(preset: EQPreset): void {
    this._activeEQPreset = preset.id;

    this._controls.eqLow?.setValue(preset.low);
    this._controls.eqMid?.setValue(preset.mid);
    this._controls.eqHigh?.setValue(preset.high);

    sync.sendImmediate('effects.eq.low', preset.low);
    sync.sendImmediate('effects.eq.mid', preset.mid);
    sync.sendImmediate('effects.eq.high', preset.high);

    this._callbacks.onEQChange?.({ low: preset.low, mid: preset.mid, high: preset.high });
  }

  updateConfig(config: Partial<EffectsSectionConfig>): void {
    if (config.masterVolume !== undefined) {
      this._controls.masterVolume?.setValue(config.masterVolume);
    }
    if (config.eq) {
      if (config.eq.low !== undefined) this._controls.eqLow?.setValue(config.eq.low);
      if (config.eq.mid !== undefined) this._controls.eqMid?.setValue(config.eq.mid);
      if (config.eq.high !== undefined) this._controls.eqHigh?.setValue(config.eq.high);
    }
    if (config.reverb) {
      if (config.reverb.decay !== undefined) this._controls.reverbDecay?.setValue(config.reverb.decay);
      if (config.reverb.wetness !== undefined) this._controls.reverbWet?.setValue(config.reverb.wetness);
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
