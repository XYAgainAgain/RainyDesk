/**
 * WebGL Renderer Type Definitions
 *
 * Types for the WebGL 2 instanced rain renderer and background shader.
 * These represent the renderer's view of physics data — a simpler shape
 * than the full simulation types in physics.ts.
 */

// Background Rain Shader

export interface BackgroundRainConfig {
  intensity: number;       // 0.0–1.0
  wind: number;            // -1.0 to 1.0 (normalized from -100 to 100)
  layerCount: number;      // 1–5
  speed: number;           // Speed multiplier
  enabled: boolean;
  colorTint: [number, number, number]; // RGB 0–1 as [r, g, b]
  rainbowMode: boolean;
  rainbowSpeed: number;    // 1.0–10.0
  reverseGravity: boolean;
}

// Renderer-side physics data (simplified view of simulation output)

export interface RendererRaindrop {
  body: {
    position: { x: number; y: number };
    velocity: { x: number; y: number };
  };
  radius: number;
  length: number;
  opacity: number;
}

export interface RendererSplashParticle {
  x: number;
  y: number;
  radius: number;
  opacity: number;
}

export interface RendererPhysicsSystem {
  raindrops: RendererRaindrop[];
  splashParticles: RendererSplashParticle[];
}
