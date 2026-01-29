# RainyDesk Development Roadmap

**Last Updated:** 2026-01-28
**Purpose:** Phase-by-phase development plan

---

## Executive Summary

**Where We Stand:**
- Tauri migration complete (GPU 10–20%, memory ~40MB, sub-second startup)
- Core systems working: 8-bit pixelation, multi-monitor, window detection, audio
- Dual-window architecture: background shader rain + overlay physics rain
- Rainscaper dashboard feature-complete with User/Admin modes

**The Next Challenge:**

- Matter.js treats raindrops as rigid bodies ("hard rocks")
- No native support for fluid dynamics: merging, puddling, flowing
- O(N²) distance checks for particle interaction = performance wall

**The Solution: Pixi Hybrid Engine**
1. **Lagrangian Layer (Rain):** `Float32Array` particles (10× faster than objects)
2. **Eulerian Layer (Puddles):** Cellular automata grid for natural water flow
3. **Pixi.js v8:** WebGPU-accelerated rendering with `ParticleContainer`

**The Path Forward:**
1. **Phase 1**: Tauri Migration → **COMPLETE** ✔
2. **Phase 2**: Pixi Hybrid Engine → Physics/puddles/audio integration
3. **Phase 3**: Visual Polish → Ripples, wet surfaces, possibly reflections
4. **Phase 4**: Audio Refinement → Thunder, spatial audio
5. **Phase 5**: Platform Expansion → Linux (definitely), macOS (maybe)

---

## Completed: Tauri Migration (Phase 1)

**Status: COMPLETE (2026-01-28)**

See `Archive/TAURI-MIGRATION-PLAN.md` for historical details.

### Achievements
- Tauri project structure with Rust backend
- Multi-monitor overlay windows (3 displays, 144Hz)
- Transparent + click-through + always-on-top
- Window detection via Windows API
- System tray with theme-aware icons
- Rainscape persistence (file I/O in Rust)
- Dual-window architecture (HWND_BOTTOM background + always-on-top overlay)
- FPS limiter, volume presets, rainscape quick-select in tray menu
- Bundled fonts (Convergence, JetBrains Mono) — no external requests
- `.rain` file association for rainscape presets
- Formalized AppData structure with autosave support

### Rainscapes Folder Structure
```
%LOCALAPPDATA%\com.rainydesk.app\
├── config.json
├── logs\
└── rainscapes\
    ├── Autosave.rain      ← Always loaded first, overwritten on changes
    ├── Default.rain       ← Fallback if no autosave exists
    └── Custom\            ← User-created presets
```

### Performance Gains
| Metric | Electron | Tauri | Improvement |
|--------|----------|-------|-------------|
| Memory | ~200MB | ~40MB | 80% reduction |
| GPU | 30–40% | 10–20% | 50% reduction |
| Bundle | ~250MB | ~5–10MB | 95% reduction |
| Startup | 2–4sec | <1sec | 75% faster |

---

## Completed: Audio System

**Status: COMPLETE** ✔

See `.dev/AUDIO-SYSTEM.md` for complete documentation.

- TypeScript architecture (VoicePool, ImpactSynthPool, BubbleSynthPool)
- SheetLayer modulated by particle count
- MaterialManager with 7 surface types (all require Sam to fine-tune manually)
- Effects chain: EQ3 → Reverb → Master
- PhysicsMapper for velocity/volume/pitch curves
- Rainscaper integration (60+ parameters)

---

## Phase 2: Mega-Window + Pixi Hybrid Physics (PRIORITY ALPHA)

**Why?** Matter.js can't do fluid dynamics, and multi-window IPC sync is complex. Solution: ONE mega-window spanning all monitors with a void mask for gaps.

**Key documentation:**
- `.dev/MEGA-WINDOW-ARCHITECTURE.md` — Full architecture, math, diagrams
- `.dev/PIXI-PHYSICS-MIGRATION-PLAN.md` — Simulation details
- `.dev/PIXI-TONE-HYBRID-AUDIO-ENGINE.md` — Audio integration

