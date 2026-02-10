/* Reusable slider, toggle, and knob components */

export interface SliderConfig {
  id?: string;
  label: string;
  matrixLabel?: string;
  sublabel?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  formatValue?: (v: number) => string;
  defaultValue?: number;
  onChange: (value: number) => void;
  lazy?: boolean; // onChange only fires on mouse release, not during drag
  extraElement?: HTMLElement;
}

export function Slider(config: SliderConfig): HTMLElement {
  const { id, label, matrixLabel, sublabel, value, min, max, step = 1, unit, formatValue, defaultValue, onChange, lazy = false, extraElement } = config;

  const row = document.createElement('div');
  row.className = 'control-row';
  if (id) {
    row.dataset.sliderId = id;
  }
  // Store unit for external value updates (e.g. OSC knob sync)
  row.dataset.sliderUnit = unit;
  // Store both labels for dynamic switching
  if (matrixLabel) {
    row.dataset.normalLabel = label;
    row.dataset.matrixLabel = matrixLabel;
  }

  const labelContainer = document.createElement('div');
  labelContainer.className = 'control-label-container';

  const labelEl = document.createElement('span');
  labelEl.className = 'control-label';
  labelEl.textContent = label;
  labelContainer.appendChild(labelEl);

  if (sublabel) {
    const sublabelEl = document.createElement('span');
    sublabelEl.className = 'control-sublabel';
    sublabelEl.textContent = sublabel;
    labelContainer.appendChild(sublabelEl);
    labelContainer.classList.add('has-sublabel');
  }

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
      // Reset accompanying OSC knob to 0 if present
      if (extraElement && 'setValue' in extraElement) {
        (extraElement as HTMLElement & { setValue: (v: number) => void }).setValue(0);
      }
    };
    labelContainer.appendChild(resetBtn);
  }

  if (extraElement) {
    labelContainer.appendChild(extraElement);
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
    if (!lazy) onChange(newValue);
  };

  if (lazy) {
    slider.onchange = () => onChange(parseFloat(slider.value));
  }

  sliderContainer.appendChild(slider);
  sliderContainer.appendChild(valueEl);

  row.appendChild(labelContainer);
  row.appendChild(sliderContainer);

  // Attach formatter for external value updates (OSC knob sync, etc.)
  if (formatValue) {
    (row as SliderRow)._formatValue = formatValue;
  }

  return row;
}

/* Slider row with attached formatter for external value updates */
export interface SliderRow extends HTMLElement {
  _formatValue?: (v: number) => string;
}

/* Update a slider's visual state externally without firing onChange (avoids feedback loops) */
export function updateSliderValue(container: HTMLElement, sliderId: string, value: number): void {
  const row = container.querySelector(`[data-slider-id="${sliderId}"]`) as SliderRow | null;
  if (!row) return;
  const slider = row.querySelector('.slider') as HTMLInputElement | null;
  const valueEl = row.querySelector('.control-value') as HTMLElement | null;
  if (slider) slider.value = String(value);
  if (valueEl) {
    const unit = row.dataset.sliderUnit || '';
    const formatter = row._formatValue;
    const display = formatter ? formatter(value) : String(Math.round(value));
    valueEl.textContent = unit ? `${display}${unit}` : display;
  }
}

export interface ToggleConfig {
  label: string;
  sublabel?: string;
  checked: boolean;
  disabled?: boolean;
  disabledNote?: string;
  onChange: (checked: boolean) => void;
}

