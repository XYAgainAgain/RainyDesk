/**
 * RainyDesk Audio System Type Definitions
 *
 * Core types for the voice-pooled audio synthesis architecture.
 * See .dev/AUDIO-REWRITE-PLAN.md for full architecture documentation.
 */

import type * as Tone from 'tone';

// Voice Pool Types

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
  /** Timestamp when this voice was acquired (for voice stealing priority) */
  acquireTime: number;
  /** Timestamp when this voice was released (for cleanup tracking) */
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

// Material Types

/** Types of synths used for impact sounds */
export type ImpactSynthType = 'noise' | 'membrane' | 'metal';

/** Types of oscillators used for bubble sounds */
export type BubbleOscillatorType = 'sine' | 'triangle' | 'square' | 'sawtooth';

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

// Physics-to-Audio Mapping Types

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
  /** Stereo pan position (-1 = left, 0 = center, 1 = right) */
  pan: number;
}

// Sheet Layer Types

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

// Effects Chain Types

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

// Rainscape Types

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

// Audio System State Types

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

// Event Types

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

// v2.0 Wind Module Types

/** Configuration for the continuous wind noise bed */
export interface WindBedConfig {
  enabled: boolean;
  noiseType: NoiseType;
  /** Base gain in dB (-60 to 0) */
  baseGain: number;
  /** Low-pass filter frequency (100-2000 Hz) */
  lpfFreq: number;
  /** High-pass filter frequency (20-500 Hz) */
  hpfFreq: number;
  /** LFO rate for filter modulation (0.01-2 Hz) */
  lfoRate: number;
  /** LFO depth (0-1) */
  lfoDepth: number;
}

/** Configuration for wind-structure interaction sounds */
export interface WindInteractionConfig {
  enabled: boolean;
  /** Corner whistle gain (dB) */
  cornerWhistleGain: number;
  /** Eave drip contribution gain (dB) */
  eaveDripGain: number;
  /** Rattle/vibration gain (dB) */
  rattleGain: number;
}

/** Configuration for wind gust events */
export interface WindGustConfig {
  enabled: boolean;
  /** Minimum interval between gusts (seconds) */
  minInterval: number;
  /** Maximum interval between gusts (seconds) */
  maxInterval: number;
  /** Envelope rise time (seconds) */
  riseTime: number;
  /** Envelope fall time (seconds) */
  fallTime: number;
  /** Intensity range [min, max] (0-1) */
  intensityRange: [number, number];
}

/** Configuration for aeolian (wire whistle) tones - Strouhal formula: f = St x V / D */
export interface AeolianConfig {
  enabled: boolean;
  /** Strouhal number (typically 0.15-0.25 for cylinders) */
  strouhalNumber: number;
  /** Wire diameter in mm */
  wireDiameter: number;
  /** Base frequency calculated from Strouhal formula */
  baseFreq: number;
  /** Harmonic multipliers */
  harmonics: number[];
  /** Output gain (dB) */
  gain: number;
}

/** Musical mode for singing wind */
export type MusicalMode =
  | 'ionian'
  | 'dorian'
  | 'phrygian'
  | 'lydian'
  | 'mixolydian'
  | 'aeolian'
  | 'locrian'
  | 'pentatonic'
  | 'blues';

/** Formant frequencies for vowel shaping */
export interface FormantSet {
  f1: number;
  f2: number;
  f3: number;
  f4: number;
  f5: number;
}

/** Configuration for singing/whistling wind effect */
export interface SingingWindConfig {
  enabled: boolean;
  /** Musical mode for pitch quantization */
  mode: MusicalMode;
  /** Root note (e.g., "C4", "A3") */
  rootNote: string;
  /** Vowel formant frequencies */
  vowelFormants: FormantSet;
  /** Output gain (dB) */
  gain: number;
}

/** Configuration for katabatic (downslope) wind */
export interface KatabaticConfig {
  enabled: boolean;
  /** Low frequency boost (dB) */
  lowFreqBoost: number;
  /** Surge LFO rate (Hz) */
  surgeRate: number;
  /** Output gain (dB) */
  gain: number;
}

/** Complete wind module configuration */
export interface WindModuleConfig {
  /** Master gain for entire wind module (dB) */
  masterGain: number;
  bed: WindBedConfig;
  interaction: WindInteractionConfig;
  gust: WindGustConfig;
  aeolian: AeolianConfig;
  singing: SingingWindConfig;
  katabatic: KatabaticConfig;
}

// v2.0 Thunder Module Types

