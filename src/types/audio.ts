/**
 * RainyDesk Audio System Type Definitions
 *
 * Core types for the voice-pooled audio synthesis architecture.
 * See .dev/AUDIO-REWRITE-PLAN.md for full architecture documentation.
 */

import type * as Tone from 'tone';

// ============================================================================
// Voice Pool Types
// ============================================================================

/** Synth types that can be used in voice pools */
export type SynthType = Tone.Synth | Tone.NoiseSynth | Tone.MembraneSynth | Tone.MetalSynth;

/** Individual voice in a pool */
export interface Voice<T extends SynthType = SynthType> {
  /** Unique identifier for this voice */
  id: number;
  /** The Tone.js synth instance */
  synth: T;
  /** Whether this voice is currently playing */
  busy: boolean;
  /** Timestamp when this voice will be free (for voice stealing) */
  releaseTime: number;
}

/** Voice pool configuration */
export interface VoicePoolConfig {
  /** Number of voices in the pool */
  size: number;
  /** Whether to steal oldest voice when pool is exhausted */
  enableStealing: boolean;
}

/** Voice pool interface for managing synth instances */
export interface IVoicePool<T extends SynthType = SynthType> {
  /** All voices in the pool */
  readonly voices: ReadonlyArray<Voice<T>>;
  /** Pool configuration */
  readonly config: VoicePoolConfig;
  /** Acquire an idle voice, or steal oldest if enabled */
  acquire(): Voice<T> | null;
  /** Release a voice back to the pool */
  release(voice: Voice<T>): void;
  /** Get count of currently active (busy) voices */
  getActiveCount(): number;
  /** Resize the pool (creates/destroys voices as needed) */
  resize(newSize: number): void;
  /** Clean up all voices */
  dispose(): void;
}

// ============================================================================
// Material Types
// ============================================================================

/** Types of synths used for impact sounds */
export type ImpactSynthType = 'noise' | 'membrane' | 'metal';

/** Types of oscillators used for bubble sounds */
export type BubbleOscillatorType = 'sine' | 'triangle';

/** Configuration for a surface material's audio characteristics */
export interface MaterialConfig {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Probability (0-1) that a drop produces a bubble sound */
  bubbleProbability: number;
  /** Type of synth for impact transients */
  impactSynthType: ImpactSynthType;
  /** Oscillator type for bubble resonance */
  bubbleOscillatorType: BubbleOscillatorType;
  /** Base filter frequency (Hz) */
  filterFreq: number;
  /** Filter Q (resonance) */
  filterQ: number;
  /** Minimum decay time (seconds) */
  decayMin: number;
  /** Maximum decay time (seconds) */
  decayMax: number;
  /** Multiplier for Minnaert frequency calculation */
  pitchMultiplier: number;
  /** Additional gain offset (dB) */
  gainOffset: number;
}

// ============================================================================
// Physics-to-Audio Mapping Types
// ============================================================================

/** Data extracted from a Matter.js collision event */
export interface CollisionEvent {
  /** Drop radius in millimeters */
  dropRadius: number;
  /** Impact velocity in m/s */
  velocity: number;
  /** Drop mass (from Matter.js body) */
  mass: number;
  /** Surface type identifier (from body label) */
  surfaceType: string;
  /** Impact position */
  position: {
    x: number;
    y: number;
  };
  /** Impact angle in radians (0 = perpendicular to surface) */
  impactAngle: number;
}

/** Parameters derived from collision for audio triggering */
export interface AudioParams {
  /** Volume in dB */
  volume: number;
  /** Frequency in Hz (Minnaert resonance) */
  frequency: number;
  /** Decay time in seconds */
  decay: number;
  /** Whether to trigger bubble sound (probability check result) */
  triggerBubble: boolean;
  /** Filter frequency for this impact */
  filterFreq: number;
}

// ============================================================================
// Sheet Layer Types
// ============================================================================

/** Noise types available in Tone.js */
export type NoiseType = 'white' | 'pink' | 'brown';

/** Filter types for sheet layer */
export type FilterType = 'lowpass' | 'highpass' | 'bandpass';

/** Configuration for the sheet layer (background rain noise) */
export interface SheetLayerConfig {
  /** Type of noise generator */
  noiseType: NoiseType;
  /** Filter type */
  filterType: FilterType;
  /** Filter cutoff frequency (Hz) */
  filterFreq: number;
  /** Filter Q (resonance) */
  filterQ: number;
  /** Volume at 0 active particles (dB) */
  minVolume: number;
  /** Volume at max particles (dB) */
  maxVolume: number;
  /** Particle count considered "max" for volume scaling */
  maxParticleCount: number;
  /** Ramp time for volume changes (seconds) */
  rampTime: number;
}

// ============================================================================
// Effects Chain Types
// ============================================================================

/** 3-band EQ settings */
export interface EQSettings {
  /** Low band gain (dB) */
  low: number;
  /** Mid band gain (dB) */
  mid: number;
  /** High band gain (dB) */
  high: number;
}

/** Reverb settings */
export interface ReverbSettings {
  /** Decay time (seconds) */
  decay: number;
  /** Wet/dry mix (0-1) */
  wetness: number;
}

/** 3D spatial position */
export interface SpatialPosition {
  x: number;
  y: number;
  z: number;
}

/** Full effects chain configuration */
export interface EffectsConfig {
  eq: EQSettings;
  reverb: ReverbSettings;
  spatialPosition: SpatialPosition;
  masterVolume: number;
}

// ============================================================================
// Rainscape Types
// ============================================================================

/** Voice pool size configuration */
export interface VoicePoolSizes {
  /** Number of impact synth voices */
  impactPoolSize: number;
  /** Number of bubble synth voices */
  bubblePoolSize: number;
}

/** Complete rainscape configuration */
export interface RainscapeConfig {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Optional description */
  description?: string;
  /** Material configuration */
  material: MaterialConfig;
  /** Sheet layer configuration */
  sheetLayer: SheetLayerConfig;
  /** Effects chain settings */
  effects: EffectsConfig;
  /** Voice pool sizes */
  voicePools: VoicePoolSizes;
  /** Metadata */
  meta?: {
    /** When this rainscape was created */
    createdAt?: string;
    /** When this rainscape was last modified */
    modifiedAt?: string;
    /** Whether this is a built-in preset */
    isBuiltIn?: boolean;
  };
}

// ============================================================================
// Audio System State Types
// ============================================================================

/** Audio system lifecycle state */
export type AudioSystemState = 'uninitialized' | 'initializing' | 'ready' | 'playing' | 'stopped' | 'error';

/** Audio system statistics for monitoring */
export interface AudioSystemStats {
  /** Current state */
  state: AudioSystemState;
  /** Active impact voices */
  activeImpactVoices: number;
  /** Active bubble voices */
  activeBubbleVoices: number;
  /** Current particle count feeding sheet layer */
  particleCount: number;
  /** Collisions processed per second */
  collisionsPerSecond: number;
  /** Collisions dropped due to pool exhaustion */
  droppedCollisions: number;
}

// ============================================================================
// Event Types
// ============================================================================

/** Events emitted by the audio system */
export interface AudioSystemEvents {
  /** Fired when audio system state changes */
  stateChange: (state: AudioSystemState) => void;
  /** Fired when a rainscape is loaded */
  rainscapeLoaded: (config: RainscapeConfig) => void;
  /** Fired when stats are updated (for UI) */
  statsUpdated: (stats: AudioSystemStats) => void;
  /** Fired on audio system error */
  error: (error: Error) => void;
}