export function Toggle(config: ToggleConfig): HTMLElement {
  const { label, sublabel, checked, disabled = false, disabledNote, onChange } = config;

  const row = document.createElement('div');
  row.className = 'control-row';
  if (disabled) {
    row.classList.add('disabled');
  }

  const labelContainer = document.createElement('div');
  labelContainer.className = 'toggle-label-container';

  const labelEl = document.createElement('span');
  labelEl.className = 'control-label';
  labelEl.textContent = label;
  if (disabled && disabledNote) {
    const note = document.createElement('span');
    note.className = 'control-note';
    note.textContent = ` (${disabledNote})`;
    labelEl.appendChild(note);
  }
  labelContainer.appendChild(labelEl);

  if (sublabel) {
    const sublabelEl = document.createElement('span');
    sublabelEl.className = 'control-sublabel';
    sublabelEl.textContent = sublabel;
    labelContainer.appendChild(sublabelEl);
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

  row.appendChild(labelContainer);
  row.appendChild(toggleContainer);

  return row;
}

export interface ColorPickerConfig {
  label: string;
  value: string;
  presets?: string[];
  defaultValue?: string | (() => string); // Static or dynamic default for reset button
  onChange: (color: string) => void;
}

export function ColorPicker(config: ColorPickerConfig): HTMLElement {
  const { label, value, presets = ['#4a9eff', '#ff6b6b', '#6bff6b', '#ffff6b', '#ff6bff', '#6bffff', '#ff7300', '#ffffff', '#888888'], defaultValue, onChange } = config;

  const row = document.createElement('div');
  row.className = 'control-row color-picker-row';

  const labelContainer = document.createElement('div');
  labelContainer.className = 'control-label-container';

  const labelEl = document.createElement('span');
  labelEl.className = 'control-label';
  labelEl.textContent = label;
  labelContainer.appendChild(labelEl);

  if (defaultValue !== undefined) {
    const resetBtn = document.createElement('button');
    resetBtn.className = 'reset-button';
    resetBtn.title = 'Reset to default';
    resetBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
    resetBtn.onclick = (e) => {
      e.preventDefault();
      // Get the current default (may be dynamic based on mode)
      const currentDefault = typeof defaultValue === 'function' ? defaultValue() : defaultValue;
      colorInput.value = currentDefault;
      onChange(currentDefault);
      // Update active state
      swatches.querySelectorAll('.color-swatch').forEach(s => {
        s.classList.toggle('active', (s as HTMLElement).style.backgroundColor === currentDefault);
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

// TriToggle (3-state selector: left / off / right)

export interface TriToggleConfig {
  label: string;
  value: 'left' | 'off' | 'right';
  leftLabel?: string;
  rightLabel?: string;
  onChange: (value: 'left' | 'off' | 'right') => void;
  id?: string;
}

export function TriToggle(config: TriToggleConfig): HTMLElement {
  const { label, value, leftLabel = '\u25C0', rightLabel = '\u25B6', onChange, id } = config;

  const row = document.createElement('div');
  row.className = 'tri-toggle';
  if (id) row.id = id;

  const labelEl = document.createElement('span');
  labelEl.className = 'tri-toggle-label';
  labelEl.textContent = label;

  const track = document.createElement('div');
  track.className = 'tri-toggle-track';

  const segments: { key: 'left' | 'off' | 'right'; label: string }[] = [
    { key: 'left', label: leftLabel },
    { key: 'off', label: 'Off' },
    { key: 'right', label: rightLabel },
  ];

  // Sliding highlight pill that moves between positions
  const slider = document.createElement('div');
  slider.className = 'tri-toggle-slider';
  track.appendChild(slider);

  const positionMap: Record<string, { left: string; colorClass: string }> = {
    left: { left: '2px', colorClass: 'slider-left' },
    off: { left: 'calc(33.33% + 0.5px)', colorClass: 'slider-off' },
    right: { left: 'calc(66.66% - 1px)', colorClass: 'slider-right' },
  };

  const updateSlider = (key: string) => {
    const pos = positionMap[key]!;
    slider.style.left = pos.left;
    slider.className = `tri-toggle-slider ${pos.colorClass}`;
  };
  updateSlider(value);

  const segmentEls: HTMLElement[] = [];

  for (const seg of segments) {
    const el = document.createElement('div');
    el.className = 'tri-toggle-segment';
    el.textContent = seg.label;
    if (seg.key === value) el.classList.add('selected');
    el.addEventListener('click', () => {
      for (const s of segmentEls) s.classList.remove('selected');
      el.classList.add('selected');
      updateSlider(seg.key);
      onChange(seg.key);
    });
    segmentEls.push(el);
    track.appendChild(el);
  }

  row.appendChild(labelEl);
  row.appendChild(track);

  return row;
}

// RotaryKnob (generic, reusable fine-tuning control)

export interface RotaryKnobConfig {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  id?: string;
  description?: string; // Tooltip text
}

export function RotaryKnob(config: RotaryKnobConfig): HTMLElement {
  const { min, max, onChange, id, description } = config;
  let currentValue = config.value;

  const knob = document.createElement('div');
  knob.className = 'rotary-knob';
  if (id) knob.dataset.knobId = id;

  const tooltipPrefix = description ? `${description}: ` : '';
  knob.title = `${tooltipPrefix}${Math.round(currentValue)}`;

  const indicator = document.createElement('div');
  indicator.className = 'rotary-knob-indicator';
  knob.appendChild(indicator);

  // Map to rotation angle: 0 = 225deg, max = 315deg, arc spans 270deg total
  const updateVisual = () => {
    const t = (currentValue - min) / (max - min); // 0-1
    const angle = 225 + t * 270; // 225deg to 495deg
    indicator.style.transform = `rotate(${angle}deg)`;
    knob.title = `${tooltipPrefix}${Math.round(currentValue)}`;

    knob.classList.toggle('has-value', t > 0.01);

    const arcDeg = t * 270; // 0deg to 270deg
    knob.style.setProperty('--glow-arc-deg', `${arcDeg}deg`);

    // Toggle osc-active on parent .control-row so the paired slider shows feedback
    // Use requestAnimationFrame so this also works during initial construction
    // (knob might not be in DOM yet when updateVisual first runs)
    requestAnimationFrame(() => {
      const controlRow = knob.closest('.control-row');
      if (controlRow) {
        controlRow.classList.toggle('osc-active', t > 0.01);
      }
    });
  };

  updateVisual();

  // DAW-style dual-axis drag
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startValue = 0;

  const onMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startValue = currentValue;
    knob.classList.add('active');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!dragging) return;
    // Up or right = increase, down or left = decrease
    const deltaX = e.clientX - startX;
    const deltaY = -(e.clientY - startY); // Invert Y so up = positive
    const combined = (deltaX + deltaY) * 0.5;
    const range = max - min;
    // ~2px per unit of value
    const sensitivity = range / 100;
    const newValue = Math.max(min, Math.min(max, startValue + combined * sensitivity));
    currentValue = Math.round(newValue);
    updateVisual();
    onChange(currentValue);
  };

  const onMouseUp = () => {
    dragging = false;
    knob.classList.remove('active');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };

  knob.addEventListener('mousedown', onMouseDown);

  // Double-click to zero
  knob.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    currentValue = min;
    updateVisual();
    onChange(min);
  });

  // Enables slider Reset buttons & similar
  (knob as unknown as { setValue: (v: number) => void }).setValue = (v: number) => {
    currentValue = Math.max(min, Math.min(max, Math.round(v)));
    updateVisual();
    onChange(currentValue);
  };

  // Safety cleanup: if knob is removed from DOM mid-drag, release listeners
  const observer = new MutationObserver(() => {
    if (!knob.isConnected) {
      onMouseUp();
      observer.disconnect();
    }
  });
  requestAnimationFrame(() => {
    if (knob.parentElement) {
      observer.observe(knob.parentElement, { childList: true });
    }
  });

  return knob;
}
