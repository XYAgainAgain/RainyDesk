/**
 * PhysicsSection - Intensity, wind, and gravity controls
 *
 * Available in both User and Admin modes.
 */

import { ControlGroup, Slider, Toggle } from '../components/controls';

export interface PhysicsSectionConfig {
  intensity: number;
  wind: number;
  gravity: number;
  dropMinSize: number;
  dropMaxSize: number;
  terminalVelocity: number;
  renderScale: number;
  // Background rain shader settings
  backgroundRainEnabled: boolean;
}

export interface PhysicsSectionCallbacks {
  onIntensityChange?: (intensity: number) => void;
  onWindChange?: (wind: number) => void;
  onGravityChange?: (gravity: number) => void;
}

export class PhysicsSection {
  private _element: HTMLDivElement | null = null;
  private _config: PhysicsSectionConfig;
  private _controls: {
    intensity?: Slider;
    wind?: Slider;
    gravity?: Slider;
    dropMinSize?: Slider;
    dropMaxSize?: Slider;
    terminalVelocity?: Slider;
    renderScale?: Slider;
    backgroundRainEnabled?: Toggle;
  } = {};
  private _isAdminMode: boolean;

  constructor(
    config: PhysicsSectionConfig,
    _callbacks: PhysicsSectionCallbacks = {},
    isAdminMode = false
  ) {
    this._config = config;
    // Callbacks reserved for future use
    this._isAdminMode = isAdminMode;
  }

  create(): HTMLDivElement {
    this._element = document.createElement('div');
    this._element.className = 'rs-section';

    // Main Physics Group
    const mainGroup = new ControlGroup({
      id: 'physics-main',
      title: 'Rain Simulation',
      variant: 'earth',
      collapsible: false,
    });
    mainGroup.create();

    this._controls.intensity = new Slider({
      id: 'physics-intensity',
      label: 'Intensity',
      path: 'physics.intensity',
      min: 0,
      max: 100,
      step: 1,
      value: this._config.intensity,
      unit: '%',
      variant: 'earth',
    });
    mainGroup.addControl(this._controls.intensity.create());

    this._controls.wind = new Slider({
      id: 'physics-wind',
      label: 'Wind',
      path: 'physics.wind',
      min: -100,
      max: 100,
      step: 1,
      value: this._config.wind,
      variant: 'air',
      formatValue: (v) => {
        if (v === 0) return 'None';
        return (v > 0 ? '+' : '') + v;
      },
    });
    mainGroup.addControl(this._controls.wind.create());

    this._element.appendChild(mainGroup.element!);

    // Advanced Physics Group (Admin mode only shows all controls)
    if (this._isAdminMode) {
      const advancedGroup = new ControlGroup({
        id: 'physics-advanced',
        title: 'Advanced',
        variant: 'earth',
        defaultCollapsed: false,
      });
      advancedGroup.create();

      this._controls.gravity = new Slider({
        id: 'physics-gravity',
        label: 'Gravity',
        path: 'physics.gravity',
        min: 0,
        max: 2000,
        step: 10,
        value: this._config.gravity,
        variant: 'earth',
      });
      advancedGroup.addControl(this._controls.gravity.create());

      this._controls.dropMinSize = new Slider({
        id: 'physics-drop-min',
        label: 'Min Size',
        path: 'physics.dropMinSize',
        min: 1,
        max: 10,
        step: 0.5,
        value: this._config.dropMinSize,
        unit: 'px',
        variant: 'water',
      });
      advancedGroup.addControl(this._controls.dropMinSize.create());

      this._controls.dropMaxSize = new Slider({
        id: 'physics-drop-max',
        label: 'Max Size',
        path: 'physics.dropMaxSize',
        min: 1,
        max: 10,
        step: 0.5,
        value: this._config.dropMaxSize,
        unit: 'px',
        variant: 'water',
      });
      advancedGroup.addControl(this._controls.dropMaxSize.create());

      this._controls.terminalVelocity = new Slider({
        id: 'physics-terminal-vel',
        label: 'Terminal Vel',
        path: 'physics.terminalVelocity',
        min: 100,
        max: 1000,
        step: 10,
        value: this._config.terminalVelocity,
        variant: 'earth',
      });
      advancedGroup.addControl(this._controls.terminalVelocity.create());

      // Render scale - power-of-2 increments for pixelated aesthetic
      // 1.0 = Off, 0.5 = 2x, 0.25 = 4x (default), 0.125 = 8x
      this._controls.renderScale = new Slider({
        id: 'physics-render-scale',
        label: 'Render Scale',
        path: 'physics.renderScale',
        min: 0.125,
        max: 1.0,
        step: 0.125,
        value: this._config.renderScale,
        variant: 'water',
        formatValue: (v) => {
          // Show clean labels for power-of-2 values
          if (v >= 1.0) return '100%';
          if (Math.abs(v - 0.5) < 0.01) return '50%';
          if (Math.abs(v - 0.25) < 0.01) return '25%';
          if (Math.abs(v - 0.125) < 0.01) return '12.5%';
          // Intermediate values show percentage
          return `${Math.round(v * 100)}%`;
        },
      });
      advancedGroup.addControl(this._controls.renderScale.create());

      // Add hint text below the render scale slider
      const renderScaleHint = document.createElement('div');
      renderScaleHint.className = 'rs-control-hint';
      renderScaleHint.innerHTML = '<em>Lower values = chunkier pixels, better performance. Does not affect audio.</em>';
      advancedGroup.addControl(renderScaleHint);

      this._element.appendChild(advancedGroup.element!);

      // Background Rain Group (shader-based atmospheric layer)
      const backgroundGroup = new ControlGroup({
        id: 'physics-background-rain',
        title: 'Background Rain',
        variant: 'water',
        defaultCollapsed: false,
      });
      backgroundGroup.create();

      this._controls.backgroundRainEnabled = new Toggle({
        id: 'bg-rain-enabled',
        label: 'Background Rain',
        path: 'backgroundRain.enabled',
        value: this._config.backgroundRainEnabled ?? true,
      });
      backgroundGroup.addControl(this._controls.backgroundRainEnabled.create());

      // Add hint text for background rain
      const bgRainHint = document.createElement('div');
      bgRainHint.className = 'rs-control-hint';
      bgRainHint.innerHTML = '<em>Atmospheric rain layer auto-linked to physics settings.</em>';
      backgroundGroup.addControl(bgRainHint);

      this._element.appendChild(backgroundGroup.element!);
    }

    return this._element;
  }

  updateConfig(config: Partial<PhysicsSectionConfig>): void {
    if (config.intensity !== undefined) this._controls.intensity?.setValue(config.intensity);
    if (config.wind !== undefined) this._controls.wind?.setValue(config.wind);
    if (config.gravity !== undefined) this._controls.gravity?.setValue(config.gravity);
    if (config.dropMinSize !== undefined) this._controls.dropMinSize?.setValue(config.dropMinSize);
    if (config.dropMaxSize !== undefined) this._controls.dropMaxSize?.setValue(config.dropMaxSize);
    if (config.terminalVelocity !== undefined) this._controls.terminalVelocity?.setValue(config.terminalVelocity);
    if (config.renderScale !== undefined) this._controls.renderScale?.setValue(config.renderScale);
    if (config.backgroundRainEnabled !== undefined) this._controls.backgroundRainEnabled?.setValue(config.backgroundRainEnabled);
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
