/**
 * Header - Mode toggle and close button
 *
 * Contains title, User/Admin mode toggle, and close button.
 */

import { state, RainscaperMode } from '../RainscaperState';

export interface HeaderCallbacks {
  onClose?: () => void;
  onModeChange?: (mode: RainscaperMode) => void;
}

export class Header {
  private _element: HTMLDivElement | null = null;
  private _modeButtons: Map<RainscaperMode, HTMLButtonElement> = new Map();
  private _callbacks: HeaderCallbacks;

  constructor(callbacks: HeaderCallbacks = {}) {
    this._callbacks = callbacks;
  }

  create(): HTMLDivElement {
    this._element = document.createElement('div');
    this._element.className = 'rs-header';

    // Title
    const title = document.createElement('div');
    title.className = 'rs-header__title';
    title.textContent = 'Rainscaper';

    // Controls container
    const controls = document.createElement('div');
    controls.className = 'rs-header__controls';

    // Mode toggle
    const modeToggle = this.createModeToggle();
    controls.appendChild(modeToggle);

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'rs-close-btn';
    closeBtn.innerHTML = '&times;';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => {
      state.setVisible(false);
      this._callbacks.onClose?.();
    });
    controls.appendChild(closeBtn);

    this._element.appendChild(title);
    this._element.appendChild(controls);

    // Subscribe to mode changes
    state.subscribe((s) => {
      this.updateModeToggle(s.mode);
    });

    return this._element;
  }

  private createModeToggle(): HTMLDivElement {
    const toggle = document.createElement('div');
    toggle.className = 'rs-mode-toggle';

    const modes: RainscaperMode[] = ['user', 'admin'];

    for (const mode of modes) {
      const btn = document.createElement('button');
      btn.className = 'rs-mode-toggle__btn';
      btn.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
      btn.dataset.mode = mode;

      if (state.data.mode === mode) {
        btn.classList.add('active');
      }

      btn.addEventListener('click', () => {
        state.setMode(mode);
        this._callbacks.onModeChange?.(mode);
      });

      this._modeButtons.set(mode, btn);
      toggle.appendChild(btn);
    }

    return toggle;
  }

  private updateModeToggle(activeMode: RainscaperMode): void {
    for (const [mode, btn] of this._modeButtons) {
      btn.classList.toggle('active', mode === activeMode);
    }
  }

  get element(): HTMLDivElement | null {
    return this._element;
  }

  dispose(): void {
    this._modeButtons.clear();
    this._element = null;
  }
}