### Phase 2a: Rust — Mega-Window Infrastructure

- [ ] Add `VirtualDesktop` struct (bounding box + monitor regions + primary index)
- [ ] Add `get_virtual_desktop` command with proper work area detection
- [ ] Add `get_primary_monitor_index` using Windows API
- [ ] Replace multi-window creation with `create_mega_overlay` (single always-on-top)
- [ ] Replace multi-window background with `create_mega_background` (single HWND_BOTTOM)
- [ ] Update window detection to emit global coordinates

### Phase 2b: Renderer — Void Mask & Spawn Logic

- [ ] Receive `VirtualDesktop` from Rust, build void mask
- [ ] Compute spawn map (per-column topmost non-void Y)
- [ ] Compute floor map (per-column work area bottom)
- [ ] Update `GridSimulation` constructor to accept `VirtualDesktop`
- [ ] Add `CELL_VOID` constant, treat as solid wall
- [ ] Rain spawns only in valid columns (respects spawn map)
- [ ] Puddles drain at floor level (~2% per 30Hz tick)

### Phase 2c: Cellular Automata — Puddle Flow

- [ ] Implement Noita-style flow rules (down → down-diagonal → horizontal)
- [ ] Wall adhesion for dribble effect (30% stick chance)
- [ ] Void boundaries block flow (same as windows)
- [ ] Cross-monitor waterfall effect (water finds "ledges")

### Phase 2d: Audio — Spatial Positioning

- [ ] Single audio context on mega-window (no duplicates)
- [ ] Stereo pan from global X coordinate
- [ ] Future: 5.1/7.1 via `PannerNode` with HRTF mode

### Phase 2e: Integration & Cleanup

- [ ] Remove per-monitor renderer logic
- [ ] Remove Matter.js A/B toggle (Pixi only)
- [ ] Position Rainscaper on primary monitor region
- [ ] Handle hot-swap monitors (destroy + recreate mega-windows)

