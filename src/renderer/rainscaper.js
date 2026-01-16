
import audioSystem from './audioSystem.js';

export class Rainscaper {
  constructor() {
    this.panel = null;
    this.isVisible = false;
    this.activeTab = 'audio';
    this.presets = [];
    this.physics = null;
    this.config = null;
  }

  async init(physicsSystem, config) {
    this.physics = physicsSystem;
    this.config = config;

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'rainscaper.css';
    document.head.appendChild(link);

    this.panel = document.createElement('div');
    this.panel.className = 'rainscaper-panel';
    this.panel.style.display = 'none';

    this.render();
    document.body.appendChild(this.panel);

    this.panel.addEventListener('mouseenter', () => {
      window.rainydesk.setIgnoreMouseEvents(false);
      window.rainydesk.updateRainscapeParam('manualMode', true); 
    });
    this.panel.addEventListener('mouseleave', () => {
      window.rainydesk.setIgnoreMouseEvents(true, { forward: true });
    });

    await this.refreshRainscapes();
    
    // Load last used rainscape if available
    if (this.config && this.config.rainscapeName && this.config.rainscapeName !== 'Glass Window') {
       const data = await window.rainydesk.readRainscape(this.config.rainscapeName + '.json');
       if (data) this.applyPreset(data);
    }
  }

  async refreshRainscapes() {
    const files = await window.rainydesk.loadRainscapes();
    this.presets = files;
    this.updatePresetDropdown();
  }

  toggle() {
    this.isVisible = !this.isVisible;
    this.panel.style.display = this.isVisible ? 'flex' : 'none';
    
    if (this.isVisible) {
      window.rainydesk.updateRainscapeParam('manualMode', true);
      this.refresh();
    }
  }

  refresh() {
    if (this.panel) this.renderContent();
  }

  render() {
    this.panel.innerHTML = `
      <div class="rainscaper-header">
        <div class="rainscaper-title">Rainscaper</div>
        <button class="btn btn-primary" id="rs-close">×</button>
      </div>
      
      <div class="preset-controls" style="padding: 10px; background: #323232;">
        <select id="rs-preset-select">
          <option value="">Select Rainscape...</option>
        </select>
        <button class="btn btn-success" id="rs-save">Save</button>
      </div>

      <div class="rainscaper-tabs">
        <div class="rainscaper-tab ${this.activeTab === 'audio' ? 'active' : ''}" data-tab="audio">Audio</div>
        <div class="rainscaper-tab ${this.activeTab === 'synths' ? 'active' : ''}" data-tab="synths">Synths</div>
        <div class="rainscaper-tab ${this.activeTab === 'physics' ? 'active' : ''}" data-tab="physics">Physics</div>
      </div>

      <div class="rainscaper-content" id="rs-content"></div>
    `;

    this.bindEvents();
    this.renderContent();
  }

  bindEvents() {
    this.panel.querySelector('#rs-close').onclick = () => this.toggle();
    
    this.panel.querySelectorAll('.rainscaper-tab').forEach(tab => {
      tab.onclick = () => {
        this.activeTab = tab.dataset.tab;
        this.render(); 
      };
    });

    this.panel.querySelector('#rs-save').onclick = async () => {
      const name = prompt("Enter Rainscape Name:");
      if (name) {
        const data = this.gatherPresetData();
        await window.rainydesk.saveRainscape(name, data);
        await this.refreshRainscapes();
      }
    };
  }

