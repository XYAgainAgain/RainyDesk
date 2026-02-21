/**
 * RainyDesk Type Definitions
 *
 * Central export for all type definitions.
 * Import from '@types' or 'src/types' to get all types.
 */

// Audio system types
export type {
  // Voice pool
  SynthType,
  Voice,
  VoicePoolConfig,
  IVoicePool,
  // Materials
  ImpactSynthType,
  BubbleOscillatorType,
  MaterialConfig,
  // Physics-to-audio mapping
  CollisionEvent,
  AudioParams,
  // Sheet layer
  NoiseType,
  FilterType,
  SheetLayerConfig,
  // Effects
  EQSettings,
  ReverbSettings,
  SpatialPosition,
  EffectsConfig,
  // Rainscape config
  VoicePoolSizes,
  RainscapeConfig,
  // System state
  AudioSystemState,
  AudioSystemStats,
  AudioSystemEvents,
} from './audio';

// Physics system types
export type {
  PhysicsConfig,
  RainParticleConfig,
  SurfaceType,
  LabeledBody,
  RainDrop,
  WindowBounds,
  CollisionZone,
  CollisionCallback,
  IPhysicsSystem,
} from './physics';

// Rainscape/persistence types
export type {
  RainscapeSaveFile,
  AutosaveFile,
  RainscapeListItem,
  BuiltInRainscapeId,
  MaterialPreset,
  SheetLayerPreset,
  RainscaperParam,
  RainscaperSection,
  RainscaperLayout,
  ParamUpdateMessage,
  LoadRainscapeMessage,
  SaveRainscapeMessage,
  RainscapeIPCChannel,
} from './rainscape';

// WebGL renderer types
export type {
  BackgroundRainConfig,
  RendererRaindrop,
  RendererSplashParticle,
  RendererPhysicsSystem,
} from './webgl';
