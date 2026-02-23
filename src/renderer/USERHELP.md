# RainyDesk User Guide

*Get your desktop wet.* 🌧️

Welcome to RainyDesk! This is a desktop rain simulation that renders transparent overlays across all your monitors. Rain falls around your windows (not through them... hopefully), has some seriously deep procedural audio, and stays smooth even at wicked high refresh rates.

---

## Getting Damp

**Opening the Panel**

- Left-click the RainyDesk icon in your system tray (usually bottom-right corner)
- The Rainscaper panel appears on your primary monitor! Wow, magic!
- Click the <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="vertical-align:middle"><path d="M16.584 6C15.8124 4.2341 14.0503 3 12 3C9.23858 3 7 5.23858 7 8V10.0288M12 14.5V16.5M7 10.0288C7.47142 10 8.05259 10 8.8 10H15.2C16.8802 10 17.7202 10 18.362 10.327C18.9265 10.6146 19.3854 11.0735 19.673 11.638C20 12.2798 20 13.1198 20 14.8V16.2C20 17.8802 20 18.7202 19.673 19.362C19.3854 19.9265 18.9265 20.3854 18.362 20.673C17.7202 21 16.8802 21 15.2 21H8.8C7.11984 21 6.27976 21 5.63803 20.673C5.07354 20.3854 4.6146 19.9265 4.32698 19.362C4 18.7202 4 17.8802 4 16.2V14.8C4 13.1198 4 12.2798 4.32698 11.638C4.6146 11.0735 5.07354 10.6146 5.63803 10.327C5.99429 10.1455 6.41168 10.0647 7 10.0288Z" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg> button to unsnap, then drag it wherever you like; it remembers its position!
- Click the **?** button in the top-right of the panel header to open this very help guide
- Click the version number (bottom-right of the panel) for quick links to **[GitHub](https://github.com/XYAgainAgain/RainyDesk)**, **[Ko-fi](https://ko-fi.com/xyagain)**, **Help**, **Update**, **Autostart** toggle, & **Quit**

**Basic Controls**

- **Intensity:** How much rain falls (1% = a lil dribble, 100% = torrential)
- **Windiness:** Horizontal wind force (-100 left, +100 right, 0 = calm)
- **Volume:** Master audio volume (0–100%); setting it to 0 will toggle Mute
- **Mute:** Silence all audio without losing your volume slider settings
- **Pause:** Freeze the simulation in place!

**Oscillator Knobs (OSC)**

Some sliders have a small rotary knob next to them which you can click and drag. These are oscillators — they automatically drift the slider's value around its current position, creating natural variation over time. Turn the knob up for wider swings, or leave it at zero for manual control only. Also, they glow!

- **Intensity Knob:** Auto-varies rainfall between lighter and heavier
- **Wind Gust Knob:** Creates gusting wind that shifts direction (disabled in Matrix Mode)
- **Impact Pitch Knob:** Adds per-drop pitch variation to raindrop impact sounds (recommended!)
- **Turbulence/Glitchiness Knob:** Changes how wacky wild your physics particles are :)
- **Rain Sheet Knob:** Changes the background noise level (disabled in Matrix Mode)

---

## Autosave

RainyDesk automatically saves your settings whenever you make a change. Watch the panel footer:

- **Saving...** — writing changes (pulsing white dot)
- **Saved!** — complete (solid white dot)
- **Raining** — normal operation (green dot)

All your preferences persist between sessions. No accidentally losing your carefully-crafted rain vibes!

---

## Per-Mode Settings

Rain Mode and Matrix Mode each save their own independent settings. When you switch modes, your sliders, audio levels, and visual tweaks are remembered separately for each mode. So your cozy rain setup won't get overwritten by your Matrix tuning (or vice versa). System settings like FPS limit, grid scale, render scale, and audio channels are shared between modes.

---

## Tray Menu

Right-click the tray icon for quick access:

- **Pause & Resume** (linked to the toggle)
- **Volume override presets** (Mute, 5%, 10%, 25%, 50%, 75%, 90%, 100%)
- **Open Rainscaper** panel
- **Quit RainyDesk**  <sub>(why would you do this?)</sub>

---

## The Five Tabs

### Basics

Your everyday rain controls, plus panel appearance settings!

- **Intensity, Windiness, Volume, Mute, Pause**
- **UI Scale:** Resize the panel from 50% to 250%
- **Themes:** 12 lovely little alliterative premade themes plus a Windows accent color matcher, a randomizer, and a whole custom theme editor!

### Physics

Fine-tune the simulation to your liking!

- **Gravity:** Drop fall speed (100 = very floaty, 2000 = monsoon season). Steps by 10.
- **Splash Size:** How big splashes are when drops hit surfaces. Has a chain-link icon that links it to Drop Mass — when linked, bigger drops automatically make bigger splashes!
- **Puddle Drain:** How fast puddles disappear (0% = pretty persistent, 100% = near-instant)
- **Turbulence:** Random chaos in the rain motion. Has its own OSC knob!
- **Max Drop Mass:** Size of individual drops (1 = tiny, 10 = thicc). Also has a chain-link icon that controls the splash size link.
- **Reverse Gravity:** Rain falls up! Shocking, I know.