  updatePresetDropdown() {
    const select = this.panel.querySelector('#rs-preset-select');
    if (!select) return; 
    
    select.innerHTML = '<option value="">Select Rainscape...</option>';
    this.presets.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p;
      opt.innerText = p.replace('.json', '');
      select.appendChild(opt);
    });
    
    select.onchange = async (e) => {
      if (e.target.value) {
        const data = await window.rainydesk.readRainscape(e.target.value);
        if (data) this.applyPreset(data);
      }
    };
  }

  renderContent() {
    const container = this.panel.querySelector('#rs-content');
    container.innerHTML = '';

    if (this.activeTab === 'physics') {
      this.renderPhysicsControls(container);
      return;
    }

    if (!audioSystem.isInitialized) {
      const msg = document.createElement('div');
      msg.innerText = 'Audio not initialized.\nClick the window to start audio engine.';
      msg.style.color = '#ff5555';
      msg.style.textAlign = 'center';
      msg.style.padding = '20px';
      container.appendChild(msg);
      return;
    }

    if (this.activeTab === 'audio') {
      this.renderAudioControls(container);
    } else if (this.activeTab === 'synths') {
      this.renderSynthControls(container);
    }
  }

  renderAudioControls(container) {
    // SPLASH LAYER (Cyan)
    this.renderControlGroup(container, 'Splash Layer', 'group-splash', [
      { id: 'layers.splash.vol', label: 'Volume', min: -100, max: 10, val: audioSystem.splashNoise.volume.value,
        fn: v => (v <= -99 ? -1000 : v) },
      { id: 'filters.splash.type', label: 'Filter', type: 'select', options: ['lowpass', 'highpass', 'bandpass', 'notch'], val: audioSystem.splashFilter.type },
      { id: 'filters.splash.freq', label: 'Freq', min: 100, max: 10000, val: audioSystem.splashFilter.frequency.value },
      { id: 'filters.splash.Q',    label: 'Q',    min: 0.1, max: 10, step: 0.1, val: audioSystem.splashFilter.Q.value }
    ]);

    // DROP LAYER (Green)
    this.renderControlGroup(container, 'Drop Layer', 'group-drop', [
      { id: 'layers.drop.vol', label: 'Volume', min: -100, max: 10, val: audioSystem.dropNoise.volume.value,
        fn: v => (v <= -99 ? -1000 : v) },
      { id: 'filters.drop.type', label: 'Filter', type: 'select', options: ['lowpass', 'highpass', 'bandpass', 'notch'], val: audioSystem.dropFilter.type },
      { id: 'filters.drop.freq', label: 'Freq', min: 100, max: 5000, val: audioSystem.dropFilter.frequency.value },
      { id: 'filters.drop.Q',    label: 'Q',    min: 0.1, max: 10, step: 0.1, val: audioSystem.dropFilter.Q.value }
    ]);

    // RUMBLE LAYER (Orange)
    this.renderControlGroup(container, 'Rumble Layer', 'group-rumble', [
      { id: 'layers.rumble.vol', label: 'Volume', min: -100, max: 10, val: audioSystem.rumbleNoise.volume.value,
        fn: v => (v <= -99 ? -1000 : v) },
      { id: 'filters.rumble.type', label: 'Filter', type: 'select', options: ['lowpass', 'highpass', 'bandpass', 'notch'], val: audioSystem.rumbleFilter.type },
      { id: 'filters.rumble.freq', label: 'Freq', min: 20, max: 1000, val: audioSystem.rumbleFilter.frequency.value },
      { id: 'filters.rumble.Q',    label: 'Q',    min: 0.1, max: 10, step: 0.1, val: audioSystem.rumbleFilter.Q.value }
    ]);

    // WIND LAYER (Purple)
    this.renderControlGroup(container, 'Wind Layer', 'group-wind', [
      { id: 'layers.wind.vol', label: 'Volume', min: -100, max: 10, val: audioSystem.windNoise.volume.value,
        fn: v => (v <= -99 ? -1000 : v) },
      { id: 'filters.wind.type', label: 'Filter', type: 'select', options: ['lowpass', 'highpass', 'bandpass', 'notch'], val: audioSystem.windFilter.type },
      { id: 'filters.wind.freq', label: 'Freq', min: 20, max: 2000, val: audioSystem.windFilter.frequency.value },
      { id: 'filters.wind.Q',    label: 'Q',    min: 0.1, max: 10, step: 0.1, val: audioSystem.windFilter.Q.value },
      { id: 'wind.speed', label: 'LFO Spd', min: 0.01, max: 5, step: 0.01, val: audioSystem.windPanner.frequency.value },
      { id: 'wind.depth', label: 'LFO Dep', min: 0, max: 1, step: 0.05, val: audioSystem.windPanner.depth.value },
    ]);
    
    // REVERB (Blue-Grey)
    this.renderControlGroup(container, 'Reverb', 'group-reverb', [
      { id: 'reverb.decay', label: 'Decay', min: 0.1, max: 10, val: audioSystem.reverb.decay },
      { id: 'reverb.wet',   label: 'Wet',   min: 0, max: 1, step: 0.05, val: audioSystem.reverb.wet.value },
    ]);
  }

  renderSynthControls(container) {
    const oscTypes = ['sine', 'square', 'triangle', 'sawtooth', 'pwm', 'pulse'];
    
    // BUBBLE SYNTH (Pink)
    this.renderControlGroup(container, 'Bubble Synth', 'group-bubble', [
      { id: 'synths.bubble.osc',   label: 'Osc',    type: 'select', options: oscTypes, val: audioSystem.bubbleSynth.oscillator.type },
      { id: 'synths.bubble.vol',   label: 'Volume', min: -100, max: 10, val: audioSystem.bubbleSynth.volume.value,
        fn: v => (v <= -99 ? -1000 : v) },
      { id: 'synths.global.pitchScale', label: 'Pitch Scale', min: 0.01, max: 2.0, step: 0.01, val: window.rainPitchScale || 0.25 },
      { id: 'synths.bubble.decay', label: 'Decay', min: 0.01, max: 1.0, step: 0.01, val: audioSystem.bubbleSynth.envelope.decay },
    ]);

    // IMPACT SYNTH (Red)
    const noiseTypes = ['white', 'pink', 'brown'];
    this.renderControlGroup(container, 'Impact Synth', 'group-impact', [
      { id: 'synths.impact.type',  label: 'Noise',  type: 'select', options: noiseTypes, val: audioSystem.impactSynth.noise.type },
      { id: 'synths.impact.vol',   label: 'Volume', min: -100, max: 10, val: audioSystem.impactSynth.volume.value,
        fn: v => (v <= -99 ? -1000 : v) },
      { id: 'synths.impact.decay', label: 'Decay',  min: 0.001, max: 0.2, step: 0.001, val: audioSystem.impactSynth.envelope.decay },
    ]);
  }

  renderPhysicsControls(container) {
    // PHYSICS (Yellow)
    this.renderControlGroup(container, 'Global Physics', 'group-physics', [
      { id: 'physics.intensity', label: 'Intensity', min: 0, max: 100, val: this.config.intensity },
      { id: 'physics.wind',      label: 'Wind',      min: -100, max: 100, val: this.config.wind },
      { id: 'physics.gravity',   label: 'Gravity',   min: 0, max: 2000, val: this.physics.config.gravity },
    ]);

    this.renderControlGroup(container, 'Droplets', 'group-physics', [
      { id: 'physics.dropMinSize', label: 'Min Size', min: 1, max: 10, val: this.config.dropMinSize },
      { id: 'physics.dropMaxSize', label: 'Max Size', min: 1, max: 10, val: this.config.dropMaxSize },
      { id: 'physics.terminalVelocity', label: 'Terminal Vel', min: 100, max: 1000, val: this.physics.config.terminalVelocity },
    ]);
  }

  renderControlGroup(parent, title, className, controls) {
    const group = document.createElement('div');
    group.className = `control-group ${className}`;
    
    const h = document.createElement('div');
    h.className = 'control-group-title';
    h.innerText = title;
    group.appendChild(h);

    controls.forEach(c => {
      const row = document.createElement('div');
      row.className = 'control-row';
      
      const label = document.createElement('div');
      label.className = 'control-label';
      label.innerText = c.label;
      
      let input;
      
      if (c.type === 'select') {
        input = document.createElement('select');
        input.className = 'control-input';
        c.options.forEach(opt => {
          const o = document.createElement('option');
          o.value = opt;
          o.innerText = opt;
          if (opt === c.val) o.selected = true;
          input.appendChild(o);
        });
        
        input.onchange = (e) => {
          this.updateParam(c.id, e.target.value);
        };
      } else {
        input = document.createElement('input');
        input.type = 'range';
        input.className = 'control-input';
        input.min = c.min;
        input.max = c.max;
        input.step = c.step || 1;
        input.value = c.val;
        
        const valDisplay = document.createElement('div');
        valDisplay.className = 'control-value';
        valDisplay.innerText = c.val <= -99 ? 'Mute' : c.val;

        input.oninput = (e) => {
          const rawVal = parseFloat(e.target.value);
          const finalVal = c.fn ? c.fn(rawVal) : rawVal;
          valDisplay.innerText = rawVal <= -99 ? 'Mute' : rawVal;
          this.updateParam(c.id, finalVal);
        };
        row.appendChild(valDisplay);
      }

      row.prepend(label);
      row.appendChild(input);
      group.appendChild(row);
    });

    parent.appendChild(group);
  }

  updateParam(id, value) {
    window.rainydesk.updateRainscapeParam(id, value);
  }

    // --- PRESET HANDLING ---
    gatherPresetData() {
      return {
        name: this.currentRainscape?.name || 'Custom Rainscape',
        layers: {
          splash: { vol: audioSystem.splashNoise.volume.value, freq: audioSystem.splashFilter.frequency.value, Q: audioSystem.splashFilter.Q.value, type: audioSystem.splashFilter.type },
          drop:   { vol: audioSystem.dropNoise.volume.value,   freq: audioSystem.dropFilter.frequency.value,   Q: audioSystem.dropFilter.Q.value,   type: audioSystem.dropFilter.type },
          rumble: { vol: audioSystem.rumbleNoise.volume.value, freq: audioSystem.rumbleFilter.frequency.value, Q: audioSystem.rumbleFilter.Q.value, type: audioSystem.rumbleFilter.type },
          wind:   { vol: audioSystem.windNoise.volume.value,   freq: audioSystem.windFilter.frequency.value,   Q: audioSystem.windFilter.Q.value,   type: audioSystem.windFilter.type },
        },
        synths: {
          bubble: { vol: audioSystem.bubbleSynth.volume.value, decay: audioSystem.bubbleSynth.envelope.decay, osc: audioSystem.bubbleSynth.oscillator.type },
          impact: { vol: audioSystem.impactSynth.volume.value, decay: audioSystem.impactSynth.envelope.decay, type: audioSystem.impactSynth.noise.type },
          global: { pitchScale: window.rainPitchScale }
        },
        windMod: { speed: audioSystem.windPanner.frequency.value, depth: audioSystem.windPanner.depth.value },
        reverb: { decay: audioSystem.reverb.decay, wet: audioSystem.reverb.wet.value },
        physics: {
          gravity: this.physics.config.gravity,
          wind: this.config.wind,
          intensity: this.config.intensity,
          dropMinSize: this.config.dropMinSize,
          dropMaxSize: this.config.dropMaxSize,
          terminalVelocity: this.physics.config.terminalVelocity
        }
      };
    }
  
    applyPreset(data) {
      if (!data) return;
      window.rainydesk.log(`Applying Rainscape: ${data.name}`);
      
      const sync = (id, val) => window.rainydesk.updateRainscapeParam(id, val);
  
      // Layers
      if (data.layers) {
        Object.keys(data.layers).forEach(layer => {
          const l = data.layers[layer];
          sync(`layers.${layer}.vol`, l.vol);
          sync(`filters.${layer}.freq`, l.freq);
          sync(`filters.${layer}.Q`, l.Q);
          sync(`filters.${layer}.type`, l.type);
        });
      }
  
      // Synths
      if (data.synths) {
        if (data.synths.bubble) {
          sync('synths.bubble.vol', data.synths.bubble.vol);
          sync('synths.bubble.decay', data.synths.bubble.decay);
          sync('synths.bubble.osc', data.synths.bubble.osc);
        }
        if (data.synths.impact) {
          sync('synths.impact.vol', data.synths.impact.vol);
          sync('synths.impact.decay', data.synths.impact.decay);
          sync('synths.impact.type', data.synths.impact.type);
        }
        if (data.synths.global) sync('synths.global.pitchScale', data.synths.global.pitchScale);
      }
  
      // Reverb & Wind Mod
      if (data.reverb) {
        sync('reverb.decay', data.reverb.decay);
        sync('reverb.wet', data.reverb.wet);
      }
      if (data.windMod) {
        sync('wind.speed', data.windMod.speed);
        sync('wind.depth', data.windMod.depth);
      }
  
      // Physics
      if (data.physics) {
        sync('physics.gravity', data.physics.gravity);
        sync('physics.wind', data.physics.wind);
        sync('physics.intensity', data.physics.intensity);
        sync('physics.dropMinSize', data.physics.dropMinSize);
        sync('physics.dropMaxSize', data.physics.dropMaxSize);
        sync('physics.terminalVelocity', data.physics.terminalVelocity);
      }
  
      // Force UI Refresh
      setTimeout(() => this.refresh(), 200);
    }}

export const rainscaper = new Rainscaper();
