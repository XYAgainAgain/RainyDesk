/**
 * RainyDesk Physics System Type Definitions
 *
 * Types shared between the physics system and audio system.
 * The physics system (Matter.js) generates collision events that
 * the audio system consumes.
 */

// Re-export CollisionEvent for physics system to use when emitting events
export type { CollisionEvent } from './audio';

// ============================================================================
// Physics Configuration
// ============================================================================

/** Physics engine configuration */
export interface PhysicsConfig {
  /** Gravity strength (positive = downward) */
  gravity: number;
  /** Wind force (negative = left, positive = right) */
  wind: number;
  /** Air resistance coefficient (0-1) */
  airResistance: number;
  /** Maximum fall speed */
  terminalVelocity: number;
  /** Time step for physics updates (seconds) */
  timeStep: number;
}

/** Rain particle configuration */
export interface RainParticleConfig {
  /** Minimum particle radius (pixels) */
  minRadius: number;
  /** Maximum particle radius (pixels) */
  maxRadius: number;
  /** Minimum spawn rate (particles/second) */
  minSpawnRate: number;
  /** Maximum spawn rate (particles/second) */
  maxSpawnRate: number;
  /** Current intensity (0-1), affects spawn rate and size distribution */
  intensity: number;
}

// ============================================================================
// Collision Surface Types
// ============================================================================

/**
 * Surface type identifiers used in Matter.js body labels.
 * These map to MaterialConfig IDs in the audio system.
 */
export type SurfaceType =
  | 'glass_window'
  | 'tin_roof'
  | 'concrete'
  | 'leaves'
  | 'water'
  | 'wood'
  | 'ground'
  | 'window_top'  // Top edge of detected windows
  | 'unknown';

/** Matter.js body with RainyDesk-specific label */
export interface LabeledBody {
  /** Surface type for audio mapping */
  label: SurfaceType;
  /** Body ID */
  id: number;
  /** Position */
  position: {
    x: number;
    y: number;
  };
  /** Velocity */
  velocity: {
    x: number;
    y: number;
  };
}

// ============================================================================
// Raindrop Types
// ============================================================================

/** A rain particle in the physics simulation */
export interface RainDrop {
  /** Unique ID for this drop */
  id: number;
  /** Matter.js body reference */
  body: LabeledBody;
  /** Radius in pixels */
  radius: number;
  /** Radius in millimeters (for audio calculations) */
  radiusMM: number;
  /** Mass derived from radius */
  mass: number;
  /** Whether this drop has splashed */
  splashed: boolean;
  /** Creation timestamp */
  createdAt: number;
}

// ============================================================================
// Window Detection Types
// ============================================================================

/** A detected window's bounds for collision */
export interface WindowBounds {
  /** Window title (for debugging) */
  title: string;
  /** Left edge X coordinate */
  x: number;
  /** Top edge Y coordinate */
  y: number;
  /** Window width */
  width: number;
  /** Window height */
  height: number;
  /** Z-order (higher = more in front) */
  zOrder: number;
}

/** Collision zone created from window bounds */
export interface CollisionZone {
  /** Source window info */
  window: WindowBounds;
  /** Matter.js body ID for this zone */
  bodyId: number;
  /** Surface type for this zone */
  surfaceType: SurfaceType;
}

// ============================================================================
// Physics System Interface
// ============================================================================

/** Callback for collision events */
export type CollisionCallback = (event: import('./audio').CollisionEvent) => void;

/** Physics system public interface */
export interface IPhysicsSystem {
  /** Initialize the physics engine */
  init(): void;
  /** Start the simulation */
  start(): void;
  /** Stop the simulation */
  stop(): void;
  /** Update physics (called each frame with delta time) */
  update(deltaTime: number): void;
  /** Get current particle count */
  getParticleCount(): number;
  /** Set rain intensity (0-1) */
  setIntensity(intensity: number): void;
  /** Set wind strength (-1 to 1) */
  setWind(wind: number): void;
  /** Update window collision zones */
  updateWindowZones(windows: WindowBounds[]): void;
  /** Subscribe to collision events */
  onCollision(callback: CollisionCallback): void;
  /** Clean up resources */
  dispose(): void;
}