### Audio

Sculpt your ideal soundscape! There's a lot going on here, so let's break it down.

#### Impact Sound

The individual *tik-tak-tik-tap* sounds of raindrops hitting things.

- **Impact Volume:** How loud each individual drop sounds
- **Impact Pitch:** Filter center frequency; lower values = deeper *thuds*, higher values = brighter tinks
  - Has an OSC knob for per-drop pitch variation!

#### Rain Sheet

The steady background rain wash — the ambient bed of sound underneath individual impacts. Think of it as "how heavy the rain sounds overall."

Has an OSC knob for subtle volume variation!

#### Wind

Wind layer volume. Nice and swooshy. This responds to the **Windiness** slider on the Basics tab — turn up the wind for more whoosh. Includes a gentle bed of wind noise, occasional gusts, and some whistling at higher speeds. 

Needs Audio Channels set to Standard or Full.

#### Thunder

Rumbling, cracking, booming storms! 🌩️ <sub>...Mostly functional!</sub>

- **Storminess:** How often lightning strikes (1 = almost never, 100 = all the time).
- **Distance:** How far away the storm is in kilometers (because science works in metric). Close strikes are crackly and loud; distant ones are deep and rumbly with a longer delay.
- **Environment:** What's between you and the storm; *Forest*, *Plains*, *Mountain*, *Coastal*, *Suburban*, or *Urban*. Each subtly changes how the thunder echoes and reverberates.
- **STRIKE!** button: Manually trigger a lightning bolt for testing or dramatic effect!

Thunder needs Audio Channels set to Full.

#### Texture

Looping drops-on-surface rain layered on top of everything else. This adds a pretty realistic vibe!

- **Enable/Disable toggle** which turns the texture layer on or off
- **Texture Volume:** How loud the layer is
- **Texture Intensity:** How heavy the rain sounds (can be linked to master Intensity!)
- **Surface:** What material the rain is hitting; *Generic*, *Concrete*, *Forest*, *Metal*, or *Umbrella*. Each sounds different, and you bet I'll be adding more! 
  - In the future, expect the normal droplet impact sounds to match the Surface selection.


#### Matrix Synth (Matrix Mode only)

When Matrix Mode is on, a **Matrix Synth** section appears:

