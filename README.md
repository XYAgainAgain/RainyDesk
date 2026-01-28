#  🌧️ RainyDesk 💻

Ever wish it could rain on your desktop? Now it can, and you can use windows as umbrellas. ☔

RainyDesk is a peaceful desktop rain simulator that overlays semi-realistic rain on all your monitors. It's transparent, click-through, and never gets in your way — just some nice moist ambiance while you work, game, write, vibe, or relax.

## What does it do?

It makes it rain on your screen! That's pretty much it! Physics-based raindrops fall across all your monitors, splash when they hit the bottom (or the tops of your windows), and sound like actual rain. You can adjust how heavy the rain is, how it sounds, and way, waaaay more.

**Perfect for:**

- *Working/vibing in a cozy atmosphere*
- *Studying or reading with ambient rain sounds*
- *Relaxing without leaving your desk*
- *Pretending it's a rainy day when it's not and you're annoyed about it*

## Current Status

RainyDesk is in active development. Right now it works fine for basic rain simulation across multiple monitors with realistic physics. Lots of cool features are planned (see below).

**What Works:**

- Rain falls on all your monitors (including vertical/rotated ones)
- Realistic physics with splishysplashies
- Click-through transparency (rain never blocks your mouse)
- System tray controls for intensity and volume
- High refresh rate support (anywhere from 60–240Hz!)
- Window detection (rain flows around your windows unless maximized)

**What's Coming:**

- **Rainscapes!** Full presets like "Tin Roof", "Forest", "Concrete" with matching audio
- Custom rainscape editor to save your perfect rainy day vibes
- Thunder (because we *gotta*)
- Much improved physics engine with surface tension, cohesion/adhesion, dripping, pooling, etc.
- Better audio system (currently being rebuilt from scratch... again)
- 3D spatial audio with full 5.1/7.1 surround sound support (like Dolby Atmos for Headphones)
- More visual effects (animated background rain, adjustable trails, colors, droplet styles, etc.)
- Peaceful auto-start with gentle fade-in so you don't get jump-scared by fake water
- Quality presets for different performance needs (runs physics sim at lower res, then upscales)
- Auto-launch on startup/login to immediately soak your desktop

## Installation

RainyDesk isn't released just yet, but you can run it from source:

```bash
npm install
npm start
```

Pre-built installers coming soon once it's more polished!

## Requirements

- Windows 10/11 (Linux X11 support coming soon! I pinky promise!)
- An audio device such as headphones, earbuds, or speakers (preferably with surround sound)
- At least one monitor lmao

## How to use it

Once running, RainyDesk sits in your system tray. Click the icon to open controls or right-click for options. The rain is always there, transparent and out of the way, until you want to adjust it.

## Why does this exist?

Sometimes you just want it to rain. I know I sure do. This scratches that itch.

## Technical Details

For developers: RainyDesk is built with Electron, WebGL 2 instanced rendering, Matter.js physics, and tone.js audio synthesis. Each monitor gets its own transparent overlay window running an independent particle simulation. Kinda neat! 💦

## Third-Party Libraries

- [Tone.js](https://tonejs.github.io) (v15.1.22) — MIT License — Audio synthesis
- [Matter.js](https://brm.io/matter-js) (v0.20.0) — MIT License — Physics engine
- [get-windows](https://github.com/sindresorhus/get-windows) — MIT License — Window detection

## License

RainyDesk is currently source-available under the Business Source License 1.1 (BSL-1.1). That means you are welcome to use, tinker with, and modify RainyDesk for personal, educational, and non-commercial purposes. I've chosen a BSL so I can keep the project freely available while preventing third parties from repackaging and selling it as a commercial product without permission. Don't want that, now do we?

>  **Change Date: 2029-01-01** — on or after this date RainyDesk will automatically be relicensed under the MIT License, making it fully permissive and open-source.

If you'd like to use RainyDesk commercially before the Change Date (for example to bundle or sell it), please contact me to discuss a commercial license. If you jive with the project, tips and small donations are hugely appreciated — Ko-fi: https://ko-fi.com/xyagain

## The Fool Who Made It

**Sam Atwood** of [The King's Busketeers](https://tkb.band/)

*Please don't sue me if rainwater starts pouring out of your USB ports, that's unintended behavior.*

---

*Get your desktop wet.* 🌧️
