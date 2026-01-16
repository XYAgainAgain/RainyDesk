/**
 * RainyDesk Audio System
 * Procedural rain audio generation using tone.js
 * Implements "Multi-Layered Noise" + "Rainscapes" + "Physical Impact Synthesis"
 */

import * as Tone from 'https://cdn.skypack.dev/tone@15.1.22';

/**
 * Rainscape Presets
 * Defines the sonic character of different surfaces
 */
const RAINSCAPES = {
  glass_window: {
    id: 'glass_window',
    name: 'Glass Window',
    description: 'Medium rain hitting a glass pane',
    layers: {
      splash: { type: 'highpass', freq: 2000, Q: 1, gain: 0 },    // Lower splash freq
      drop:   { type: 'bandpass', freq: 800,  Q: 1, gain: 0 },    // Lower body freq
      rumble: { type: 'lowpass',  freq: 800,  Q: 0.5, gain: -5 }, 
      wind:   { type: 'lowpass',  freq: 300,  Q: 0.5, gain: 0 }   
    },
    reverb: { decay: 0.5, wetness: 0.2 }, 
    lfo: { frequency: 0.2, depth: 2 } 
  },
  tin_roof: {
    id: 'tin_roof',
    name: 'Tin Roof',
    description: 'Sharp, metallic, pinging rain',
    layers: {
      splash: { type: 'highpass', freq: 4500, Q: 4, gain: 5 },    // Very sharp
      drop:   { type: 'bandpass', freq: 2500, Q: 5, gain: 3 },    // Resonant pings
      rumble: { type: 'lowpass',  freq: 600,  Q: 0.5, gain: -2 }, // Hollow rumble
      wind:   { type: 'lowpass',  freq: 400,  Q: 0.5, gain: 0 }
    },
    reverb: { decay: 0.8, wetness: 0.1 }, 
    lfo: { frequency: 0.5, depth: 1 }
  },
  concrete: {
    id: 'concrete',
    name: 'Concrete',
    description: 'Dull, thudding rain on pavement',
    layers: {
      splash: { type: 'highpass', freq: 1000, Q: 0.5, gain: -5 }, // Muted
      drop:   { type: 'bandpass', freq: 800,  Q: 0.5, gain: 2 },  // Thuds
      rumble: { type: 'lowpass',  freq: 400,  Q: 1, gain: 5 },    // Heavy low end
      wind:   { type: 'lowpass',  freq: 200,  Q: 0.5, gain: 0 }
    },
    reverb: { decay: 2.5, wetness: 0.4 }, 
    lfo: { frequency: 0.1, depth: 3 }
  },
  leaves: {
    id: 'leaves',
    name: 'Forest Leaves',
    description: 'Soft, white-noise like diffusion',
    layers: {
      splash: { type: 'highpass', freq: 5000, Q: 0.5, gain: -2 }, // Soft sizzle
      drop:   { type: 'bandpass', freq: 2000, Q: 0.5, gain: 0 },  // Diffused drops
      rumble: { type: 'lowpass',  freq: 500,  Q: 0.5, gain: 0 },  // Forest floor
      wind:   { type: 'lowpass',  freq: 800,  Q: 0.5, gain: 5 }   // Leaf rustle
    },
    reverb: { decay: 3.0, wetness: 0.5 }, 
    lfo: { frequency: 0.8, depth: 4 }
  }
};

class RainAudioSystem {
  constructor() {
    // Audio layers
    this.splashNoise = null;
    this.dropNoise = null;
    this.rumbleNoise = null;
    this.windNoise = null;
    
    // Impact Synthesis (Hybrid Model)
    this.bubbleSynth = null; // Resonant bubble pinch-off
    this.impactSynth = null; // Rigid surface impact "click"

    // Filters
    this.splashFilter = null;
    this.dropFilter = null;
    this.rumbleFilter = null;
    this.windFilter = null;

    // Modulation
    this.rainLFO = null;    // Modulates rain intensity (pulsing)
    this.windPanner = null; // AutoPanner for wind

    // Effects chain
    this.eq3 = null;
    this.reverb = null;
    this.panner3d = null;
    this.masterVolume = null;

    // Audio state
    this.isInitialized = false;
    this.isPlaying = false;
    this.currentRainscape = RAINSCAPES.glass_window; // Default
    this.lastImpactTime = 0; // For throttling
    this.onRainscapeChange = null; // Callback for UI updates
    this.manualMode = false; // If true, disables automated mixing

    // Configuration
    this.config = {
      volume: 0.5,
      intensity: 0.5,
      wind: 0,
      dropSize: 0.5, 
      eqLow: 0,
      eqMid: 0,
      eqHigh: 0,
      reverbWetness: 0.3,
      spatialX: 0,
      spatialY: 1,
      spatialZ: 0
    };
  }