- **Key:** Transpose the tune! Choices are: Matrix (G), Reloaded (B&#9837;), Revolutions (E), Resurrections (C#)
- **Bass/Melody/Drone:** Individual synth layer volumes, tweak as you like

The Matrix synth plays a 90-bar chord progression based on Rob Dougan's classic banger [*Clubbed to Death*](https://youtu.be/9FuiZfSkhOw?si=02AJs3FpG4BPN_qP) at 102 BPM. Individual code stream impacts play the melody over a pre-programmed bassline. I worked really hard on this part — I hope you dig it! 💚

### Visuals

Customize all that wetness!

- **BG Intensity/BG Layers:** Control background rain brightness, opacity, and depth
- **Rain Color:** Pick a preset or choose literally any color (click the reset icon to restore default)
- **Gay Mode:** Rainbow color cycling on a 1-minute rotation 🏳‍🌈
  - **Rainbow Speed** appears when enabled (1–10×)
- **Matrix Mode:** Digital rain with cascading code streams and musical collision effects

### System

Performance tuning, behavior toggles, diagnostics, and actions all in collapsible sections!

#### Performance

- **FPS Limit:** Cap the framerate from 15–360, or leave it uncapped (Max). Lower values save GPU power.
- **Audio Channels:** How much sound processing your CPU handles in three tiers:
  - **Lite:** Just raindrop impacts, the rain sheet, and the texture. Minimalistic, you might say.
  - **Standard:** Adds wind layers and more raindrops impacts. Pretty good balance.
  - **Full:** Everything on by default, including thunder. The wettest experience possible!
- **Grid Scale:** Simulation resolution in 4 tiers — **Potato**/**Chunky**/**Normal**/**Detailed**. Lower = better performance, higher = finer water detail.
- **Render Scale:** Visual resolution in 4 tiers — **Lo-Fi**/**Pixel**/**Clean**/**Full**. Lower is lighter on the GPU, but it all sounds the same!
- When you change **Grid Scale** or **Render Scale**, an **Apply Changes** button appears. If you were paused when you click it, the button changes to **Resume?** — click it again to unpause & apply.
- **Data Density:** Controls how thick Matrix Mode code streams are in 4 tiers, only available when plugged into the Matrix — **Noob**/**Normie**/**Nerd**/**Neo**.

#### Behavior

- **Window Collision:** Toggle rain interaction with your app windows on or off
- **Rain Over Fullscreen:** When OFF, rain hides on monitors running fullscreen apps
  - **Audio Muffling** (sub-toggle): Lowers volume behind fullscreen apps
- **Rain Over Maximized:** When OFF, rain hides on monitors with maximized windows
  - **Audio Muffling** (sub-toggle): Lowers volume behind maximized apps
- **Background Shader:** Toggle the behind-all-windows atmospheric rain layer
- **3D Audio:** *Coming Soon™*
- **Start with Windows:** Launch RainyDesk automatically on login

#### Stats & System Info

Real-time performance stats updated twice per second:

- Frames per second (FPS), active drops, water cells, frame time
- System info: CPU model, GPU model, total RAM, per-monitor refresh rates, virtual desktop resolution

#### Actions

- **Reset RainyDesk:** Reinitializes the entire simulation. Has a **30-second cooldown** between uses (shows a countdown) to prevent you from breaking anything.
  - **Monitor Hot-Swap:** Plugged in or unplugged a monitor? The Reset button will flash red — click it to recalculate your layout and get everything working again!

**Performance Presets:** Four one-click profiles that set multiple settings at once:

- <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle"><path d="M21 14.7C21 18.1794 19.0438 21 15.5 21C11.9562 21 10 18.1794 10 14.7C10 11.2206 15.5 3 15.5 3C15.5 3 21 11.2206 21 14.7Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 8.2C8 9.7464 7.11083 11 5.5 11C3.88917 11 3 9.7464 3 8.2C3 6.6536 5.5 3 5.5 3C5.5 3 8 6.6536 8 8.2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> **Potato:** Bare minimum for older hardware (Potato grid, Lo-Fi render, 30 FPS, Lite audio)
- <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle"><path d="M10.5 21L12 18M14.5 21L16 18M6.5 21L8 18M8.8 15C6.14903 15 4 12.9466 4 10.4137C4 8.31435 5.6 6.375 8 6C8.75283 4.27403 10.5346 3 12.6127 3C15.2747 3 17.4504 4.99072 17.6 7.5C19.0127 8.09561 20 9.55741 20 11.1402C20 13.2719 18.2091 15 16 15L8.8 15Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> **Light:** Easy on resources (Chunky grid, Pixel render, 60 FPS, Standard audio)
- <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle"><path d="M16 13V20M4 14.7519C3.37037 13.8768 3 12.8059 3 11.6493C3 9.20008 4.8 6.9375 7.5 6.5C8.34694 4.48637 10.3514 3 12.6893 3C15.684 3 18.1317 5.32251 18.3 8.25C19.8893 8.94488 21 10.6503 21 12.4969C21 13.4232 20.7205 14.2842 20.2413 15M12 14V21M8 13V20" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> **Balanced:** The default sweet spot (Normal grid, Pixel render, 60 FPS, Full audio)
- <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle"><path d="M19.3278 16C20.3478 15.1745 21 13.9119 21 12.4969C21 10.6503 19.8893 8.94488 18.3 8.25C18.1317 5.32251 15.684 3 12.6893 3C10.3514 3 8.34694 4.48637 7.5 6.5C4.8 6.9375 3 9.20008 3 11.6493C3 13.1613 3.63296 14.5269 4.65065 15.5M8 18V20M8 12V14M12 19V21M16 18V20M16 12V14M12 13V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> **Cranked:** Maximum prettiness (Detailed grid, Clean render, uncapped FPS, Full audio)

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

**Audio stuttering or crackling?**

- Switch **Audio Channels** to **Lite** or **Standard** — this is the #1 fix for audio performance issues!
- Lower **Master Volume** below 75%
- Reduce individual sound sliders on the Audio tab
- Turn off **Thunder** and/or **Texture** if you don't need them

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
- **Mute** RainyDesk for silent rain while watching a movie or playing a game!
- Try turning the Matrix gay! 👀
- Use the **Windows** theme to auto-match your system accent color!
- Click *everything!* You probably won't break anything (you can always reset), but you might find some fun stuff!
- In Matrix Mode, labels get thematic renames: Gravity → Fall Speed, Drop Mass → String Length, and Reverse Gravity → Reverse Engineer. Same controls, cooler names! 😎
- **Impact Pitch** at low values sounds like rain on a thick roof; crank it up for a tin-can-in-a-thunderstorm vibe!
- Try different **Texture surfaces** — Metal sounds like rain on a tin roof, Forest sounds like rain in the woods, and Umbrella sounds like... well, take a wild guess.
- Crank **Storminess** to 100 and set **Distance** to under 2 km for an intense close-range thunderstorm experience!
- The button with the gear icon **⚙** at the bottom left of this help window opens Performance Presets right here; handy for quick tuning!

---

## Settings Location

**Rainscapes** (click to open): `Documents\RainyDesk\`

Your autosave and default preset live here. Save/load and preset sharing are coming in a future update!

**Logs** (click to open): `%LOCALAPPDATA%\com.rainydesk.app\logs\`

The 5 most recent session logs live here.

**NOTE TO TESTERS:** It would be *very* helpful to send me those logs along with your feedback!

---

## Need More Help?

**Found a bug or have a suggestion?** Contact me on Discord (**XYAgain**) for the fastest response. Once I figure out how to use it, you'll be able to report problems/request features at the [GitHub Issues page!](https://github.com/XYAgainAgain/RainyDesk/issues)

**Want to support development?** My [Ko-fi](https://ko-fi.com/xyagain) cup is open & tips are very much appreciated!

⛈ *Enjoy your cozy rainy computer! I love you!* ☔
