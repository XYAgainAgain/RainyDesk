#  🌧️ RainyDesk 💻

Ever wish it could rain on your desktop? Now it can, and you can use windows as umbrellas. ☔

RainyDesk is a peaceful desktop rain simulator that overlays semi-realistic rain on all your monitors. It's transparent, click-through, and never gets in your way — just some nice moist ambiance while you work, game, write, vibe, or relax.

## What does it do?

It makes it rain on your screen! That's pretty much it! Physics-based raindrops fall across all your monitors, splash when they hit the bottom (or the tops of your windows), and sound like actual rain. You can adjust how heavy the rain is, how it sounds, and way, waaaay more.

**Perfect for:**

- *Working & vibing in a cozy atmosphere*
- *Focus assistance when studying or reading*
- *Relaxing without leaving your desk*
- *Pretending it's a rainy day when it's not and you're annoyed about it*

## Current Status

RainyDesk is in active development and I'm really not rushing it because it's my first big non-website project. The core experience is working nicely — rain physics simulation, mathematically correct audio synthesis, and a painfully detailed control panel (defaults to easy mode, don't worry).

**What Works:**

- Rain falls on all your monitors (including vertical/rotated ones)
- Realistic physics with splishysplashies on the tops/sides of windows + the taskbar
- Click-through transparency (rain never blocks your mouse)
- System tray controls for intensity and volume
- High refresh rate support (anywhere from 60–240Hz!)
- Window detection; rain flows around your windows unless maximized, and if it's maximized, it's muffled!
- Tray icon! Left-click to open Rainscaper panel or right-click to open a small context menu (Pause/Resume, Open Rainscaper, Volume Presets, & Quit RainyDesk)
- **Rainscaper control panel** — tweak everything from rain intensity to audio materials
- **Rainscape preset system** — save and load your perfect rainy day vibes
- **Procedural audio synthesis** — voice-pooled impact sounds, bubble effects, and background sheet noise
- **7 audio materials** — Glass, Metal, Wood, Concrete, Fabric, Foliage, Water (each sounds different!)
- **Background rain** — atmospheric rain layers behind your windows with no physics, but really sells the effect
- **Render scale options** — pixelated 8-bit aesthetic or crispy full-res circles, your choice! Lower render scale is lighter on the graphics card, but it all sounds the same!
- **Gentle fade-in on startup** — no jump-scares from fake water

**What's Coming:**

- ***Thunder synth!*** Because we *gotta* have the booms! ⛈
- Much improved water physics with surface tension, cohesion/adhesion, dripping, pooling, and all that juicy fluid stuff (hopefully at a relatively low render cost)
- 3D spatial audio with full 5.1/7.1 surround sound support (like Dolby Atmos for Headphones — rain all around you!)
- More visual effects (adjustable trails, colors, droplet styles)
- Maybe per-window surface materials (imagine rain sounding different on each app)
- Auto-launch on startup/login to immediately soak your desktop
- Linux support (I pinkie promise!) and maybe MacOS later
- A nice easy installer & decent app size (<350 MB)
- Snow? 🌨👀

## Installation

RainyDesk isn't released just yet, but you can run it from source if you're cool. Download the project as a ZIP, extract anywhere you like, then open a `cmd` terminal in that directory and do these lil guys to make yourself an executable:

```bash
npm install
npm run tauri dev
```

Pre-built installers coming once it's more polished!

## Requirements

- Windows 10/11 (Linux support coming eventually, X11-window manager only)
- An audio device such as headphones, earbuds, or speakers (preferably with surround sound)
- At least one monitor lmao

## How to use it

Once running, RainyDesk sits in your system tray. Right-click the icon for quick controls, or press the hotkey to open the Rainscaper panel. The rain is always there, transparent and out of the way, until you want to adjust it.

## Why does this exist?

Sometimes you just want it to rain. I know I sure do. This scratches that itch.

## How It Works (ELI5) 🧒

Imagine your entire desktop — all your monitors — as one big invisible grid, like graph paper. RainyDesk draws a single giant transparent window over everything and makes it rain on that grid.

**The magic:**
- **Void mask:** Gaps between your monitors? Those are "walls" that rain can't pass through.
- **Spawn map:** Rain only falls from the top of each monitor, not from empty space.
- **Puddles:** When rain hits something, it turns into water that spreads out like a real puddle.
- **Waterfalls:** If your monitors are at different heights, puddles can spill over the edge and cascade down to the lower monitor. 🌊

**What makes it feel real:**
- Drag a window over a puddle? *Splash!* Half the water vanishes, half goes flying sideways.
- Close a window with water on it? The puddle falls and splashes on whatever's below.
- Go fullscreen for a game? Rain hides on that screen but keeps falling on your others.

It's like having a tiny water park on your desktop, except you can't get wet.

## Technical Details 🔧

For big nerds: RainyDesk is built with Tauri (Rust backend + WebView2), Pixi.js v8 rendering, and Tone.js audio synthesis.

**Architecture:**
- ONE mega-overlay window spans your entire virtual desktop (all monitors)
- ONE mega-background window renders atmospheric rain behind everything
- Void mask treats gaps between monitors as solid walls
- Hybrid physics: Lagrangian particles (rain) + Eulerian grid (puddles)
- Cellular automata for natural water flow (Noita-style!)
- Spatial audio: rain position → stereo pan (5.1/7.1 coming later)

## Third-Party Libraries

- [Tauri](https://tauri.app) (v2) — MIT License — Desktop app framework
- [Pixi.js](https://pixijs.com) (v8) — MIT License — GPU-accelerated rendering
- [Tone.js](https://tonejs.github.io) (v15.1.22) — MIT License — Audio synthesis

## License

RainyDesk is currently source-available under the Business Source License 1.1 (BSL-1.1). That means you are welcome to use, tinker with, and modify RainyDesk for personal, educational, and non-commercial purposes. I've chosen BSL so I can keep the project freely available while preventing third parties from repackaging and selling it as a commercial product without permission. Don't want that, now do we?

>  **Change Date: 2029-01-01** — on or after this date RainyDesk will automatically be relicensed under the MIT License, making it fully permissive and open-source.

If you'd like to use RainyDesk commercially before the Change Date (for example to bundle or sell it), please contact me to discuss a commercial license.

If you jive with the project, tips and small donations are hugely appreciated — Ko-fi: https://ko-fi.com/xyagain

## The Fool Who Made It

**Sam Atwood** of [The King's Busketeers](https://tkb.band/)

*Please don't sue me if rainwater starts pouring out of your USB ports, that's unintended behavior.*

---

*Get your desktop wet.* 🌧️
