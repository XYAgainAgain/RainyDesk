/**
 * ArpeggioSequencer - Chord progression tracker for Matrix Mode
 *
 * Pure data + timing module. Tracks position within a 90-bar cycle
 * based on "Clubbed to Death" (Kurayamino Variation) in G Dorian at 102 BPM.
 * Provides the next harmonically correct note name for GlitchSynth collision triggers.
 *
 * No Tone.js dependency - this is just data and math.
 * See .dev/ARPEGGIO-SEQUENCER-DESIGN.md for full spec.
 */

// Types

export type Section = 'main' | 'bridge' | 'breakdown';
export type SectionChangeCallback = (section: Section, bar: number) => void;

export interface ChordData {
  name: string;       // "Gm", "D", etc.
  root: string;       // Bass note with octave, e.g. "G1"
  notes: string[];    // Triad (3) or arpeggio (4 or 8) note names
}

interface BridgeBar {
  chord: ChordData;
  splitChord?: ChordData;  // Present on bars 84-86 (chord changes at beat 3)
}

// Timing constants (102 BPM)

const BPM = 102;
const BEAT_MS = 60000 / BPM;             // ~588.24ms per quarter note
const BAR_MS = BEAT_MS * 4;              // ~2352.94ms per bar
const TOTAL_BARS = 90;
const CYCLE_MS = BAR_MS * TOTAL_BARS;    // ~211,764.7ms (~3:32)

// Chord data

// Main Loop: 4 chords cycling every 4 bars (bars 0-63)
// Ascending root motion (G -> A -> Bb -> C) with 3-note triads
const MAIN_CHORDS: ChordData[] = [
  { name: 'Gm', root: 'G1',  notes: ['G3', 'Bb3', 'D4'] },
  { name: 'Am', root: 'A1',  notes: ['A3', 'C4', 'E4'] },
  { name: 'Bb', root: 'Bb1', notes: ['Bb3', 'D4', 'F4'] },
  { name: 'C',  root: 'C2',  notes: ['C4', 'E4', 'G4'] },
];

// Bridge Theme: 8 chords (bars 64-71, repeats 72-79)
// 8-note up-and-back arpeggio: root -> 3rd -> 5th -> 8ve -> 10th -> 8ve -> 5th -> 3rd
const BRIDGE_THEME: ChordData[] = [
  { name: 'Gm', root: 'G1',  notes: ['G3', 'Bb3', 'D4', 'G4', 'Bb4', 'G4', 'D4', 'Bb3'] },
  { name: 'D',  root: 'D1',  notes: ['F#3', 'A3', 'D4', 'F#4', 'A4', 'F#4', 'D4', 'A3'] },
  { name: 'Gm', root: 'G1',  notes: ['G3', 'Bb3', 'D4', 'G4', 'Bb4', 'G4', 'D4', 'Bb3'] },
  { name: 'C',  root: 'C2',  notes: ['G3', 'C4', 'E4', 'G4', 'C5', 'G4', 'E4', 'C4'] },
  { name: 'Gm', root: 'G1',  notes: ['G3', 'Bb3', 'D4', 'G4', 'Bb4', 'G4', 'D4', 'Bb3'] },
  { name: 'Eb', root: 'Eb1', notes: ['G3', 'Bb3', 'Eb4', 'G4', 'Bb4', 'G4', 'Eb4', 'Bb3'] },
  { name: 'Bb', root: 'Bb1', notes: ['F3', 'Bb3', 'D4', 'F4', 'Bb4', 'F4', 'D4', 'Bb3'] },
  { name: 'D',  root: 'D1',  notes: ['F#3', 'A3', 'D4', 'F#4', 'A4', 'F#4', 'D4', 'A3'] },
];

