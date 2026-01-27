# RainyDesk Development Roadmap

**Last Updated:** 2026-01-27
**Purpose:** Detailed phase-by-phase development plan

---

## Executive Summary

**Where We Stand:**
- Core functionality feature-complete (physics, audio, UI, multi-monitor)
- All major systems working (8-bit pixelation, fullscreen detection, audio effects, window detection)
- Audio architecture production-ready (voice pooling, material manager, effects chain)
- Rainscaper dashboard feature-complete with User/Admin modes

**The Bottleneck:**
- GPU usage: 15-30% (Electron's Chromium compositor overhead on transparent windows)
- This is **not a WebGL problem** (only 2 draw calls/frame) - it's Electron's core architecture
- Research shows **Tauri reduces GPU to <5%** via native Windows compositor

**The Path Forward:**
1. **Phase 1**: Migrate to Tauri -> **Expected: 80% memory reduction, <5% GPU**
2. **Phase 2**: Visual polish -> Background rain shader, ripple effects
3. **Phase 3**: Audio refinement -> Thunder system, parameter audit
4. **Phase 4+**: Physics expansion -> Water pooling, drips, wet surfaces

**Parallel Work:** Phase 2 visual polish can begin during Phase 1 Tauri migration (frontend code is portable).

---

## Completed: Audio System (Phases 1-4.5)

**See `.dev/AUDIO-SYSTEM.md` for complete documentation.**

- Phase 1: TypeScript infrastructure (tsconfig.json, src/types/, esbuild)
- Phase 2: Core audio engine (VoicePool, ImpactSynthPool, BubbleSynthPool, SheetLayer, PhysicsMapper, MaterialManager)
- Phase 3: AudioSystem orchestrator with effects chain
- Phase 4: Rainscaper TypeScript rewrite (User/Admin modes, reactive state)
- Phase 4.5: Matter.js integration (collision -> audio params)

---

## Phase 1: Tauri Migration (PRIORITY ALPHA)

**Why Tauri?** Research shows Electron's Chromium compositor causes inherent GPU overhead on transparent windows (3 monitors x 144Hz = 432 composite ops/sec). WebView2-based Tauri uses native Windows compositor instead.

**Expected Performance Gains:**
- Memory: ~200MB (Electron) -> ~40MB (Tauri) = **80% reduction**
- Bundle: ~250MB (Electron) -> ~5-10MB (Tauri) = **95% reduction**
- Startup: 2-4sec -> <1sec
- GPU: 15-30% (Electron) -> <5% (native compositor, not Chromium)

**See `.dev/TAURI-MIGRATION-PLAN.md` for detailed blueprint.**

### Phase 1a: Foundation (COMPLETE - 2026-01-27)

**Completed:**
- Tauri project structure (`src-tauri/`, Cargo.toml, tauri.conf.json)
- Tauri API shim (`src/renderer/tauri-api.js`) - mirrors Electron preload API
- Multi-monitor overlay windows (all 3 displays working)
- Transparent + click-through + always-on-top windows
- Rust IPC commands (log_message, get_config, save/load_rainscape, etc.)
- Window detection via Windows API (src-tauri/src/window_detector.rs)
- 144 FPS rendering, audio system working across monitors
- **Window zone coordinate conversion** - global -> per-monitor local coords
- **Cross-monitor window clipping** - windows spanning monitors create zones on each
- **Phantom window filtering** - minimized windows, suspended UWP apps, system overlays
- **File-based logging** - logs to `%LOCALAPPDATA%\com.rainydesk.app\logs\RainyDesk.log`
- **System tray with context menu** - Pause/Resume, Open Rainscaper, Quit
- **Theme-aware tray icon** - white icon on dark taskbar, black on light
- **Rainscaper panel interactivity** - click-through disabled when panel open
- **Electron fully removed** - all `src/main/`, `src/preload/`, forge.config.js deleted
- **Package.json cleaned** - Tauri-only dependencies (200+ fewer packages)
- **Rainscape persistence** - proper file I/O in Rust backend
- **Dual-window architecture** - background windows (HWND_BOTTOM) + overlay windows

**GPU Performance Improvement:**
- GPU usage now 10-20% (down from 30-40% in Electron)
- Sawtooth pattern observed; may be compositor-related

**Known Issues (for next session):**
- Rainscaper panel positioning - sits too low, overlaps Windows taskbar
- Click-through behavior janky - need to toggle window after clicking away
- Background rain parameter sync needs testing (intensity/wind/toggle to background windows)
- Audio collision errors - Tone.js timing (non-critical)

**Remaining for Phase 1:**
- Display change events (hot-plug monitors) - skipped for now
- FPS limiter option in Rainscaper (30/60/120/144/uncapped)

### Phase 1b: Frontend Parity
- Migrate WebGL renderer (no changes needed, still runs in WebView2)
- Migrate Rainscaper UI (React/TypeScript, should work as-is)
- Migrate Audio system (Tone.js via WebView2)
- Set up localStorage for settings persistence

### Phase 1c: Testing & Cutover
- Multi-monitor testing on 3 displays
- Audio sync across monitors
- Fullscreen detection
- System tray icon with theme-aware switching (completed in 1a)
- Build & package for Windows

### Phase 1d: Platform Expansion
- Linux support (WebKitGTK, test on Lenovo Legion 5)
- macOS support (WKWebView, requires `macOSPrivateApi` for click-through)

---

## Phase 2: Visual Polish (PRIORITY BRAVO)

**Shader research complete.** See `.dev/SHADER-RESEARCH.md` for comprehensive analysis of Rain World, Noita, and pixel art water techniques.

### Phase 2a: Background Rain Layer (IN PROGRESS - 2026-01-27)

Add a shader-based atmospheric rain layer that runs behind physics particles.

**Completed:**
- `src/renderer/webgl/BackgroundRainShader.js` created
  - Full-screen quad with procedural fragment shader
  - Uses layered value noise for rain streaks (1-5 configurable layers)
  - Animated via time uniform with speed multiplier
  - Wind parameter slants rain direction
  - Intensity linked to physics intensity setting
- `WebGLRainRenderer.js` updated
  - Background rain renders FIRST (behind physics particles)
  - Uses same low-res framebuffer for consistent pixelated aesthetic
  - API: `setBackgroundRainConfig()`, `setBackgroundRainIntensity()`, `setBackgroundRainWind()`
- **Dual-window architecture** (2026-01-27)
  - Background windows at `HWND_BOTTOM` (desktop level, behind all apps)
  - Overlay windows (always-on-top) for physics rain
  - Separate `background-renderer.js` and `background.html` for minimal footprint
  - Background mode: WebGL shader only (no physics, audio, or Rainscaper UI)
- `PhysicsSection.ts` updated
  - Admin mode: "Background Rain" control group with enable toggle
  - Intensity slider controls layers (1-5), speed (0.5x-1.5x), and shader opacity
- IPC parameter sync: background windows listen for `update-rainscape-param` events

**Shader technique:**
- Single full-screen pass (~1-3% GPU)
- Hash-based value noise (no texture sampling)
- Multiple depth layers with parallax effect
- Wind affects UV slant for natural rain angle
- Falls faster than physics drops (25x scroll speed) for atmospheric effect

**Remaining issues:**
- Verify parameter sync reaches background windows (intensity, wind, toggle)
- Test enable/disable toggle functionality

**Benefits:**
- Adds atmosphere without physics cost
- True z-layering (behind all windows, above wallpaper)
- Complements pixelated aesthetic
- Linked to Sheet audio layer conceptually

### Phase 2b: Ripple Effects on Surfaces

When physics drops hit windows, trigger shader-based ripples.

**Implementation:**
1. Pass impact positions to shader as uniform array (max 16-32 simultaneous)
2. Each impact spawns expanding ring animation
3. Fade out over 1 second
4. Layer over window surfaces only (use depth buffer)

**Technical approach:**
- Ring equation: `distance - (time * speed)` -> step mask for clean ripples
- Apply distortion to surface texture via normal offset
- Efficient: parallel processing of all rings in single pass

**Files to create:**
- Update `WebGLRainRenderer.js` - Add ripple layer
- Update `physicsSystem.js` - Queue impacts for shader

### Phase 2c: Wet Surface Glow (Optional)

After rain accumulation, surfaces show wetness:
- Slight reflectivity increase (mirror effect)
- Cool blue tint
- Subtle displacement for "water film"

**Depends on:** Completion of background rain layer + ripple effects.

---

## Phase 3: Audio Polish (PRIORITY CHARLIE)

### Phase 3a: Thunder Implementation

**Open research questions** (from Copilot notes):
- Realistic thunder synthesis using Tone.js?
- Part of voice pool or separate system?
- Random timing or intensity-based frequency?
- Spatial audio (specific direction vs omnidirectional)?
- Rainscape-dependent (disable on glass, enable on tin roof)?

**Proposed approach:**
1. Dedicated `ThunderSynthPool` class (max 2-3 voices, infrequent)
2. Perlin noise-based pitch sweep (low rumble -> high crack)
3. Random intervals based on rain intensity
4. Spatialize via pan LFO modulation
5. Add to material configs (enable/disable per surface)

**Files to create:**
- `src/renderer/audio/ThunderSynthPool.ts`
- Add `thunder` property to `MaterialConfig`
- Update `Rainscaper` UI: Thunder section in Effects tab

### Phase 3b: Rainscaper Parameter Audit (COMPLETE - 2026-01-25)

**Completed:**
- Audited AudioSystem.ts exports vs Rainscaper controls
- Fixed ImpactPoolSection path mismatch (`attackTime` -> `attack`)
- Added filter range controls (`filterFreqMin`, `filterFreqMax`) to ImpactPoolSection
- Added envelope controls (`attack`, `decayMin`, `decayMax`) to BubblePoolSection
- Added `square` and `sawtooth` oscillator options to bubble waveform dropdowns
- Created PhysicsMapperSection (9 params: velocity/volume mapping, Minnaert, decay scaling)
- Created SystemSection (fadeInTime, fadeOutTime, enableVoiceStealing)
- Updated AudioSystem.updateParam for `physicsMapper.*` and `system.*` paths
- Added VoicePool.setVoiceStealing() method
- Admin mode now has 8 tabs: Material, Impact, Bubble, Sheet, Mapper, Effects, Physics, System

**Files created:**
- `src/renderer/rainscaper/sections/PhysicsMapperSection.ts`
- `src/renderer/rainscaper/sections/SystemSection.ts`

**Files modified:**
- `src/renderer/audio/AudioSystem.ts` - new path handlers
- `src/renderer/audio/VoicePool.ts` - setVoiceStealing method
- `src/renderer/audio/ImpactSynthPool.ts` - getSynthConfig method
- `src/renderer/audio/BubbleSynthPool.ts` - extended oscillator types
- `src/renderer/rainscaper/Rainscaper.ts` - integrated new sections
- `src/renderer/rainscaper/RainscaperState.ts` - added mapper/system tabs
- `src/renderer/rainscaper/sections/*.ts` - various fixes
- `src/types/audio.ts` - BubbleOscillatorType expanded

### Phase 3c: Selector Testing

Material selector, preset selector, and advanced controls need QA pass.

**Tests:**
- Switching materials updates audio immediately
- Saving custom presets works
- Loading presets restores all parameters
- Admin/User mode toggle preserves state

---

## Phase 4: Physics System Expansion (FUTURE)

**Gating Criteria:** Tauri migration complete, visual polish done, performance stable on all 3 monitors.

**Goal:** Transform basic rain physics into an advanced 2D water simulation with pooling, accumulation, and flow dynamics.

**Approach:** "8-Bit Pixelated Water" - Simulate physics at 25% resolution (matches framebuffer scale), upscale rendering for aesthetic. Lower resolution makes complex fluid dynamics feasible without performance cost.

**Technical Architecture (CPU-based, inspired by Noita):**
- World divided into 64x64 chunks
- Each chunk tracks "dirty rect" (only update changed cells)
- Simple cellular automata rules per material type
- Gravity, wind force, density-based settling
- Integration with existing Matter.js rigid bodies

### Phase 4a: Water Pooling & Flow

**Key Features:**
1. Water accumulates on window tops instead of bouncing off
2. Gravity causes water to flow down sides realistically
3. Wind can blow water sideways (no more "umbrella effect")
4. Multiple puddles interact (merge when adjacent)

**Implementation:**
- Add water-specific cellular automata rules
- Integrate with `physicsSystem.js` window zone detection
- Render pooled water as additional WebGL layer (separate from particle drops)
- Support for multiple surface materials (wood absorbs, glass reflects, etc.)

**Files to create/modify:**
- `src/renderer/physicsSystem.js` - Add water state grid + CA rules
- `src/renderer/webgl/WaterPoolRenderer.js` - Render pooled water
- `src/renderer/rainscaper/sections/PhysicsSection.ts` - Water simulation controls

### Phase 4b: Drip Dynamics

**Features:**
- Water accumulation triggers procedural drip events
- Drips fall in streams, creating splashes below
- Drips modulate audio (different timbre than direct rain)
- Works on any window edge, not just tops

**Technical approach:**
- Track water volume per window zone
- Threshold: when volume > X, spawn drip particle stream
- Drips register collisions separately (lighter audio signature)
- Pool below catches drips, accumulates again

**Files to modify:**
- `src/renderer/physicsSystem.js` - Drip spawning logic
- `src/renderer/audio/AudioSystem.ts` - Drip collision mapping

### Phase 4c: Advanced Visualization

**Visual enhancements:**
1. **Rain Pixels** - Replace circles with tapered streaks when pooled
   - At terminal velocity: full teardrop trail
   - In water: blocky "rain pixels" squashing together
   - Procedurally generated based on density

2. **Reflection Effects** - Pooled water reflects sky/environment
   - Subtle, not photorealistic (fits pixelated aesthetic)
   - Uses flipped sprite rendering (Rain World technique)

3. **Surface Wetness** - Surfaces show increasing wetness over time
   - Tint shift (cool blue)
   - Slight glossiness increase
   - Persists until no rain for 30+ seconds

**Files to create/modify:**
- `src/renderer/webgl/WebGLRainRenderer.js` - New particle shape modes
- `src/renderer/webgl/ReflectionRenderer.js` - Pooled water reflections
- Add wetness texture layer to window detection

### Phase 4d: Performance Validation

**Must maintain:**
- 144 FPS on primary monitors
- 100 FPS on vertical monitor
- <5% CPU per monitor (pooling calculation)
- <5% GPU (water rendering)
- <300MB memory total

**Benchmarking:**
- Profile with 3 monitors, max rain intensity
- Test with multiple window types (floating, tiled, fullscreen)
- Stress test with 10+ seconds of continuous rain

**Fallback:** If performance drops, implement LOD system:
- Reduce pooling simulation on secondary monitors
- Disable drip simulation on battery power
- Lower water surface resolution on older GPUs

---

## Phase 5: Platform Support & Polish (Post-Release)

### Phase 5a: Linux Support

Lenovo Legion 5, Mint:
- Test window detection on Linux APIs
- Verify WebGL on integrated GPU
- Package as AppImage or .deb
- Audio setup (PulseAudio/ALSA compatibility)

### Phase 5b: macOS Support

M1 Mac Mini:
- Test transparent windows on macOS
- Verify high-DPI rendering (Retina display)
- Audio output (CoreAudio)
- App signing & notarization for distribution

### Phase 5c: UI Polish

- Keyboard navigation in Rainscaper (Tab/Arrow keys)
- High contrast mode detection + adjustment
- Screen reader support (ARIA labels)
- Custom titlebar styling

### Phase 5d: Distribution & Auto-Update

- Code signing for Windows installer
- Auto-update mechanism (Tauri native)
- GitHub releases pipeline
- Installer customization

---

## Implementation Summary

| Phase | Priority | Status | Blocker |
|-------|----------|--------|---------|
| 1: Tauri Migration | ALPHA | In Progress | None |
| 2: Visual Polish | BRAVO | In Progress (2a) | None |
| 3: Audio Polish | CHARLIE | In Progress | None |
| 4: Physics Expansion | DELTA | Design Complete | Phase 1,2,3 done |
| 5: Platform Support | ECHO | Design Complete | Phase 1 done |

**Critical Path:** Phase 1 (Tauri) -> Phase 2 (Visual) -> Phase 3 (Audio) -> Phase 4 (Physics) -> Release

---

## Planned Features (Long-Term)

### Audio System Enhancements

**Manual Controls (in addition to rainscape selection):**
- 3-band EQ (low/mid/high) - filter controls exist, not true EQ yet
- Reverb with wetness slider (IMPLEMENTED)
- Thunder controls (volume, frequency, intensity) - NOT IMPLEMENTED
- Gravity reversal: Optional reversed audio playback when rain goes upwards (future)
- Full spatial surround sound support:
  - Must work with Dolby Atmos for Headphones and similar digital spatial solutions
  - **3D Cube UI**: Simple 2D render of a 3D cube letting user position where rain sounds originate
    - Behind/Above/In front
    - Left/Right sides
    - Ground/substrate (for splash sounds)
  - Intuitive drag-to-position interface
  - **Per-monitor channel muffling**: On multi-monitor setups, fullscreen on one monitor should muffle only the corresponding audio channel(s), not all audio globally

**Built-in Rainscapes** (surface types that adjust procedural parameters):
- Glass/windows (default) - IMPLEMENTED
- Tin roof - planned
- Concrete - planned
- Leaves/forest floor - planned
- Other roof types (shingles, tile, metal, wood) - planned
- Grass, Dirt, Mud - planned
- Open air - planned

### Visual Features (Future)
- **Raindrop trails**: Toggle/adjust the gradient trail effect
- **Gravity reversal**: Make rain go upwards instead of down (fun experimental mode)
- **Windowsill water accumulation**: Pooling water on window tops with drip physics

### Platform Support
- **Phase 1**: Windows (current) - IMPLEMENTED
- **Phase 2**: Linux (user's Lenovo Legion 5 laptop runs Mint)
- **Phase 3**: macOS (user has 2020 M1 Mac Mini, 8GB RAM, 512GB SSD)
