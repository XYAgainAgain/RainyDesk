/**
 * GlitchSynth - Digital glitch sounds for Matrix Mode collisions
 *
 * Short bursts of noise + square wave bleeps with bitcrusher.
 * Triggered when matrix streams hit windows or the taskbar.
 * Quantized to 120 BPM for musical feel.
 *
 * See .dev/MATRIX-MODE.md for spec.
 */

import * as Tone from 'tone';

// Beat quantization config (120 BPM, quantized to 16th notes)
const BEAT_CONFIG = {
  BPM: 120,                    // Tempo of background drone loop
  BEAT_MS: 500,                // 60000 / 120 = 500ms per quarter note
  SIXTEENTH_MS: 125,           // 500 / 4 = 125ms per 16th note
  ON_BEAT_THRESHOLD_MS: 12,    // ±12ms window (24ms total - tight for electronic music)
};

// D minor scale frequencies across 2 octaves (D3 to D5)
// Scale: D, E, F, G, A, Bb, C
const D_MINOR_FREQUENCIES = [
  // Octave 3
  146.83,  // D3
  164.81,  // E3
  174.61,  // F3
  196.00,  // G3
  220.00,  // A3
  233.08,  // Bb3
  261.63,  // C4
  // Octave 4
  293.66,  // D4
  329.63,  // E4
  349.23,  // F4
  392.00,  // G4
  440.00,  // A4
  466.16,  // Bb4
  523.25,  // C5
  // Top
  587.33,  // D5
];

export interface TriggerResult {
  onBeat: boolean;  // Was this collision on a beat?
}

export class GlitchSynth {
  private noise: Tone.Noise | null = null;
  private synth: Tone.Synth | null = null;
  private bitcrusher: Tone.BitCrusher | null = null;
  private noiseEnv: Tone.AmplitudeEnvelope | null = null;
  private gain: Tone.Gain | null = null;
  private initialized = false;

  // Background drone (crossfade looping)
  private dronePlayerA: Tone.Player | null = null;
  private dronePlayerB: Tone.Player | null = null;
  private droneGain: Tone.Gain | null = null;
  private droneCrossfade: Tone.CrossFade | null = null;
  private droneActive = false;

  // Beat tracking (timestamp when drone started, used for quantization)
  private beatOriginTime = 0;

  constructor() {
    // Lazy init - only create audio nodes when first used
  }

  private ensureInit(): void {
    if (this.initialized) return;

    this.gain = new Tone.Gain(Tone.dbToGain(-30)).toDestination();
    this.bitcrusher = new Tone.BitCrusher(4).connect(this.gain);

    this.noiseEnv = new Tone.AmplitudeEnvelope({
      attack: 0.005,
      decay: 0.03,
      sustain: 0,
      release: 0.02,
    }).connect(this.bitcrusher);

    this.noise = new Tone.Noise('white').connect(this.noiseEnv);
    this.noise.start();

    this.synth = new Tone.Synth({
      oscillator: { type: 'square' },
      envelope: {
        attack: 0.001,
        decay: 0.05,
        sustain: 0,
        release: 0.01,
      },
    }).connect(this.bitcrusher);

    this.initialized = true;
  }

  /**
   * Check if current time is "on beat" (within threshold of a 16th note boundary)
   * Quantizing to 16th notes gives 8 potential hit points per bar for arpeggios.
   */
  private isOnBeat(): boolean {
    if (!this.droneActive || this.beatOriginTime === 0) {
      // No drone = no beat reference, treat all as off-beat
      return false;
    }
    const elapsed = performance.now() - this.beatOriginTime;
    // Position within current 16th note (0–125ms)
    const positionIn16th = elapsed % BEAT_CONFIG.SIXTEENTH_MS;
    // On-beat if within ±25ms of a 16th note boundary
    return positionIn16th < BEAT_CONFIG.ON_BEAT_THRESHOLD_MS ||
           positionIn16th > (BEAT_CONFIG.SIXTEENTH_MS - BEAT_CONFIG.ON_BEAT_THRESHOLD_MS);
  }