  async init() {
    if (this.isInitialized) return;

    try {
      await Tone.start();
      console.log('Tone.js audio context started');

      this.masterVolume = new Tone.Volume(0).toDestination();
      
      this.panner3d = new Tone.Panner3D({
        panningModel: 'HRTF',
        positionX: this.config.spatialX,
        positionY: this.config.spatialY,
        positionZ: this.config.spatialZ
      }).connect(this.masterVolume);

      this.reverb = new Tone.Reverb({
        decay: 1.5,
        wet: this.config.reverbWetness
      }).connect(this.panner3d);
      await this.reverb.generate();

      this.eq3 = new Tone.EQ3({
        low: this.config.eqLow,
        mid: this.config.eqMid,
        high: this.config.eqHigh
      }).connect(this.reverb);

      this.rainLFO = new Tone.LFO({
        frequency: 0.2,
        min: -2, 
        max: 2
      }).start();

      this.windPanner = new Tone.AutoPanner({
        frequency: 0.1,
        depth: 0.6,
        type: 'sine'
      }).connect(this.eq3).start();

      // Layers
      this.splashNoise = new Tone.Noise('white');
      this.splashFilter = new Tone.Filter().connect(this.eq3);
      this.splashNoise.connect(this.splashFilter);
      this.splashNoise.volume.value = -60;

      this.dropNoise = new Tone.Noise('pink');
      this.dropFilter = new Tone.Filter().connect(this.eq3);
      this.dropNoise.connect(this.dropFilter);
      this.dropNoise.volume.value = -60;
      
      this.rumbleNoise = new Tone.Noise('brown');
      this.rumbleFilter = new Tone.Filter().connect(this.eq3);
      this.rumbleNoise.connect(this.rumbleFilter);
      this.rumbleNoise.volume.value = -60;

      this.rainLFO.connect(this.dropNoise.volume);
      this.rainLFO.connect(this.rumbleNoise.volume);

      this.windNoise = new Tone.Noise('brown');
      this.windFilter = new Tone.Filter().connect(this.windPanner);
      this.windNoise.connect(this.windFilter);
      this.windNoise.volume.value = -60;

      // Synths
      this.bubbleSynth = new Tone.Synth({
        oscillator: { type: "sine" },
        envelope: { attack: 0.005, decay: 0.1, sustain: 0, release: 0.1 },
        volume: -8 
      }).connect(this.eq3);

      this.impactSynth = new Tone.NoiseSynth({
        noise: { type: "white" },
        envelope: { attack: 0.001, decay: 0.05, sustain: 0 },
        volume: -5 
      }).connect(this.eq3);

      this.loadRainscape('glass_window');
      this.isInitialized = true;
      console.log('Audio system initialized');
    } catch (error) {
      console.error('Failed to initialize audio system:', error);
      throw error;
    }
  }

  triggerImpact(mass, velocityScale = 1.0) {
    if (!this.isInitialized || !this.isPlaying) return;

    const now = Tone.now();
    if (now - this.lastImpactTime < 0.02) return;
    this.lastImpactTime = now;

    const radius_mm = 1.0 + (mass * 0.5); 
    let freq = (3260 / (0.6 * radius_mm)) * (window.rainPitchScale || 0.25);
    freq = Math.max(200, Math.min(4000, freq));

    const velFactor = Math.max(0.1, Math.min(1.0, velocityScale));
    
    this.bubbleSynth.triggerAttackRelease(freq, "32n", now, velFactor);
    if (radius_mm > 1.0 || velFactor > 0.5) {
      this.impactSynth.triggerAttackRelease("32n", now, velFactor * 0.8);
    }
  }

  loadRainscape(id) {
    if (!RAINSCAPES[id]) id = 'glass_window';
    this.currentRainscape = RAINSCAPES[id];
    const rs = this.currentRainscape;
    
    if (this.onRainscapeChange) this.onRainscapeChange(rs.name);

    if (this.isInitialized) {
      this._applyFilter(this.splashFilter, rs.layers.splash);
      this._applyFilter(this.dropFilter, rs.layers.drop);
      this._applyFilter(this.rumbleFilter, rs.layers.rumble);
      this._applyFilter(this.windFilter, rs.layers.wind);
      this.reverb.decay.rampTo(rs.reverb.decay, 0.5);
      this.reverb.wet.rampTo(rs.reverb.wetness, 0.5);
      this.rainLFO.frequency.rampTo(rs.lfo.frequency, 0.5);
      this.rainLFO.min = -rs.lfo.depth;
      this.rainLFO.max = rs.lfo.depth;
      this.setIntensity(this.config.intensity * 100);
    }
  }

