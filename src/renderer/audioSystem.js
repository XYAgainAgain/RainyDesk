/**
 * RainyDesk Audio System
 * Procedural rain audio generation using tone.js
 * Implements "Multi-Layered Noise" approach for realistic rain sound
 */

import * as Tone from 'https://cdn.skypack.dev/tone@15.1.22';

class RainAudioSystem {
  constructor() {
    // Audio layers
    this.splashNoise = null; // High freq (white noise)
    this.dropNoise = null;   // Mid freq (pink noise)
    this.rumbleNoise = null; // Low freq (brown noise)
    this.windNoise = null;   // Separate wind layer

    // Filters
    this.splashFilter = null;
    this.dropFilter = null;
    this.rumbleFilter = null;
    this.windFilter = null;

    // Effects chain
    this.eq3 = null;
    this.reverb = null;
    this.panner3d = null;
    this.masterVolume = null;

    // Audio state
    this.isInitialized = false;
    this.isPlaying = false;

    // Configuration
    this.config = {
      volume: 0.5,
      intensity: 0.5,
      wind: 0,
      eqLow: 0,
      eqMid: 0,
      eqHigh: 0,
      reverbWetness: 0.3,
      spatialX: 0,
      spatialY: 1,
      spatialZ: 0
    };
  }

  /**
   * Initialize the audio system
   * Must be called after user interaction due to browser autoplay policies
   */
  async init() {
    if (this.isInitialized) return;

    try {
      // Ensure Tone.js context is ready
      await Tone.start();
      console.log('Tone.js audio context started');

      // Create master volume control
      this.masterVolume = new Tone.Volume(0).toDestination();

      // Create 3D panner for spatial audio
      this.panner3d = new Tone.Panner3D({
        panningModel: 'HRTF',
        positionX: this.config.spatialX,
        positionY: this.config.spatialY,
        positionZ: this.config.spatialZ
      }).connect(this.masterVolume);

      // Create reverb for ambient space
      this.reverb = new Tone.Reverb({
        decay: 1.5,
        wet: this.config.reverbWetness
      }).connect(this.panner3d);

      // Wait for reverb to generate impulse response
      await this.reverb.generate();

      // Create 3-band EQ
      this.eq3 = new Tone.EQ3({
        low: this.config.eqLow,
        mid: this.config.eqMid,
        high: this.config.eqHigh
      }).connect(this.reverb);

      // --- Layer 1: Splash (High Frequency) ---
      // White noise for the crisp, wet impact sounds
      this.splashNoise = new Tone.Noise('white');
      this.splashFilter = new Tone.Filter({
        type: 'highpass',
        frequency: 3000,
        Q: 1
      }).connect(this.eq3);
      this.splashNoise.connect(this.splashFilter);
      this.splashNoise.volume.value = -60; // Start silent

      // --- Layer 2: Drops (Mid Frequency) ---
      // Pink noise for the main body of the rain sound
      this.dropNoise = new Tone.Noise('pink');
      this.dropFilter = new Tone.Filter({
        type: 'bandpass',
        frequency: 1200,
        Q: 1
      }).connect(this.eq3);
      this.dropNoise.connect(this.dropFilter);
      this.dropNoise.volume.value = -60; // Start silent

      // --- Layer 3: Rumble (Low Frequency) ---
      // Brown noise for the ambient roar/background
      this.rumbleNoise = new Tone.Noise('brown');
      this.rumbleFilter = new Tone.Filter({
        type: 'lowpass',
        frequency: 800,
        Q: 0.5
      }).connect(this.eq3);
      this.rumbleNoise.connect(this.rumbleFilter);
      this.rumbleNoise.volume.value = -60; // Start silent

      // --- Wind Layer ---
      this.windNoise = new Tone.Noise('brown');
      this.windFilter = new Tone.Filter({
        type: 'lowpass',
        frequency: 300,
        Q: 0.5
      }).connect(this.eq3);
      this.windNoise.connect(this.windFilter);
      this.windNoise.volume.value = -60; // Start silent

      this.isInitialized = true;
      console.log('Audio system initialized (Multi-Layer Mode)');
    } catch (error) {
      console.error('Failed to initialize audio system:', error);
      throw error;
    }
  }

  /**
   * Start playing rain audio
   */
  async start() {
    if (!this.isInitialized) {
      await this.init();
    }

    if (!this.isPlaying) {
      this.splashNoise.start();
      this.dropNoise.start();
      this.rumbleNoise.start();
      this.windNoise.start();
      this.isPlaying = true;
      console.log('Rain audio started');
      
      // Apply current settings
      this.setIntensity(this.config.intensity * 100);
      this.setVolume(this.config.volume * 100);
    }
  }

