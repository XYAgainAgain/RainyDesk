/**
 * SystemSection - Audio system configuration controls (Admin mode)
 *
 * Controls for fade times and voice stealing behavior.
 */

import { ControlGroup, Slider, Toggle, Select } from '../components/controls';

export interface SystemConfig {
  fadeInTime: number;
  fadeOutTime: number;
  enableVoiceStealing: boolean;
  fpsLimit: number;
}

export interface SystemSectionCallbacks {
  onConfigChange?: (config: Partial<SystemConfig>) => void;
}

export class SystemSection {
  private _element: HTMLDivElement | null = null;
  private _config: SystemConfig;
  private _controls: Record<string, Slider | Toggle | Select> = {};

  constructor(config: SystemConfig, _callbacks: SystemSectionCallbacks = {}) {
    this._config = config;
  }

  create(): HTMLDivElement {
    this._element = document.createElement('div');
    this._element.className = 'rs-section';

    // Fade Settings Group
    const fadeGroup = new ControlGroup({
      id: 'system-fade',
      title: 'Fade Settings',
      variant: 'neutral',
      collapsible: false,
    });
    fadeGroup.create();

    this._controls.fadeInTime = new Slider({
      id: 'system-fade-in',
      label: 'Fade In',
      path: 'system.fadeInTime',
      min: 0,
      max: 10,
      step: 0.5,
      value: this._config.fadeInTime,
      unit: 's',
      variant: 'neutral',
      formatValue: (v) => v === 0 ? 'Off' : v.toFixed(1) + 's',
    });
    fadeGroup.addControl(this._controls.fadeInTime.create());

    this._controls.fadeOutTime = new Slider({
      id: 'system-fade-out',
      label: 'Fade Out',
      path: 'system.fadeOutTime',
      min: 0,
      max: 5,
      step: 0.1,
      value: this._config.fadeOutTime,
      unit: 's',
      variant: 'neutral',
      formatValue: (v) => v === 0 ? 'Off' : v.toFixed(1) + 's',
    });
    fadeGroup.addControl(this._controls.fadeOutTime.create());

    this._element.appendChild(fadeGroup.element!);

    // Voice Pool Behavior Group
    const poolGroup = new ControlGroup({
      id: 'system-pool',
      title: 'Voice Pool Behavior',
      variant: 'water',
    });
    poolGroup.create();

    this._controls.enableVoiceStealing = new Toggle({
      id: 'system-voice-stealing',
      label: 'Voice Stealing',
      path: 'system.enableVoiceStealing',
      value: this._config.enableVoiceStealing,
    });
    poolGroup.addControl(this._controls.enableVoiceStealing.create());

    // Add hint text explaining voice stealing
    const hint = document.createElement('div');
    hint.className = 'rs-control-hint';
    hint.innerHTML = '<em>When enabled, steals oldest voice when pool is full</em>';
    poolGroup.addControl(hint);

    this._element.appendChild(poolGroup.element!);

    // Performance Group
    const perfGroup = new ControlGroup({
      id: 'system-perf',
      title: 'Performance',
      variant: 'neutral',
    });
    perfGroup.create();

    this._controls.fpsLimit = new Select({
      id: 'system-fps-limit',
      label: 'FPS Limit',
      path: 'system.fpsLimit',
      value: String(this._config.fpsLimit),
      options: [
        { value: '0', label: 'Uncapped' },
        { value: '30', label: '30 FPS' },
        { value: '60', label: '60 FPS' },
        { value: '120', label: '120 FPS' },
        { value: '144', label: '144 FPS' },
      ],
    });
    perfGroup.addControl(this._controls.fpsLimit.create());

    this._element.appendChild(perfGroup.element!);

    return this._element;
  }

  updateConfig(config: Partial<SystemConfig>): void {
    if (config.fadeInTime !== undefined) {
      (this._controls.fadeInTime as Slider)?.setValue(config.fadeInTime);
    }
    if (config.fadeOutTime !== undefined) {
      (this._controls.fadeOutTime as Slider)?.setValue(config.fadeOutTime);
    }
    if (config.enableVoiceStealing !== undefined) {
      (this._controls.enableVoiceStealing as Toggle)?.setValue(config.enableVoiceStealing);
    }
    if (config.fpsLimit !== undefined) {
      (this._controls.fpsLimit as Select)?.setValue(String(config.fpsLimit));
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
