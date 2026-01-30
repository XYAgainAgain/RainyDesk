/**
 * Rainscape Studio - Main Application Logic
 * V2.5 - Fixed Truncation Issue
 */

import { UI } from './ui.js';

let audioSystem = null;
let currentTab = 'master';
let isPlaying = false;
let currentBPM = 120;
let lastFrameTime = performance.now();

// DOM Elements
const controlDeck = document.getElementById('control-deck');

// State History
let history = [];
let redoStack = [];
const MAX_HISTORY = 50;

/**
 * Factory defaults
 */
const DEFAULTS = {
    master: { volume: -12, muted: false, buses: { rain: { volume: -6, muted: false, solo: false }, wind: { volume: -12, muted: false, solo: false }, thunder: { volume: -6, muted: false, solo: false }, matrix: { volume: -12, muted: false, solo: false } }, limiter: { threshold: -1, release: 0.1 } },
    impacts: { material: "Default", impact: { poolSize: 12, noiseType: "pink", attack: 0.001, decayMin: 0.03, decayMax: 0.08, filterFreqMin: 2000, filterFreqMax: 6000, filterQ: 2.0 }, bubble: { poolSize: 8, oscillatorType: "sine", pulseWidth: 0.5, probability: 0.4, chirpAmount: 0.1, freqMin: 800, freqMax: 4000, filterQ: 5.0, distortion: 0, ringMod: false, harmonics: { count: 1 } }, physics: { radiusFreqMultiplier: 1.0, radiusDecayMultiplier: 1.0, angleBubbleBoost: 0.5 }, graupel: { enabled: false, grainCount: 5, spacing: 8 }, shimmer: { enabled: true, bits: 4 } },
    sheetLayer: { enabled: true, noiseType: "pink", filterFreq: 800, filterQ: 1.0, stereo: { width: 0.8, lfoRateL: 0.13, lfoRateR: 0.17, lfoDepth: 0.15 }, baseGain: -50, maxParticleCount: 1500, manualVolumeOverride: false, chorus: { enabled: false, wet: 0.3 }, absorption: { enabled: false, amount: 0.5, cutoff: 1500 } },
    windLayer: { enabled: true, speed: 0, masterGain: -12, bed: { enabled: true, noiseType: "brown", filterFreq: 300, filterQ: 0.5, volume: -24 }, interaction: { enabled: true, flavor: "Forest", noiseType: "pink", filterFreq: 600, filterQ: 2.0 }, gust: { enabled: true, intensity: 0.6, intervalMin: 15, intervalMax: 45 }, aeolian: { enabled: false, strouhal: 0.2, gain: -30, harmonics: [1, 2, 3] }, singing: { enabled: false, mode: 'Aeolian', voices: 4, gain: -24, vowel: 'Ooh', customF1: 300, customF2: 800, customF3: 2500 }, katabatic: { enabled: false, lowFreqBoost: 6, surgeRate: 0.08, gain: -30 } },
    thunder: { enabled: true, distance: 2.0, masterGain: -6, tortuosity: 0.5, tearingEnabled: true, crackEnabled: true, bodyEnabled: true, rumbleEnabled: true, sidechainEnabled: true, sidechainDuckAmount: 15, manualOffsets: { l1: 0, l2: 100, l3: 300, l4: 500 } },
    matrix: { enabled: false, masterGain: -12, droneEnabled: true, codeDrops: { triggerRate: 40, harmonicity: 3.14 }, glitch: { probability: 0.3, bits: 4, sampleRateDrop: 0.2 }, agent: { feedbackDur: 1.5, subStart: 120, subEnd: 20, subDur: 2 } },
    sfx: { reverb: { decay: 2.5, wetness: 0.25 }, eq: { rain: { low: 0, mid: 0, high: 0 }, wind: { low: 0, mid: 0, high: 0 }, thunder: { low: 0, mid: 0, high: 0 }, master: { low: 0, mid: 0, high: 0 } }, compressor: { threshold: -24, ratio: 4 }, bitcrusher: { enabled: false, bits: 8 }, spatial: { listener: { x: 0, y: 0, z: 0 } }, muffling: { enabled: false, volumeDrop: 6, lpCutoff: 800 }, delay: { enabled: false, time: 0.3, feedback: 0.3, wet: 0.2 }, filter: { enabled: false, type: 'lowpass', freq: 2000, Q: 1.0 } }
};

