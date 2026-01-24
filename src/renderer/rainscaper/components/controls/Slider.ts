/**
 * Slider - Range input with value display
 *
 * Reusable slider control with label, range input, and formatted value.
 */

import { sync } from '../../StateSync';

export type SliderVariant = 'water' | 'resonance' | 'earth' | 'air' | 'positive' | 'neutral';

export interface SliderConfig {
  id: string;
  label: string;
  path: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  unit?: string;
  variant?: SliderVariant;
  formatValue?: (value: number) => string;
  transformValue?: (value: number) => number;
}

export class Slider {
  private _element: HTMLDivElement | null = null;
  private _input: HTMLInputElement | null = null;
  private _valueDisplay: HTMLSpanElement | null = null;
  private _config: SliderConfig;

  constructor(config: SliderConfig) {
    this._config = config;
  }

  create(): HTMLDivElement {
    this._element = document.createElement('div');
    this._element.className = 'rs-control-row';

    // Label
    const label = document.createElement('div');
    label.className = 'rs-control-row__label';
    label.textContent = this._config.label;

    // Input wrapper
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'rs-control-row__input';

    // Range input
    this._input = document.createElement('input');
    this._input.type = 'range';
    this._input.className = 'rs-slider';
    if (this._config.variant) {
      this._input.classList.add(`rs-slider--${this._config.variant}`);
    }
    this._input.id = this._config.id;
    this._input.min = String(this._config.min);
    this._input.max = String(this._config.max);
    this._input.step = String(this._config.step ?? 1);
    this._input.value = String(this._config.value);

    this._input.addEventListener('input', () => this.handleInput());

    inputWrapper.appendChild(this._input);

    // Value display
    const valueContainer = document.createElement('div');
    valueContainer.className = 'rs-control-row__value';

    this._valueDisplay = document.createElement('span');
    this._valueDisplay.textContent = this.formatValue(this._config.value);
    valueContainer.appendChild(this._valueDisplay);

    if (this._config.unit) {
      const unitSpan = document.createElement('span');
      unitSpan.className = 'rs-control-row__unit';
      unitSpan.textContent = this._config.unit;
      valueContainer.appendChild(unitSpan);
    }

    this._element.appendChild(label);
    this._element.appendChild(inputWrapper);
    this._element.appendChild(valueContainer);

    return this._element;
  }

  private handleInput(): void {
    if (!this._input) return;

    const rawValue = parseFloat(this._input.value);
    const transformedValue = this._config.transformValue
      ? this._config.transformValue(rawValue)
      : rawValue;

    // Update display
    if (this._valueDisplay) {
      this._valueDisplay.textContent = this.formatValue(rawValue);
    }

    // Queue IPC update (debounced)
    sync.queueUpdate(this._config.path, transformedValue);
  }

  private formatValue(value: number): string {
    if (this._config.formatValue) {
      return this._config.formatValue(value);
    }

    // Default formatting based on step
    const step = this._config.step ?? 1;
    if (step < 1) {
      const decimals = String(step).split('.')[1]?.length ?? 1;
      return value.toFixed(decimals);
    }
    return String(Math.round(value));
  }

  setValue(value: number): void {
    if (this._input) {
      this._input.value = String(value);
    }
    if (this._valueDisplay) {
      this._valueDisplay.textContent = this.formatValue(value);
    }
  }

  getValue(): number {
    return this._input ? parseFloat(this._input.value) : this._config.value;
  }

  get element(): HTMLDivElement | null {
    return this._element;
  }

  get path(): string {
    return this._config.path;
  }

  dispose(): void {
    this._element = null;
    this._input = null;
    this._valueDisplay = null;
  }
}
