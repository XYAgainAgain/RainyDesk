/**
 * MaterialManager - Maps surface types to audio characteristics
 *
 * Different surfaces produce different rain sounds (glass vs tin vs concrete).
 * Stores MaterialConfig definitions and provides lookup by surface type.
 */

import type { MaterialConfig, ImpactSynthType, BubbleOscillatorType } from '../../types/audio';

const BUILT_IN_MATERIALS: Record<string, MaterialConfig> = {
  glass_window: {
    id: 'glass_window',
    name: 'Glass Window',
    bubbleProbability: 0,  // Disabled by default - annoying until presets available
    impactSynthType: 'noise',
    bubbleOscillatorType: 'sine',
    filterFreq: 4000,
    filterQ: 1.5,
    decayMin: 0.03,
    decayMax: 0.1,
    pitchMultiplier: 1.0,
    gainOffset: 0,
  },

  water: {
    id: 'water',
    name: 'Water/Puddle',
    bubbleProbability: 0,  // Disabled by default
    impactSynthType: 'noise',
    bubbleOscillatorType: 'sine',
    filterFreq: 2000,
    filterQ: 0.8,
    decayMin: 0.05,
    decayMax: 0.15,
    pitchMultiplier: 0.8,
    gainOffset: -3,
  },

  tin_roof: {
    id: 'tin_roof',
    name: 'Tin Roof',
    bubbleProbability: 0.1,
    impactSynthType: 'metal',
    bubbleOscillatorType: 'triangle',
    filterFreq: 6000,
    filterQ: 2.0,
    decayMin: 0.02,
    decayMax: 0.08,
    pitchMultiplier: 1.5,
    gainOffset: 3,
  },

  concrete: {
    id: 'concrete',
    name: 'Concrete',
    bubbleProbability: 0.05,
    impactSynthType: 'membrane',
    bubbleOscillatorType: 'sine',
    filterFreq: 1500,
    filterQ: 0.5,
    decayMin: 0.02,
    decayMax: 0.06,
    pitchMultiplier: 0.6,
    gainOffset: -6,
  },

  leaves: {
    id: 'leaves',
    name: 'Leaves/Foliage',
    bubbleProbability: 0.3,
    impactSynthType: 'noise',
    bubbleOscillatorType: 'sine',
    filterFreq: 1800,
    filterQ: 0.7,
    decayMin: 0.04,
    decayMax: 0.12,
    pitchMultiplier: 0.9,
    gainOffset: -9,
  },

  wood: {
    id: 'wood',
    name: 'Wood',
    bubbleProbability: 0.15,
    impactSynthType: 'membrane',
    bubbleOscillatorType: 'triangle',
    filterFreq: 2500,
    filterQ: 1.2,
    decayMin: 0.03,
    decayMax: 0.09,
    pitchMultiplier: 0.85,
    gainOffset: -3,
  },

  default: {
    id: 'default',
    name: 'Default',
    bubbleProbability: 0,  // Disabled by default
    impactSynthType: 'noise',
    bubbleOscillatorType: 'sine',
    filterFreq: 3000,
    filterQ: 1.0,
    decayMin: 0.03,
    decayMax: 0.1,
    pitchMultiplier: 1.0,
    gainOffset: 0,
  },
};

/** Manages surface material configurations for audio synthesis. */
export class MaterialManager {
  private _materials: Map<string, MaterialConfig>;
  private _defaultMaterialId: string;

  constructor() {
    this._materials = new Map();
    this._defaultMaterialId = 'default';

    for (const [id, config] of Object.entries(BUILT_IN_MATERIALS)) {
      this._materials.set(id, { ...config });
    }
  }

  /** Get material by surface type. Returns default if not found. */
  getMaterial(surfaceType: string): MaterialConfig {
    const material = this._materials.get(surfaceType);
    if (material) return { ...material };

    // Case-insensitive fallback
    const lowerType = surfaceType.toLowerCase();
    for (const [id, config] of this._materials) {
      if (id.toLowerCase() === lowerType) {
        return { ...config };
      }
    }

    return this.getDefaultMaterial();
  }

  getDefaultMaterial(): MaterialConfig {
    const defaultMat = this._materials.get(this._defaultMaterialId);
    return defaultMat ? { ...defaultMat } : { ...BUILT_IN_MATERIALS['default']! };
  }

  hasMaterial(surfaceType: string): boolean {
    return this._materials.has(surfaceType);
  }

  getMaterialIds(): string[] {
    return Array.from(this._materials.keys());
  }

  getAllMaterials(): MaterialConfig[] {
    return Array.from(this._materials.values()).map(m => ({ ...m }));
  }

  registerMaterial(config: MaterialConfig): void {
    this._materials.set(config.id, { ...config });
  }

  /** Remove a material. Cannot remove the default material. */
  removeMaterial(id: string): boolean {
    if (id === this._defaultMaterialId || id === 'default') {
      console.warn('[MaterialManager] Cannot remove default material');
      return false;
    }
    return this._materials.delete(id);
  }

  setDefaultMaterial(id: string): void {
    if (this._materials.has(id)) {
      this._defaultMaterialId = id;
    } else {
      console.warn(`[MaterialManager] Material '${id}' not found`);
    }
  }

  updateMaterial(id: string, updates: Partial<MaterialConfig>): boolean {
    const existing = this._materials.get(id);
    if (!existing) return false;
    this._materials.set(id, { ...existing, ...updates, id });
    return true;
  }

  cloneMaterial(sourceId: string, newId: string, newName?: string): MaterialConfig | null {
    const source = this._materials.get(sourceId);
    if (!source) return null;

    const cloned: MaterialConfig = {
      ...source,
      id: newId,
      name: newName ?? `${source.name} (Copy)`,
    };

    this._materials.set(newId, cloned);
    return { ...cloned };
  }

  reset(): void {
    this._materials.clear();
    for (const [id, config] of Object.entries(BUILT_IN_MATERIALS)) {
      this._materials.set(id, { ...config });
    }
    this._defaultMaterialId = 'default';
  }

  exportMaterials(): Record<string, MaterialConfig> {
    const result: Record<string, MaterialConfig> = {};
    for (const [id, config] of this._materials) {
      result[id] = { ...config };
    }
    return result;
  }

  importMaterials(materials: Record<string, MaterialConfig>, replace = false): void {
    if (replace) this._materials.clear();

    for (const [id, config] of Object.entries(materials)) {
      this._materials.set(id, { ...config, id });
    }

    if (!this._materials.has('default')) {
      this._materials.set('default', { ...BUILT_IN_MATERIALS['default']! });
    }
  }

  /** Create a material config with defaults filled in. */
  static createMaterial(
    id: string,
    name: string,
    overrides: Partial<Omit<MaterialConfig, 'id' | 'name'>> = {}
  ): MaterialConfig {
    return {
      id,
      name,
      bubbleProbability: 0.4,
      impactSynthType: 'noise' as ImpactSynthType,
      bubbleOscillatorType: 'sine' as BubbleOscillatorType,
      filterFreq: 3000,
      filterQ: 1.0,
      decayMin: 0.03,
      decayMax: 0.1,
      pitchMultiplier: 1.0,
      gainOffset: 0,
      ...overrides,
    };
  }

  static getBuiltInIds(): string[] {
    return Object.keys(BUILT_IN_MATERIALS);
  }
}
