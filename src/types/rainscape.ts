/**
 * RainyDesk Rainscape Type Definitions
 *
 * Types specific to rainscape presets, persistence, and the Rainscaper UI.
 */

import type { RainscapeConfig, MaterialConfig, SheetLayerConfig } from './audio';

// Re-export core config type
export type { RainscapeConfig } from './audio';

// Persistence Types

/** Rainscape save file format */
export interface RainscapeSaveFile {
  /** File format version for future compatibility */
  version: 1;
  /** The rainscape configuration */
  rainscape: RainscapeConfig;
  /** When this file was saved */
  savedAt: string;
}

/** Autosave file format (includes additional state) */
export interface AutosaveFile {
  /** File format version */
  version: 1;
  /** Current rainscape configuration */
  rainscape: RainscapeConfig;
  /** Audio system state to restore */
  audioState: {
    /** Master volume (0-1) */
    volume: number;
    /** Whether audio was playing */
    isPlaying: boolean;
    /** Whether muted */
    isMuted: boolean;
  };
  /** When autosave was written */
  savedAt: string;
}

/** List of available rainscapes (for UI dropdown) */
export interface RainscapeListItem {
  /** Rainscape ID */
  id: string;
  /** Display name */
  name: string;
  /** Whether this is a built-in preset */
  isBuiltIn: boolean;
  /** File path (for user-saved rainscapes) */
  filePath?: string;
}

// Built-in Presets

/** IDs of built-in rainscape presets */
export type BuiltInRainscapeId = 'glass_window' | 'tin_roof' | 'concrete' | 'leaves';

/** Partial config for creating material presets */
export type MaterialPreset = Omit<MaterialConfig, 'id' | 'name'>;

/** Partial config for creating sheet layer presets */
export type SheetLayerPreset = Omit<SheetLayerConfig, 'maxParticleCount' | 'rampTime'>;

// Rainscaper UI Types

/** A parameter exposed in the Rainscaper UI */
export interface RainscaperParam {
  /** Unique path to this parameter (e.g., "material.bubbleProbability") */
  path: string;
  /** Display label */
  label: string;
  /** Parameter type */
  type: 'slider' | 'select' | 'toggle' | 'number';
  /** Minimum value (for sliders/numbers) */
  min?: number;
  /** Maximum value (for sliders/numbers) */
  max?: number;
  /** Step size (for sliders/numbers) */
  step?: number;
  /** Options (for selects) */
  options?: Array<{ value: string; label: string }>;
  /** Unit suffix to display */
  unit?: string;
  /** Tooltip/description */
  description?: string;
}

/** A group of related parameters in the UI */
export interface RainscaperSection {
  /** Section identifier */
  id: string;
  /** Display title */
  title: string;
  /** Parameters in this section */
  params: RainscaperParam[];
  /** Whether section is collapsible */
  collapsible?: boolean;
  /** Whether section starts collapsed */
  defaultCollapsed?: boolean;
}

/** Complete Rainscaper panel layout */
export interface RainscaperLayout {
  /** Sections to display */
  sections: RainscaperSection[];
}

// IPC Message Types

/** Parameter update message (renderer → main → all renderers) */
export interface ParamUpdateMessage {
  /** Parameter path */
  path: string;
  /** New value */
  value: number | string | boolean;
  /** Source renderer ID (to avoid echo) */
  sourceId?: number;
}

/** Rainscape load request */
export interface LoadRainscapeMessage {
  /** Rainscape ID or file path */
  id: string;
}

/** Rainscape save request */
export interface SaveRainscapeMessage {
  /** Name to save as */
  name: string;
  /** Configuration to save */
  config: RainscapeConfig;
}

/** IPC channels for rainscape operations */
export type RainscapeIPCChannel =
  | 'rainscape:load'
  | 'rainscape:save'
  | 'rainscape:delete'
  | 'rainscape:list'
  | 'rainscape:param-update'
  | 'rainscape:autosave'
  | 'rainscape:get-autosave';
