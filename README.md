#  🌧️ RainyDesk 💻

Ever wish it could rain on your desktop? Now it can, and you can use windows as umbrellas. ☔

**RainyDesk** is a peaceful desktop rain simulator that overlays semi-realistic pixelated rain on all your monitors. It's transparent, click-through, and never gets in your way — just some nice moist ambiance while you work, game, write, vibe, or relax.

### What does it do? ⛈
It makes it rain on your screen! That's pretty much it! Physics-based raindrops fall across all your monitors, splash when they hit stuff, and sound like actual rain. You can adjust how heavy the rain is, how whooshy the wind is, how everything sounds, and way, waaaay more.

**Perfect for...**

- *Working & vibing in a cozy atmosphere*
- *Focus assistance when studying or reading*
- *Relaxing without leaving your desk*
- *Pretending it's a rainy day when it's not and you're annoyed about it*

### Why does this exist?
Sometimes you just want it to rain. I know I sure do. This ~~scratches~~ splashes that itch.

### How do I use this? ☔
Right now it's a bit tricky, but soon I'll have a proper installer which you can download and double-click to install, then run it like any other application. During the installation, it will ask you if you want RainyDesk to automatically run when you log in. You can change this option (and all the others) at any time!

Once running, RainyDesk sits in your system tray. Left-click the tray icon to open the Rainscaper panel or right-click to open a small context menu:
- Pause/Resume
- Open Rainscaper
- Volume Presets (there's a bunch)
- Quit RainyDesk

The Rainscaper panel is a little more complicated, but it has an Easy Mode (for most folks) and an Admin Mode (for the real rain-heads). I'll include a full guide here once it's done!

#### Installation
RainyDesk isn't released just yet, but you can run it from source if you're cool. Download the project as a ZIP, extract anywhere you like, then open a `cmd` terminal in that directory and do these lil guys to make yourself an executable:

```bash
npm install
npm run tauri dev
```

*Pre-built installers coming once it's more polished!*

#### Requirements
- Windows 10/11 (Linux support coming eventually, X11 window manager only)
- An audio device such as headphones, earbuds, or speakers (preferably with surround sound)
- ~50 MB of free storage space
- At least one monitor lmao

### How does this work? 🌂
Imagine your entire desktop — *all* your monitors, no matter how weirdly they're laid out — as one big invisible grid, like graph paper. RainyDesk draws a single giant transparent window over everything and makes it rain on that grid. There's also another one behind everything for extra rain (optional but recommended).

**The Magic:**
- **Void Mask:** RainyDesk figures out where your monitors *aren't* and ignores that space. Got gaps between your screens? Those are "walls" that rain can't pass through. If they're right next to each other, though, the water treats it all as one big space to splash around in! 🌊
- **Spawn Map:** Rain only falls from the top of each monitor, not from empty space. Or the other direction, if you click the Reverse Gravity toggle. 🙃
- **Puddles:** When rain hits something, it turns into water that spreads out like a real puddle. Well, a real 2D puddle. It's pretty close, at least! 😰
- **Waterfalls:** Try lining up a bunch of windows and making a little cascade! Also, if your monitors are at different heights, puddles can spill over the edge and cascade down to the lower monitor. Be careful accidentally drowning your taskbar icons! 🤿

**The Feel:**
- Drag a window over a puddle? *Sploosh!* Some water vanishes, some goes flying out sideways!
- Close/move a window with water on it? *Splash!* The puddle falls and splashes on whatever's below!
- Go fullscreen for a game or video? *Ssshh!* Rain hides on that screen but keeps falling on your others for maximum coze!

> *Is coze a word? Cozy but a noun? Whatever, you get it.* 

**The Point:**
It's like having a tiny rainstorm on your desktop, except you can't get wet. Not from RainyDesk, at least. Don't come running to me if you spill something on yourself.

## Current Status: Gathering Clouds ☁
RainyDesk is in active development and I'm really not rushing it because it's my first big non-website project. The core experience is working pretty well — rain physics simulation, mathematically correct audio synthesis, and a painfully detailed control panel (defaults to easy mode, don't worry).

**What Works:**

- **Cozy pixelated rain** falls on all your monitors (including vertical/rotated ones)
- **Cool water physics** with surface tension, cohesion/adhesion, dripping, pooling, and all that juicy fluid stuff with oodles of splishysplashies on the tops/sides of windows + the taskbar
- Click-through transparency (rain never blocks your mouse)
- **System tray controls** for volume & hot-swapping between Rainscapes
- **High refresh rate** support (anywhere from 60–240Hz) via interpolation
- **Window detection**; rain flows around your windows unless maximized, and if it's maximized, it's muffled!
- **Tray icon!** Huge shout-out to my friend Erin for making it! 💙👩‍🎨🧡
- **Rainscaper control panel** to tweak everything from rain intensity to audio materials to gravity
- **Rainscape preset system** to save and load your perfect rainy day vibes as `.rain` files like `TinRoof.rain` & `Forest.rain`
- **Procedural audio synthesis** for voice-pooled impact sounds, bubble effects, wind, and background sheet noise (and EQ + FX + LFOs!)
- **Background rain** made of atmospheric layers behind your windows with no physics; really sells the effect!
- **Render scale options** for pixelated 8-bit aesthetic or crispy full-res circles, your choice! Lower render scale is lighter on the graphics card, but it all sounds the same!
- **Gentle fade-in on startup** so no jump-scares from fake water lol

**What's Coming:**
- ***Thunder synth!*** Because we *gotta* have the booms! ⛈
- **7 audio materials** which are Glass, Metal, Wood, Concrete, Fabric, Foliage, & Water (each sounds different!)
- 3D spatial audio with full 5.1/7.1 surround sound support (like Dolby Atmos for Headphones — rain all around you!)
- More visual effects (adjustable trails, colors, droplet styles)
- Auto-launch on startup/login to immediately soak your desktop; currently manual for my sanity
- Linux support (I pinkie promise!) and maybe MacOS later if my Mac Mini behaves
- A nice easy installer & decent app size (<50 MB)
- Snow? 🌨👀

## Tech Specs for Big Nerds
RainyDesk is built with **Tauri** (Rust backend + WebView2), **Pixi.js** v8 rendering, and **Tone.js** audio synthesis.

**Architecture:**
- One mega-overlay window spans your entire virtual desktop (all monitors, even weird setups)
- Another mega-background window renders atmospheric rain behind everything
- Void mask treats gaps between/around monitors as solid walls; calculated automatically on start
- Hybrid physics: Lagrangian particles (rain) + Eulerian grid (puddles)
- Cellular automata for natural water flow (Noita-style!)
- Spatial audio: rain position → stereo pan (5.1/7.1 coming later, I swear)

## Third-Party Libraries
Truly could not have made this without these. Holy heck, what a huge help! Thanks y'all! ♥
- [Tauri](https://tauri.app) (v2) — MIT License — Desktop app framework
- [Pixi.js](https://pixijs.com) (v8) — MIT License — GPU-accelerated rendering
- [Tone.js](https://tonejs.github.io) (v15.1.22) — MIT License — Audio synthesis

## License & Acknowledgments
RainyDesk is currently source-available under the Business Source License 1.1 (BSL-1.1). That means you are welcome to use, tinker with, and modify RainyDesk for personal, educational, and non-commercial purposes. I've chosen BSL so I can keep the project freely available while preventing third parties from repackaging and selling it as a commercial product without permission. Don't want that, now do we?

>  **Change Date: 2030-02-05** — on or after this date RainyDesk will automatically be relicensed under the MIT License, making it fully permissive and open-source.

If you'd like to use RainyDesk commercially before the Change Date, which is my birthday, (for example to bundle or sell it), please contact me to discuss a commercial license. I may be feeling magnanimous.

---

None of this wacky wetness would have been possible without the hard work and research of all the folks who made the above libraries and wrote the papers with excruciatingly accurate titles I used for the raindrop audio synthesis:
- ["Computational Real-Time Sound Synthesis of Rain"](https://www.diva-portal.org/smash/record.jsf?pid=diva2%3A19156&dswid=-6144) (2003) by Andreas Zita
- ["On the Measurement and Prediction of Rainfall Noise"](https://www.sciencedirect.com/science/article/abs/pii/S0003682X20307404?via%3Dihub) (2021) by G. Schmid, M. J. Kingan, L. Panton, G. Willmott, Y. Yang, C. Decraene, E. Reynders, & A. Hall
- ["Procedural Modeling of Interactive Sound Sources in Virtual Reality"](https://link.springer.com/chapter/10.1007/978-3-031-04021-4_2) (2023) by Federico Avanzini
- ["Rainfall Observation Leveraging Raindrop Sounds Acquired Using Waterproof Enclosure: Exploring Optimal Length of Sounds for Frequency Analysis"](https://www.mdpi.com/1424-8220/24/13/4281) (2024) by Seunghyun Hwang, Changhyun Jun, Carlo De Michele, Hyeon-Joon Kim, & Jinwook Lee 
- ["A Theoretical Study on Drop Impact Sound and Rain Noise"](https://www.cambridge.org/core/journals/journal-of-fluid-mechanics/article/abs/theoretical-study-on-drop-impact-sound-and-rain-noise/7A703959CA20067BB96BE8037030143E) (1991) by Y. P. Guo & J. E. Ffowcs Williams

---

## 🌈 Whodunnit 🌂
**RainyDesk** was made with love (and a little Claude Code help) by **Sam Atwood** of [The King's Busketeers](https://tkb.band/)!

If you jive with the project, tips and small [Ko-fi](https://ko-fi.com/xyagain) donations are hugely appreciated!

*Please don't submit an issue if rainwater starts pouring out of your USB ports, that's unintended behavior.*

---

<div style="text-align: center;" markdown="1"><i>Get your desktop wet.</i> 🌧️</div>