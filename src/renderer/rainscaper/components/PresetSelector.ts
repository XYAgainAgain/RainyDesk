/**
 * PresetSelector - Dropdown and action buttons for rainscape presets
 *
 * Shows preset dropdown, save button, and import/export buttons.
 */

import { state } from '../RainscaperState';

export interface PresetSelectorCallbacks {
  onPresetSelect?: (presetName: string) => void;
  onSave?: () => void;
  onImport?: () => void;
  onExport?: () => void;
}

export class PresetSelector {
  private _element: HTMLDivElement | null = null;
  private _select: HTMLSelectElement | null = null;
  private _saveBtn: HTMLButtonElement | null = null;
  private _callbacks: PresetSelectorCallbacks;

  constructor(callbacks: PresetSelectorCallbacks = {}) {
    this._callbacks = callbacks;
  }

  create(): HTMLDivElement {
    this._element = document.createElement('div');
    this._element.className = 'rs-preset-bar';

    // Preset dropdown
    this._select = document.createElement('select');
    this._select.className = 'rs-select rs-preset-bar__select';
    this._select.addEventListener('change', () => {
      const value = this._select?.value;
      if (value) {
        this._callbacks.onPresetSelect?.(value);
      }
    });

    // Save button
    this._saveBtn = document.createElement('button');
    this._saveBtn.className = 'rs-btn rs-btn--success';
    this._saveBtn.textContent = 'Save';
    this._saveBtn.addEventListener('click', () => {
      this._callbacks.onSave?.();
    });

    // Import button
    const importBtn = document.createElement('button');
    importBtn.className = 'rs-btn rs-btn--secondary';
    importBtn.textContent = 'Import';
    importBtn.title = 'Import rainscape from JSON';
    importBtn.addEventListener('click', () => {
      this._callbacks.onImport?.();
    });

    // Export button
    const exportBtn = document.createElement('button');
    exportBtn.className = 'rs-btn rs-btn--secondary';
    exportBtn.textContent = 'Export';
    exportBtn.title = 'Export current rainscape to JSON';
    exportBtn.addEventListener('click', () => {
      this._callbacks.onExport?.();
    });

    this._element.appendChild(this._select);
    this._element.appendChild(this._saveBtn);
    this._element.appendChild(importBtn);
    this._element.appendChild(exportBtn);

    // Subscribe to state changes
    state.subscribe((s) => {
      this.updatePresets(s.presets);
      this.updateDirtyState(s.isDirty);
    });

    return this._element;
  }

  updatePresets(presets: string[]): void {
    if (!this._select) return;

    const currentValue = this._select.value;
    this._select.innerHTML = '';

    // Default option
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Select Rainscape...';
    this._select.appendChild(defaultOpt);

    // Preset options
    for (const preset of presets) {
      const opt = document.createElement('option');
      opt.value = preset;
      opt.textContent = preset.replace('.json', '');
      this._select.appendChild(opt);
    }

    // Restore selection if still valid
    if (presets.includes(currentValue)) {
      this._select.value = currentValue;
    }
  }

  updateDirtyState(isDirty: boolean): void {
    if (this._saveBtn) {
      this._saveBtn.classList.toggle('pulse', isDirty);
    }
  }

  setSelectedPreset(presetName: string): void {
    if (this._select) {
      const filename = presetName.endsWith('.json') ? presetName : presetName + '.json';
      this._select.value = filename;
    }
  }

  get element(): HTMLDivElement | null {
    return this._element;
  }

  dispose(): void {
    this._element = null;
    this._select = null;
    this._saveBtn = null;
  }
}
