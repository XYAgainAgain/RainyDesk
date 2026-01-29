/**
 * Panel - Draggable container for Rainscaper UI
 *
 * Handles click-through behavior and contains all other components.
 */

import { state } from '../RainscaperState';

export class Panel {
  private _element: HTMLDivElement | null = null;
  private _content: HTMLDivElement | null = null;

  /** Create the panel DOM element */
  create(): HTMLDivElement {
    this._element = document.createElement('div');
    this._element.className = 'rainscaper-panel hidden';

    // Click-through controlled by show()/hide(), not hover events
    // (Tauri requires explicit window focus control)

    // Subscribe to visibility changes
    state.subscribe((s) => {
      if (this._element) {
        this._element.classList.toggle('hidden', !s.isVisible);
      }
    });

    return this._element;
  }

  /** Get the panel element */
  get element(): HTMLDivElement | null {
    return this._element;
  }

  /** Set the header element */
  setHeader(header: HTMLElement): void {
    if (this._element) {
      this._element.appendChild(header);
    }
  }

  /** Set the tabs element */
  setTabs(tabs: HTMLElement): void {
    if (this._element) {
      this._element.appendChild(tabs);
    }
  }

  /** Set the preset bar element */
  setPresetBar(presetBar: HTMLElement): void {
    if (this._element) {
      this._element.appendChild(presetBar);
    }
  }

  /** Create and return the content container */
  createContent(): HTMLDivElement {
    this._content = document.createElement('div');
    this._content.className = 'rs-content';

    if (this._element) {
      this._element.appendChild(this._content);
    }

    return this._content;
  }

  /** Get the content container */
  get content(): HTMLDivElement | null {
    return this._content;
  }

  /** Set the stats bar element */
  setStatsBar(statsBar: HTMLElement): void {
    if (this._element) {
      this._element.appendChild(statsBar);
    }
  }

  /** Show the panel */
  show(): void {
    state.setVisible(true);
  }

  /** Hide the panel */
  hide(): void {
    state.setVisible(false);
  }

  /** Toggle panel visibility */
  toggle(): void {
    state.toggle();
  }

  /** Check if panel is visible */
  get isVisible(): boolean {
    return state.data.isVisible;
  }

  /** Append panel to DOM */
  mount(container: HTMLElement = document.body): void {
    if (this._element && !this._element.parentElement) {
      container.appendChild(this._element);
    }
  }

  /** Remove panel from DOM */
  unmount(): void {
    if (this._element && this._element.parentElement) {
      this._element.parentElement.removeChild(this._element);
    }
  }

  dispose(): void {
    this.unmount();
    this._element = null;
    this._content = null;
  }
}
