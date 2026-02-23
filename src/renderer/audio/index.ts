/**
 * RainyDesk Audio System
 *
 * Voice-pooled procedural rain audio synthesis.
 * Entry point for the audio module bundle.
 */

// Re-export types for consumers
export type {
  Voice,
  VoicePoolConfig,
  IVoicePool,
  SynthType,
  CollisionEvent,
  AudioParams,
  AudioChannelTier,
  RainscapeConfig,
  MaterialConfig,
  SheetLayerConfig,
  AudioSystemState,
  AudioSystemStats,
  EQSettings,
  ReverbSettings,
  VoicePoolSizes,
} from '../../types/audio';

// Export core components
export { VoicePool } from './VoicePool';
export { ImpactSynthPool, type ImpactSynthConfig } from './ImpactSynthPool';
export { BubbleSynthPool, type BubbleSynthConfig } from './BubbleSynthPool';
export { SheetLayer } from './SheetLayer';
export { PhysicsMapper, type PhysicsMapperConfig } from './PhysicsMapper';
export { MaterialManager } from './MaterialManager';

// Export main orchestrator
export { AudioSystem, type AudioSystemConfig } from './AudioSystem';

// Export texture layer
export { TextureLayer } from './TextureLayer';

// Export Matrix Mode audio
export { GlitchSynth } from './GlitchSynth';
export { ArpeggioSequencer, type Section } from './ArpeggioSequencer';

// Export Tone.js for audio context initialization
export * as Tone from 'tone';

export const AUDIO_SYSTEM_VERSION = '2.0.0';

// Default export for convenience
export { AudioSystem as default } from './AudioSystem';
