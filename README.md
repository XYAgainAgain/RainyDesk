# RainyDesk

A peaceful desktop rain simulation application for Windows and Linux. RainyDesk creates transparent overlays on all your monitors, simulating realistic rain with physics-based particles and procedural audio. Get your desktop wet! 🌧

## Features

### Current (Phase 1)
- **Multi-monitor support** — Works across all displays, including vertical/rotated monitors
- **Click-through transparency** — Rain never interferes with your workflow
- **Realistic physics** — Gravity, wind, air resistance, and splash effects
- **System tray controls** — Adjust intensity and volume on the fly
- **High refresh rate support** — Matches your monitor (120Hz, 144Hz+)

### Planned
- **Rainscapes** — Complete presets combining visuals and audio (Tin Roof, Forest, Urban, etc.)
- **Custom rainscapes** — Edit and save your own perfect rain atmosphere
- **Window detection** — Rain flows around your windows, never on top
- **Procedural audio system** — Customizable rain sounds with spatial positioning
- **Advanced audio controls** — 3-band EQ, reverb, surround sound with 3D positioning
- **Visual options** — Adjustable trails, experimental gravity reversal
- **Quality presets** — Low/Medium/High/Ultra for different performance needs
- **Gentle startup** — Auto-loads last rainscape with peaceful fade-in

## Installation

### Development
```bash
npm install
npm start
```

### Building
```bash
npm run package    # Package for current platform
npm run make       # Create distributable installer
```

## Requirements

- Node.js 16+
- Windows 10/11 (Linux support coming soon!)
- High refresh rate monitors supported (60Hz to 240Hz+)

## Usage

RainyDesk runs in your system tray. Right-click the tray icon to:
- Pause/resume rain mid-simulation
- Adjust the current rainscape or pick a new one
- Control volume and overall quality
- Quit the application

## Architecture

Built with Electron, RainyDesk creates one transparent overlay window per monitor. Each window runs an independent canvas-based particle simulation with delta-time physics for consistent behavior across different refresh rates.

## Performance

- Maintains native refresh rate on all monitors
- Target: 2000+ particles per monitor at a minimum of 120fps
- Memory footprint: <200MB total

## Platform Support

- **Current**: Windows 10/11
- **Coming**: Linux (tested on Mint)

## Third-Party Libraries

- **Tone.js** (v15.1.22) - MIT License - Procedural audio synthesis - https://tonejs.github.io
- **Matter.js** (v0.20.0) - MIT License - 2D physics engine - https://brm.io/matter-js

## License

GPL-3.0

## Author

Sam Atwood
