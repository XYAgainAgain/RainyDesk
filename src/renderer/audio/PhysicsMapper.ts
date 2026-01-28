/**
 * PhysicsMapper - Converts physics collision data to audio parameters
 *
 * Physics-to-audio bridge using:
 * - Velocity -> Volume (logarithmic dB mapping)
 * - Radius -> Frequency (Minnaert: f ~ 3000/r)
 * - Velocity + Angle -> Bubble probability
 * - Radius -> Decay time
 */

import type { CollisionEvent, AudioParams, MaterialConfig } from '../../types/audio';

export interface PhysicsMapperConfig {
  velocityMin: number;
  velocityMax: number;
  volumeMin: number;
  volumeMax: number;
  minnaertBase: number;
  freqMin: number;
  freqMax: number;
  decayBase: number;
  decayRadiusScale: number;
}

const DEFAULT_CONFIG: PhysicsMapperConfig = {
  velocityMin: 0.5,
  velocityMax: 20,
  volumeMin: -40,
  volumeMax: -6,
  minnaertBase: 3000,
  freqMin: 200,
  freqMax: 4000,
  decayBase: 0.05,
  decayRadiusScale: 0.02,
};

/** Maps physics collision events to audio synthesis parameters. */
export class PhysicsMapper {
  private _config: PhysicsMapperConfig;

  constructor(config: Partial<PhysicsMapperConfig> = {}) {
    this._config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Convert a collision event to audio parameters. */
  mapCollision(event: CollisionEvent, material: MaterialConfig): AudioParams {
    return {
      volume: this.mapVelocityToVolume(event.velocity) + material.gainOffset,
      frequency: this.mapRadiusToFrequency(event.dropRadius, material.pitchMultiplier),
      decay: this.mapRadiusToDecay(event.dropRadius, material),
      triggerBubble: this.shouldTriggerBubble(event, material),
      filterFreq: this.calculateFilterFreq(event, material),
    };
  }

  /** Map velocity to volume (dB) using logarithmic scaling. */
  mapVelocityToVolume(velocity: number): number {
    const { velocityMin, velocityMax, volumeMin, volumeMax } = this._config;

    const clampedVelocity = Math.max(velocityMin, Math.min(velocityMax, velocity));
    const normalized = (clampedVelocity - velocityMin) / (velocityMax - velocityMin);

    // Log curve for natural perception
    const logScaled = Math.log10(normalized * 9 + 1);

    return volumeMin + (volumeMax - volumeMin) * logScaled;
  }

  /** Map radius to frequency using Minnaert formula (f ~ 3000/r). */
  mapRadiusToFrequency(radiusMm: number, pitchMultiplier = 1): number {
    const { minnaertBase, freqMin, freqMax } = this._config;

    const safeRadius = Math.max(0.5, radiusMm);
    const frequency = (minnaertBase / safeRadius) * pitchMultiplier;

    return Math.max(freqMin, Math.min(freqMax, frequency));
  }

  /** Map radius to decay time. Larger drops = longer decay. */
  mapRadiusToDecay(radiusMm: number, material: MaterialConfig): number {
    const { decayBase, decayRadiusScale } = this._config;
    const decay = decayBase + radiusMm * decayRadiusScale;
    return Math.max(material.decayMin, Math.min(material.decayMax, decay));
  }

  /**
   * Determine if collision should trigger bubble sound.
   * Considers material probability, impact angle, and velocity.
   */
  shouldTriggerBubble(event: CollisionEvent, material: MaterialConfig): boolean {
    let probability = material.bubbleProbability;

    // Perpendicular impacts (angle=0) trap bubbles more often
    const angleFactor = Math.cos(event.impactAngle);
    probability *= (0.5 + 0.5 * angleFactor);

    // High velocity splashes destroy bubbles
    if (event.velocity > 15) {
      probability *= 0.5;
    } else if (event.velocity > 10) {
      probability *= 0.75;
    }

    return Math.random() < probability;
  }

  /** Calculate filter frequency. Higher velocity = brighter sound. */
  calculateFilterFreq(event: CollisionEvent, material: MaterialConfig): number {
    const velocityFactor = Math.min(1, event.velocity / this._config.velocityMax);
    const freq = material.filterFreq * (1 + velocityFactor);
    // Clamp to valid audio frequency range
    return Math.max(20, Math.min(18000, freq));
  }

  updateConfig(config: Partial<PhysicsMapperConfig>): void {
    this._config = { ...this._config, ...config };
  }

  getConfig(): PhysicsMapperConfig {
    return { ...this._config };
  }

  /** Quick Minnaert frequency calculation. */
  static minnaertFrequency(radiusMm: number): number {
    return 3000 / Math.max(0.5, radiusMm);
  }

  /** Convert Matter.js speed (pixels/frame) to m/s. */
  static matterSpeedToMs(matterSpeed: number, pixelsPerMeter = 100, fps = 60): number {
    return (matterSpeed * fps) / pixelsPerMeter;
  }

  /** Convert Matter.js radius (pixels) to millimeters. */
  static pixelsToMm(radiusPixels: number, pixelsPerMm = 10): number {
    return radiusPixels / pixelsPerMm;
  }
}