  /**
   * Trigger a glitch sound on collision.
   * Returns whether this was an on-beat collision (for visual effects).
   * OFF-BEAT collisions are SILENT - only on-beat gets sound + flash.
   */
  trigger(): TriggerResult {
    this.ensureInit();

    const onBeat = this.isOnBeat();

    if (onBeat) {
      // ON-BEAT: Full dramatic sound in D minor
      this.noiseEnv?.triggerAttackRelease(0.05);
      const freq = D_MINOR_FREQUENCIES[Math.floor(Math.random() * D_MINOR_FREQUENCIES.length)];
      this.synth?.triggerAttackRelease(freq, 0.08);
    }
    // OFF-BEAT: Silent (no sound, just visual scramble)

    return { onBeat };
  }

  /** Set glitch volume in decibels */
  setVolume(db: number): void {
    this.ensureInit();
    if (this.gain) {
      this.gain.gain.value = Tone.dbToGain(db);
    }
  }

  /** Load and start background drone with crossfade looping */
  async startDrone(url: string, fadeInSeconds = 3): Promise<void> {
    if (this.droneActive) return;

    try {
      // Ensure audio context is started (Tone.js requirement)
      await Tone.start();

      this.droneGain = new Tone.Gain(0).toDestination();
      this.droneCrossfade = new Tone.CrossFade(0).connect(this.droneGain);

      // Create both players and wait for BOTH to load
      this.dronePlayerA = new Tone.Player({ url }).connect(this.droneCrossfade.a);
      this.dronePlayerB = new Tone.Player({ url }).connect(this.droneCrossfade.b);

      // Wait for both players to load
      await Tone.loaded();
      console.log('[Matrix] Drone audio loaded, starting playback');

      // Record beat origin for quantization (120 BPM sync)
      this.beatOriginTime = performance.now();
      console.log(`[Matrix] Beat origin set, BPM: ${BEAT_CONFIG.BPM}`);

      // Now start the loop
      this.droneActive = true;
      this.droneGain.gain.rampTo(Tone.dbToGain(-18), fadeInSeconds);
      this.startDroneLoop();
    } catch (err) {
      console.error('[Matrix] Failed to load drone:', err);
      throw err; // Re-throw so caller knows it failed
    }
  }

  /** Manage crossfade loop scheduling */
  private startDroneLoop(): void {
    if (!this.dronePlayerA || !this.dronePlayerB || !this.droneCrossfade) return;

    const duration = this.dronePlayerA.buffer.duration;
    const crossfadeTime = 2;

    this.dronePlayerA.start();
    this.droneCrossfade.fade.value = 0;

    const scheduleNext = (useA: boolean) => {
      if (!this.droneActive) return;

      const nextPlayer = useA ? this.dronePlayerB : this.dronePlayerA;
      if (!nextPlayer || !this.droneCrossfade) return;

      const startTime = Tone.now() + duration - crossfadeTime;

      Tone.Transport.scheduleOnce(() => {
        if (!this.droneActive) return;
        nextPlayer.start();
        this.droneCrossfade?.fade.rampTo(useA ? 1 : 0, crossfadeTime);
        scheduleNext(!useA);
      }, startTime);
    };

    if (Tone.Transport.state !== 'started') {
      Tone.Transport.start();
    }
    scheduleNext(true);
  }

  /** Stop drone with fade out */
  stopDrone(fadeOutSeconds = 2): void {
    if (!this.droneActive) return;
    this.droneActive = false;

    this.droneGain?.gain.rampTo(0, fadeOutSeconds);

    setTimeout(() => {
      this.dronePlayerA?.stop();
      this.dronePlayerB?.stop();
      this.dronePlayerA?.dispose();
      this.dronePlayerB?.dispose();
      this.droneCrossfade?.dispose();
      this.droneGain?.dispose();
      this.dronePlayerA = null;
      this.dronePlayerB = null;
      this.droneCrossfade = null;
      this.droneGain = null;
    }, (fadeOutSeconds + 0.5) * 1000);
  }

  /** Clean up all audio resources */
  dispose(): void {
    this.stopDrone(0);

    if (!this.initialized) return;

    this.noise?.stop();
    this.noise?.dispose();
    this.synth?.dispose();
    this.noiseEnv?.dispose();
    this.bitcrusher?.dispose();
    this.gain?.dispose();

    this.noise = null;
    this.synth = null;
    this.noiseEnv = null;
    this.bitcrusher = null;
    this.gain = null;
    this.initialized = false;
  }
}
