/**
 * Wikipedia URL Mapping for Audio Technical Terms
 * Manually curated links to specific Wikipedia articles/sections.
 */
export const WIKI_MAP = {
    // General Audio
    "Volume": "https://en.wikipedia.org/wiki/Loudness",
    "Gain": "https://en.wikipedia.org/wiki/Gain_(electronics)",
    "Pan": "https://en.wikipedia.org/wiki/Panning_(audio)",
    "Stereo Width": "https://en.wikipedia.org/wiki/Stereophonic_sound#Stereo_width",
    "Mute": "https://en.wikipedia.org/wiki/Mute_(electronics)",
    "Solo": "https://en.wikipedia.org/wiki/Solo_(music)",
    "BPM": "https://en.wikipedia.org/wiki/Tempo",
    
    // Synthesis Basics
    "Oscillator": "https://en.wikipedia.org/wiki/Electronic_oscillator",
    "Sine": "https://en.wikipedia.org/wiki/Sine_wave",
    "Triangle": "https://en.wikipedia.org/wiki/Triangle_wave",
    "Square": "https://en.wikipedia.org/wiki/Square_wave",
    "Sawtooth": "https://en.wikipedia.org/wiki/Sawtooth_wave",
    "Pulse Width": "https://en.wikipedia.org/wiki/Pulse-width_modulation",
    "Harmonics": "https://en.wikipedia.org/wiki/Harmonic",
    "FM": "https://en.wikipedia.org/wiki/Frequency_modulation_synthesis",
    "Envelope": "https://en.wikipedia.org/wiki/Envelope_(music)",
    "Attack": "https://en.wikipedia.org/wiki/Envelope_(music)#ADSR",
    "Decay": "https://en.wikipedia.org/wiki/Envelope_(music)#ADSR",
    "Sustain": "https://en.wikipedia.org/wiki/Envelope_(music)#ADSR",
    "Release": "https://en.wikipedia.org/wiki/Envelope_(music)#ADSR",
    
    // Noise Types
    "White Noise": "https://en.wikipedia.org/wiki/White_noise",
    "Pink Noise": "https://en.wikipedia.org/wiki/Pink_noise",
    "Brown Noise": "https://en.wikipedia.org/wiki/Brownian_noise",
    
    // Filters
    "Filter": "https://en.wikipedia.org/wiki/Audio_filter",
    "Cutoff": "https://en.wikipedia.org/wiki/Cutoff_frequency",
    "Resonance": "https://en.wikipedia.org/wiki/Q_factor",
    "Q": "https://en.wikipedia.org/wiki/Q_factor",
    "Filter Q": "https://en.wikipedia.org/wiki/Q_factor",
    "Lowpass": "https://en.wikipedia.org/wiki/Low-pass_filter",
    "Highpass": "https://en.wikipedia.org/wiki/High-pass_filter",
    "Bandpass": "https://en.wikipedia.org/wiki/Band-pass_filter",
    "Notch": "https://en.wikipedia.org/wiki/Band-stop_filter",
    "Formant": "https://en.wikipedia.org/wiki/Formant",
    "F1": "https://en.wikipedia.org/wiki/Formant#Formants_and_phonetics",
    "F2": "https://en.wikipedia.org/wiki/Formant#Formants_and_phonetics",
    "F3": "https://en.wikipedia.org/wiki/Formant#Formants_and_phonetics",
    
    // Effects
    "Reverb": "https://en.wikipedia.org/wiki/Reverberation",
    "Delay": "https://en.wikipedia.org/wiki/Delay_(audio_effect)",
    "Echo": "https://en.wikipedia.org/wiki/Echo",
    "Feedback": "https://en.wikipedia.org/wiki/Audio_feedback",
    "Distortion": "https://en.wikipedia.org/wiki/Distortion_(music)",
    "BitCrusher": "https://en.wikipedia.org/wiki/Bitcrusher",
    "Sample Rate": "https://en.wikipedia.org/wiki/Sampling_(signal_processing)",
    "Compressor": "https://en.wikipedia.org/wiki/Dynamic_range_compression",
    "Limiter": "https://en.wikipedia.org/wiki/Limiter",
    "Threshold": "https://en.wikipedia.org/wiki/Dynamic_range_compression#Threshold",
    "Ratio": "https://en.wikipedia.org/wiki/Dynamic_range_compression#Ratio",
    "Sidechain": "https://en.wikipedia.org/wiki/Dynamic_range_compression#Side-chaining",
    
    // Physics & Rain Specific
    "Minnaert": "https://en.wikipedia.org/wiki/Minnaert_resonance",
    "Strouhal": "https://en.wikipedia.org/wiki/Strouhal_number",
    "Aeolian": "https://en.wikipedia.org/wiki/Aeolian_sound",
    "Katabatic": "https://en.wikipedia.org/wiki/Katabatic_wind",
    "Tortuosity": "https://en.wikipedia.org/wiki/Tortuosity",
    "N-Wave": "https://en.wikipedia.org/wiki/N-wave",
    "Graupel": "https://en.wikipedia.org/wiki/Graupel",
    "Doppler": "https://en.wikipedia.org/wiki/Doppler_effect",
    "Chebyshev": "https://en.wikipedia.org/wiki/Chebyshev_filter",
    "Chorus": "https://en.wikipedia.org/wiki/Chorus_effect",
    "Absorption": "https://en.wikipedia.org/wiki/Absorption_(acoustics)",
    "Spatial": "https://en.wikipedia.org/wiki/3D_audio_effect",
    "Muffling": "https://en.wikipedia.org/wiki/Muffler",
    "Ducking": "https://en.wikipedia.org/wiki/Ducking",
    "Harmonicity": "https://en.wikipedia.org/wiki/Frequency_modulation_synthesis#Harmonicity_ratio"
};

/**
 * Get the best matching Wikipedia URL for a given label.
 */
export function getWikiUrl(label) {
    if (WIKI_MAP[label]) return WIKI_MAP[label];
    let clean = label.replace(/\s\([a-zA-Z%]+\)$/, '');
    if (WIKI_MAP[clean]) return WIKI_MAP[clean];
    if (clean.includes('→')) {
        const suffix = clean.split('→').pop().trim();
        if (WIKI_MAP[suffix]) return WIKI_MAP[suffix];
        if (suffix.includes("Freq")) return WIKI_MAP["Cutoff"];
        if (suffix.includes("Decay")) return WIKI_MAP["Decay"];
    }
    const words = clean.split(' ');
    for (const word of words) { if (WIKI_MAP[word]) return WIKI_MAP[word]; }
    if (clean.includes("Filter")) return WIKI_MAP["Filter"];
    if (clean.includes("LFO")) return "https://en.wikipedia.org/wiki/Low-frequency_oscillation";
    if (clean.includes("Harm")) return WIKI_MAP["Harmonics"];
    return `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(clean)}`;
}
