/**
 * Type definitions for the Pixi hybrid physics simulation.
 * See .dev/PIXI-PHYSICS-MIGRATION-PLAN.md for architecture details.
 */

/** Collision event passed to audio system */
export interface CollisionEvent {
    /** Impact velocity in screen pixels/sec (scaled 4× from logic space) */
    velocity: number;
    /** Drop radius in screen pixels (scaled 4× from logic space) */
    dropRadius: number;
    /** Angle of approach in radians */
    impactAngle: number;
    /** Surface material type */
    surfaceType: string;
    /** Relative mass (based on radius³) */
    mass: number;
    /** Impact position in screen coordinates */
    position: { x: number; y: number };
    /** Which surface was hit */
    collisionSurface: 'top' | 'left' | 'right';
}

/** Callback for collision events (wired to AudioSystem) */
export type CollisionCallback = (event: CollisionEvent) => void;

/** Display info from Tauri backend */
export interface DisplayInfo {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    scaleFactor: number;
}

/** Window zone data from Tauri backend */
export interface WindowZone {
    x: number;
    y: number;
    width: number;
    height: number;
    title?: string;
    material?: string;
    isMaximized?: boolean;
}

/** Monitor region within virtual desktop */
export interface MonitorRegion {
    index: number;
    /** Position relative to virtual desktop origin (always >= 0) */
    x: number;
    y: number;
    width: number;
    height: number;
    /** Work area (excluding taskbar) relative to virtual desktop origin */
    workX: number;
    workY: number;
    workWidth: number;
    workHeight: number;
    scaleFactor: number;
}

/** Virtual desktop info (bounding box of all monitors) */
export interface VirtualDesktop {
    /** Bounding box origin (may be negative if monitor extends left/above primary) */
    originX: number;
    originY: number;
    /** Total bounding box dimensions */
    width: number;
    height: number;
    /** Individual monitor regions */
    monitors: MonitorRegion[];
    /** Index of primary monitor (for UI positioning) */
    primaryIndex: number;
}

/** Configuration for GridSimulation */
export interface SimulationConfig {
    /** Maximum number of rain particles */
    maxDrops: number;
    /** Maximum number of splash particles */
    maxSplashes: number;
    /** Gravity in logic pixels/sec² */
    gravity: number;
    /** Base wind velocity in logic pixels/sec */
    windBase: number;
    /** Wind turbulence amplitude */
    windTurbulence: number;
    /** Rain spawn rate (drops per second) */
    spawnRate: number;
    /** Minimum drop radius in logic pixels */
    radiusMin: number;
    /** Maximum drop radius in logic pixels */
    radiusMax: number;
    /** Horizontal velocity threshold for pass-through (0–1) */
    slipThreshold: number;
    /** Probability water sticks to walls (dribble effect, 0–1) */
    wallAdhesion: number;
}

/** Default simulation configuration */
export const DEFAULT_CONFIG: SimulationConfig = {
    maxDrops: 2000,
    maxSplashes: 500,
    gravity: 980,        // Logic pixels/sec² (~9.8 m/s² scaled; feels like real rain)
    windBase: 0,
    windTurbulence: 10,
    spawnRate: 100,
    radiusMin: 0.8,      // Visible drops
    radiusMax: 2.0,      // Larger max for variety
    slipThreshold: 0.85,
    wallAdhesion: 0.05,  // 5% chance to stick (faster dribble)
};

/** Grid cell values */
export const CELL_AIR = 0;
export const CELL_GLASS = 1;
export const CELL_WATER = 10;
export const CELL_VOID = 255;  // Void areas (gaps between monitors) — solid walls

/** Tick rates in seconds */
export const RAIN_TICK = 1 / 60;
export const PUDDLE_TICK = 1 / 60;