  _applyFilter(filterNode, settings) {
    filterNode.type = settings.type;
    filterNode.frequency.rampTo(settings.freq, 0.5);
    filterNode.Q.rampTo(settings.Q, 0.5);
  }

  async start() {
    if (!this.isInitialized) await this.init();
    if (!this.isPlaying) {
      this.splashNoise.start();
      this.dropNoise.start();
      this.rumbleNoise.start();
      this.windNoise.start();
      this.isPlaying = true;
      this.setIntensity(this.config.intensity * 100);
      this.setVolume(this.config.volume * 100);
      this.setWind(this.config.wind * 100);
    }
  }

  stop() {
    if (this.isPlaying) {
      this.splashNoise.stop();
      this.dropNoise.stop();
      this.rumbleNoise.stop();
      this.windNoise.stop();
      this.isPlaying = false;
    }
  }

  setVolume(volume) {
    this.config.volume = volume / 100;
    if (this.isInitialized && this.masterVolume) {
      const db = volume <= 0 ? -1000 : Tone.gainToDb(this.config.volume);
      this.masterVolume.volume.rampTo(db, 0.1);
    }
  }

  setManualMode(enabled) { this.manualMode = enabled; }

  setIntensity(intensity) {
    this.config.intensity = intensity / 100;
    const i = this.config.intensity;
    const rs = this.currentRainscape;

    if (this.isInitialized && !this.manualMode) {
      const splashBase = -60; 
      const splashTarget = -20 + (rs.layers.splash.gain || 0);
      this.splashNoise.volume.rampTo(splashBase + (i * (splashTarget - splashBase)), 0.2);

      const dropBase = -60;
      const dropTarget = -15 + (rs.layers.drop.gain || 0);
      this.dropNoise.volume.rampTo(dropBase + (i * (dropTarget - dropBase)), 0.2);

      let rumbleDb = -1000;
      if (i > 0.2) {
        const rumbleTarget = -10 + (rs.layers.rumble.gain || 0);
        rumbleDb = -40 + ((i - 0.2) / 0.8) * (rumbleTarget - (-40));
      }
      this.rumbleNoise.volume.rampTo(rumbleDb, 0.2);
      this.bubbleSynth.volume.rampTo(-10 + (i * 15), 0.2);
    }
  }

  setWind(intensity) {
    this.config.wind = intensity / 100;
    const i = Math.abs(this.config.wind);
    if (this.isInitialized && this.windNoise && this.windPanner) {
      const windDb = i === 0 ? -1000 : -40 + (i * 30);
      this.windNoise.volume.rampTo(windDb, 0.5);
      this.windPanner.frequency.rampTo(0.1 + (i * 2), 0.5);
    }
  }

  updateParam(path, value) {
    if (!this.isInitialized) return;
    const parts = path.split('.');
    const category = parts[0]; 
    const name = parts[1];     
    const param = parts[2];    

    if (category === 'manualMode') { this.setManualMode(value); return; }

    if (category === 'layers') {
      let node = (name === 'splash' ? this.splashNoise : (name === 'drop' ? this.dropNoise : (name === 'rumble' ? this.rumbleNoise : this.windNoise)));
      if (node && param === 'vol') node.volume.value = value;
    } else if (category === 'filters') {
      let node = (name === 'splash' ? this.splashFilter : (name === 'drop' ? this.dropFilter : (name === 'rumble' ? this.rumbleFilter : this.windFilter)));
      if (node) {
        if (param === 'freq') node.frequency.value = value;
        if (param === 'Q') node.Q.value = value;
        if (param === 'type') node.type = value;
      }
    } else if (category === 'synths') {
      if (name === 'bubble') {
        if (param === 'vol') this.bubbleSynth.volume.value = value;
        if (param === 'decay') this.bubbleSynth.envelope.decay = value;
        if (param === 'osc') this.bubbleSynth.oscillator.type = value;
      } else if (name === 'impact') {
        if (param === 'vol') this.impactSynth.volume.value = value;
        if (param === 'decay') this.impactSynth.envelope.decay = value;
        if (param === 'type') this.impactSynth.noise.type = value;
      } else if (name === 'global' && param === 'pitchScale') {
        window.rainPitchScale = value;
      }
    } else if (category === 'reverb') {
      if (name === 'decay') this.reverb.decay = value;
      if (name === 'wet') this.reverb.wet.value = value;
    } else if (category === 'wind') {
      if (name === 'speed') this.windPanner.frequency.value = value;
      if (name === 'depth') this.windPanner.depth.value = value;
    }
  }

  dispose() {
    this.stop();
    this.isInitialized = false;
  }
}

const audioSystem = new RainAudioSystem();
export default audioSystem;