/** Configuration for the initial high-frequency crack/tear */
export interface ThunderTearingConfig {
  enabled: boolean;
  noiseType: 'white' | 'pink';
  /** High-pass filter frequency (2000-8000 Hz) */
  hpfFreq: number;
  /** Attack time (0.001-0.05s) */
  attackTime: number;
  /** Decay time (0.05-0.3s) */
  decayTime: number;
  /** Output gain (dB) */
  gain: number;
}

/** Configuration for the N-wave pressure spike */
export interface ThunderCrackConfig {
  enabled: boolean;
  /** Base frequency (50-200 Hz) */
  frequency: number;
  /** Number of harmonics */
  harmonics: number;
  /** Attack time (seconds) */
  attackTime: number;
  /** Decay time (seconds) */
  decayTime: number;
  /** Output gain (dB) */
  gain: number;
}

/** Configuration for the main thunder body rumble */
export interface ThunderBodyConfig {
  enabled: boolean;
  noiseType: 'pink' | 'brown';
  /** Low-pass filter frequency (200-800 Hz) */
  lpfFreq: number;
  /** Reverb decay time (2-8s) */
  reverbDecay: number;
  /** Output gain (dB) */
  gain: number;
}

/** Configuration for sub-bass rumble tail */
export interface ThunderRumbleConfig {
  enabled: boolean;
  /** Base frequency (20-60 Hz) */
  frequency: number;
  /** Amplitude LFO rate (0.1-1 Hz) */
  lfoRate: number;
  /** Duration (3-15s) */
  duration: number;
  /** Output gain (dB) */
  gain: number;
}

/** Complete thunder module configuration */
export interface ThunderModuleConfig {
  /** Master gain for entire thunder module (dB) */
  masterGain: number;
  /** Minimum interval between auto-strikes (seconds) */
  minInterval: number;
  /** Maximum interval between auto-strikes (seconds) */
  maxInterval: number;
  /** Distance range for strikes [min, max] in km */
  distanceRange: [number, number];
  /** Enable sidechain compression of other buses during thunder */
  sidechainEnabled: boolean;
  /** Sidechain compressor ratio */
  sidechainRatio: number;
  /** Sidechain attack time (seconds) */
  sidechainAttack: number;
  /** Sidechain release time (seconds) */
  sidechainRelease: number;
  tearing: ThunderTearingConfig;
  crack: ThunderCrackConfig;
  body: ThunderBodyConfig;
  rumble: ThunderRumbleConfig;
}

// v2.0 Matrix Module Types (Sci-Fi/Digital Rain)

/** Configuration for FM synthesis digital rain drops */
export interface MatrixDropConfig {
  enabled: boolean;
  /** Carrier frequency (200-2000 Hz) */
  carrierFreq: number;
  /** Modulator frequency ratio (0.5-4) */
  modulatorRatio: number;
  /** FM modulation index (0-20) */
  modulationIndex: number;
  /** Pitch glide time (0-0.5s) */
  glideTime: number;
  /** Attack time (seconds) */
  attackTime: number;
  /** Decay time (seconds) */
  decayTime: number;
  /** Output gain (dB) */
  gain: number;
}

/** Configuration for background binaural drone */
export interface MatrixDroneConfig {
  enabled: boolean;
  /** Base oscillator frequency */
  baseFreq: number;
  /** Beat frequency for binaural effect (0.5-8 Hz) */
  beatFreq: number;
  /** Phaser LFO rate */
  phaserRate: number;
  /** Phaser depth (0-1) */
  phaserDepth: number;
  /** Output gain (dB) */
  gain: number;
}

/** Configuration for digital glitch effects */
export interface MatrixGlitchConfig {
  enabled: boolean;
  /** Bit depth reduction (1-16) */
  bitDepth: number;
  /** Sample rate reduction factor */
  sampleRateReduction: number;
  /** Probability of glitch burst (0-1) */
  probability: number;
  /** Output gain (dB) */
  gain: number;
}

/** Complete matrix module configuration */
export interface MatrixModuleConfig {
  /** Master gain for entire matrix module (dB) */
  masterGain: number;
  drop: MatrixDropConfig;
  drone: MatrixDroneConfig;
  glitch: MatrixGlitchConfig;
}

// v2.0 Bus & SFX Types