let state = { meta: { name: "My Rainscape", author: "User", schemaVersion: "2.0" }, master: structuredClone(DEFAULTS.master), impacts: structuredClone(DEFAULTS.impacts), sheets: [ structuredClone(DEFAULTS.sheetLayer), structuredClone(DEFAULTS.sheetLayer) ], winds: [ structuredClone(DEFAULTS.windLayer), structuredClone(DEFAULTS.windLayer) ], thunder: structuredClone(DEFAULTS.thunder), matrix: structuredClone(DEFAULTS.matrix), sfx: structuredClone(DEFAULTS.sfx) };

function saveHistory() {
    history.push(JSON.stringify(state));
    if (history.length > MAX_HISTORY) history.shift();
    redoStack = [];
}

function undo() {
    if (history.length === 0) return;
    redoStack.push(JSON.stringify(state));
    state = JSON.parse(history.pop());
    updateTabUI();
    markUnsaved();
}

function redo() {
    if (redoStack.length === 0) return;
    history.push(JSON.stringify(state));
    state = JSON.parse(redoStack.pop());
    updateTabUI();
    markUnsaved();
}

function updateParam(localPath, audioPath, value, wrapKey = null) {
    const parts = localPath.split('.');
    let curr = state;
    for (let i = 0; i < parts.length - 1; i++) { curr = curr[parts[i]]; }
    curr[parts[parts.length - 1]] = value;

    if (audioSystem && audioPath) {
        const payload = wrapKey ? { [wrapKey]: value } : value;
        audioSystem.updateParam(audioPath, payload);
        markUnsaved();
    }
}

let isUnsaved = false;
function markUnsaved() { isUnsaved = true; const ind = document.getElementById('autosave-status'); if (ind) ind.textContent = 'Unsaved •'; }
function markSaved() { isUnsaved = false; const ind = document.getElementById('autosave-status'); if (ind) ind.textContent = 'Saved ✓'; }

async function ensureEngineStarted() {
    if (!audioSystem) return;
    if (!isPlaying) { const btn = document.getElementById('play-pause-btn'); if (btn) btn.click(); }
}

function resetModule() {
    if (confirm(`Reset ${currentTab} to defaults?`)) {
        saveHistory();
        const keyMap = { 'master': 'master', 'impacts': 'impacts', 'sheets': 'sheets', 'winds': 'winds', 'thunder': 'thunder', 'matrix': 'matrix', 'sfx': 'sfx' };
        const key = keyMap[currentTab];
        if (key === 'sheets') state.sheets = [ structuredClone(DEFAULTS.sheetLayer), structuredClone(DEFAULTS.sheetLayer) ];
        else if (key === 'winds') state.winds = [ structuredClone(DEFAULTS.windLayer), structuredClone(DEFAULTS.windLayer) ];
        else state[key] = structuredClone(DEFAULTS[key]);
        updateTabUI();
        markUnsaved();
    }
}

