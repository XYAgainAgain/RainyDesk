/**
 * UserPresets - Material preset cards for User mode
 *
 * Displays clickable material cards with icons and names.
 */

import { state } from '../RainscaperState';
import { sync } from '../StateSync';

interface MaterialCard {
  id: string;
  name: string;
  icon: string;
}

const MATERIAL_CARDS: MaterialCard[] = [
  { id: 'glass_window', name: 'Glass', icon: 'W' },
  { id: 'tin_roof', name: 'Tin Roof', icon: 'T' },
  { id: 'concrete', name: 'Concrete', icon: 'C' },
  { id: 'leaves', name: 'Leaves', icon: 'L' },
  { id: 'water', name: 'Water', icon: '~' },
  { id: 'wood', name: 'Wood', icon: '#' },
];

export interface UserPresetsCallbacks {
  onMaterialSelect?: (materialId: string) => void;
}

export class UserPresets {
  private _element: HTMLDivElement | null = null;
  private _cards: Map<string, HTMLDivElement> = new Map();
  private _callbacks: UserPresetsCallbacks;

  constructor(callbacks: UserPresetsCallbacks = {}) {
    this._callbacks = callbacks;
  }

  create(): HTMLDivElement {
    this._element = document.createElement('div');
    this._element.className = 'rs-section';

    // Section title
    const title = document.createElement('h3');
    title.className = 'rs-section__title';
    title.textContent = 'Surface Material';
    title.style.cssText = `
      font-size: 14px;
      font-weight: 500;
      color: var(--rs-text-secondary);
      margin: 0 0 12px 0;
      text-transform: uppercase;
      letter-spacing: 1px;
      font-family: var(--rs-font-mono);
    `;
    this._element.appendChild(title);

    // Material grid
    const grid = document.createElement('div');
    grid.className = 'rs-material-grid';

    for (const material of MATERIAL_CARDS) {
      const card = this.createCard(material);
      this._cards.set(material.id, card);
      grid.appendChild(card);
    }

    this._element.appendChild(grid);

    // Subscribe to material changes
    state.subscribe((s) => {
      this.updateActiveCard(s.currentMaterialId);
    });

    return this._element;
  }

  private createCard(material: MaterialCard): HTMLDivElement {
    const card = document.createElement('div');
    card.className = 'rs-material-card';
    card.dataset.material = material.id;

    if (state.data.currentMaterialId === material.id) {
      card.classList.add('active');
    }

    // Icon
    const icon = document.createElement('div');
    icon.className = 'rs-material-card__icon';
    icon.textContent = material.icon;
    icon.style.cssText = `
      font-family: var(--rs-font-mono);
      font-size: 28px;
      font-weight: bold;
    `;

    // Name
    const name = document.createElement('div');
    name.className = 'rs-material-card__name';
    name.textContent = material.name;

    card.appendChild(icon);
    card.appendChild(name);

    card.addEventListener('click', () => {
      state.setCurrentMaterialId(material.id);
      sync.sendImmediate('material.id', material.id);
      this._callbacks.onMaterialSelect?.(material.id);
    });

    return card;
  }

  private updateActiveCard(activeMaterialId: string): void {
    for (const [id, card] of this._cards) {
      card.classList.toggle('active', id === activeMaterialId);
    }
  }

  get element(): HTMLDivElement | null {
    return this._element;
  }

  dispose(): void {
    this._cards.clear();
    this._element = null;
  }
}
