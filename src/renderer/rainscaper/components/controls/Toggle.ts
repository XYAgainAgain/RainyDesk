/**
 * Toggle - Switch component
 *
 * Reusable toggle switch control with label.
 */

import { sync } from '../../StateSync';

export interface ToggleConfig {
  id: string;
  label: string;
  path: string;
  value: boolean;
}

export class Toggle {
  private _element: HTMLDivElement | null = null;
  private _input: HTMLInputElement | null = null;
  private _config: ToggleConfig;

  constructor(config: ToggleConfig) {
    this._config = config;
  }

  create(): HTMLDivElement {
    this._element = document.createElement('div');
    this._element.className = 'rs-control-row';

    // Label
    const label = document.createElement('div');
    label.className = 'rs-control-row__label';
    label.textContent = this._config.label;

    // Toggle wrapper
    const toggleWrapper = document.createElement('label');
    toggleWrapper.className = 'rs-toggle';

    // Hidden checkbox input
    this._input = document.createElement('input');
    this._input.type = 'checkbox';
    this._input.className = 'rs-toggle__input';
    this._input.id = this._config.id;
    this._input.checked = this._config.value;

    this._input.addEventListener('change', () => this.handleChange());

    // Track
    const track = document.createElement('span');
    track.className = 'rs-toggle__track';

    // Thumb
    const thumb = document.createElement('span');
    thumb.className = 'rs-toggle__thumb';

    toggleWrapper.appendChild(this._input);
    toggleWrapper.appendChild(track);
    toggleWrapper.appendChild(thumb);

    this._element.appendChild(label);
    this._element.appendChild(toggleWrapper);

    return this._element;
  }

  private handleChange(): void {
    if (!this._input) return;

    const value = this._input.checked;
    sync.sendImmediate(this._config.path, value);
  }

  setValue(value: boolean): void {
    if (this._input) {
      this._input.checked = value;
    }
  }

  getValue(): boolean {
    return this._input?.checked ?? this._config.value;
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
  }
}