**Performance targets:**
- 744K grid cells (Sam's setup) at 0.25 scale
- <3% CPU for cellular automata (30Hz)
- <10% GPU for Pixi rendering
- ~1.7 MB simulation state

### Model & Agent Recommendations

| Phase | Recommended Model | Rationale |
|-------|-------------------|-----------|
| **2a: Rust Infrastructure** | Opus | Architectural decisions, Windows API, new structs |
| **2b: Void Mask & Spawn** | Sonnet | Math is documented, straightforward implementation |
| **2c: Cellular Automata** | Opus → Sonnet | Opus for flow rules & edge cases, Sonnet for tuning |
| **2d: Audio Spatial** | Sonnet | Existing audio system, simple X→pan mapping |
| **2e: Integration** | Sonnet | Cleanup/removal work, Opus if issues arise |

**Agent recommendations:**
- **Explore agent:** Use before each phase to find existing patterns (e.g., "how does current window detection work?")
- **Code review agent:** Run after completing each phase to catch bugs before testing
- **Plan agent:** If stuck on a phase, use to break it into smaller steps

**General workflow:**
1. Start session with Sonnet + Explore agent to gather context
2. Switch to Opus for architectural decisions or debugging complex issues
3. Return to Sonnet for implementation once approach is clear
4. Use code review agent before manual testing

---

## Phase 3: Visual Polish (PRIORITY BRAVO)

**Depends on:** Phase 2 completion (Pixi renderer)

### Phase 3a: Background Rain Layer

**Status: COMPLETE (2026-01-28)**

- `BackgroundRainShader.js` — Procedural fragment shader
- Layered value noise for rain streaks (1–5 layers)
- Wind parameter for rain angle
- Runs at HWND_BOTTOM (behind all windows)

### Phase 3b: Ripple Effects

**Goal:** Shader-based ripples when drops hit surfaces.

**Implementation:**
- Pass impact positions to shader as uniform array (max 16–32)
- Expanding ring animation per impact
- Fade over 1 second
- Layer over window surfaces via depth buffer

### Phase 3c: Wet Surface Effects

**Goal:** Surfaces show wetness after rain accumulation.

**Features:**
- Slight reflectivity increase
- Cool blue tint
- Subtle displacement for water film
- Persists until rain stops for 30+ seconds

**Depends on:** Puddle layer from Phase 2 providing accumulation data.

---

## Phase 4: Audio Polish (PRIORITY CHARLIE)

### Phase 4a: Thunder System

**Proposed architecture:**
- `ThunderSynthPool.ts` — Dedicated pool (2–3 voices)
- Perlin noise pitch sweep (low rumble → high crack)
- Random intervals based on rain intensity
- Spatial panning via LFO modulation

**Files to create:**
- `src/renderer/audio/ThunderSynthPool.ts`
- Add `thunder` config to MaterialManager
- Rainscaper Thunder section

### Phase 4b: Spatial Audio (Future)

**Goal:** 3D positioning of rain sounds.

**Features:**
- Per-monitor channel mapping
- Fullscreen on one monitor muffles only that channel
- 3D cube UI for positioning rain origin
- Dolby Atmos / spatial audio compatibility

### Phase 4c: Material Expansion

**Current:** Only glass has full sound design.

**Planned materials:**
- Tin roof (metallic ring)
- Concrete (dull thud)
- Leaves/foliage (rustling)
- Fabric/awning (muted soft)
- Wood (warm dampened)

---

## Phase 5: Platform Expansion (PRIORITY DELTA)

### Phase 5a: Linux Support

**Target:** Lenovo Legion 5 (Linux Mint)

- WebKitGTK backend testing
- Window detection via X11/Wayland APIs
- PulseAudio/PipeWire compatibility
- AppImage or .deb packaging

### Phase 5b: macOS Support

**Target:** 2020 M1 Mac Mini

- WKWebView backend
- `macOSPrivateApi` for click-through transparency
- Retina display scaling
- CoreAudio output
- App signing & notarization

### Phase 5c: Distribution

- Windows code signing
- Tauri auto-update mechanism
- GitHub releases pipeline
- Installer customization

---

## Implementation Summary

| Phase | Priority | Status | Blocker |
|-------|----------|--------|---------|
| 1: Tauri Migration | — | **COMPLETE** | — |
| 2: Pixi Hybrid Engine | ALPHA | Not Started | None |
| 3: Visual Polish | BRAVO | 3a Complete | Phase 2 |
| 4: Audio Polish | CHARLIE | Not Started | None |
| 5: Platform Expansion | DELTA | Not Started | Phase 2 |

**Critical Path:** Phase 2 (Pixi) → Phase 3 (Visual) → Phase 4 (Audio) → Phase 5 (Platforms) → Release

---

## Key Documentation

| Document | Purpose |
|----------|---------|
| `PIXI-PHYSICS-MIGRATION-PLAN.md` | Hybrid engine architecture |
| `PIXI-TONE-HYBRID-AUDIO-ENGINE.md` | Audio integration spec |
| `GEMINI-FINAL-PIXI-NOTES.md` | Implementation checklist |
| `AUDIO-SYSTEM.md` | Current audio architecture |
| `SHADER-RESEARCH.md` | Rain World, Noita techniques |
| `RAIN-SYNTH.md` / `RAIN-SYNTH-2.md` | Acoustic physics reference |

---

## Long-Term Features

### Physics
- Water pooling on window tops
- Drip dynamics (accumulation triggers streams)
- Freeze mode (pause physics, windows push frozen drops)
- Gravity reversal (rain falls upward)

### Visuals
- Rain pixel shape modes (circles → tapered streaks)
- Pooled water reflections
- Dynamic wetness textures

### Audio
- Full spatial surround (Atmos support)
- Per-surface thunder enable/disable
- Drip-specific audio signature
