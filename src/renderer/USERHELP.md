# RainyDesk User Guide

*Get your desktop wet.* 🌧️

Welcome to RainyDesk, and thanks for using it! This is a desktop rain simulation that renders transparent overlays across all your monitors. Rain falls around your windows (not through them... hopefully), has some advanced procedural audio, and stays smooth even at wicked high refresh rates.

---

## Getting Damp

**Opening the Panel**

- Left-click the RainyDesk icon in your system tray (usually bottom-right corner)
- The Rainscaper panel appears on your primary monitor! Wow, magic!
- Drag it wherever you like; it remembers your preferred position!
- Click the **?** button in the top-right of the panel header for this help guide
- Click the version number (bottom-right of the panel) for quick links to GitHub and an **Autostart** toggle

**Basic Controls**

- **Intensity:** How much rain falls (1% = a lil dribble, 100% = torrential)
- **Wind:** Horizontal wind force (-100 left, +100 right, 0 = calm)
- **Volume:** Master audio volume (0–100%)
- **Mute:** Silence all audio without losing your volume slider settings
- **Pause:** Freeze the simulation in place

**Oscillator Knobs (OSC)**

Some sliders have a small rotary knob next to them. These are oscillators — they automatically drift the slider's value around its current position, creating natural variation over time. Turn the knob up for wider swings, or leave it at zero for manual control only. Also, they glow!

- **Intensity OSC:** Auto-varies rainfall between lighter and heavier
- **Wind Gust OSC:** Creates gusting wind that shifts direction (disabled in Matrix Mode)
- **Impact Pitch OSC:** Adds per-drop pitch variation to raindrop sounds
- **Turbulence/Glitchiness OSC:** Changes how wacky wild your physics particles are :)
- **Rain Sheet OSC:** Changes the background noise level (disabled in Matrix Mode)

---

## Autosave

RainyDesk automatically saves your settings whenever you make a change. Watch the panel footer:

- **Saving...** — writing changes (pulsing white dot)
- **Saved!** — complete (solid white dot)
- **Raining** — normal operation (green dot)

All your preferences persist between sessions! No accidentally losing your hand-crafted rain vibes!

---

## Per-Mode Settings

Rain Mode and Matrix Mode each save their own independent settings. When you switch modes, your sliders, audio levels, and visual tweaks are remembered separately for each mode. So your cozy rain setup won't get overwritten by your Matrix tuning (or vice versa). System settings like FPS limit, grid scale, and render scale are shared between modes.

---

## Tray Menu

Right-click the tray icon for quick access:

- Pause & Resume (linked to the toggle)
- Volume override presets (Mute, 5%, 10%, 25%, 50%, 75%, 90%, 100%)
- Open Rainscaper panel
- Quit RainyDesk <sub>(why would you do this?)</sub>

---

## The Five Tabs

### Basics

Your everyday rain controls, plus panel appearance settings!

- **Intensity, Wind, Volume, Mute, Pause**
- **UI Scale:** Resize the panel from 50% to 250%
- **Themes:** 12 lovely little alliterative premade themes plus a Windows accent color matcher, a randomizer, and a whole custom theme editor!

### Physics

Fine-tune the simulation to your liking!

- **Gravity:** Drop fall speed (100 = very floaty, 2000 = monsoon season). Steps by 10.
- **Splash Size:** How big splashes are when drops hit surfaces. Has a chain-link icon (🔗) that links it to Drop Mass — when linked, bigger drops automatically make bigger splashes!
- **Puddle Drain:** How fast puddles disappear (0% = pretty persistent, 100% = near-instant)
- **Turbulence:** Random chaos in the rain motion. Has its own OSC knob!
- **Max Drop Mass:** Size of individual drops (1 = tiny, 10 = thicc). Also has a chain-link icon that controls the splash size link.
- **Reverse Gravity:** Rain falls up! Shocking, I know...

### Audio

Sculpt your ideal soundscape!

- **Master Volume:** Same as Basics tab (linked)
- **Impact Sound:** Raindrop collision volume, currently limited to little *tip-tik-tak-tap* sounds
- **Impact Pitch:** Filter center frequency for raindrop sounds — lower values = deeper thuds, higher values = brighter tinks
  - Has its own **OSC knob** for per-drop pitch variation!
