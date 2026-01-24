/**
 * TabBar - Section navigation tabs
 *
 * Displays tabs based on current mode (User vs Admin).
 */

import { state, RainscaperTab } from '../RainscaperState';

export interface TabBarCallbacks {
  onTabChange?: (tab: RainscaperTab) => void;
}

export class TabBar {
  private _element: HTMLDivElement | null = null;
  private _tabButtons: Map<RainscaperTab, HTMLButtonElement> = new Map();
  private _callbacks: TabBarCallbacks;

  constructor(callbacks: TabBarCallbacks = {}) {
    this._callbacks = callbacks;
  }

  create(): HTMLDivElement {
    this._element = document.createElement('div');
    this._element.className = 'rs-tabs';

    this.renderTabs();

    // Subscribe to state changes
    state.subscribe((s) => {
      // Re-render tabs if mode changed
      const currentTabs = state.getCurrentTabs();
      const renderedTabs = Array.from(this._tabButtons.keys());

      if (currentTabs.length !== renderedTabs.length ||
          !currentTabs.every((t, i) => t === renderedTabs[i])) {
        this.renderTabs();
      }

      // Update active state
      this.updateActiveTab(s.activeTab);
    });

    return this._element;
  }

  private renderTabs(): void {
    if (!this._element) return;

    this._element.innerHTML = '';
    this._tabButtons.clear();

    const tabs = state.getCurrentTabs();

    for (const tab of tabs) {
      const btn = document.createElement('button');
      btn.className = 'rs-tab';
      btn.textContent = state.getTabLabel(tab);
      btn.dataset.tab = tab;

      if (state.data.activeTab === tab) {
        btn.classList.add('active');
      }

      btn.addEventListener('click', () => {
        state.setActiveTab(tab);
        this._callbacks.onTabChange?.(tab);
      });

      this._tabButtons.set(tab, btn);
      this._element.appendChild(btn);
    }
  }

  private updateActiveTab(activeTab: RainscaperTab): void {
    for (const [tab, btn] of this._tabButtons) {
      btn.classList.toggle('active', tab === activeTab);
    }
  }

  get element(): HTMLDivElement | null {
    return this._element;
  }

  dispose(): void {
    this._tabButtons.clear();
    this._element = null;
  }
}