// Bridge Variation: bars 80-87
// 80-83: same as theme steps 0-3
// 84-86: split-bar (two chords per bar, 4-note ascending arpeggios each)
// 87: full-bar Eb (8-note pattern)
const BRIDGE_VARIATION: BridgeBar[] = [
  // 80-83: identical to theme steps 0-3
  { chord: BRIDGE_THEME[0]! },
  { chord: BRIDGE_THEME[1]! },
  { chord: BRIDGE_THEME[2]! },
  { chord: BRIDGE_THEME[3]! },
  // 84: Gm -> D (split at beat 3)
  {
    chord:      { name: 'Gm', root: 'G1', notes: ['G3', 'Bb3', 'D4', 'G4'] },
    splitChord: { name: 'D',  root: 'D1', notes: ['F#3', 'A3', 'D4', 'F#4'] },
  },
  // 85: Gm -> C (split at beat 3)
  {
    chord:      { name: 'Gm', root: 'G1', notes: ['G3', 'Bb3', 'D4', 'G4'] },
    splitChord: { name: 'C',  root: 'C2', notes: ['G3', 'C4', 'E4', 'G4'] },
  },
  // 86: Gm -> F (split at beat 3)
  {
    chord:      { name: 'Gm', root: 'G1', notes: ['G3', 'Bb3', 'D4', 'G4'] },
    splitChord: { name: 'F',  root: 'F1', notes: ['A3', 'C4', 'F4', 'A4'] },
  },
  // 87: full-bar Eb (8-note up-and-back)
  { chord: { name: 'Eb', root: 'Eb1', notes: ['G3', 'Bb3', 'Eb4', 'G4', 'Bb4', 'G4', 'Eb4', 'Bb3'] } },
];

// Note transposition helper

// Chromatic note names (sharps and flats both mapped)
const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// Map note name (with accidentals) to semitone offset (0–11)
const NOTE_TO_SEMITONE: Record<string, number> = {
  'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4, 'Fb': 4,
  'E#': 5, 'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8, 'Ab': 8,
  'A': 9, 'A#': 10, 'Bb': 10, 'B': 11, 'Cb': 11,
};

/**
 * Transpose a note name (e.g. "G3", "Bb4", "F#3") by semitones.
 * Returns the transposed note name (e.g. transposeNote("G3", 2) -> "A3").
 */
