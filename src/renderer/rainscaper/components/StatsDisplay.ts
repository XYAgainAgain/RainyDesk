/**
 * StatsDisplay - Live voice count and collision rate display
 *
 * Shows audio system statistics in the panel footer.
 */

import { state } from '../RainscaperState';
import type { AudioSystemStats } from '../../../types/audio';

export class StatsDisplay {
  private _element: HTMLDivElement | null = null;
  private _impactVoices: HTMLSpanElement | null = null;
  private _bubbleVoices: HTMLSpanElement | null = null;
  private _collisions: HTMLSpanElement | null = null;
  private _particles: HTMLSpanElement | null = null;

  create(): HTMLDivElement {
    this._element = document.createElement('div');
    this._element.className = 'rs-stats';

    // Impact voices
    const impactStat = this.createStat('Impact', 'impact');
    this._impactVoices = impactStat.querySelector('.rs-stat__value');

    // Bubble voices
    const bubbleStat = this.createStat('Bubble', 'bubble');
    this._bubbleVoices = bubbleStat.querySelector('.rs-stat__value');

    // Collisions/sec
    const collisionStat = this.createStat('Hits/s', 'collisions');
    this._collisions = collisionStat.querySelector('.rs-stat__value');

    // Particles
    const particleStat = this.createStat('Drops', 'particles');
    this._particles = particleStat.querySelector('.rs-stat__value');

    this._element.appendChild(impactStat);
    this._element.appendChild(bubbleStat);
    this._element.appendChild(collisionStat);
    this._element.appendChild(particleStat);

    // Subscribe to stats updates
    state.subscribe((s) => {
      if (s.stats) {
        this.updateStats(s.stats);
      }
    });

    return this._element;
  }

  private createStat(label: string, id: string): HTMLDivElement {
    const stat = document.createElement('div');
    stat.className = 'rs-stat';
    stat.dataset.stat = id;

    const labelEl = document.createElement('span');
    labelEl.className = 'rs-stat__label';
    labelEl.textContent = label + ':';

    const value = document.createElement('span');
    value.className = 'rs-stat__value';
    value.textContent = '0';

    stat.appendChild(labelEl);
    stat.appendChild(value);

    return stat;
  }

  updateStats(stats: AudioSystemStats): void {
    if (this._impactVoices) {
      this._impactVoices.textContent = String(stats.activeImpactVoices);
    }
    if (this._bubbleVoices) {
      this._bubbleVoices.textContent = String(stats.activeBubbleVoices);
    }
    if (this._collisions) {
      this._collisions.textContent = String(stats.collisionsPerSecond);
    }
    if (this._particles) {
      this._particles.textContent = String(stats.particleCount);
    }
  }

  get element(): HTMLDivElement | null {
    return this._element;
  }

  dispose(): void {
    this._element = null;
    this._impactVoices = null;
    this._bubbleVoices = null;
    this._collisions = null;
    this._particles = null;
  }
}