- **Rain Sheet:** Steady background rain wash — the ambient bed of sound underneath individual impacts
- **Wind:** Wind layer volume, nice and swooshy
- **Thunder:** *Rolling in soon...*

When Matrix Mode is on, a **Matrix Synth** section appears:

- **Key:** Transpose the tune! Choices are: Matrix (G), Reloaded (B♭), Revolutions (E), Resurrections (C#)
- **Bass/Melody/Drone:** Individual synth layer volumes, tweak as you like

The Matrix synth plays a 90-bar chord progression based on Rob Dougan's classic banger [Clubbed to Death](https://youtu.be/9FuiZfSkhOw?si=02AJs3FpG4BPN_qP) at 102 BPM. Individual code stream impacts play the melody over a pre-programmed bassline. I worked really hard on this part — I hope you dig it! 💚

### Visuals

Customize all that wetness!

- **BG Intensity/BG Layers:** Control background rain brightness, opacity, and depth
- **Rain Color:** Pick literally any color (click the reset icon to restore default)
- **Gay Mode:** Rainbow color cycling on a 1-minute rotation 🏳‍🌈
  - **Rainbow Speed** appears when enabled (1–10×)
- **Matrix Mode:** Digital rain with cascading code streams and musical collision effects

### System

Performance tuning, behavior toggles, diagnostics, and actions — all in collapsible sections!

#### Performance

- **FPS Limit:** Cap the framerate from 15 all the way to 360, or leave it uncapped (Max). Lower values save GPU power.
- **Grid Scale:** Simulation resolution in 4 tiers — **Potato** / **Chunky** / **Normal** / **Detailed**. Lower = better performance, higher = finer water detail.
- **Render Scale:** Visual resolution in 4 tiers — **Lo-Fi** / **Pixel** / **Clean** / **Full**. Lower is lighter on the GPU, but it all sounds the same!
- When you change Grid Scale or Render Scale, an **Apply Changes** button appears. If you were paused when you click it, the button changes to **Resume?** — click it again to unpause.
- **Data Density:** Controls how thick Matrix Mode code streams are. 4 tiers — **Noob**/**Normie**/**Nerd**/**Neo** (Matrix Mode only).

#### Behavior

- **Window Collision:** Toggle rain interaction with your app windows on or off
- **Rain Over Fullscreen:** When OFF, rain hides on monitors running fullscreen apps
  - **Audio Muffling** (sub-toggle): Lowers volume behind fullscreen apps
- **Rain Over Maximized:** When OFF, rain hides on monitors with maximized windows
  - **Audio Muffling** (sub-toggle): Lowers volume behind maximized apps
- **Background Shader:** Toggle the behind-all-windows atmospheric rain layer
- **3D Audio:** Coming Soon™
- **Start with Windows:** Launch RainyDesk automatically on login

#### Stats & System Info

Real-time performance stats updated twice per second:

- FPS, active drops, water cells, frame time
- System info: CPU model, GPU model, total RAM, per-monitor refresh rates, virtual desktop resolution

#### Actions

- **Reset RainyDesk:** Reinitializes the entire simulation. Has a **30-second cooldown** between uses (shows a countdown). If a monitor configuration change is detected, the cooldown resets automatically and the button pulses red to get your attention. You gotta click it or the rain won't work right!
  - **Monitor Hot-Swap:** Plugged in or unplugged a monitor? The Reset button will flash red — click it to recalculate your rain layout!

**Performance Presets** — Four one-click buttons:

- <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle"><path d="M21 14.7C21 18.1794 19.0438 21 15.5 21C11.9562 21 10 18.1794 10 14.7C10 11.2206 15.5 3 15.5 3C15.5 3 21 11.2206 21 14.7Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 8.2C8 9.7464 7.11083 11 5.5 11C3.88917 11 3 9.7464 3 8.2C3 6.6536 5.5 3 5.5 3C5.5 3 8 6.6536 8 8.2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> **Potato:** Bare minimum for older hardware (low grid, low render, 30 FPS, BG off)
- <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle"><path d="M10.5 21L12 18M14.5 21L16 18M6.5 21L8 18M8.8 15C6.14903 15 4 12.9466 4 10.4137C4 8.31435 5.6 6.375 8 6C8.75283 4.27403 10.5346 3 12.6127 3C15.2747 3 17.4504 4.99072 17.6 7.5C19.0127 8.09561 20 9.55741 20 11.1402C20 13.2719 18.2091 15 16 15L8.8 15Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> **Light:** Easy on resources (Chunky grid, Pixel render, 60 FPS, BG off)
- <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle"><path d="M16 13V20M4 14.7519C3.37037 13.8768 3 12.8059 3 11.6493C3 9.20008 4.8 6.9375 7.5 6.5C8.34694 4.48637 10.3514 3 12.6893 3C15.684 3 18.1317 5.32251 18.3 8.25C19.8893 8.94488 21 10.6503 21 12.4969C21 13.4232 20.7205 14.2842 20.2413 15M12 14V21M8 13V20" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> **Balanced:** The default sweet spot (Normal grid, Pixel render, 60 FPS, BG on)
- <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle"><path d="M19.3278 16C20.3478 15.1745 21 13.9119 21 12.4969C21 10.6503 19.8893 8.94488 18.3 8.25C18.1317 5.32251 15.684 3 12.6893 3C10.3514 3 8.34694 4.48637 7.5 6.5C4.8 6.9375 3 9.20008 3 11.6493C3 13.1613 3.63296 14.5269 4.65065 15.5M8 18V20M8 12V14M12 19V21M16 18V20M16 12V14M12 13V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> **Cranked:** Maximum prettiness (Detailed grid, Clean render, uncapped FPS, BG on)

---

## Troubleshooting

**Rain laggy or choppy?**

- Try a lower **Performance Preset** (Potato or Light) on the System tab
- Lower **Grid Scale** to Chunky or Potato
- Reduce **BG Layers** to 1–2 on the Visuals tab
- Lower **Intensity** to reduce active drops

**High GPU usage?**

- Try lower **Grid Scale** and **Render Scale** settings
- Increase **Puddle Drain** (less water on screen)
- Lower **FPS Limit** to 30 or 60
- Check the System tab for real-time framerate monitoring

**Audio sounds distorted?**

- Lower **Master Volume** below 75%
- Reduce individual sound sliders on the Audio tab
- If in Matrix Mode, the bitcrush effect is intentional

**Rain going through windows?**

- Close those darn things, you're letting in the damp! Nah just kidding, it isn't real water.
- Make sure **Window Collision** is enabled on the System tab
- Window positions update at 60 Hz. Very fast window moves may cause brief visual lag or weird puddles. This is normal. Mostly. I hope.

---

## Tips and Tricks

- Flip on **Reverse Gravity** and time your toggles to make rain float mid-air!
- Set Volume to 0% for silent rain while watching a movie or playing a game!
- Try turning the Matrix gay! 👀
- Use the **Windows** theme to auto-match your system accent color!
- Click *everything!* You probably won't break anything (you can always reset), but you might find some fun stuff!
- In Matrix Mode, labels get thematic renames: Gravity → Fall Speed, Drop Mass → String Length, and Reverse Gravity → Reverse Engineer. Same controls, cooler names! 😎
- **Impact Pitch** at low values sounds like rain on a thick roof; crank it up for a tin-can-in-a-thunderstorm vibe!

---

## Settings Location

**Rainscapes** (click to open):

`Documents\RainyDesk\`

Your autosave and default preset live here. Save/load and preset sharing are coming in a future update!

**Logs** (click to open):

`%LOCALAPPDATA%\com.rainydesk.app\logs\`

The 5 most recent session logs live here.

**NOTE TO TESTERS:** It would be *very* helpful to send me those logs along with your feedback!

---

## Need More Help?

**Found a bug or have a suggestion?** Contact me on Discord (**XYAgain**) for the fastest response. Once I figure out how to use it, you'll be able to report problems at [github.com/XYAgainAgain/RainyDesk/issues](https://github.com/XYAgainAgain/RainyDesk/issues)

**Want to support development?** [Ko-fi](https://ko-fi.com/xyagain) is open & very much appreciated!

⛈ *Enjoy your cozy rainy computer! I love you!* ☔