export function transposeNote(note: string, semitones: number): string {
  if (semitones === 0) return note;

  // Parse note: letter(s) + octave
  const match = note.match(/^([A-G][b#]?)(-?\d+)$/);
  if (!match) return note; // Unparseable, return as-is

  const noteName = match[1]!;
  const octave = parseInt(match[2]!, 10);

  const baseSemitone = NOTE_TO_SEMITONE[noteName];
  if (baseSemitone === undefined) return note;

  // Total semitone position from C0
  const totalSemitones = (octave * 12) + baseSemitone + semitones;
  const newOctave = Math.floor(totalSemitones / 12);
  const newNoteIdx = ((totalSemitones % 12) + 12) % 12; // Handle negative

  return (NOTE_NAMES[newNoteIdx] ?? 'C') + newOctave;
}

// Sequencer class

export class ArpeggioSequencer {
  /** Timestamp (performance.now) when the drone started - beat reference */
  private beatOriginTime: number;

  /** Current position within the 90-bar cycle */
  private currentBar = 0;
  /** Current beat within the bar (0-3, fractional) */
  private currentBeat = 0;
  /** Current section */
  private currentSection: Section = 'main';

  /** Previous bar (for change detection) */
  private lastBar = -1;
  /** Previous beat (for split-bar crossing detection) */
  private lastBeat = 0;
  /** Steps through chord notes, resets on bar/chord change */
  private noteIndex = 0;

  /** Semitone transpose offset (0 = Matrix key of G, applied to all returned notes) */
  private transposeSemitones = 0;

  /** Callback fired when section changes */
  onSectionChange: SectionChangeCallback | null = null;

  constructor(beatOriginTime: number) {
    this.beatOriginTime = beatOriginTime;
  }

  /**
   * Set transpose offset in semitones. 0 = original key (G Dorian).
   * All notes returned by getNextNote() and getCurrentBassRoot() are transposed.
   */
  setTranspose(semitones: number): void {
    this.transposeSemitones = semitones;
  }

  /** Get current transpose offset in semitones */
  getTranspose(): number {
    return this.transposeSemitones;
  }

  /**
   * Update timing state. Call every frame.
   * Detects bar changes, section boundaries, and split-bar chord transitions.
   */
  update(): void {
    const elapsed = performance.now() - this.beatOriginTime;

    // Wrap within 90-bar cycle
    const cyclePosition = ((elapsed % CYCLE_MS) + CYCLE_MS) % CYCLE_MS;

    this.currentBar = Math.floor(cyclePosition / BAR_MS);
    this.currentBeat = (cyclePosition % BAR_MS) / BEAT_MS;

    // Clamp bar to valid range (shouldn't exceed 89, but safety)
    if (this.currentBar >= TOTAL_BARS) {
      this.currentBar = 0;
    }

    // Detect bar change
    if (this.currentBar !== this.lastBar) {
      this.noteIndex = 0;

      // Check for section boundary
      const newSection = this.getSection(this.currentBar);
      if (newSection !== this.currentSection) {
        this.currentSection = newSection;
        this.onSectionChange?.(this.currentSection, this.currentBar);
      }

      this.lastBar = this.currentBar;
    }

    // Split-bar mid-bar chord change: reset noteIndex when beat crosses 2.0
    // Only applies to bars 84-86 which have splitChord
    if (this.currentBar >= 84 && this.currentBar <= 86) {
      const variationIdx = this.currentBar - 80;
      const bridgeBar = BRIDGE_VARIATION[variationIdx];
      if (bridgeBar?.splitChord) {
        // Detect crossing: lastBeat was <2.0, currentBeat is >=2.0
        if (this.lastBeat < 2.0 && this.currentBeat >= 2.0) {
          this.noteIndex = 0;
        }
      }
    }

    this.lastBeat = this.currentBeat;
  }

  /**
   * Get the current chord based on bar position.
   * Handles main loop cycling, bridge theme repeats, variation splits, and breakdown.
   */
  getCurrentChord(): ChordData {
    const bar = this.currentBar;

    // Main Loop: bars 0-63
    if (bar <= 63) {
      return MAIN_CHORDS[bar % 4]!;
    }

    // Bridge Theme first pass: bars 64-71
    if (bar >= 64 && bar <= 71) {
      return BRIDGE_THEME[bar - 64]!;
    }

    // Bridge Theme repeat: bars 72-79
    if (bar >= 72 && bar <= 79) {
      return BRIDGE_THEME[bar - 72]!;
    }

    // Bridge Variation: bars 80-87
    if (bar >= 80 && bar <= 87) {
      const variationIdx = bar - 80;
      const bridgeBar = BRIDGE_VARIATION[variationIdx]!;

      // Split-bar: if past beat 2 and there's a second chord, use it
      if (bridgeBar.splitChord && this.currentBeat >= 2.0) {
        return bridgeBar.splitChord;
      }
      return bridgeBar.chord;
    }

    // Breakdown: bars 88-89 (same chords as main loop steps 0-1)
    if (bar >= 88) {
      return MAIN_CHORDS[bar - 88]!;
    }

    // Fallback (shouldn't reach here)
    return MAIN_CHORDS[0]!;
  }

  /**
   * Get the next note in the current chord's sequence.
   * Increments noteIndex, wrapping around the chord's note array.
   * Called by GlitchSynth on each on-beat collision.
   * Applies transpose offset if set.
   */
  getNextNote(): string {
    const chord = this.getCurrentChord();
    const note = chord.notes[this.noteIndex % chord.notes.length]!;
    this.noteIndex++;
    return transposeNote(note, this.transposeSemitones);
  }

  /** Get the current chord's bass root note (e.g. "G1"), transposed if offset is set */
  getCurrentBassRoot(): string {
    return transposeNote(this.getCurrentChord().root, this.transposeSemitones);
  }

  /** Public accessor for current position info */
  getBarPosition(): { bar: number; beat: number; section: Section; chordName: string } {
    return {
      bar: this.currentBar,
      beat: this.currentBeat,
      section: this.currentSection,
      chordName: this.getCurrentChord().name,
    };
  }

  /** Determine which section a bar belongs to */
  private getSection(bar: number): Section {
    if (bar <= 63) return 'main';
    if (bar <= 87) return 'bridge';
    return 'breakdown';
  }
}