/** Configuration for an audio bus (gain stage with processing) */
export interface BusConfig {
  /** Bus gain (dB) */
  gain: number;
  /** Mute state */
  mute: boolean;
  /** Solo state */
  solo: boolean;
  /** Stereo pan (-1 to 1) */
  pan: number;
  /** 3-band EQ low gain (dB) */
  eqLow: number;
  /** 3-band EQ mid gain (dB) */
  eqMid: number;
  /** 3-band EQ high gain (dB) */
  eqHigh: number;
  /** Enable bus compressor */
  compressorEnabled: boolean;
  /** Compressor threshold (dB) */
  compressorThreshold: number;
  /** Compressor ratio */
  compressorRatio: number;
  /** Send level to master reverb (0-1) */
  reverbSend: number;
  /** Send level to delay effect (0-1) */
  delaySend: number;
}

/** Master bus configuration */
export interface MasterBusConfig {
  /** Master output gain (dB) */
  gain: number;
  /** Enable output limiter */
  limiterEnabled: boolean;
  /** Limiter threshold (dB) */
  limiterThreshold: number;
}

/** Complete SFX/bus routing configuration */
export interface SFXConfig {
  rainBus: BusConfig;
  windBus: BusConfig;
  thunderBus: BusConfig;
  matrixBus: BusConfig;
  masterBus: MasterBusConfig;
}

// v2.0 Impact & Bubble Config (Enhanced)

/** Enhanced impact synth configuration */
export interface ImpactConfig {
  /** Enable impact sounds */
  enabled: boolean;
  /** Noise type for impacts */
  noiseType: NoiseType;
  /** Attack time (seconds) */
  attack: number;
  /** Minimum decay time (seconds) */
  decayMin: number;
  /** Maximum decay time (seconds) */
  decayMax: number;
  /** Minimum filter frequency (Hz) */
  filterFreqMin: number;
  /** Maximum filter frequency (Hz) */
  filterFreqMax: number;
  /** Filter resonance Q */
  filterQ: number;
  /** Output gain (dB) */
  gain: number;
  /** Voice pool size */
  poolSize: number;
}

/** Enhanced bubble synth configuration */
export interface BubbleConfig {
  /** Enable bubble sounds */
  enabled: boolean;
  /** Oscillator waveform */
  oscillatorType: BubbleOscillatorType;
  /** Attack time (seconds) */
  attack: number;
  /** Minimum decay time (seconds) */
  decayMin: number;
  /** Maximum decay time (seconds) */
  decayMax: number;
  /** Pitch chirp amount (0-1, how much pitch drops) */
  chirpAmount: number;
  /** Chirp duration (seconds) */
  chirpTime: number;
  /** Minimum frequency (Hz) */
  freqMin: number;
  /** Maximum frequency (Hz) */
  freqMax: number;
  /** Bubble probability per impact (0-1) */
  probability: number;
  /** Output gain (dB) */
  gain: number;
  /** Voice pool size */
  poolSize: number;
}

// v2.0 Complete Rainscape Configuration

/** Rain simulation parameters */
export interface RainConfig {
  /** Rain intensity (0-100) */
  intensity: number;
  /** Wind strength (0-100) */
  wind: number;
  /** Turbulence amount (0-1) */
  turbulence: number;
  /** Drop size range */
  dropSize: {
    min: number;
    max: number;
  };
  /** Enable splash particles */
  splashEnabled: boolean;
}

/** Visual rendering parameters */
export interface VisualConfig {
  /** Pixel render scale (0.125-1.0) */
  pixelScale: number;
  /** Color tint (hex string) */
  colorTint: string;
  /** Drop trail length */
  trailLength: number;
  /** Splash opacity (0-1) */
  splashOpacity: number;
}

/** Complete v2.0 audio configuration */
export interface AudioConfigV2 {
  /** Master volume (dB) */
  masterVolume: number;

  /** Impact/thud sounds */
  impact: ImpactConfig;
  /** Bubble/plink resonance */
  bubble: BubbleConfig;
  /** Background sheet noise */
  sheet: SheetLayerConfig;

  /** Wind module */
  wind: WindModuleConfig;
  /** Thunder module */
  thunder: ThunderModuleConfig;
  /** Matrix/digital rain module */
  matrix: MatrixModuleConfig;
  /** Bus routing and SFX */
  sfx: SFXConfig;
}

/** Complete v2.0 rainscape configuration */
export interface RainscapeConfigV2 {
  /** Rainscape display name */
  name: string;
  /** Schema version */
  version: '2.0.0';
  /** Optional description */
  description?: string;
  /** Author name */
  author?: string;
  /** Tags for categorization */
  tags?: string[];

  /** Rain simulation parameters */
  rain: RainConfig;

  /** Audio configuration */
  audio: AudioConfigV2;

  /** Visual rendering parameters */
  visual?: VisualConfig;

  /** Metadata */
  meta?: {
    createdAt?: string;
    modifiedAt?: string;
    isBuiltIn?: boolean;
  };
}
