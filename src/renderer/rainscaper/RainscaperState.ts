/**
 * RainscaperState - Reactive state management for Rainscaper UI
 *
 * Single source of truth for all UI state. Notifies subscribers on changes.
 */

import type { RainscapeConfig, AudioSystemStats } from '../../types/audio';

export type RainscaperMode = 'user' | 'admin';
export type RainscaperTab = 'presets' | 'effects' | 'physics' | 'material' | 'impact' | 'bubble' | 'sheet' | 'mapper' | 'system';

export interface RainscaperStateData {
  mode: RainscaperMode;
  isVisible: boolean;
  activeTab: RainscaperTab;
  currentRainscape: RainscapeConfig | null;
  currentMaterialId: string;
  isDirty: boolean;
  stats: AudioSystemStats | null;
  presets: string[];
  collapsedGroups: Set<string>;
}

type StateChangeCallback = (state: RainscaperStateData) => void;

// Default stats can be used for initial UI rendering if needed
// const DEFAULT_STATS: AudioSystemStats = {
//   state: 'uninitialized',
//   activeImpactVoices: 0,
//   activeBubbleVoices: 0,
//   particleCount: 0,
//   collisionsPerSecond: 0,
//   droppedCollisions: 0,
// };

export class RainscaperState {
  private _data: RainscaperStateData;
  private _listeners: Set<StateChangeCallback> = new Set();

  constructor() {
    // Load persisted mode from localStorage (default to 'user')
    const savedMode = this.loadPersistedMode();

    this._data = {
      mode: savedMode,
      isVisible: false,
      activeTab: savedMode === 'user' ? 'presets' : 'material',
      currentRainscape: null,
      currentMaterialId: 'glass_window',
      isDirty: false,
      stats: null,
      presets: [],
      collapsedGroups: new Set(),
    };
  }

  /** Load persisted mode from localStorage */
  private loadPersistedMode(): RainscaperMode {
    try {
      const saved = localStorage.getItem('rainscaper-mode');
      if (saved === 'admin' || saved === 'user') {
        return saved;
      }
    } catch {
      // localStorage not available
    }
    return 'user';
  }

  /** Save mode to localStorage */
  private persistMode(mode: RainscaperMode): void {
    try {
      localStorage.setItem('rainscaper-mode', mode);
    } catch {
      // localStorage not available
    }
  }

  /** Get current state (read-only snapshot) */
  get data(): Readonly<RainscaperStateData> {
    return this._data;
  }

  /** Subscribe to state changes */
  subscribe(callback: StateChangeCallback): () => void {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  /** Notify all subscribers */
  private notify(): void {
    for (const callback of this._listeners) {
      try {
        callback(this._data);
      } catch (err) {
        console.error('[RainscaperState] Listener error:', err);
      }
    }
  }

  /** Batch update multiple properties */
  update(changes: Partial<RainscaperStateData>): void {
    let hasChanges = false;

    for (const [key, value] of Object.entries(changes)) {
      const k = key as keyof RainscaperStateData;
      if (this._data[k] !== value) {
        // Use type assertion to allow dynamic property assignment
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this._data as any)[k] = value;
        hasChanges = true;
      }
    }

    if (hasChanges) {
      this.notify();
    }
  }

  // Convenience setters

  setMode(mode: RainscaperMode): void {
    if (this._data.mode !== mode) {
      // Reset tab to appropriate default for new mode
      const defaultTab: RainscaperTab = mode === 'user' ? 'presets' : 'material';
      this.update({ mode, activeTab: defaultTab });
      // Persist mode preference
      this.persistMode(mode);
    }
  }

  setVisible(visible: boolean): void {
    if (this._data.isVisible !== visible) {
      this.update({ isVisible: visible });
    }
  }

  toggle(): void {
    this.setVisible(!this._data.isVisible);
  }

  setActiveTab(tab: RainscaperTab): void {
    if (this._data.activeTab !== tab) {
      this.update({ activeTab: tab });
    }
  }

  setCurrentRainscape(config: RainscapeConfig | null): void {
    this.update({
      currentRainscape: config,
      currentMaterialId: config?.material.id ?? 'glass_window',
      isDirty: false,
    });
  }

  setCurrentMaterialId(id: string): void {
    if (this._data.currentMaterialId !== id) {
      this.update({ currentMaterialId: id, isDirty: true });
    }
  }

  markDirty(): void {
    if (!this._data.isDirty) {
      this.update({ isDirty: true });
    }
  }

  markClean(): void {
    if (this._data.isDirty) {
      this.update({ isDirty: false });
    }
  }

  setStats(stats: AudioSystemStats | null): void {
    this._data.stats = stats;
    this.notify();
  }

  setPresets(presets: string[]): void {
    this._data.presets = presets;
    this.notify();
  }

  toggleGroup(groupId: string): void {
    const collapsed = new Set(this._data.collapsedGroups);
    if (collapsed.has(groupId)) {
      collapsed.delete(groupId);
    } else {
      collapsed.add(groupId);
    }
    this.update({ collapsedGroups: collapsed });
  }

  isGroupCollapsed(groupId: string): boolean {
    return this._data.collapsedGroups.has(groupId);
  }

  /** Get user-mode tabs */
  getUserTabs(): RainscaperTab[] {
    return ['presets', 'effects', 'physics'];
  }

  /** Get admin-mode tabs */
  getAdminTabs(): RainscaperTab[] {
    return ['material', 'impact', 'bubble', 'sheet', 'mapper', 'effects', 'physics', 'system'];
  }

  /** Get tabs for current mode */
  getCurrentTabs(): RainscaperTab[] {
    return this._data.mode === 'user' ? this.getUserTabs() : this.getAdminTabs();
  }

  /** Get display name for a tab */
  getTabLabel(tab: RainscaperTab): string {
    const labels: Record<RainscaperTab, string> = {
      presets: 'Presets',
      effects: 'Effects',
      physics: 'Physics',
      material: 'Material',
      impact: 'Impact',
      bubble: 'Bubble',
      sheet: 'Sheet',
      mapper: 'Mapper',
      system: 'System',
    };
    return labels[tab];
  }
}

/** Singleton instance */
export const state = new RainscaperState();
