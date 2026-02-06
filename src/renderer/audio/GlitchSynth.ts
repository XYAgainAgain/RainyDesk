/**
 * GlitchSynth - Digital glitch sounds for Matrix Mode collisions
 *
 * Short bursts of noise + square wave bleeps with bitcrusher.
 * Triggered when matrix streams hit windows or the taskbar.
 * Quantized to 102 BPM, chord-driven by ArpeggioSequencer.
 *
 * See .dev/ARPEGGIO-SEQUENCER-DESIGN.md for chord progression spec.
 */

import * as Tone from 'tone';
import { ArpeggioSequencer, type Section } from './ArpeggioSequencer';

// Beat quantization config (102 BPM, quantized to 16th notes)
const BEAT_CONFIG = {
  BPM: 102,
  BEAT_MS: 60000 / 102,           // ~588ms per quarter note
  SIXTEENTH_MS: 60000 / 102 / 4,  // ~147ms per 16th note
  EIGHTH_MS: 60000 / 102 / 2,     // ~294ms per eighth note
  ON_BEAT_THRESHOLD_MS: 12,        // +/-12ms window (24ms total)
};

// Bass synth envelope presets
const BASS_SUSTAINED = { attack: 0.3, decay: 0.1, sustain: 0.9, release: 0.5 };
const BASS_PULSED = { attack: 0.01, decay: 0.15, sustain: 0, release: 0.1 };

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
  private droneStopping = false; // Prevents restart during fade-out

  // Beat tracking (timestamp when drone started, used for quantization)
  private beatOriginTime = 0;

  // Arpeggio sequencer (chord progression tracking)
  private sequencer: ArpeggioSequencer | null = null;

  // Bass synth (triangle wave, low register)
  private bassSynth: Tone.Synth | null = null;
  private bassGain: Tone.Gain | null = null;
  private lastBassBar = -1;
  private bassSecondPulsePending = false;

  // Section/volume tracking
  private currentSection: Section = 'main';
  private targetDroneVolumeDb = -18;

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
    // Position within current 16th note (0-147ms)
    const positionIn16th = elapsed % BEAT_CONFIG.SIXTEENTH_MS;
    // On-beat if within +/-12ms of a 16th note boundary
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

    if (onBeat && this.sequencer) {
      // ON-BEAT: Harmonically correct note from sequencer
      this.noiseEnv?.triggerAttackRelease(0.05);
      const note = this.sequencer.getNextNote();
      this.synth?.triggerAttackRelease(note, 0.08);
    } else if (onBeat) {
      // Fallback: G4 if no sequencer active
      this.noiseEnv?.triggerAttackRelease(0.05);
      this.synth?.triggerAttackRelease('G4', 0.08);
    }
    // OFF-BEAT: Silent (no sound, just visual scramble)

    return { onBeat };
  }

  /**
   * Per-frame update. Advances sequencer timing and triggers bass notes.
   * Must be called from renderer.js game loop.
   */
  update(): void {
    if (!this.sequencer || !this.droneActive) return;
    this.sequencer.update();
    this.updateBass();
  }

  /** Set glitch volume in decibels */
  setVolume(db: number): void {
    this.ensureInit();
    if (this.gain) {
      this.gain.gain.value = Tone.dbToGain(db);
    }
  }

  /** Set drone volume in decibels (tracks target for section fade-ins) */
  setDroneVolume(db: number): void {
    this.targetDroneVolumeDb = db;
    // Only apply immediately during main loop (bridge/breakdown fade drone to 0)
    if (this.currentSection === 'main' && this.droneGain) {
      this.droneGain.gain.rampTo(Tone.dbToGain(db), 0.1);
    }
  }

  /** Load and start background drone with crossfade looping */
  async startDrone(url: string, fadeInSeconds = 3): Promise<void> {
    // Block if already active OR currently stopping (fade-out in progress)
    if (this.droneActive || this.droneStopping) return;

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

      // Record beat origin for quantization (102 BPM sync)
      this.beatOriginTime = performance.now();
      console.log(`[Matrix] Beat origin set, BPM: ${BEAT_CONFIG.BPM}`);

      // Create sequencer synced to beat origin
      this.sequencer = new ArpeggioSequencer(this.beatOriginTime);
      this.sequencer.onSectionChange = (section: Section, bar: number) => {
        this.handleSectionChange(section, bar);
      };

      // Create bass synth (triangle wave for warm low end)
      this.bassSynth = new Tone.Synth({
        oscillator: { type: 'triangle' },
        envelope: BASS_SUSTAINED,
      });
      this.bassGain = new Tone.Gain(Tone.dbToGain(-12)).toDestination();
      this.bassSynth.connect(this.bassGain);

      // Now start the loop
      this.droneActive = true;
      this.currentSection = 'main';
      this.lastBassBar = -1;
      this.droneGain.gain.rampTo(Tone.dbToGain(this.targetDroneVolumeDb), fadeInSeconds);
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
    this.droneStopping = true; // Block restarts during fade-out

    this.droneGain?.gain.rampTo(0, fadeOutSeconds);

    // Release bass immediately
    this.bassSynth?.triggerRelease();

    // Cancel any scheduled crossfade events to prevent memory leak
    Tone.Transport.cancel();

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

      // Clean up bass
      this.bassSynth?.dispose();
      this.bassGain?.dispose();
      this.bassSynth = null;
      this.bassGain = null;

      // Clean up sequencer
      this.sequencer = null;

      this.droneStopping = false; // Safe to restart now
    }, (fadeOutSeconds + 0.5) * 1000);
  }

  /** Clean up all audio resources */
  dispose(): void {
    // Clean up sequencer and bass first
    this.sequencer = null;
    this.bassSynth?.triggerRelease();
    this.bassSynth?.dispose();
    this.bassGain?.dispose();
    this.bassSynth = null;
    this.bassGain = null;

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

  // --- Private helpers ---

  /**
   * Handle section transitions (drone fading, bass mode switching).
   * Called by the sequencer's onSectionChange callback.
   */
  private handleSectionChange(section: Section, bar: number): void {
    this.currentSection = section;
    console.log(`[Matrix] Section change: ${section} (bar ${bar})`);

    if (section === 'main') {
      // Fade drone back in to user's volume over 2s
      this.droneGain?.gain.rampTo(Tone.dbToGain(this.targetDroneVolumeDb), 2);
      // Switch bass to sustained envelope
      if (this.bassSynth) {
        this.bassSynth.envelope.attack = BASS_SUSTAINED.attack;
        this.bassSynth.envelope.decay = BASS_SUSTAINED.decay;
        this.bassSynth.envelope.sustain = BASS_SUSTAINED.sustain;
        this.bassSynth.envelope.release = BASS_SUSTAINED.release;
      }
    } else {
      // Bridge or breakdown: fade drone to silence over 2s
      this.droneGain?.gain.rampTo(0, 2);
      // Release any held bass note
      this.bassSynth?.triggerRelease();
      this.lastBassBar = -1;

      if (section === 'bridge') {
        // Switch bass to pulsed envelope (for "dmm dmm" when it re-enters at bar 76)
        if (this.bassSynth) {
          this.bassSynth.envelope.attack = BASS_PULSED.attack;
          this.bassSynth.envelope.decay = BASS_PULSED.decay;
          this.bassSynth.envelope.sustain = BASS_PULSED.sustain;
          this.bassSynth.envelope.release = BASS_PULSED.release;
        }
      }
    }
  }

  /**
   * Update bass synth based on current bar position.
   * Two modes: sustained (main loop) and pulsed "dmm dmm" (bridge bars 76+).
   */
  private updateBass(): void {
    if (!this.bassSynth || !this.sequencer) return;

    const { bar, beat } = this.sequencer.getBarPosition();

    // Determine if bass should be active this bar
    const bassActive = this.isBassActiveForBar(bar);

    // Bar change: trigger new bass note or release
    if (bar !== this.lastBassBar) {
      this.lastBassBar = bar;
      this.bassSecondPulsePending = false;

      if (!bassActive) {
        this.bassSynth.triggerRelease();
        return;
      }

      const root = this.sequencer.getCurrentBassRoot();

      if (this.currentSection === 'main') {
        // Sustained: hold the note for the whole bar
        // Release previous note briefly before attacking new one
        this.bassSynth.triggerRelease();
        // Small delay to avoid overlapping releases
        setTimeout(() => {
          if (this.bassSynth && this.droneActive) {
            this.bassSynth.triggerAttack(root);
          }
        }, 10);
      } else if (this.isBridgePulsedBar(bar)) {
        // Pulsed: first "dmm" on beat 1
        this.bassSynth.triggerAttackRelease(root, BEAT_CONFIG.EIGHTH_MS / 1000);
        this.bassSecondPulsePending = true;
      }
    }

    // Second pulse timing for bridge "dmm dmm" pattern
    // Fire second eighth note at beat 0.5 (the "and" of 1)
    if (this.bassSecondPulsePending && beat >= 0.5) {
      this.bassSecondPulsePending = false;
      const root = this.sequencer.getCurrentBassRoot();
      this.bassSynth.triggerAttackRelease(root, BEAT_CONFIG.EIGHTH_MS / 1000);
    }
  }

  /** Bars where bass is active (returns false for silent bars) */
  private isBassActiveForBar(bar: number): boolean {
    // Bars 0-1: silent (intro, no bass yet)
    if (bar <= 1) return false;
    // Bars 2-63: sustained bass (main loop)
    if (bar >= 2 && bar <= 63) return true;
    // Bars 64-75: silent (bass drops out with drone at bridge start)
    if (bar >= 64 && bar <= 75) return false;
    // Bars 76-87: pulsed bass (bridge re-entry)
    if (bar >= 76 && bar <= 87) return true;
    // Bars 88-89: silent (breakdown)
    return false;
  }

  /** Whether this bar uses pulsed "dmm dmm" bass articulation */
  private isBridgePulsedBar(bar: number): boolean {
    return bar >= 76 && bar <= 87;
  }
}