const Modules = {
    master() {
        const diagram = document.createElement('div'); diagram.className = 'routing-diagram';
        diagram.textContent = `Rain Bus ────┬──► Master Bus ──► Limiter ──► Output\nWind Bus ────┤\nThunder Bus ─┤\nMatrix Bus ──┘`;
        const buses = ['Rain', 'Wind', 'Thunder', 'Matrix'].map(id => {
            const bId = id.toLowerCase(); const b = state.master.buses[bId];
            return UI.createGroup(`${id} Bus`, [
                UI.createSlider('Volume', { min: -60, max: 0, value: b.volume, unit: 'dB', onChange: (v) => updateParam(`master.buses.${bId}.volume`, `set${id}BusConfig`, { gain: v }) }),
                UI.createToggle('Muted', { value: b.muted, onChange: (v) => updateParam(`master.buses.${bId}.muted`, `set${id}BusConfig`, { muted: v }) }),
                UI.createToggle('Solo', { value: b.solo, onChange: (v) => updateParam(`master.buses.${bId}.solo`, `set${id}BusConfig`, { solo: v }) })
            ]);
        });
        return [UI.createGroup('Flow', [diagram]), UI.createGroup('Global', [UI.createToggle('Master Mute', { value: state.master.muted, onChange: (v) => { state.master.muted = v; audioSystem?.setMuted(v); markUnsaved(); } })]), ...buses, UI.createGroup('Limiter', [UI.createSlider('Threshold', { min: -12, max: 0, step: 0.1, value: state.master.limiter.threshold, unit: 'dB', onChange: (v) => markUnsaved() }), UI.createSlider('Release', { min: 0.01, max: 0.5, step: 0.01, value: state.master.limiter.release, unit: 's', onChange: (v) => markUnsaved() })])];
    },

    impacts() {
        return [
            UI.createGroup('Material', [UI.createSelect('Preset', { items: ['Glass', 'Tin', 'Concrete', 'Leaves', 'Water', 'Wood', 'Stone', 'Tile', 'Slate', 'Marble', 'Thatch', 'Default'], value: state.impacts.material, onChange: (v) => updateParam('impacts.material', 'material.id', v.toLowerCase()) })]),
            UI.createGroup('Impact Synth', [
                UI.createSlider('Pool Size', { min: 1, max: 64, value: state.impacts.impact.poolSize, onChange: (v) => updateParam('impacts.impact.poolSize', 'voicePools.impactPoolSize', v) }),
                UI.createSelect('Noise Type', { items: ['white', 'pink', 'brown'], value: state.impacts.impact.noiseType, onChange: (v) => updateParam('impacts.impact.noiseType', 'impact.noiseType', v) }),
                UI.createSlider('Attack', { min: 0, max: 0.1, step: 0.001, value: state.impacts.impact.attack, unit: 's', onChange: (v) => updateParam('impacts.impact.attack', 'impact.attack', v) }),
                UI.createSlider('Decay Max', { min: 0.01, max: 2.0, step: 0.01, value: state.impacts.impact.decayMax, unit: 's', onChange: (v) => updateParam('impacts.impact.decayMax', 'impact.decayMax', v) }),
                UI.createSlider('Filter Q', { min: 0.1, max: 30, step: 0.1, value: state.impacts.impact.filterQ, onChange: (v) => updateParam('impacts.impact.filterQ', 'impact.filterQ', v) }),
                UI.createTrigger('▶ Impact', () => audioSystem?.getImpactPool()?.trigger({ volume: -12, frequency: 1000, decay: 0.1, triggerBubble: false, filterFreq: 2000, pan: 0 })),
                UI.createTrigger('▶ Burst x10', () => { const p = audioSystem?.getImpactPool(); for(let i=0; i<10; i++) setTimeout(() => p?.trigger({ volume: -12, frequency: 1000 + Math.random()*500, decay: 0.1, triggerBubble: Math.random()>0.5, filterFreq: 2000, pan: Math.random()*2-1 }), i*30); })
            ]),
            UI.createGroup('Bubble Synth', [
                UI.createSlider('Pool Size', { min: 1, max: 32, value: state.impacts.bubble.poolSize, onChange: (v) => updateParam('impacts.bubble.poolSize', 'voicePools.bubblePoolSize', v) }),
                UI.createSelect('Oscillator', { items: ['sine', 'triangle', 'square', 'sawtooth', 'pulse'], value: state.impacts.bubble.oscillatorType, onChange: (v) => updateParam('impacts.bubble.oscillatorType', 'bubble.oscillatorType', v) }),
                UI.createSlider('Pulse Width', { min: 0.01, max: 0.99, step: 0.01, value: state.impacts.bubble.pulseWidth, tooltip: 'Only for Pulse type', onChange: (v) => updateParam('impacts.bubble.pulseWidth', 'bubble.pulseWidth', v) }),
                UI.createSlider('Probability', { min: 0, max: 1, step: 0.01, value: state.impacts.bubble.probability, onChange: (v) => updateParam('impacts.bubble.probability', 'bubble.probability', v) }),
                UI.createSlider('Chirp', { min: 0, max: 2, step: 0.01, value: state.impacts.bubble.chirpAmount, onChange: (v) => updateParam('impacts.bubble.chirpAmount', 'bubble.chirpAmount', v) }),
                UI.createSlider('Harmonic Count', { min: 1, max: 16, step: 1, value: state.impacts.bubble.harmonics.count, onChange: (v) => updateParam('impacts.bubble.harmonics.count', 'bubble.harmonicCount', v) }),
                UI.createTrigger('▶ Bubble', () => audioSystem?.getBubblePool()?.trigger({ volume: -18, frequency: 2000, decay: 0.2, triggerBubble: true, filterFreq: 4000, pan: 0 }))
            ]),
            UI.createGroup('Physics', [
                UI.createSlider('Radius→Freq', { min: 0.5, max: 2.0, step: 0.01, value: state.impacts.physics.radiusFreqMultiplier, onChange: (v) => updateParam('impacts.physics.radiusFreqMultiplier', 'physicsMapper.radiusFreqMultiplier', v) }),
                UI.createSlider('Radius→Decay', { min: 0.5, max: 2.0, step: 0.01, value: state.impacts.physics.radiusDecayMultiplier, onChange: (v) => updateParam('impacts.physics.radiusDecayMultiplier', 'physicsMapper.radiusDecayMultiplier', v) })
            ]),
            UI.createGroup('Graupel Mode', [
                UI.createToggle('Enabled', { value: state.impacts.graupel.enabled, onChange: (v) => markUnsaved() }),
                UI.createSlider('Grains', { min: 2, max: 15, step: 1, value: state.impacts.graupel.grainCount, onChange: (v) => markUnsaved() }),
                UI.createToggle('Shimmer', { value: state.impacts.shimmer.enabled, onChange: (v) => markUnsaved() }),
                UI.createSlider('BitCrush', { min: 2, max: 8, step: 1, value: state.impacts.shimmer.bits, onChange: (v) => markUnsaved() }),
                UI.createTrigger('▶ Shimmer', () => console.log('Shimmer triggered'))
            ])
        ];
    },

    sheets() {
        const createLayer = (idx, mock = false) => {
            const s = state.sheets[idx];
            return [
                UI.createGroup(`Sheet ${idx+1}`, [
                    UI.createToggle('Preview', { value: s.enabled, onChange: (v) => { s.enabled = v; if(!mock) { updateParam(`sheets.${idx}.enabled`, 'sheetLayer.enabled', v); if(v) ensureEngineStarted(); } } }),
                    UI.createSelect('Noise Type', { items: ['white', 'pink', 'brown'], value: s.noiseType, onChange: (v) => { if(!mock) updateParam(`sheets.${idx}.noiseType`, 'sheetLayer.noiseType', v); } }),
                    UI.createSlider('Filter Freq', { min: 100, max: 12000, step: 100, value: s.filterFreq, unit: 'Hz', onChange: (v) => { if(!mock) updateParam(`sheets.${idx}.filterFreq`, 'sheetLayer.filterFreq', v); } })
                ], true),
                UI.createGroup('Stereo & Absorption', [
                    UI.createSlider('Width', { min: 0, max: 1, step: 0.01, value: s.stereo.width, onChange: (v) => markUnsaved() }),
                    UI.createToggle('Absorption', { value: s.absorption.enabled, onChange: (v) => markUnsaved() })
                ], true)
            ];
        };
        return [UI.createTabs({ 'Layer 1': () => createLayer(0), 'Layer 2': () => createLayer(1, true) })];
    },

    winds() {
        const createLayer = (idx, mock = false) => {
            const w = state.winds[idx];
            return [
                UI.createGroup(`Global ${idx+1}`, [
                    UI.createSlider('Wind Speed', { min: 0, max: 100, step: 1, value: w.speed, unit: '%', onChange: (v) => { w.speed = v; if(!mock) audioSystem?.setWindSpeed(v); } }),
                    UI.createSlider('Master Gain', { min: -60, max: 0, step: 1, value: w.masterGain, unit: 'dB', onChange: (v) => updateParam(`winds.${idx}.masterGain`, 'wind.masterGain', v) }),
                    UI.createTrigger('▶ Gust', () => { if(!mock && audioSystem) audioSystem.triggerGust(); }),
                    UI.createToggle('Aeolian Preview', { value: w.aeolian.enabled, onChange: (v) => { w.aeolian.enabled = v; if(!mock) updateParam(`winds.${idx}.aeolian.enabled`, 'wind.aeolian', { enabled: v }); if(v) ensureEngineStarted(); } }),
                    UI.createToggle('Singing Preview', { value: w.singing.enabled, onChange: (v) => { w.singing.enabled = v; if(!mock) updateParam(`winds.${idx}.singing.enabled`, 'wind.singing', { enabled: v }); if(v) ensureEngineStarted(); } })
                ], true),
                UI.createGroup('Bed', [
                    UI.createToggle('Enabled', { value: w.bed.enabled, onChange: (v) => markUnsaved() }),
                    UI.createSelect('Noise', { items: ['pink', 'brown'], value: w.bed.noiseType, onChange: (v) => updateParam(`winds.${idx}.bed.noiseType`, 'wind.bed', { noiseType: v }) }),
                    UI.createSlider('Freq', { min: 50, max: 800, step: 10, value: w.bed.filterFreq, unit: 'Hz', onChange: (v) => updateParam(`winds.${idx}.bed.filterFreq`, 'wind.bed', { filterFreq: v }) })
                ], true),
                UI.createGroup('Atmosphere', [
                    UI.createToggle('Katabatic', { value: w.katabatic.enabled, tooltip: 'Polar shear wind', onChange: (v) => updateParam(`winds.${idx}.katabatic.enabled`, 'wind.katabatic', { enabled: v }) }),
                    UI.createSlider('Surge Rate', { min: 0.01, max: 0.5, step: 0.01, value: w.katabatic.surgeRate, unit: 'Hz', onChange: (v) => updateParam(`winds.${idx}.katabatic.surgeRate`, 'wind.katabatic', { surgeRate: v }) }),
                    UI.createSlider('Low Boost', { min: 0, max: 12, step: 0.5, value: w.katabatic.lowFreqBoost || 6, unit: 'dB', onChange: (v) => updateParam(`winds.${idx}.katabatic.lowFreqBoost`, 'wind.katabatic', { lowFreqBoost: v }) })
                ], true),
                UI.createGroup('Singing Wind', [
                    UI.createSelect('Mode', { items: ['Aeolian', 'Dorian', 'Phrygian', 'Lydian', 'Pentatonic'], value: w.singing.mode, onChange: (v) => updateParam(`winds.${idx}.singing.mode`, 'wind.singing', { mode: v }) }),
                    UI.createSelect('Vowel', { items: ['Uhh', 'Ooh', 'Aah', 'Eeh', 'Ohh', 'Custom'], value: w.singing.vowel, onChange: (v) => { updateParam(`winds.${idx}.singing.vowel`, null, v); updateTabUI(); } }),
                    ...(w.singing.vowel === 'Custom' ? [
                        UI.createSlider('F1', { min: 200, max: 1000, step: 1, value: w.singing.customF1, unit: 'Hz', onChange: (v) => updateParam(`winds.${idx}.singing.customF1`, 'wind.singing', { customF1: v }) }),
                        UI.createSlider('F2', { min: 400, max: 3000, step: 1, value: w.singing.customF2, unit: 'Hz', onChange: (v) => updateParam(`winds.${idx}.singing.customF2`, 'wind.singing', { customF2: v }) })
                    ] : [])
                ], true)
            ];
        };
        return [UI.createTabs({ 'Wind 1': () => createLayer(0), 'Wind 2': () => createLayer(1, true) })];
    },

    thunder() {
        return [
            UI.createGroup('Macro', [
                UI.createSlider('Distance', { min: 0.1, max: 15, step: 0.1, value: state.thunder.distance, unit: 'km', onChange: (v) => updateParam('thunder.distance', 'thunder.distance', v) }),
                UI.createSlider('Tortuosity', { min: 0, max: 1, step: 0.01, value: state.thunder.tortuosity, onChange: (v) => updateParam('thunder.tortuosity', 'thunder.tortuosity', v) }),
                UI.createTrigger('▶ Full Sequence', () => audioSystem?.triggerThunder(state.thunder.distance))
            ]),
            UI.createGroup('Manual Triggers', [
                UI.createTrigger('▶ L1: Tearing', () => console.log('L1')), UI.createTrigger('▶ L2: Crack', () => console.log('L2')), UI.createTrigger('▶ L3: Body', () => console.log('L3')), UI.createTrigger('▶ L4: Rumble', () => console.log('L4'))
            ]),
            UI.createGroup('Layers', [
                UI.createToggle('Tearing', { value: state.thunder.tearingEnabled, onChange: (v) => updateParam('thunder.tearingEnabled', 'thunder.tearing', { enabled: v }) }),
                UI.createToggle('Crack', { value: state.thunder.crackEnabled, onChange: (v) => updateParam('thunder.crackEnabled', 'thunder.crack', { enabled: v }) }),
                UI.createToggle('Body', { value: state.thunder.bodyEnabled, onChange: (v) => updateParam('thunder.bodyEnabled', 'thunder.body', { enabled: v }) }),
                UI.createToggle('Rumble', { value: state.thunder.rumbleEnabled, onChange: (v) => updateParam('thunder.rumbleEnabled', 'thunder.rumble', { enabled: v }) })
            ]),
            UI.createGroup('Sidechain', [
                UI.createToggle('Enabled', { value: state.thunder.sidechainEnabled, onChange: (v) => updateParam('thunder.sidechainEnabled', 'thunder.sidechainEnabled', v) }),
                UI.createSlider('Amount', { min: 0, max: 30, step: 1, value: state.thunder.sidechainDuckAmount, unit: 'dB', onChange: (v) => updateParam('thunder.sidechainDuckAmount', 'thunder.sidechainDuckAmount', v) })
            ])
        ];
    },

    sfx() {
        const createEQ = (bus) => UI.createGroup(`${bus.toUpperCase()} EQ`, [
            UI.createSlider('Low', { min: -15, max: 15, step: 0.5, value: state.sfx.eq[bus].low, unit: 'dB', onChange: (v) => markUnsaved() }),
            UI.createSlider('Mid', { min: -15, max: 15, step: 0.5, value: state.sfx.eq[bus].mid, unit: 'dB', onChange: (v) => markUnsaved() }),
            UI.createSlider('High', { min: -15, max: 15, step: 0.5, value: state.sfx.eq[bus].high, unit: 'dB', onChange: (v) => markUnsaved() })
        ], true);
        return [
            createEQ('rain'), createEQ('wind'), createEQ('thunder'), createEQ('master'),
            UI.createGroup('Reverb', [
                UI.createSelect('Preset', { items: ['Room', 'Hall', 'Cathedral', 'Plate', 'Outdoor'], value: 'Hall', onChange: (v) => { saveHistory(); updateTabUI(); } }),
                UI.createSlider('Decay', { min: 0.5, max: 20, step: 0.1, value: state.sfx.reverb.decay, unit: 's', onChange: (v) => updateParam('sfx.reverb.decay', 'effects.reverb.decay', v) }),
                UI.createSlider('Wet', { min: 0, max: 1, step: 0.01, value: state.sfx.reverb.wetness, onChange: (v) => updateParam('sfx.reverb.wetness', 'effects.reverb.wetness', v) })
            ]),
            UI.createGroup('Compression', [
                UI.createSlider('Threshold', { min: -50, max: 0, step: 1, value: state.sfx.compressor.threshold, unit: 'dB', onChange: (v) => markUnsaved() }),
                UI.createSlider('Ratio', { min: 1, max: 20, step: 0.1, value: state.sfx.compressor.ratio, onChange: (v) => markUnsaved() })
            ]),
            UI.createGroup('Special & Spatial', [
                UI.createToggle('BitCrusher', { value: state.sfx.bitcrusher.enabled, onChange: (v) => markUnsaved() }),
                UI.createToggle('Muffling', { value: state.sfx.muffling.enabled, tooltip: 'Fullscreen simulation', onChange: (v) => markUnsaved() }),
                UI.createSlider('Spatial X', { min: -10, max: 10, step: 0.1, value: state.sfx.spatial.listener.x, onChange: (v) => markUnsaved() })
            ]),
            UI.createGroup('Delay', [
                UI.createToggle('Enabled', { value: state.sfx.delay.enabled, onChange: (v) => markUnsaved() }),
                UI.createSlider('Time', { min: 0.03, max: 2, step: 0.01, value: state.sfx.delay.time, unit: 's', onChange: (v) => markUnsaved() }),
                UI.createSlider('Feedback', { min: 0, max: 0.95, step: 0.05, value: state.sfx.delay.feedback, onChange: (v) => markUnsaved() })
            ])
        ];
    },

    matrix() {
        return [
            UI.createGroup('Global', [
                UI.createToggle('Enabled', { value: state.matrix.enabled, onChange: (v) => { state.matrix.enabled = v; audioSystem?.setMatrixMode(v); if(v) ensureEngineStarted(); markUnsaved(); } }),
                UI.createSlider('Master Gain', { min: -60, max: 0, step: 1, value: state.matrix.masterGain, unit: 'dB', onChange: (v) => updateParam('matrix.masterGain', 'matrix.masterGain', v) }),
                UI.createTrigger('▶ Drop', () => audioSystem?.triggerMatrixDrop()),
                UI.createTrigger('▶ Glitch', () => audioSystem?.triggerMatrixGlitch()),
                UI.createTrigger('▶ Agent', () => console.log('Agent'))
            ]),
            UI.createGroup('FM Drops', [
                UI.createSlider('Rate', { min: 5, max: 150, step: 1, value: state.matrix.codeDrops.triggerRate, unit: '/s', onChange: (v) => updateParam('matrix.codeDrops.triggerRate', 'matrix.drop', { triggerRate: v }) }),
                UI.createSlider('Harmonicity', { min: 0.25, max: 12, step: 0.01, value: state.matrix.codeDrops.harmonicity, onChange: (v) => updateParam('matrix.codeDrops.harmonicity', 'matrix.drop', { harmonicity: v }) })
            ]),
            UI.createGroup('Glitch & Agent', [
                UI.createSlider('Probability', { min: 0, max: 1, step: 0.01, value: state.matrix.glitch.probability, onChange: (v) => markUnsaved() }),
                UI.createSlider('Sample Rate', { min: 0.05, max: 0.5, step: 0.05, value: state.matrix.glitch.sampleRateDrop, onChange: (v) => markUnsaved() })
            ]),
            UI.createGroup('Drone', [
                UI.createToggle('Enabled', { value: state.matrix.droneEnabled, onChange: (v) => updateParam('matrix.droneEnabled', 'matrix.drone', { enabled: v }) }),
                UI.createSlider('Base Freq', { min: 40, max: 200, step: 1, value: state.matrix.osc1Freq, unit: 'Hz', onChange: (v) => updateParam('matrix.osc1Freq', 'matrix.drone', { baseFreq: v }) })
            ])
        ];
    },

    io() {
        return [
            UI.createGroup('File', [
                UI.createTrigger('Make it .rain', () => { const blob = new Blob([JSON.stringify(audioSystem ? audioSystem.getCurrentRainscapeV2() : state, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'my-rainscape.rain'; a.click(); }),
                UI.createTrigger('Import .rain', () => { const input = document.createElement('input'); input.type = 'file'; input.accept = '.rain,.json'; input.onchange = (e) => { const reader = new FileReader(); reader.onload = (re) => { const json = JSON.parse(re.target.result); if (audioSystem?.loadRainscape) audioSystem.loadRainscape(json); }; reader.readAsText(e.target.files[0]); }; input.click(); })
            ]),
            UI.createGroup('Presets', [UI.createSelect('Load Preset', { items: ['Cozy Study', 'Tin Shed', 'Forest Meditation', 'Urban Noir'], value: 'Cozy Study', onChange: (v) => console.log(v) })])
        ];
    }
};

function updateTabUI() {
    const titles = { 'master': { title: 'Master Bus Control', theme: 'master' }, 'impacts': { title: 'Impacts & Materials', theme: 'rain' }, 'sheets': { title: 'Rain Sheet Synthesis', theme: 'rain' }, 'winds': { title: 'Wind Engine Synthesis', theme: 'wind' }, 'thunder': { title: 'Thunder Synthesis', theme: 'thunder' }, 'sfx': { title: 'Global Effects', theme: 'sfx' }, 'matrix': { title: 'Digital Rain', theme: 'matrix' }, 'io': { title: 'I/O & Presets', theme: 'master' } };
    controlDeck.innerHTML = '';
    const config = titles[currentTab] || { title: 'Module', theme: 'master' };
    document.body.setAttribute('data-theme', config.theme);
    const container = document.createElement('div'); container.className = 'module-container';
    const header = document.createElement('header'); header.className = 'module-header'; header.innerHTML = `<h2>${config.title}</h2><div class="module-actions"><button class="btn small" id="reset-${currentTab}">Reset</button></div>`;
    const grid = document.createElement('div'); grid.className = 'control-grid';
    if (Modules[currentTab]) {
        const items = Modules[currentTab]();
        items.forEach(comp => { if (Array.isArray(comp)) comp.forEach(c => grid.appendChild(c)); else grid.appendChild(comp); });
    }
    container.appendChild(header); container.appendChild(grid); controlDeck.appendChild(container);
    document.getElementById(`reset-${currentTab}`).onclick = resetModule;
}

function setupAudioInit() {
    const btn = document.getElementById('audio-start-btn'); const statusText = document.querySelector('#audio-status .status-text'); const bpmDisplay = document.getElementById('stat-bpm');
    bpmDisplay.onclick = () => { const val = prompt('BPM:', Math.round(currentBPM)); if (val && !isNaN(val)) { currentBPM = parseFloat(val); if (window.Tone) window.Tone.getTransport().bpm.value = currentBPM; bpmDisplay.textContent = `${Math.round(currentBPM)} BPM`; } };
    btn.addEventListener('click', async () => {
        btn.textContent = 'Initializing...'; btn.disabled = true;
        try {
            const { AudioSystem, Tone: BundledTone } = await import('./audio.bundle.js');
            const Tone = BundledTone || window.Tone;
            if (Tone) { await Tone.start(); if (Tone.context.state === 'suspended') { statusText.textContent = 'Click to Resume'; btn.textContent = 'Resume Audio'; btn.disabled = false; return; } }
            audioSystem = new AudioSystem({ impactPoolSize: 24, bubblePoolSize: 16 });
            await audioSystem.init();
            document.getElementById('audio-status').classList.add('ready'); statusText.textContent = 'Audio Ready';
            btn.style.display = 'none'; document.getElementById('transport-group').classList.remove('hidden');
            startStatsPolling();
        } catch (e) { console.error(e); btn.textContent = 'Start Audio Engine'; btn.disabled = false; }
    });
}

function setupTabNavigation() {
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => { const tabId = item.getAttribute('data-tab'); if (tabId === currentTab) return; document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active')); item.classList.add('active'); currentTab = tabId; updateTabUI(); });
    });
}

function setupGlobalControls() {
    const playPauseBtn = document.getElementById('play-pause-btn'); const muteBtn = document.getElementById('mute-btn'); const masterVol = document.getElementById('master-volume'); const masterVolValue = document.getElementById('master-volume-value');
    playPauseBtn.addEventListener('click', () => { if (!audioSystem) return; isPlaying = !isPlaying; if (isPlaying) { audioSystem.start(); playPauseBtn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`; } else { audioSystem.stop(); playPauseBtn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>`; } });
    masterVol.addEventListener('input', () => { const val = masterVol.value; masterVolValue.textContent = `${val}dB`; updateParam('master.volume', 'effects.masterVolume', parseFloat(val), true); });
    muteBtn.addEventListener('click', () => { state.master.muted = !state.master.muted; if (audioSystem) audioSystem.setMuted(state.master.muted); muteBtn.classList.toggle('active', state.master.muted); markUnsaved(); });
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space') { e.preventDefault(); playPauseBtn.click(); }
        else if (e.code === 'KeyM') { muteBtn.click(); }
        else if (e.ctrlKey && e.code === 'KeyZ') { e.preventDefault(); undo(); }
        else if ((e.ctrlKey && e.code === 'KeyY') || (e.ctrlKey && e.shiftKey && e.code === 'KeyZ')) { e.preventDefault(); redo(); }
        else if (e.code.startsWith('Digit')) { const idx = parseInt(e.code.replace('Digit', '')) - 1; const items = document.querySelectorAll('.nav-item'); if (idx >= 0 && items[idx]) items[idx].click(); }
    });
    setInterval(() => { if (isUnsaved) { localStorage.setItem('rainscape-studio-autosave', JSON.stringify(state)); markSaved(); } }, 30000);
}

function startStatsPolling() {
    setInterval(() => {
        if (!audioSystem) return;
        const stats = audioSystem.getStats();
        document.getElementById('stat-voices').textContent = `Imp:${stats.activeImpactVoices}/24 | Bub:${stats.activeBubbleVoices}/16`;
        const now = performance.now(); const delta = now - lastFrameTime; lastFrameTime = now;
        const cpuLoad = Math.max(0, Math.min(100, Math.round((delta - 100) * 2)));
        document.getElementById('stat-cpu').textContent = `${cpuLoad}%`;
        const bpm = window.Tone?.getTransport()?.bpm?.value || currentBPM;
        document.getElementById('stat-bpm').textContent = `${Math.round(bpm)} BPM`;
    }, 100);
}

document.addEventListener('DOMContentLoaded', () => { setupTabNavigation(); setupAudioInit(); setupGlobalControls(); updateTabUI(); });
