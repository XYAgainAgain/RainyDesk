/**
 * StateSync - IPC synchronization utilities for Rainscaper
 *
 * Handles debounced parameter broadcasts and autosave triggering.
 */

import { state } from './RainscaperState';

interface PendingUpdate {
  path: string;
  value: number | string | boolean;
  timestamp: number;
}

/** Debounce interval for slider drags (ms) */
const DEBOUNCE_MS = 16;

/** Autosave delay after last change (ms) */
const AUTOSAVE_DELAY_MS = 10000;

export class StateSync {
  private _pendingUpdates: Map<string, PendingUpdate> = new Map();
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Listen for external parameter updates from other renderers
    if (typeof window !== 'undefined' && window.rainydesk?.onUpdateRainscapeParam) {
      window.rainydesk.onUpdateRainscapeParam((path: string, value: unknown) => {
        this.handleExternalUpdate(path, value);
      });
    }
  }

  /** Queue a parameter update (debounced) */
  queueUpdate(path: string, value: number | string | boolean): void {
    this._pendingUpdates.set(path, {
      path,
      value,
      timestamp: performance.now(),
    });

    // Mark state as dirty
    state.markDirty();

    // Schedule flush
    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => this.flush(), DEBOUNCE_MS);
    }

    // Reset autosave timer
    this.scheduleAutosave();
  }

  /** Immediately send a parameter update (bypass debounce) */
  sendImmediate(path: string, value: number | string | boolean): void {
    if (typeof window !== 'undefined' && window.rainydesk?.updateRainscapeParam) {
      window.rainydesk.updateRainscapeParam(path, value);
    }
    state.markDirty();
    this.scheduleAutosave();
  }

  /** Flush all pending updates */
  private flush(): void {
    this._flushTimer = null;

    if (this._pendingUpdates.size === 0) return;

    const updates = Array.from(this._pendingUpdates.values());
    this._pendingUpdates.clear();

    // Send all updates via IPC
    if (typeof window !== 'undefined' && window.rainydesk?.updateRainscapeParam) {
      for (const { path, value } of updates) {
        window.rainydesk.updateRainscapeParam(path, value);
      }
    }
  }

  /** Handle parameter update from another renderer (to stay in sync) */
  private handleExternalUpdate(_path: string, _value: unknown): void {
    // The main process broadcasts updates to all renderers.
    // We don't need to re-apply them here since the AudioSystem
    // handles them directly. This is just a hook for future use.
  }

  /** Schedule autosave after delay */
  private scheduleAutosave(): void {
    if (this._autosaveTimer) {
      clearTimeout(this._autosaveTimer);
    }

    this._autosaveTimer = setTimeout(() => {
      this.triggerAutosave();
    }, AUTOSAVE_DELAY_MS);
  }

  /** Trigger autosave */
  private async triggerAutosave(): Promise<void> {
    this._autosaveTimer = null;

    if (!state.data.isDirty) return;

    try {
      const rainscaper = await this.getRainscaperInstance();
      if (rainscaper) {
        const data = rainscaper.gatherPresetData() as Record<string, unknown>;
        if (data) {
          data.name = 'Autosave';
          await window.rainydesk.saveRainscape('autosave.json', data);
          console.log('[StateSync] Autosave complete');
        }
      }
    } catch (err) {
      console.error('[StateSync] Autosave failed:', err);
    }
  }

  /** Get Rainscaper instance (injected later) */
  private _rainscaperGetter: (() => unknown) | null = null;

  setRainscaperGetter(getter: () => unknown): void {
    this._rainscaperGetter = getter;
  }

  private async getRainscaperInstance(): Promise<{ gatherPresetData: () => unknown } | null> {
    if (this._rainscaperGetter) {
      return this._rainscaperGetter() as { gatherPresetData: () => unknown };
    }
    return null;
  }

  /** Force immediate autosave */
  async saveNow(): Promise<void> {
    if (this._autosaveTimer) {
      clearTimeout(this._autosaveTimer);
      this._autosaveTimer = null;
    }
    await this.triggerAutosave();
  }

  /** Cancel pending autosave */
  cancelAutosave(): void {
    if (this._autosaveTimer) {
      clearTimeout(this._autosaveTimer);
      this._autosaveTimer = null;
    }
  }

  dispose(): void {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._autosaveTimer) {
      clearTimeout(this._autosaveTimer);
      this._autosaveTimer = null;
    }
    this._pendingUpdates.clear();
  }
}

/** Singleton instance */
export const sync = new StateSync();
