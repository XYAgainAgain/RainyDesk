/**
 * Select - Styled dropdown control
 *
 * Reusable select control with label and options.
 */

import { sync } from '../../StateSync';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectConfig {
  id: string;
  label: string;
  path: string;
  options: SelectOption[];
  value: string;
}

export class Select {
  private _element: HTMLDivElement | null = null;
  private _select: HTMLSelectElement | null = null;
  private _config: SelectConfig;

  constructor(config: SelectConfig) {
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

    // Select element
    this._select = document.createElement('select');
    this._select.className = 'rs-select';
    this._select.id = this._config.id;

    for (const opt of this._config.options) {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      if (opt.value === this._config.value) {
        option.selected = true;
      }
      this._select.appendChild(option);
    }

    this._select.addEventListener('change', () => this.handleChange());

    inputWrapper.appendChild(this._select);

    this._element.appendChild(label);
    this._element.appendChild(inputWrapper);

    return this._element;
  }

  private handleChange(): void {
    if (!this._select) return;

    const value = this._select.value;
    sync.sendImmediate(this._config.path, value);
  }

  setValue(value: string): void {
    if (this._select) {
      this._select.value = value;
    }
  }

  getValue(): string {
    return this._select?.value ?? this._config.value;
  }

  get element(): HTMLDivElement | null {
    return this._element;
  }

  get path(): string {
    return this._config.path;
  }

  dispose(): void {
    this._element = null;
    this._select = null;
  }
}
