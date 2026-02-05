/**
 * RainyDesk Panel - UI Components
 *
 * Reusable slider and toggle components.
 */

export interface SliderConfig {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  formatValue?: (v: number) => string;
  defaultValue?: number;
  onChange: (value: number) => void;
}

export function Slider(config: SliderConfig): HTMLElement {
  const { label, value, min, max, step = 1, unit, formatValue, defaultValue, onChange } = config;

  const row = document.createElement('div');
  row.className = 'control-row';

  // Label container to hold label + optional reset button
  const labelContainer = document.createElement('div');
  labelContainer.className = 'control-label-container';

  const labelEl = document.createElement('span');
  labelEl.className = 'control-label';
  labelEl.textContent = label;
  labelContainer.appendChild(labelEl);

  // Add reset button next to label if defaultValue is provided
  if (defaultValue !== undefined) {
    const resetBtn = document.createElement('button');
    resetBtn.className = 'reset-button';
    resetBtn.title = `Reset to ${defaultValue}`;
    resetBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
    resetBtn.onclick = (e) => {
      e.preventDefault();
      slider.value = String(defaultValue);
      const display = formatValue ? formatValue(defaultValue) : String(Math.round(defaultValue));
      valueEl.textContent = unit ? `${display}${unit}` : display;
      onChange(defaultValue);
    };
    labelContainer.appendChild(resetBtn);
  }

  const sliderContainer = document.createElement('div');
  sliderContainer.className = 'slider-container';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'slider';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);

  const valueEl = document.createElement('span');
  valueEl.className = 'control-value';
  const displayValue = formatValue ? formatValue(value) : String(Math.round(value));
  valueEl.textContent = unit ? `${displayValue}${unit}` : displayValue;

  slider.oninput = () => {
    const newValue = parseFloat(slider.value);
    const display = formatValue ? formatValue(newValue) : String(Math.round(newValue));
    valueEl.textContent = unit ? `${display}${unit}` : display;
    onChange(newValue);
  };

  sliderContainer.appendChild(slider);
  sliderContainer.appendChild(valueEl);

  row.appendChild(labelContainer);
  row.appendChild(sliderContainer);

  return row;
}

export interface ToggleConfig {
  label: string;
  checked: boolean;
  disabled?: boolean;
  disabledNote?: string;
  onChange: (checked: boolean) => void;
}

export function Toggle(config: ToggleConfig): HTMLElement {
  const { label, checked, disabled = false, disabledNote, onChange } = config;

  const row = document.createElement('div');
  row.className = 'control-row';
  if (disabled) {
    row.classList.add('disabled');
  }

  const labelEl = document.createElement('span');
  labelEl.className = 'control-label';
  labelEl.textContent = label;
  if (disabled && disabledNote) {
    const note = document.createElement('span');
    note.className = 'control-note';
    note.textContent = ` (${disabledNote})`;
    labelEl.appendChild(note);
  }

  const toggleContainer = document.createElement('div');
  toggleContainer.className = 'toggle-container';

  const toggle = document.createElement('label');
  toggle.className = 'toggle';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.disabled = disabled;

  const track = document.createElement('span');
  track.className = 'toggle-track';

  const thumb = document.createElement('span');
  thumb.className = 'toggle-thumb';

  input.onchange = () => {
    onChange(input.checked);
  };

  toggle.appendChild(input);
  toggle.appendChild(track);
  toggle.appendChild(thumb);
  toggleContainer.appendChild(toggle);

  row.appendChild(labelEl);
  row.appendChild(toggleContainer);

  return row;
}

export interface ColorPickerConfig {
  label: string;
  value: string;
  presets?: string[];
  defaultValue?: string;
  onChange: (color: string) => void;
}

export function ColorPicker(config: ColorPickerConfig): HTMLElement {
  const { label, value, presets = ['#4a9eff', '#ff6b6b', '#6bff6b', '#ffff6b', '#ff6bff', '#6bffff', '#ffffff', '#888888'], defaultValue, onChange } = config;

  const row = document.createElement('div');
  row.className = 'control-row color-picker-row';

  // Label container to hold label + optional reset button
  const labelContainer = document.createElement('div');
  labelContainer.className = 'control-label-container';

  const labelEl = document.createElement('span');
  labelEl.className = 'control-label';
  labelEl.textContent = label;
  labelContainer.appendChild(labelEl);

  // Add reset button next to label if defaultValue is provided
  if (defaultValue !== undefined) {
    const resetBtn = document.createElement('button');
    resetBtn.className = 'reset-button';
    resetBtn.title = 'Reset to default';
    resetBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
    resetBtn.onclick = (e) => {
      e.preventDefault();
      colorInput.value = defaultValue;
      onChange(defaultValue);
      // Update active state
      swatches.querySelectorAll('.color-swatch').forEach(s => {
        s.classList.toggle('active', (s as HTMLElement).style.backgroundColor === defaultValue);
      });
    };
    labelContainer.appendChild(resetBtn);
  }

  const pickerContainer = document.createElement('div');
  pickerContainer.className = 'color-picker-container';

  // Color input (native picker)
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'color-input';
  colorInput.value = value;
  colorInput.oninput = () => {
    onChange(colorInput.value);
    // Clear active state on custom color
    swatches.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
  };

  // Preset swatches
  const swatches = document.createElement('div');
  swatches.className = 'color-swatches';

  for (const preset of presets) {
    const swatch = document.createElement('button');
    swatch.className = 'color-swatch';
    swatch.style.backgroundColor = preset;
    if (preset === value) {
      swatch.classList.add('active');
    }
    swatch.onclick = () => {
      colorInput.value = preset;
      onChange(preset);
      // Update active state
      swatches.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
    };
    swatches.appendChild(swatch);
  }

  pickerContainer.appendChild(colorInput);
  pickerContainer.appendChild(swatches);

  row.appendChild(labelContainer);
  row.appendChild(pickerContainer);

  return row;
}
