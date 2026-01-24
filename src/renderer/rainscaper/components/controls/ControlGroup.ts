/**
 * ControlGroup - Collapsible section container
 *
 * Groups related controls under a colored header that can be collapsed.
 */

import { state } from '../../RainscaperState';

export type ControlGroupVariant = 'water' | 'resonance' | 'earth' | 'air' | 'positive' | 'neutral';

export interface ControlGroupConfig {
  id: string;
  title: string;
  variant?: ControlGroupVariant;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
}

export class ControlGroup {
  private _element: HTMLDivElement | null = null;
  private _content: HTMLDivElement | null = null;
  private _toggleIcon: HTMLDivElement | null = null;
  private _config: ControlGroupConfig;

  constructor(config: ControlGroupConfig) {
    this._config = {
      collapsible: true,
      defaultCollapsed: false,
      ...config,
    };
  }

  create(): HTMLDivElement {
    this._element = document.createElement('div');
    this._element.className = 'rs-control-group';
    if (this._config.variant) {
      this._element.classList.add(`rs-control-group--${this._config.variant}`);
    }

    // Check if group should start collapsed
    const isCollapsed = this._config.defaultCollapsed ||
      state.isGroupCollapsed(this._config.id);
    if (isCollapsed) {
      this._element.classList.add('collapsed');
    }

    // Header
    const header = document.createElement('div');
    header.className = 'rs-control-group__header';

    const title = document.createElement('div');
    title.className = 'rs-control-group__title';
    title.textContent = this._config.title;

    header.appendChild(title);

    // Collapse toggle icon
    if (this._config.collapsible) {
      this._toggleIcon = document.createElement('div');
      this._toggleIcon.className = 'rs-control-group__toggle';
      this._toggleIcon.innerHTML = '&#9660;'; // Down arrow
      header.appendChild(this._toggleIcon);

      header.addEventListener('click', () => this.toggleCollapse());
    }

    // Content container
    this._content = document.createElement('div');
    this._content.className = 'rs-control-group__content';

    this._element.appendChild(header);
    this._element.appendChild(this._content);

    return this._element;
  }

  private toggleCollapse(): void {
    if (!this._element) return;

    const isCollapsed = this._element.classList.toggle('collapsed');
    state.toggleGroup(this._config.id);

    // Keep state in sync
    if (isCollapsed !== state.isGroupCollapsed(this._config.id)) {
      state.toggleGroup(this._config.id);
    }
  }

  /** Add a control element to the group */
  addControl(control: HTMLElement): void {
    if (this._content) {
      this._content.appendChild(control);
    }
  }

  /** Add multiple controls */
  addControls(controls: HTMLElement[]): void {
    for (const control of controls) {
      this.addControl(control);
    }
  }

  /** Clear all controls */
  clearControls(): void {
    if (this._content) {
      this._content.innerHTML = '';
    }
  }

  /** Set collapsed state */
  setCollapsed(collapsed: boolean): void {
    if (this._element) {
      this._element.classList.toggle('collapsed', collapsed);
    }
  }

  get element(): HTMLDivElement | null {
    return this._element;
  }

  get content(): HTMLDivElement | null {
    return this._content;
  }

  get id(): string {
    return this._config.id;
  }

  dispose(): void {
    this._element = null;
    this._content = null;
    this._toggleIcon = null;
  }
}
