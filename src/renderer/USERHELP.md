# RainyDesk User Guide
*Get your desktop wet.* 🌧️

Welcome to RainyDesk! A desktop rain simulation that renders transparent overlays across all your monitors. Rain falls around your windows (not through them), comes with procedural audio, and stays smooth even at 144 Hz.

---

## Getting Damp

**Opening the Panel**
- Left-click the RainyDesk icon in your system tray (usually bottom-right corner)
- The Rainscaper panel appears on your primary monitor! Wow, magic!
- Drag it wherever you like; it remembers your preferred position!

**Basic Controls**
- **Intensity:** How much rain falls (0% = a lil dribble, 100% = torrential)
- **Wind:** Horizontal wind force (-100 left, +100 right, 0 = calm)
- **Volume:** Master audio volume (0–100%)
- **Mute:** Silence all audio without losing your volume slider settings
- **Pause:** Freeze the simulation in place

---

## Autosave

RainyDesk automatically saves your settings whenever you make a change. Watch the footer:
- **Autosaving...** — writing changes (pulsing white dot)
- **Autosaved!** — complete (solid white dot)
- **Raining** — normal operation (green dot)

All your preferences persist between sessions! No accidentally losing your hand-crafted rain vibes!

---

## Tray Menu

Right-click the tray icon for quick access:
- Pause & Resume (linked to the toggle)
- Volume presets (Mute, 5%, 10%, 25%, 50%, 75%, 90%, 100%)
- Open Rainscaper panel
- Quit RainyDesk

------

## The Five Tabs

### Basic

Your everyday rain controls, plus panel appearance settings!
- **Intensity, Wind, Volume, Mute, Pause**
- **UI Scale:** Resize the panel from 50% to 250%
- **Themes:** 12 lovely little themes including a Windows accent color theme

### Physics

Fine-tune the simulation to your liking!
- **Gravity:** Drop fall speed (100 = very floaty, 2000 = rapid)
- **Splash Size:** How big splashes are when drops hit surfaces
- **Puddle Drain:** How fast puddles disappear (0% = pretty persistent, 100% = near-instant)
- **Turbulence:** Random chaos in the rain motion
- **Max Drop Mass:** Size of individual drops (1 = tiny, 10 = thicc)
- **Reverse Gravity:** Rain falls up! Shocking, I know...
- **Grid Scale:** Simulation resolution (Chunky/Normal/Detailed) — click "Apply Changes" after!

### Audio

Sculpt your ideal soundscape!
- **Master Volume:** Same as Basic tab (linked)
- **Impact Sound:** Raindrop collision volume
- **Wind:** Wind layer volume
- **Thunder:** *Coming soon, I promise!*

When Matrix Mode is on, a **Matrix Synth** section appears:
- **Key:** Transpose the tune! Choices are: Matrix (G), Reloaded (B♭), Revolutions (E), Resurrections (C#)
- **Bass/Collision/Drone:** Individual synth layer volumes, tweak as you like

The Matrix synth plays a 90-bar chord progression based on Rob Dougan's classic banger [Clubbed to Death](https://youtu.be/9FuiZfSkhOw?si=02AJs3FpG4BPN_qP) at 102 BPM. Individual code stream impacts play the melody over a pre-programmed bassline. I worked really hard on this part — I hope you dig it! 💚

### Visual
Customize all that wetness!
- **Background Shader:** Toggle the behind-all-windows rain layer
- **BG Intensity/BG Layers:** Control background rain brightness, opacity, and depth
- **Rain Color:** Pick literally any color (click the reset icon to restore default)
- **Gay Mode:** Rainbow color cycling on a 1-minute rotation 🏳‍🌈
- **Matrix Mode:** Digital rain with cascading code streams and musical collision effects

### Stats
Performance monitoring and fun system info!
- FPS, active drops, water cells, frame time, memory, uptime
- **System Info:** Virtual desktop resolution, display count, per-monitor details
- **Reset RainyDesk:** Reinitializes the simulation (30s cooldown)

---

## Troubleshooting

**Rain laggy or choppy?**
- Lower Grid Scale to Chunky on the Physics tab
- Reduce BG Layers to 1—2 on the Visual tab
- Lower Intensity to reduce active drops

**High GPU usage?**
- Try different Grid Scale settings (lower = better performance)
- Increase Puddle Drain (less water on screen)
- Check the Stats tab for framerate monitoring (60+ is ideal)

**Audio sounds distorted?**

- Lower Master Volume below 75%
- Reduce individual sound sliders on the Audio tab
- If in Matrix Mode, the bitcrush effect is intentional

**Rain going through windows?**
- Close those darn things, you're letting in the damp! Nah just kidding, it isn't real water.
- Window positions update at 60 Hz. Very fast window moves may cause brief visual lag or weird puddles. This is normal. Mostly. I hope.

---

## Tips and Tricks

- Flip on Reverse Gravity and time your toggles to make rain float mid-air!
- Set Volume to 0% for silent rain while watching a movie or playing a game!
- Try turning the Matrix gay! 👀
- Use the **Windows** theme to auto-match your system accent color!

---

## Settings Location

All your configuration files live here (you can click it to open the folder):

`%LOCALAPPDATA%\com.rainydesk.app\`

This includes your autosave, rainscape presets (available soon as shareable `.rain` files!), panel position, and 5 most recent system logs.

**NOTE TO TESTERS:** It would be *very* helpful to send me those logs along with your feedback!

---

## Need More Help?

**Found a bug or have a suggestion?** Contact me on Discord (**XYAgain**) for the fastest response. When I figure out how to use it, you'll be able to report problems at [github.com/XYAgainAgain/RainyDesk/issues](https://github.com/XYAgainAgain/RainyDesk/issues)

**Want to support development?** [Ko-fi](https://ko-fi.com/xyagain) is open & very much appreciated!

⛈ *Enjoy your cozy rainy computer! I love you!* ☔