  /**
   * Stop playing rain audio
   */
  stop() {
    if (this.isPlaying) {
      this.splashNoise.stop();
      this.dropNoise.stop();
      this.rumbleNoise.stop();
      this.windNoise.stop();
      this.isPlaying = false;
      console.log('Rain audio stopped');
    }
  }

  /**
   * Set master volume (0-100)
   */
  setVolume(volume) {
    this.config.volume = volume / 100;
    if (this.masterVolume) {
      // Map 0-100 to -60dB to 0dB
      const db = volume <= 0 ? -Infinity : Tone.gainToDb(this.config.volume);
      this.masterVolume.volume.rampTo(db, 0.1);
    }
  }

  /**
   * Set rain intensity (0-100)
   * Adjusts the mix of the three layers to simulate light->heavy rain
   */
  setIntensity(intensity) {
    this.config.intensity = intensity / 100;
    const i = this.config.intensity; // 0.0 to 1.0

    if (this.isInitialized) {
      // 1. Splash Layer (Highs): Ramps up quickly, stays consistent
      // Range: -60dB to -20dB
      const splashDb = -60 + (i * 40); 
      this.splashNoise.volume.rampTo(splashDb, 0.2);

      // 2. Drop Layer (Mids): Main body, scales linearly
      // Range: -50dB to -15dB
      const dropDb = -50 + (i * 35);
      this.dropNoise.volume.rampTo(dropDb, 0.2);

      // 3. Rumble Layer (Lows): Only audible in heavier rain
      // Range: -Infinity until 20%, then ramps to -10dB
      let rumbleDb = -Infinity;
      if (i > 0.2) {
        rumbleDb = -40 + ((i - 0.2) / 0.8) * 30;
      }
      this.rumbleNoise.volume.rampTo(rumbleDb, 0.2);
      
      // Adjust filters slightly based on intensity
      // Heavier rain = wider bandwidths
      this.dropFilter.frequency.rampTo(1000 + (i * 500), 0.5);
    }
  }

  /**
   * Set 3-band EQ values (-12 to +12 dB)
   */
  setEQ(low, mid, high) {
    this.config.eqLow = low;
    this.config.eqMid = mid;
    this.config.eqHigh = high;

    if (this.eq3) {
      this.eq3.low.value = low;
      this.eq3.mid.value = mid;
      this.eq3.high.value = high;
    }
  }

  /**
   * Set reverb wetness (0-100)
   */
  setReverb(wetness) {
    this.config.reverbWetness = wetness / 100;
    if (this.reverb) {
      this.reverb.wet.rampTo(this.config.reverbWetness, 0.3);
    }
  }

  /**
   * Set 3D spatial position (-1 to 1 for each axis)
   * x: left(-1) to right(1)
   * y: below(-1) to above(1)
   * z: behind(-1) to front(1)
   */
  setSpatialPosition(x, y, z) {
    this.config.spatialX = x;
    this.config.spatialY = y;
    this.config.spatialZ = z;

    if (this.panner3d) {
      this.panner3d.positionX.rampTo(x, 0.5);
      this.panner3d.positionY.rampTo(y, 0.5);
      this.panner3d.positionZ.rampTo(z, 0.5);
    }
  }

  /**
   * Set wind intensity (0-100)
   */
  setWind(intensity) {
    this.config.wind = intensity / 100;
    if (this.windNoise) {
      const windDb = intensity === 0 ? -Infinity : -30 + (intensity / 100 * 20);
      this.windNoise.volume.rampTo(windDb, 0.5);
    }
  }

  /**
   * Clean up audio resources
   */
  dispose() {
    this.stop();

    if (this.splashNoise) this.splashNoise.dispose();
    if (this.dropNoise) this.dropNoise.dispose();
    if (this.rumbleNoise) this.rumbleNoise.dispose();
    if (this.windNoise) this.windNoise.dispose();
    
    if (this.splashFilter) this.splashFilter.dispose();
    if (this.dropFilter) this.dropFilter.dispose();
    if (this.rumbleFilter) this.rumbleFilter.dispose();
    if (this.windFilter) this.windFilter.dispose();

    if (this.eq3) this.eq3.dispose();
    if (this.reverb) this.reverb.dispose();
    if (this.panner3d) this.panner3d.dispose();
    if (this.masterVolume) this.masterVolume.dispose();

    this.isInitialized = false;
    console.log('Audio system disposed');
  }
}

// Create singleton instance
const audioSystem = new RainAudioSystem();

export default audioSystem;
