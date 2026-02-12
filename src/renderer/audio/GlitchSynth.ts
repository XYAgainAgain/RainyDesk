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
import { ArpeggioSequencer, transposeNote, type Section } from './ArpeggioSequencer';

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
const BASS_PULSED = { attack: 0.01, decay: 0.4, sustain: 0.3, release: 0.3 }; // Longer "dmmm" not "bmp"

// Bass volume per section (B1)
const BASS_VOLUME_MAIN = -9;     // 50% slider default
const BASS_VOLUME_BRIDGE = -5;   // Prominent in bridge pulsed section (main + 4 dB)

// G Dorian ascending walk (sub-bass intro, bars 0-3)
const G_DORIAN_WALK = ['G0', 'A0', 'Bb0', 'C1', 'D1', 'Eb1', 'F1', 'G1'];

export interface TriggerResult {
  onBeat: boolean;  // Was this collision on a beat?
}

// String lead octave offset — DISABLED (string synth disabled)
// const STRING_OCTAVE_OFFSET = 2; // Transpose chord notes up 2 octaves for string register

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
  private bassNextPulseIndex = 0; // Tracks which pulse to fire next in pulsed mode

  // C1: LFO snarl on bass (filter wobble every other measure)
  private bassLfo: Tone.LFO | null = null;
  private bassFilter: Tone.Filter | null = null;
  private lastLfoBar = -1;

  // C2: Shared reverb for bass -> bridge transition and string lead
  private sharedReverb: Tone.Reverb | null = null;
  private reverbSend: Tone.Gain | null = null;

  // C3: Octave-up collision synth (bridge only)
  private octaveSynth: Tone.Synth | null = null;
  private octaveGain: Tone.Gain | null = null;

  // C4: Sub-bass doubling (felt-not-heard rumble)
  private subBassSynth: Tone.Synth | null = null;
  private subBassGain: Tone.Gain | null = null;
  private subBassFilter: Tone.Filter | null = null;
  private breakdownSubBassActive = false;

  // Sub-bass intro Dorian walk (bars 0-3)
  private introSubBassActive = false;
  private introStepIndex = 0;
  private introSnarlFired = false;

  // Drone delay: suppress gain until first OGG crossfade completes
  private droneFirstLoop = true;

  // D: String lead synth (continuous melody)
  private stringSynth: Tone.PolySynth | null = null;
  private stringGain: Tone.Gain | null = null;
  private stringVibrato: Tone.Vibrato | null = null;
  private stringDuckGain: Tone.Gain | null = null; // Sidechain duck on collision
  private lastStringBar = -1;

  // Transport event tracking (cleared individually instead of global Transport.cancel())
  private scheduledEventIds: number[] = [];
  private droneCleanupTimeout: ReturnType<typeof setTimeout> | null = null;

  // Section/volume tracking
  private currentSection: Section = 'main';
  private targetDroneVolumeDb = -17.4; // 30% slider default
  private targetBassVolumeDb = BASS_VOLUME_MAIN; // 50% slider default (-9 dB)
  private targetCollisionVolumeDb = -21.6; // 20% slider default

  // Master output node — all synth outputs route here, then to destination or external chain
  private masterOutput: Tone.Gain;

  constructor() {
    // Create master output immediately (routes to destination by default)
    this.masterOutput = new Tone.Gain(1).toDestination();
  }

  private ensureInit(): void {
    if (this.initialized) return;

    this.gain = new Tone.Gain(Tone.dbToGain(-24)).connect(this.masterOutput);
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

    try {
      if (onBeat && this.sequencer) {
        // ON-BEAT: Harmonically correct note from sequencer
        this.noiseEnv?.triggerAttackRelease(0.05);
        const note = this.sequencer.getNextNote();
        this.synth?.triggerAttackRelease(note, 0.08);

        // C3: Double collision 1 octave up during bridge
        if (this.currentSection === 'bridge' && this.octaveSynth) {
          const octaveUpNote = this.transposeOctave(note, 1);
          this.octaveSynth.triggerAttackRelease(octaveUpNote, 0.06);
        }
      } else if (onBeat) {
        // Fallback: G4 if no sequencer active
        this.noiseEnv?.triggerAttackRelease(0.05);
        this.synth?.triggerAttackRelease('G4', 0.08);
      }
      // OFF-BEAT: Silent (no sound, just visual scramble)

      // String lead synth DISABLED (for now), add -3dB ducking sidechain later
      // if (onBeat && this.stringDuckGain) {
      //   this.stringDuckGain.gain.cancelScheduledValues(Tone.now());
      //   this.stringDuckGain.gain.setValueAtTime(Tone.dbToGain(-3), Tone.now());
      //   this.stringDuckGain.gain.rampTo(1, 0.05);
      // }
    } catch (err) {
      // Tone.js timing conflicts from rapid triggers — swallow to protect caller
    }

    return { onBeat };
  }

  /**
   * Per-frame update. Advances sequencer timing, bass notes, string lead, and LFO gating.
   * Must be called from renderer.js game loop.
   */
  update(): void {
    if (!this.sequencer || !this.droneActive) return;
    try {
      this.sequencer.update();
      this.updateSubBassIntro();
      this.updateBass();
      this.updateStringLead();
      this.updateBassLfo();
    } catch (err) {
      // Tone.js scheduling errors must not propagate to game loop
    }
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
  async startDrone(url: string): Promise<void> {
    // Block if already active OR currently stopping (fade-out in progress)
    if (this.droneActive || this.droneStopping) return;

    try {
      // Ensure audio context is started (Tone.js requirement)
      await Tone.start();

      this.droneGain = new Tone.Gain(0).connect(this.masterOutput);
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

      // C2: Shared reverb (used by bass transition and string lead)
      this.sharedReverb = new Tone.Reverb({ decay: 4, wet: 1 });
      this.sharedReverb.connect(this.masterOutput);
      await this.sharedReverb.ready; // Wait for impulse response generation
      this.reverbSend = new Tone.Gain(0).connect(this.sharedReverb);

      // Create bass synth (triangle wave for warm low end)
      this.bassSynth = new Tone.Synth({
        oscillator: { type: 'triangle' },
        envelope: BASS_SUSTAINED,
      });

      // C1: Bass filter + LFO for snarl effect (every other measure)
      this.bassFilter = new Tone.Filter({ type: 'lowpass', frequency: 20000, rolloff: -12 });
      this.bassLfo = new Tone.LFO({ frequency: 0.4, type: 'triangle', min: 200, max: 800 });
      this.bassLfo.connect(this.bassFilter.frequency);
      // LFO starts stopped, gated by bar parity in updateBass()

      this.bassGain = new Tone.Gain(Tone.dbToGain(BASS_VOLUME_MAIN)).connect(this.masterOutput);
      this.bassSynth.connect(this.bassFilter);
      this.bassFilter.connect(this.bassGain);
      // Also connect bass to reverb send (C2: for transition wet)
      this.bassFilter.connect(this.reverbSend);

      // C3: Octave-up collision synth (lighter timbre, bridge only)
      this.octaveSynth = new Tone.Synth({
        oscillator: { type: 'sine' },
        envelope: { attack: 0.001, decay: 0.06, sustain: 0, release: 0.02 },
      });
      this.octaveGain = new Tone.Gain(Tone.dbToGain(-24)).connect(this.masterOutput);
      this.octaveSynth.connect(this.octaveGain);

      // C4: Sub-bass doubling (triangle, very low volume, felt-not-heard)
      this.subBassSynth = new Tone.Synth({
        oscillator: { type: 'triangle' },
        envelope: BASS_SUSTAINED,
      });
      this.subBassFilter = new Tone.Filter({ type: 'lowpass', frequency: 20000, rolloff: -12 });
      this.subBassGain = new Tone.Gain(Tone.dbToGain(-24)).connect(this.masterOutput);
      this.subBassSynth.connect(this.subBassFilter);
      this.subBassFilter.connect(this.subBassGain);

      // D: String lead synth — DISABLED pending volume/melody tuning
      // this.stringSynth = new Tone.PolySynth(Tone.Synth, {
      //   oscillator: { type: 'triangle' },
      //   envelope: { attack: 0.5, decay: 0.3, sustain: 0.8, release: 1.0 },
      // });
      // this.stringSynth.maxPolyphony = 2;
      // this.stringVibrato = new Tone.Vibrato({ frequency: 5, depth: 0.1 });
      // this.stringDuckGain = new Tone.Gain(1);
      // this.stringGain = new Tone.Gain(Tone.dbToGain(-30)).toDestination();
      // this.stringSynth.connect(this.stringVibrato);
      // this.stringVibrato.connect(this.stringDuckGain);
      // this.stringDuckGain.connect(this.stringGain);
      // this.stringDuckGain.connect(this.reverbSend);

      // Now start the loop
      this.droneActive = true;
      this.currentSection = 'main';
      this.lastBassBar = -1;
      this.droneFirstLoop = true;
      // Drone gain stays at 0 (created at 0 on line above) — delayed until first OGG crossfade
      this.startDroneLoop();
      // Start sub-bass intro Dorian walk (bars 0-3)
      this.startSubBassIntro();
    } catch (err) {
      console.error('[Matrix] Failed to load drone:', err);
      throw err; // Re-throw so caller knows it failed
    }
  }

  /** Clear all Transport events scheduled by this synth (without nuking other modules) */
  private clearScheduledEvents(): void {
    for (const id of this.scheduledEventIds) {
      Tone.Transport.clear(id);
    }
    this.scheduledEventIds = [];
  }

  /** Manage crossfade loop scheduling */
  private startDroneLoop(): void {
    if (!this.dronePlayerA || !this.dronePlayerB || !this.droneCrossfade) return;

    const duration = this.dronePlayerA.buffer.duration;
    const crossfadeTime = 2;

    this.dronePlayerA.start();
    this.droneCrossfade.fade.value = 0;

    const scheduleNext = (useA: boolean, fromTime?: number) => {
      if (!this.droneActive) return;

      const nextPlayer = useA ? this.dronePlayerB : this.dronePlayerA;
      if (!nextPlayer || !this.droneCrossfade) return;

      // Use passed-in time (from Transport callback) or Tone.now() for first call
      const baseTime = fromTime ?? Tone.now();
      const startTime = baseTime + duration - crossfadeTime;

      const eventId = Tone.Transport.scheduleOnce((time) => {
        if (!this.droneActive) return;
        // Use the Transport-provided time for accurate scheduling
        nextPlayer.start(time);
        this.droneCrossfade?.fade.rampTo(useA ? 1 : 0, crossfadeTime);
        // First crossfade = OGG's second loop starting. Fade drone in now.
        if (this.droneFirstLoop) {
          this.droneGain?.gain.rampTo(Tone.dbToGain(this.targetDroneVolumeDb), 2);
          this.droneFirstLoop = false;
        }
        scheduleNext(!useA, time);
      }, startTime);
      this.scheduledEventIds.push(eventId);
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

    // Cancel scheduled filter automations before release
    this.subBassFilter?.frequency.cancelScheduledValues(Tone.now());
    this.bassFilter?.frequency.cancelScheduledValues(Tone.now());

    // Release bass and string lead immediately
    this.bassSynth?.triggerRelease();
    this.subBassSynth?.triggerRelease();
    this.stringSynth?.releaseAll();

    // Stop LFO
    this.bassLfo?.stop();

    // Reset intro/drone state
    this.introSubBassActive = false;
    this.introStepIndex = 0;
    this.introSnarlFired = false;
    this.droneFirstLoop = true;

    // Clear only our scheduled crossfade events (not global Transport)
    this.clearScheduledEvents();

    this.droneCleanupTimeout = setTimeout(() => {
      this.droneCleanupTimeout = null;
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

      // Clean up bass + C1 filter/LFO
      this.bassLfo?.dispose();
      this.bassFilter?.dispose();
      this.bassSynth?.dispose();
      this.bassGain?.dispose();
      this.bassLfo = null;
      this.bassFilter = null;
      this.bassSynth = null;
      this.bassGain = null;

      // Clean up C2: shared reverb
      this.reverbSend?.dispose();
      this.sharedReverb?.dispose();
      this.reverbSend = null;
      this.sharedReverb = null;

      // Clean up C3: octave synth
      this.octaveSynth?.dispose();
      this.octaveGain?.dispose();
      this.octaveSynth = null;
      this.octaveGain = null;

      // Clean up C4: sub-bass
      this.subBassFilter?.dispose();
      this.subBassSynth?.dispose();
      this.subBassGain?.dispose();
      this.subBassFilter = null;
      this.subBassSynth = null;
      this.subBassGain = null;
      this.breakdownSubBassActive = false;

      // Clean up D: string lead
      this.stringSynth?.dispose();
      this.stringVibrato?.dispose();
      this.stringDuckGain?.dispose();
      this.stringGain?.dispose();
      this.stringSynth = null;
      this.stringVibrato = null;
      this.stringDuckGain = null;
      this.stringGain = null;

      // Clean up sequencer
      this.sequencer = null;

      // Reset tracking state
      this.lastLfoBar = -1;
      this.lastStringBar = -1;

      this.droneStopping = false; // Safe to restart now
    }, (fadeOutSeconds + 0.5) * 1000);
  }

  /** Clean up all audio resources */
  dispose(): void {
    // Stop drone immediately (0 = no fade) — it handles all drone-related node cleanup
    // Set droneActive=false first so stopDrone's setTimeout won't try to restart
    this.droneActive = false;
    this.droneStopping = false;

    // Cancel any pending stopDrone cleanup timeout to prevent double-dispose
    if (this.droneCleanupTimeout) {
      clearTimeout(this.droneCleanupTimeout);
      this.droneCleanupTimeout = null;
    }

    // Cancel scheduled filter automations before dispose
    this.subBassFilter?.frequency.cancelScheduledValues(Tone.now());
    this.bassFilter?.frequency.cancelScheduledValues(Tone.now());

    // Release synths immediately before dispose
    this.bassSynth?.triggerRelease();
    this.subBassSynth?.triggerRelease();
    this.stringSynth?.releaseAll();
    this.bassLfo?.stop();
    this.clearScheduledEvents();

    // Reset intro/drone state
    this.introSubBassActive = false;
    this.introStepIndex = 0;
    this.introSnarlFired = false;
    this.droneFirstLoop = true;

    // Dispose all drone-related nodes immediately (skip stopDrone's setTimeout)
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

    // Dispose bass + C1 filter/LFO
    this.bassLfo?.dispose();
    this.bassFilter?.dispose();
    this.bassSynth?.dispose();
    this.bassGain?.dispose();
    this.bassLfo = null;
    this.bassFilter = null;
    this.bassSynth = null;
    this.bassGain = null;

    // C2: shared reverb
    this.reverbSend?.dispose();
    this.sharedReverb?.dispose();
    this.reverbSend = null;
    this.sharedReverb = null;

    // C3: octave synth
    this.octaveSynth?.dispose();
    this.octaveGain?.dispose();
    this.octaveSynth = null;
    this.octaveGain = null;

    // C4: sub-bass
    this.subBassFilter?.dispose();
    this.subBassSynth?.dispose();
    this.subBassGain?.dispose();
    this.subBassFilter = null;
    this.subBassSynth = null;
    this.subBassGain = null;
    this.breakdownSubBassActive = false;

    // D: string lead
    this.stringSynth?.dispose();
    this.stringVibrato?.dispose();
    this.stringDuckGain?.dispose();
    this.stringGain?.dispose();
    this.stringSynth = null;
    this.stringVibrato = null;
    this.stringDuckGain = null;
    this.stringGain = null;

    this.sequencer = null;

    // Dispose collision synth nodes
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

    // Clean up master output
    this.masterOutput.dispose();
  }

  /**
   * Reroute all GlitchSynth audio through an external destination (e.g. AudioSystem master chain).
   * Disconnects from default destination and reconnects to the provided node.
   */
  connectOutput(destination: Tone.ToneAudioNode): void {
    this.masterOutput.disconnect();
    this.masterOutput.connect(destination);
  }

  // Private helpers

  /**
   * Handle section transitions (drone fading, bass mode switching).
   * Called by the sequencer's onSectionChange callback.
   */
  private handleSectionChange(section: Section, bar: number): void {
    this.currentSection = section;
    console.log(`[Matrix] Section change: ${section} (bar ${bar})`);

    if (section === 'main') {
      // Fade drone back in to user's volume over 2s (skip if still on first OGG loop)
      if (!this.droneFirstLoop) {
        this.droneGain?.gain.rampTo(Tone.dbToGain(this.targetDroneVolumeDb), 2);
      }
      // Switch bass to sustained envelope and main loop volume
      if (this.bassSynth) {
        this.bassSynth.envelope.attack = BASS_SUSTAINED.attack;
        this.bassSynth.envelope.decay = BASS_SUSTAINED.decay;
        this.bassSynth.envelope.sustain = BASS_SUSTAINED.sustain;
        this.bassSynth.envelope.release = BASS_SUSTAINED.release;
        // Reset pitch bend from breakdown sweep
        this.bassSynth.detune.cancelScheduledValues(Tone.now());
        this.bassSynth.detune.rampTo(0, 0.5);
      }
      // Reset bass filter from breakdown sweep (was closed to 80Hz)
      if (this.bassFilter) {
        this.bassFilter.frequency.cancelScheduledValues(Tone.now());
        this.bassFilter.frequency.rampTo(20000, 0.5);
      }
      if (this.subBassSynth) {
        this.subBassSynth.detune.cancelScheduledValues(Tone.now());
        this.subBassSynth.detune.rampTo(0, 0.5);
      }
      // Clean up breakdown sub-bass sweep if it was active
      if (this.breakdownSubBassActive) {
        this.breakdownSubBassActive = false;
        this.subBassSynth?.triggerRelease();
      }
      // Reset sub-bass filter to fully open
      if (this.subBassFilter) {
        this.subBassFilter.frequency.cancelScheduledValues(Tone.now());
        this.subBassFilter.frequency.rampTo(20000, 0.5);
      }
      // Ramp bass back to main loop volume (B1)
      this.bassGain?.gain.rampTo(Tone.dbToGain(BASS_VOLUME_MAIN), 1);
      // C2: Dry reverb send in main loop
      this.reverbSend?.gain.rampTo(0, 0.5);
      // Restart sub-bass intro Dorian walk for new cycle
      this.startSubBassIntro();
      // this.stringGain?.gain.rampTo(Tone.dbToGain(-30), 1);
    } else if (section === 'bridge') {
      // C2: Ramp reverb wet to 0.8 at main->bridge transition (long reverb tail)
      this.reverbSend?.gain.rampTo(0.8, 2);

      // Fade drone to silence over 2s
      this.droneGain?.gain.rampTo(0, 2);
      // Release any held bass note
      this.bassSynth?.triggerRelease();
      this.lastBassBar = -1;

      // Switch bass to pulsed envelope (for "dmmm dmmm" when it re-enters at bar 76)
      if (this.bassSynth) {
        this.bassSynth.envelope.attack = BASS_PULSED.attack;
        this.bassSynth.envelope.decay = BASS_PULSED.decay;
        this.bassSynth.envelope.sustain = BASS_PULSED.sustain;
        this.bassSynth.envelope.release = BASS_PULSED.release;
      }
      // Ramp bass to bridge volume (louder for pulsed section, B1)
      this.bassGain?.gain.rampTo(Tone.dbToGain(BASS_VOLUME_BRIDGE), 0.5);

      // this.stringGain?.gain.rampTo(Tone.dbToGain(-36), 2);
    } else {
      // Breakdown (bars 88-89): fade drone to silence, bass sustains with filter sweep
      this.droneGain?.gain.rampTo(0, 2);
      this.lastBassBar = -1;
      // Let pitch bend sweep finish naturally (don't cancel it)
      // C2: Fade reverb back to dry
      this.reverbSend?.gain.rampTo(0, 1);

      // Switch bass to sustained envelope (was pulsed from bridge)
      if (this.bassSynth) {
        this.bassSynth.envelope.attack = BASS_SUSTAINED.attack;
        this.bassSynth.envelope.decay = BASS_SUSTAINED.decay;
        this.bassSynth.envelope.sustain = BASS_SUSTAINED.sustain;
        this.bassSynth.envelope.release = BASS_SUSTAINED.release;
      }
      // Bass filter sweep: 20kHz down to 80Hz over 2 bars (detuned siren winding down)
      if (this.bassFilter) {
        this.bassFilter.frequency.cancelScheduledValues(Tone.now());
        const sweepDuration = BEAT_CONFIG.BEAT_MS * 8 / 1000; // 2 bars = 8 beats
        this.bassFilter.frequency.rampTo(80, sweepDuration);
      }

      // Sub-bass filter sweep: 80Hz → 300Hz over 2 bars ("rising from the depths")
      if (this.subBassSynth && this.subBassFilter) {
        // Cancel any lingering detune from bridge pitch bend
        this.subBassSynth.detune.cancelScheduledValues(Tone.now());
        this.subBassSynth.detune.rampTo(0, 0.3);
        // Close filter down to 80Hz, then sweep open
        this.subBassFilter.frequency.cancelScheduledValues(Tone.now());
        this.subBassFilter.frequency.setValueAtTime(80, Tone.now());
        const sweepDuration = BEAT_CONFIG.BEAT_MS * 8 / 1000; // 2 bars = 8 beats
        this.subBassFilter.frequency.rampTo(300, sweepDuration);
        // Trigger sustained sub-bass drone on G1
        this.subBassSynth.triggerRelease();
        setTimeout(() => {
          if (this.subBassSynth && this.droneActive) {
            this.subBassSynth.triggerAttack('G1');
          }
        }, 10);
        this.breakdownSubBassActive = true;
      }

      // this.stringGain?.gain.rampTo(Tone.dbToGain(-30), 0.5);
    }
  }

  /**
   * Start sub-bass intro Dorian walk (bars 0-3).
   * 8 ascending notes G0-G1, one every 2 beats (half-bar), with filter opening.
   */
  private startSubBassIntro(): void {
    if (!this.subBassSynth || !this.subBassFilter || !this.sequencer) return;

    this.introSubBassActive = true;
    this.introStepIndex = 0;
    this.introSnarlFired = false;

    // Prominent intro volume (-12dB, not the usual -24dB background level)
    this.subBassGain?.gain.cancelScheduledValues(Tone.now());
    const barMs = BEAT_CONFIG.BEAT_MS * 4;
    this.subBassGain?.gain.rampTo(Tone.dbToGain(-12), barMs / 1000);

    // Filter sweep: closed at 40Hz, opens to 300Hz over 4 bars (~9.4s)
    this.subBassFilter.frequency.cancelScheduledValues(Tone.now());
    this.subBassFilter.frequency.setValueAtTime(40, Tone.now());
    const sweepDuration = barMs * 4 / 1000; // 4 bars
    this.subBassFilter.frequency.rampTo(300, sweepDuration);

    // Trigger first note (G0, transposed by user key)
    const transpose = this.sequencer.getTranspose();
    const firstNote = transposeNote(G_DORIAN_WALK[0]!, transpose);
    this.subBassSynth.triggerRelease();
    setTimeout(() => {
      if (this.subBassSynth && this.droneActive) {
        this.subBassSynth.triggerAttack(firstNote);
      }
    }, 10);
  }

  /**
   * Per-frame update for sub-bass intro walk.
   * Advances through G Dorian scale during bars 0-3, fires snarl at bar 2.
   */
  private updateSubBassIntro(): void {
    if (!this.introSubBassActive || !this.sequencer || !this.subBassSynth) return;

    const { bar, beat } = this.sequencer.getBarPosition();

    // End intro at bar 4 (or later if we wrapped past): ramp volume back down
    if (bar >= 4 && bar < 88) {
      this.introSubBassActive = false;
      this.subBassGain?.gain.cancelScheduledValues(Tone.now());
      this.subBassGain?.gain.rampTo(Tone.dbToGain(-24), 0.5);
      return;
    }

    // Calculate which step we're on (0-7 across bars 0-3, 2 steps per bar)
    const step = (bar * 2) + (beat >= 2 ? 1 : 0);
    if (step > 7) return; // Safety: only 8 notes in the walk

    // Advance to next note when step changes
    if (step > this.introStepIndex) {
      this.introStepIndex = step;
      const transpose = this.sequencer.getTranspose();
      const note = transposeNote(G_DORIAN_WALK[step]!, transpose);
      this.subBassSynth.triggerRelease();
      setTimeout(() => {
        if (this.subBassSynth && this.droneActive) {
          this.subBassSynth.triggerAttack(note);
        }
      }, 10);
    }

    // Fire single snarl at bar 2
    if (bar >= 2 && !this.introSnarlFired) {
      this.triggerIntroSnarl();
    }
  }

  /**
   * Single snarl at bar 2: triangle-wave filter sweep on sub-bass.
   * Rise 200-800Hz, fall 800-200Hz, settle to 300Hz target.
   * Matches existing bass LFO character (0.4Hz, 200-800Hz range).
   */
  private triggerIntroSnarl(): void {
    if (!this.subBassFilter || this.introSnarlFired) return;
    this.introSnarlFired = true;

    // Cancel the ongoing linear filter sweep from startSubBassIntro
    this.subBassFilter.frequency.cancelScheduledValues(Tone.now());

    // Manual triangle-wave automation: rise → fall → settle
    const now = Tone.now();
    this.subBassFilter.frequency.setValueAtTime(200, now);
    this.subBassFilter.frequency.linearRampToValueAtTime(800, now + 1.25);  // Rise
    this.subBassFilter.frequency.linearRampToValueAtTime(200, now + 2.5);   // Fall
    this.subBassFilter.frequency.linearRampToValueAtTime(300, now + 4.5);   // Settle before bar 4
  }

  /**
   * Update bass synth based on current bar position.
   * Two modes: sustained (main loop) and pulsed "dmmm dmmm" (bridge bars 76+).
   * Bars 84-87 get double pulse rate: 4 eighth notes instead of 2.
   */
  private updateBass(): void {
    if (!this.bassSynth || !this.sequencer) return;

    const { bar, beat } = this.sequencer.getBarPosition();

    // Determine if bass should be active this bar
    const bassActive = this.isBassActiveForBar(bar);

    // Bar change: trigger new bass note or release
    if (bar !== this.lastBassBar) {
      this.lastBassBar = bar;
      this.bassNextPulseIndex = 0;

      if (!bassActive) {
        this.bassSynth.triggerRelease();
        return;
      }

      const root = this.sequencer.getCurrentBassRoot();

      if (this.currentSection === 'main') {
        // Sustained: hold the note for the whole bar
        this.bassSynth.triggerRelease();
        setTimeout(() => {
          if (this.bassSynth && this.droneActive) {
            this.bassSynth.triggerAttack(root);
          }
        }, 10);
      } else if (this.isBridgePulsedBar(bar)) {
        // Pulsed: first "dmmm" on beat 1
        this.bassSynth.triggerAttackRelease(root, BEAT_CONFIG.EIGHTH_MS / 1000);
        this.bassNextPulseIndex = 1;
      } else if (this.currentSection === 'breakdown') {
        // Breakdown: sustained bass with detuned pitch + closing filter
        this.bassSynth.triggerRelease();
        setTimeout(() => {
          if (this.bassSynth && this.droneActive) {
            this.bassSynth.triggerAttack(root);
          }
        }, 10);
      }
    }

    // Pulsed mode: fire additional pulses based on beat position
    if (this.isBridgePulsedBar(bar) && bassActive) {
      const root = this.sequencer.getCurrentBassRoot();
      const isFinaleBar = bar >= 84 && bar <= 87; // B4: double pulse rate

      if (isFinaleBar) {
        // 4 pulses per bar: beats 0, 0.5, 2.0, 2.5 (1 + 1& + 3 + 3&)
        const pulseBeatTimes = [0, 0.5, 2.0, 2.5];
        if (this.bassNextPulseIndex < pulseBeatTimes.length) {
          const nextBeat = pulseBeatTimes[this.bassNextPulseIndex]!;
          if (beat >= nextBeat) {
            // Skip pulse 0 (already fired on bar change)
            if (this.bassNextPulseIndex > 0) {
              this.bassSynth.triggerAttackRelease(root, BEAT_CONFIG.EIGHTH_MS / 1000);
            }
            this.bassNextPulseIndex++;
          }
        }

        // Bars 86-87: pitch bend sweep upward into breakdown transition
        // Ramps detune from 0 to +400 cents over 2 bars (~4.7s at 102 BPM)
        if (bar === 86 && beat < 0.1 && this.bassSynth.detune.value < 10) {
          this.bassSynth.detune.rampTo(400, BEAT_CONFIG.BEAT_MS * 8 / 1000);
          if (this.subBassSynth) {
            this.subBassSynth.detune.rampTo(400, BEAT_CONFIG.BEAT_MS * 8 / 1000);
          }
        }
      } else {
        // Normal pulsed: 2 pulses per bar (beats 0 and 0.5)
        if (this.bassNextPulseIndex === 1 && beat >= 0.5) {
          this.bassSynth.triggerAttackRelease(root, BEAT_CONFIG.EIGHTH_MS / 1000);
          this.bassNextPulseIndex = 2; // Done
        }
      }
    }
  }

  /** Bars where bass is active (returns false for silent bars) */
  private isBassActiveForBar(bar: number): boolean {
    // Bars 0-3: silent (intro, no bass yet) — B2: delayed from bar 2 to bar 4
    if (bar <= 3) return false;
    // Bars 4-63: sustained bass (main loop)
    if (bar >= 4 && bar <= 63) return true;
    // Bars 64-75: silent (bass drops out with drone at bridge start)
    if (bar >= 64 && bar <= 75) return false;
    // Bars 76-87: pulsed bass (bridge re-entry)
    if (bar >= 76 && bar <= 87) return true;
    // Bars 88-89: bass sustains through breakdown with filter sweep
    return true;
  }

  /** Whether this bar uses pulsed "dmm dmm" bass articulation */
  private isBridgePulsedBar(bar: number): boolean {
    return bar >= 76 && bar <= 87;
  }

  /**
   * C1: Gate bass LFO snarl on/off based on bar parity.
   * Active every other measure (2-bar cycle) for subtle filter wobble.
   */
  private updateBassLfo(): void {
    if (!this.bassLfo || !this.bassFilter || !this.sequencer) return;

    const { bar } = this.sequencer.getBarPosition();
    if (bar === this.lastLfoBar) return; // Only check on bar change
    this.lastLfoBar = bar;

    // Active on even measures (bars 0-1, 4-5, 8-9, etc.)
    const measureIndex = Math.floor(bar / 2);
    const shouldBeActive = measureIndex % 2 === 0 && this.currentSection !== 'breakdown';

    if (shouldBeActive && this.bassLfo.state !== 'started') {
      this.bassLfo.start();
    } else if (!shouldBeActive && this.bassLfo.state === 'started') {
      this.bassLfo.stop();
      // Reset filter to open when LFO is off (skip during breakdown — filter sweep active)
      if (this.currentSection !== 'breakdown') {
        this.bassFilter?.frequency.rampTo(20000, 0.1);
      }
    }
  }

  /**
   * C4 + D: Update sub-bass and string lead based on bar position.
   * Sub-bass mirrors bass notes 1 octave lower.
   * String lead follows chord progression — plays root + 3rd of current chord,
   * transposed up to string register. Changes whenever the chord changes.
   */
  private updateStringLead(): void {
    if (!this.sequencer) return;

    const { bar } = this.sequencer.getBarPosition();
    if (bar === this.lastStringBar) return; // Only act on bar change
    this.lastStringBar = bar;

    // C4: Sub-bass mirrors bass root 1 octave lower (skip during intro walk)
    if (this.subBassSynth && this.isBassActiveForBar(bar) && !this.introSubBassActive) {
      const root = this.sequencer.getCurrentBassRoot();
      const subRoot = this.transposeOctave(root, -1);

      if (this.currentSection === 'main') {
        // Sustained sub-bass
        this.subBassSynth.triggerRelease();
        setTimeout(() => {
          if (this.subBassSynth && this.droneActive) {
            this.subBassSynth.triggerAttack(subRoot);
          }
        }, 10);
      } else if (this.isBridgePulsedBar(bar)) {
        // Pulsed sub-bass matches bass pulse
        this.subBassSynth.triggerAttackRelease(subRoot, BEAT_CONFIG.EIGHTH_MS / 1000);
      }
    } else if (this.subBassSynth && !this.breakdownSubBassActive && !this.introSubBassActive) {
      // Release sub-bass on silent bars (but not during breakdown sweep or intro walk)
      this.subBassSynth.triggerRelease();
    }

    // D: String lead — DISABLED pending volume/melody tuning
    // if (!this.stringSynth) return;
    // const chord = this.sequencer.getCurrentChord();
    // const melodyNote = this.transposeOctave(chord.notes[0]!, STRING_OCTAVE_OFFSET);
    // const harmonyNote = this.transposeOctave(chord.notes[1]!, STRING_OCTAVE_OFFSET);
    // this.stringSynth.releaseAll();
    // setTimeout(() => {
    //   if (this.stringSynth && this.droneActive) {
    //     this.stringSynth.triggerAttack([melodyNote, harmonyNote]);
    //   }
    // }, 20);
    // if (this.currentSection === 'bridge' && bar >= 76) {
    //   this.stringGain?.gain.rampTo(Tone.dbToGain(-28), 2);
    // }
  }

  /** Transpose a note name up/down by N octaves (e.g. "G3" + 1 → "G4") */
  private transposeOctave(note: string, octaves: number): string {
    const match = note.match(/^([A-G]#?b?)(\d+)$/);
    if (!match) return note;
    const [, pitch, octStr] = match;
    const newOctave = Math.max(0, parseInt(octStr!, 10) + octaves);
    return `${pitch}${newOctave}`;
  }

  // Volume setters for E1 UI wiring

  /** Set bass volume in decibels */
  setBassVolume(db: number): void {
    this.targetBassVolumeDb = db;
    this.bassGain?.gain.rampTo(Tone.dbToGain(db), 0.1);
  }

  /** Get user's bass volume target in decibels */
  getBassVolume(): number {
    return this.targetBassVolumeDb;
  }

  /** Set collision sound volume in decibels */
  setCollisionVolume(db: number): void {
    this.targetCollisionVolumeDb = db;
    this.ensureInit();
    if (this.gain) {
      this.gain.gain.rampTo(Tone.dbToGain(db), 0.1);
    }
  }

  /** Get user's collision volume target in decibels */
  getCollisionVolume(): number {
    return this.targetCollisionVolumeDb;
  }

  /** Get user's drone volume target in decibels */
  getDroneVolume(): number {
    return this.targetDroneVolumeDb;
  }

  /** Set string lead volume in decibels */
  setStringVolume(db: number): void {
    this.stringGain?.gain.rampTo(Tone.dbToGain(db), 0.1);
  }

  /** Set transpose offset in semitones (delegates to ArpeggioSequencer) */
  setTranspose(semitones: number): void {
    this.sequencer?.setTranspose(semitones);
  }

  /** Get current transpose offset in semitones */
  getTranspose(): number {
    return this.sequencer?.getTranspose() ?? 0;
  }
}
