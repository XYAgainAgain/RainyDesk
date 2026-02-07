/**
 * MatrixPixiRenderer - Digital Rain with RainyDesk features
 *
 * - BitmapFont rendering (texture atlas for performance)
 * - Object pooling for ~2000+ glyphs
 * - Per-stream Gaytrix coloring (Gay Mode + Matrix Mode)
 * - Collision detection with window zones
 * - Glitch effect on collision (scramble + fade)
 *
 * See .dev/MATRIX-MODE.md for full spec.
 */

import { Application, Container, BitmapText, BitmapFont } from 'pixi.js';
import { GlowFilter, CRTFilter } from 'pixi-filters';

// Configuration
export const MATRIX_CONFIG = {
  FONT_SIZE: 20,
  COLUMN_SPACING: 20,
  // Phosphor color palette (authentic Matrix look)
  COLOR_TRACE: 0x003B00,   // Fading tail
  COLOR_BODY: 0x008F11,    // Main stream ("Islam Green")
  COLOR_LEAD: 0xE0FFD4,    // Head glyph (almost white, phosphor-hot)
  COLOR_GLOW: 0x00FF41,    // Bloom tint (for future filter)
  COLOR_FLASH: 0xFFFFFF,   // Collision flash (on-beat only)
  MIN_SPEED: 12,
  MAX_SPEED: 24,
  MUTATION_CHANCE: 0.02,
  MIN_TAIL: 8,
  MAX_TAIL: 24,
  X_JITTER: 2,
  // Collision glitch effect
  GLITCH_DURATION: 0.35,
  GLITCH_SCRAMBLE_RATE: 25,  // Faster scramble (was 10)
  GLITCH_FLASH_DURATION: 0.05, // Brief white flash on collision
  FIZZLE_HEIGHT_RATIO: 0.75,
  FIZZLE_CHANCE: 0.001,
};

// Film-authentic glyph set (~70 chars)
// 50% Katakana (Matrix Code font), 35% Latin capitals (Nimbus Mono Bold), 15% digits (no 6)
// Plus 日 (the only kanji in the film) and occasional operators
const KATAKANA = 'アウエオカキケコサシスセソタツテナニヌネハヒホマミムメモヤヨラリワー';
const LATIN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '012345789'; // No 6, per film spec
const EXTRA = '日*+:';
const GLYPHS = KATAKANA + LATIN + DIGITS + EXTRA;

/** Window zone for collision detection */
interface WindowZone {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Internal column state */
interface MatrixColumn {
  x: number;
  headY: number;        // Grid Y position of stream head
  speed: number;        // Cells per second
  length: number;       // Tail length in cells
  active: boolean;      // Currently streaming
  glyphs: BitmapText[]; // Active glyph sprites
  spawnTimer: number;   // Delay before next stream
  hue: number;          // For Gaytrix mode
  glitching: boolean;   // Collision glitch state
  glitchTimer: number;  // Remaining glitch time
  glitchAlpha: number;  // Current alpha during glitch
  flashTimer: number;   // Brief white flash on collision
}

/** Renderer configuration */
export interface MatrixRendererConfig {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  dimmed?: boolean;           // For background layer (40% opacity)
  speedMultiplier?: number;   // For background layer (0.5)
  alphaMultiplier?: number;   // For background layer (0.4)
  collisionEnabled?: boolean; // false for background layer
}

export class MatrixPixiRenderer {
  private app: Application | null = null;
  private initialized = false;

  // Config
  private config: MatrixRendererConfig;
  private speedMult: number;
  private alphaMult: number;
  private collisionEnabled: boolean;

  // Containers
  private glyphContainer: Container | null = null;
  private bloomContainer: Container | null = null;
  private bloomFilter: GlowFilter | null = null;
  private crtFilter: CRTFilter | null = null;
  private crtEnabled = false;

  // Head bloom glyphs (one per column for glow effect)
  private headBloomGlyphs: BitmapText[] = [];

  // Column data
  private columns: MatrixColumn[] = [];

  // Object pool
  private glyphPool: BitmapText[] = [];
  private initialPoolSize = 0;
  private fontReady = false;

  // Color modes
  private gaytrixMode = false;
  private globalHueCounter = 0;
  private customColor: number | null = null;

  // Trans Mode
  private transMode = false;
  private transScrollDirection: 'left' | 'off' | 'right' = 'off';
  private transScrollOffset = 0;

  // Window zones (for collision)
  private windowZones: WindowZone[] = [];
  private floorY = 0;

  // Blanked regions: X ranges where columns are suppressed (maximized/fullscreen monitors)
  private blankedRegions: { left: number; right: number }[] = [];

  // Dynamic parameters (mapped from Rainscaper sliders)
  private intensity = 50;         // 0-100: spawn rate/density
  private fallSpeedMin = 12;      // cells/sec (derived from gravity)
  private fallSpeedMax = 24;
  private glitchiness = 0.3;      // 0-1: jitter/mutation/fizzle intensity
  private minTailLength = 8;      // character count (derived from dropSize)
  private maxTailLength = 24;
  private reverseGravity = false; // streams rise from bottom

  // Data Density: font size is fixed, column spacing varies
  private readonly fontSize = 28;
  private columnSpacing = 28;

  // Performance: throttle mutations to 60Hz (matches physics tick rate)
  private mutationAccum = 0;
  private readonly MUTATION_INTERVAL = 1 / 60; // 60Hz mutation ticks

  // Callbacks - returns { onBeat: boolean } for flash intensity decision
  public onCollision: ((x: number, y: number) => { onBeat: boolean }) | null = null;

  constructor(config: MatrixRendererConfig) {
    this.config = config;
    this.speedMult = config.speedMultiplier ?? 1.0;
    this.alphaMult = config.alphaMultiplier ?? 1.0;
    this.collisionEnabled = config.collisionEnabled ?? true;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    this.app = new Application();
    await this.app.init({
      canvas: this.config.canvas,
      width: this.config.width,
      height: this.config.height,
      backgroundColor: 0x000000, // Pure black (Vampire Black was too reddish on modern displays)
      backgroundAlpha: 0, // Transparent for overlay
      antialias: false,
      resolution: 1,
      autoStart: false, // We manage rendering manually via update loop
    });

    this.glyphContainer = new Container();
    this.app.stage.addChild(this.glyphContainer);

    // Bloom container for head glow effect (rendered on top)
    this.bloomContainer = new Container();
    this.bloomFilter = new GlowFilter({
      distance: 8,
      outerStrength: 2.5,
      innerStrength: 0,
      color: MATRIX_CONFIG.COLOR_GLOW,
      quality: 0.3, // Lower quality = better performance
    });
    this.bloomContainer.filters = [this.bloomFilter];
    this.app.stage.addChild(this.bloomContainer);

    // CRT filter for retro scanline effect (applied to whole stage, starts disabled)
    this.crtFilter = new CRTFilter({
      curvature: 2,
      lineWidth: 2,
      lineContrast: 0.3,
      noise: 0.1,
      noiseSize: 1,
      vignetting: 0.2,
      vignettingAlpha: 0.7,
      vignettingBlur: 0.3,
      time: 0,
    });
    // Don't apply filter until enabled (performance)

    await this.initBitmapFont();
    // Pool size calculation: columns × max_tail_length × 1.5 safety margin
    // For 6200px @ 20px spacing = 310 columns × 24 max tail × 1.5 = ~11,000
    const columnCount = Math.ceil(this.config.width / this.columnSpacing);
    const poolSize = Math.max(8000, columnCount * MATRIX_CONFIG.MAX_TAIL * 2);
    this.initGlyphPool(poolSize);
    this.initColumns();
    this.floorY = this.config.height;

    this.initialized = true;
  }

  private async initBitmapFont(): Promise<void> {
    // Wait for web fonts to load (Matrix Code for katakana, Nimbus Mono Bold for Latin)
    await document.fonts.ready;

    const matrixLoaded = document.fonts.check('20px "Matrix Code"');
    const nimbusLoaded = document.fonts.check('bold 20px "Nimbus Mono"');
    console.log('[Matrix] Font check — Matrix Code:', matrixLoaded, '| Nimbus Mono Bold:', nimbusLoaded);

    // Font fallback chain: katakana/digits → Matrix Code, Latin → Nimbus Mono Bold
    const fontFamily = matrixLoaded
      ? "'Matrix Code', 'Nimbus Mono', monospace"
      : "'Nimbus Mono', monospace";

    BitmapFont.install({
      name: 'MatrixBitmapFont',
      style: {
        fontFamily,
        fontWeight: 'bold',
        fontSize: this.fontSize,
        fill: '#ffffff',
      },
      chars: GLYPHS.split(''),
    });

    console.log('[Matrix] BitmapFont installed');
    this.fontReady = true;
  }

  private initGlyphPool(size: number): void {
    this.initialPoolSize = size;
    for (let i = 0; i < size; i++) {
      const glyph = new BitmapText({
        text: 'A',
        style: { fontFamily: 'MatrixBitmapFont' },
      });
      glyph.visible = false;
      glyph.anchor.set(0.5);
      glyph.tint = MATRIX_CONFIG.COLOR_BODY; // Explicitly set green tint
      this.glyphPool.push(glyph);
      this.glyphContainer?.addChild(glyph);
    }
    console.log(`[Matrix] Glyph pool initialized with ${size} glyphs`);
  }

  private initColumns(): void {
    const columnCount = Math.floor(this.config.width / this.columnSpacing);
    this.columns = [];
    const gridHeight = Math.ceil(this.config.height / this.fontSize);

    // Clean up old bloom glyphs (remove from container BEFORE destroying)
    for (const g of this.headBloomGlyphs) {
      g.removeFromParent();
      g.destroy();
    }
    this.headBloomGlyphs.length = 0;

    for (let i = 0; i < columnCount; i++) {
      const baseX = i * this.columnSpacing + this.columnSpacing / 2;

      // Scale initial active % with intensity: 1% → 5% active, 100% → 90% active
      const activeChance = 0.05 + (Math.max(0, this.intensity - 1) / 99) * 0.85;

      this.columns.push({
        x: baseX + this.getXJitter(),
        headY: this.reverseGravity ? gridHeight + Math.random() * 20 : -Math.random() * 20,
        speed: this.getRandomSpeed(),
        length: this.getRandomLength(),
        active: Math.random() < activeChance,
        glyphs: [],
        spawnTimer: this.getSpawnDelay(),
        hue: 0,
        glitching: false,
        glitchTimer: 0,
        glitchAlpha: 1,
        flashTimer: 0,
      });

      // Create bloom glyph for this column's head
      const bloomGlyph = new BitmapText({
        text: 'A',
        style: { fontFamily: 'MatrixBitmapFont' },
      });
      bloomGlyph.visible = false;
      bloomGlyph.anchor.set(0.5);
      bloomGlyph.tint = MATRIX_CONFIG.COLOR_LEAD;
      this.bloomContainer?.addChild(bloomGlyph);
      this.headBloomGlyphs.push(bloomGlyph);
    }
  }

  private getRandomSpeed(): number {
    return (this.fallSpeedMin + Math.random() * (this.fallSpeedMax - this.fallSpeedMin)) * this.speedMult;
  }

  private getRandomLength(): number {
    return this.minTailLength + Math.floor(Math.random() * (this.maxTailLength - this.minTailLength));
  }

  /** Get spawn delay based on intensity (1-100). Higher intensity = shorter delays. */
  private getSpawnDelay(): number {
    // Exponential curve so low intensities feel VERY sparse:
    // Intensity 1  → 8-12s delay (a trickle of data)
    // Intensity 25 → 1.5-3s delay (sparse streams)
    // Intensity 50 → 0.3-0.8s delay (normal density)
    // Intensity 100 → 0.02-0.06s delay (wall of code)
    const t = Math.max(0, (this.intensity - 1) / 99); // 0-1 range (1=min, 100=max)
    // Exponential mapping: delay = base * e^(-k*t) for dramatic low-end sparseness
    const maxDelay = 12.0 * Math.exp(-5.2 * t);  // 12.0 → 0.06
    const minDelay = 8.0 * Math.exp(-5.9 * t);   // 8.0 → 0.02
    return minDelay + Math.random() * Math.max(0, maxDelay - minDelay);
  }

  /** Get current X jitter based on glitchiness. */
  private getXJitter(): number {
    // Glitchiness 0 → no jitter, 1 → 6px jitter (visible digital instability)
    return (Math.random() - 0.5) * 6 * 2 * this.glitchiness;
  }

  /** Get mutation chance based on glitchiness. */
  private getMutationChance(): number {
    // Glitchiness 0 → 0.5% mutation, 1 → 12% mutation (dramatic character scramble)
    return 0.005 + this.glitchiness * 0.115;
  }

  /** Get fizzle chance based on glitchiness. */
  private getFizzleChance(): number {
    // Glitchiness 0 → 0.1% fizzle, 1 → 1.5% fizzle (more streams reach the floor)
    return 0.001 + this.glitchiness * 0.014;
  }

  setGaytrixMode(enabled: boolean): void {
    this.gaytrixMode = enabled;
    // Gaytrix uses per-column hues, so bloom glow should be neutral white
    if (this.bloomFilter) {
      if (enabled) {
        this.bloomFilter.color = 0xFFFFFF;
      } else if (this.customColor !== null) {
        this.bloomFilter.color = this.customColor;
      } else {
        this.bloomFilter.color = MATRIX_CONFIG.COLOR_GLOW;
      }
    }
  }

  setRainColor(hex: string): void {
    // Parse hex color like "#FF6B6B" to number
    const cleanHex = hex.replace('#', '');
    this.customColor = parseInt(cleanHex, 16);
    // Update bloom glow halo to match custom color
    if (this.bloomFilter) this.bloomFilter.color = this.customColor;
  }

  clearCustomColor(): void {
    this.customColor = null;
    // Revert bloom glow halo to default green
    if (this.bloomFilter) this.bloomFilter.color = MATRIX_CONFIG.COLOR_GLOW;
  }

  setTransMode(enabled: boolean): void {
    this.transMode = enabled;
    if (!enabled) {
      this.transScrollOffset = 0;
    }
    // Trans mode uses white bloom (like Gaytrix)
    if (this.bloomFilter) {
      if (enabled) {
        this.bloomFilter.color = 0xFFFFFF;
      } else if (this.gaytrixMode) {
        this.bloomFilter.color = 0xFFFFFF;
      } else if (this.customColor !== null) {
        this.bloomFilter.color = this.customColor;
      } else {
        this.bloomFilter.color = MATRIX_CONFIG.COLOR_GLOW;
      }
    }
  }

  setTransScrollDirection(dir: 'left' | 'off' | 'right'): void {
    // Guard against invalid values from IPC/save data
    if (dir !== 'left' && dir !== 'off' && dir !== 'right') {
      this.transScrollDirection = 'off';
      return;
    }
    this.transScrollDirection = dir;
  }

  getTransMode(): boolean {
    return this.transMode;
  }

  getTransScrollDirection(): string {
    return this.transScrollDirection;
  }

  updateWindowZones(zones: WindowZone[]): void {
    this.windowZones = zones;
  }

  /**
   * Set blanked X regions (monitors covered by maximized/fullscreen windows).
   * Columns within these regions are hidden and don't spawn new streams.
   */
  setBlankedRegions(regions: { left: number; right: number }[]): void {
    this.blankedRegions = regions;
  }

  setFloorY(y: number): void {
    this.floorY = y;
  }

  /**
   * Set stream density (0-100).
   * Higher values = more streams spawning, shorter spawn delays.
   */
  setIntensity(value: number): void {
    this.intensity = Math.max(1, Math.min(100, value));
  }

  /** Set alpha multiplier for dimming (used by background layer). */
  setAlphaMult(value: number): void {
    this.alphaMult = Math.max(0, Math.min(1, value));
  }

  /**
   * Set fall speed from gravity value (100-2000).
   * Normal gravity 980 → 12-24 cells/sec. Scales proportionally.
   */
  setFallSpeed(gravity: number): void {
    // Map gravity to speed range: 980 → base speed (12-24)
    // Clamp to minimum 100 to prevent zero-speed streams
    const clampedGravity = Math.max(100, gravity);
    const factor = clampedGravity / 980;
    this.fallSpeedMin = MATRIX_CONFIG.MIN_SPEED * factor;
    this.fallSpeedMax = MATRIX_CONFIG.MAX_SPEED * factor;
  }

  /**
   * Set glitchiness/turbulence (0-1).
   * Controls X jitter, mutation rate, and fizzle chance.
   */
  setGlitchiness(value: number): void {
    this.glitchiness = Math.max(0, Math.min(1, value));
  }

  /**
   * Set string/tail length from drop size (1-10).
   * Maps to min/max tail character count.
   */
  setStringLength(dropSize: number): void {
    // dropSize 1 → short tails (4-10), dropSize 10 → long tails (12-30)
    // Capped at 30 to prevent FPS tank (96 cols x 40 tail = 3840 glyphs + bloom)
    const clampedSize = Math.max(1, Math.min(10, dropSize));
    const factor = clampedSize / 4; // normalize to base value of 4
    this.minTailLength = Math.max(4, Math.min(16, Math.round(MATRIX_CONFIG.MIN_TAIL * factor)));
    this.maxTailLength = Math.max(8, Math.min(30, Math.round(MATRIX_CONFIG.MAX_TAIL * factor)));
  }

  /**
   * Set reverse gravity mode (streams rise from bottom).
   */
  setReverseGravity(enabled: boolean): void {
    this.reverseGravity = enabled;
    // Reset all columns to respawn from correct direction
    for (const col of this.columns) {
      if (col.active && !col.glitching) {
        // Release current glyphs
        for (const g of col.glyphs) {
          this.releaseGlyph(g);
        }
        col.glyphs.length = 0;
        col.active = false;
        col.spawnTimer = Math.random() * 0.3;
      }
    }
  }

  /**
   * Set data density (column spacing only, font size stays fixed at 28px).
   * More columns = denser streams. Reinits columns but reuses glyph pool.
   * @param spacing Column spacing in pixels
   */
  setDensity(spacing: number): void {
    if (!this.initialized || !this.app) return;
    if (spacing === this.columnSpacing) return;

    this.columnSpacing = spacing;

    // Release all current column glyphs back to pool
    for (const col of this.columns) {
      for (const g of col.glyphs) {
        this.releaseGlyph(g);
      }
    }

    // Grow pool if needed (more columns = more glyphs needed)
    const columnCount = Math.ceil(this.config.width / spacing);
    const neededPool = Math.max(8000, columnCount * MATRIX_CONFIG.MAX_TAIL * 2);
    while (this.glyphPool.length + this.columns.reduce((n, c) => n + c.glyphs.length, 0) < neededPool) {
      const glyph = new BitmapText({
        text: 'A',
        style: { fontFamily: 'MatrixBitmapFont' },
      });
      glyph.visible = false;
      glyph.anchor.set(0.5);
      glyph.tint = MATRIX_CONFIG.COLOR_BODY;
      this.glyphPool.push(glyph);
      this.glyphContainer?.addChild(glyph);
    }

    this.initColumns();
    console.log(`[Matrix] Density changed: spacing=${spacing}px, columns=${columnCount}`);
  }

  /** Get current column spacing (for autosave) */
  getDensity(): number {
    return this.columnSpacing;
  }

  /**
   * Set CRT filter intensity (0 = off, 1 = full effect).
   * Values > 0 enable the filter, 0 disables it for performance.
   */
  setCrtIntensity(intensity: number): void {
    if (!this.crtFilter || !this.app) return;

    const clamped = Math.max(0, Math.min(1, intensity));

    if (clamped <= 0) {
      // Disable CRT filter for performance
      if (this.crtEnabled) {
        this.app.stage.filters = [];
        this.crtEnabled = false;
      }
      return;
    }

    // Enable and scale CRT parameters
    if (!this.crtEnabled) {
      this.app.stage.filters = [this.crtFilter];
      this.crtEnabled = true;
    }

    // Scale CRT parameters with intensity
    this.crtFilter.curvature = 2 * clamped;
    this.crtFilter.lineContrast = 0.3 * clamped;
    this.crtFilter.noise = 0.1 * clamped;
    this.crtFilter.vignetting = 0.2 * clamped;
    this.crtFilter.vignettingAlpha = 0.7 * clamped;
  }

  /**
   * Update CRT time for animated noise (call each frame if CRT enabled).
   */
  updateCrtTime(time: number): void {
    if (this.crtFilter && this.crtEnabled) {
      this.crtFilter.time = time;
    }
  }

  private getRandomGlyph(): string {
    return GLYPHS[Math.floor(Math.random() * GLYPHS.length)] || 'A';
  }

  private acquireGlyph(): BitmapText | null {
    let glyph = this.glyphPool.pop();
    if (!glyph) {
      // Pool exhausted — hard cap at 2× initial pool to prevent unbounded growth
      const totalGlyphs = (this.glyphContainer?.children.length ?? 0);
      if (totalGlyphs > this.initialPoolSize * 2) {
        // Too many glyphs already — skip this allocation to prevent memory leak
        return null;
      }
      glyph = new BitmapText({
        text: 'A',
        style: { fontFamily: 'MatrixBitmapFont' },
      });
      glyph.anchor.set(0.5);
      glyph.tint = MATRIX_CONFIG.COLOR_BODY;
      this.glyphContainer?.addChild(glyph);
    }
    glyph.visible = true;
    return glyph;
  }

  private releaseGlyph(glyph: BitmapText): void {
    glyph.visible = false;
    glyph.alpha = 1;
    glyph.tint = MATRIX_CONFIG.COLOR_BODY;
    this.glyphPool.push(glyph);
  }

  /** Check if an X position falls within a blanked region (maximized/fullscreen monitor) */
  private isBlanked(x: number): boolean {
    for (const region of this.blankedRegions) {
      if (x >= region.left && x <= region.right) return true;
    }
    return false;
  }

  private checkCollision(x: number, y: number): boolean {
    if (!this.collisionEnabled) return false;

    if (this.reverseGravity) {
      // Ceiling collision (top of screen) for upward-traveling streams
      if (y <= 0) return true;
    } else {
      // Floor collision (taskbar) for downward-traveling streams
      if (y >= this.floorY) return true;
    }

    // Check windows
    for (const zone of this.windowZones) {
      if (x >= zone.left && x <= zone.right && y >= zone.top && y <= zone.bottom) {
        return true;
      }
    }
    return false;
  }

  /** Convert HSL to RGB integer (for Pixi tint) */
  private hslToRgb(h: number, s: number, l: number): number {
    s /= 100;
    l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return ((Math.round((r + m) * 255) << 16) |
            (Math.round((g + m) * 255) << 8) |
             Math.round((b + m) * 255));
  }

  /** Brighten a color by adding to RGB values */
  private brightenColor(color: number, amount: number): number {
    const r = Math.min(255, ((color >> 16) & 0xFF) + amount);
    const g = Math.min(255, ((color >> 8) & 0xFF) + amount);
    const b = Math.min(255, (color & 0xFF) + amount);
    return (r << 16) | (g << 8) | b;
  }

  /** Darken a color by multiplying RGB values */
  private darkenColor(color: number, factor: number): number {
    const r = Math.floor(((color >> 16) & 0xFF) * factor);
    const g = Math.floor(((color >> 8) & 0xFF) * factor);
    const b = Math.floor((color & 0xFF) * factor);
    return (r << 16) | (g << 8) | b;
  }

  /** Smoothstep interpolation (0-1 output for t in 0-1 range) */
  private smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  /** Lerp between two RGB colors packed as integers */
  private lerpColor(a: number, b: number, t: number): number {
    const ar = (a >> 16) & 0xFF, ag = (a >> 8) & 0xFF, ab = a & 0xFF;
    const br = (b >> 16) & 0xFF, bg = (b >> 8) & 0xFF, bb = b & 0xFF;
    const r = Math.round(ar + (br - ar) * t);
    const g = Math.round(ag + (bg - ag) * t);
    const bv = Math.round(ab + (bb - ab) * t);
    return (r << 16) | (g << 8) | bv;
  }

  /**
   * Get trans flag gradient color based on column X position.
   * 5 zones: blue | pink | white | pink | blue
   * With smoothstep blending at zone boundaries (~15% blend width).
   */
  private getTransColor(columnX: number, isHead: boolean, tailProgress: number): number {
    const width = this.config.width;
    if (width <= 0) return 0xFFFFFF;

    // Trans flag colors
    const BLUE  = 0x5BCEFA;
    const PINK  = 0xF5A9B8;
    const WHITE = 0xFFFFFF;

    // Apply scroll offset with wrapping
    const x = ((columnX + this.transScrollOffset) % width + width) % width;
    const t = x / width; // 0-1 normalized position

    // 5 equal zones: each 0.2 wide
    const zoneWidth = 0.2;
    const blendWidth = 0.01; // ~5% of zone width for crisp flag stripes

    // Zone boundaries (centers of blend regions)
    // Zone 0: blue (0-0.2), Zone 1: pink (0.2-0.4), Zone 2: white (0.4-0.6)
    // Zone 3: pink (0.6-0.8), Zone 4: blue (0.8-1.0)
    const zones = [BLUE, PINK, WHITE, PINK, BLUE];
    const zoneIndex = Math.min(4, Math.floor(t / zoneWidth));
    const zonePos = (t - zoneIndex * zoneWidth) / zoneWidth; // 0-1 within zone

    let baseColor: number;
    if (zonePos < blendWidth / zoneWidth && zoneIndex > 0) {
      // Blend with previous zone
      const blendT = this.smoothstep(0, blendWidth / zoneWidth, zonePos);
      baseColor = this.lerpColor(zones[zoneIndex - 1]!, zones[zoneIndex]!, blendT);
    } else if (zonePos > 1 - blendWidth / zoneWidth && zoneIndex < 4) {
      // Blend with next zone
      const blendT = this.smoothstep(1 - blendWidth / zoneWidth, 1, zonePos);
      baseColor = this.lerpColor(zones[zoneIndex]!, zones[zoneIndex + 1]!, blendT);
    } else {
      baseColor = zones[zoneIndex]!;
    }

    // Heads: brighten +60 RGB
    if (isHead) {
      return this.brightenColor(baseColor, 60);
    }

    // Tails: darken by progress factor
    if (tailProgress > 0) {
      return this.darkenColor(baseColor, Math.max(0.2, 1 - tailProgress * 0.7));
    }

    return baseColor;
  }

  /** Get color for a glyph based on mode and position in stream */
  private getStreamColor(hue: number, isHead: boolean, tailProgress: number, columnX = 0): number {
    // Priority: Trans > Gaytrix > Custom Color > Default Green
    if (this.transMode) {
      return this.getTransColor(columnX, isHead, tailProgress);
    }

    if (this.gaytrixMode) {
      // Gaytrix: per-stream hue with brightness based on position
      const lightness = isHead ? 90 : (60 - tailProgress * 30);
      return this.hslToRgb(hue, 80, lightness);
    }

    if (this.customColor !== null) {
      // Custom color mode
      if (isHead) {
        return this.brightenColor(this.customColor, 100);
      }
      if (tailProgress < 0.3) {
        return this.customColor;
      }
      return this.darkenColor(this.customColor, 0.3);
    }

    // Default green Matrix colors
    if (isHead) return MATRIX_CONFIG.COLOR_LEAD;
    return tailProgress < 0.3 ? MATRIX_CONFIG.COLOR_BODY : MATRIX_CONFIG.COLOR_TRACE;
  }

  update(dt: number): void {
    if (!this.initialized || !this.fontReady) return;

    // Throttle mutations to 30Hz (saves BitmapText recalculation overhead)
    this.mutationAccum += dt;
    const doMutations = this.mutationAccum >= this.MUTATION_INTERVAL;
    if (doMutations) this.mutationAccum = 0;

    // Advance trans gradient scroll offset
    if (this.transMode && this.transScrollDirection !== 'off') {
      const speed = 80; // px/sec
      const dir = this.transScrollDirection === 'left' ? 1 : -1;
      this.transScrollOffset += speed * dt * dir;
      // Wrap every frame to prevent float precision loss over long runtimes
      this.transScrollOffset = ((this.transScrollOffset % this.config.width) + this.config.width) % this.config.width;
    }

    try {
      this.updateColumns(dt, doMutations);

      // Animate CRT noise if enabled
      if (this.crtEnabled && this.crtFilter) {
        this.crtFilter.time = performance.now() / 1000;
      }
    } catch (err) {
      console.error('[Matrix] Update error:', err instanceof Error ? err.message : String(err));
    }
  }

  private updateColumns(dt: number, doMutations = true): void {
    const gridHeight = Math.ceil(this.config.height / this.fontSize);
    const direction = this.reverseGravity ? -1 : 1;

    for (let colIdx = 0; colIdx < this.columns.length; colIdx++) {
      const column = this.columns[colIdx]!;
      const bloomGlyphForCol = this.headBloomGlyphs[colIdx];

      // Blanked region check: suppress columns on monitors covered by maximized/fullscreen windows
      if (this.isBlanked(column.x)) {
        // Release any active glyphs and prevent spawning
        if (column.active || column.glitching) {
          for (const g of column.glyphs) {
            this.releaseGlyph(g);
          }
          column.glyphs.length = 0;
          column.active = false;
          column.glitching = false;
          column.spawnTimer = 0.5; // Short timer so it respawns quickly when unblanked
        }
        if (bloomGlyphForCol) bloomGlyphForCol.visible = false;
        continue;
      }

      // Handle glitching state (collision happened)
      if (column.glitching) {
        column.glitchTimer -= dt;
        column.flashTimer -= dt;
        column.glitchAlpha = Math.max(0, column.glitchTimer / MATRIX_CONFIG.GLITCH_DURATION);

        // During flash phase: bright white tint
        const isFlashing = column.flashTimer > 0;

        // Scramble glyphs rapidly (throttled to mutation tick for perf)
        for (let gi = 0; gi < column.glyphs.length; gi++) {
          const glyph = column.glyphs[gi]!;
          if (doMutations && Math.random() < MATRIX_CONFIG.GLITCH_SCRAMBLE_RATE * this.MUTATION_INTERVAL) {
            glyph.text = this.getRandomGlyph();
          }

          // Flash: white tint, then fade back through mode-appropriate color
          if (isFlashing) {
            glyph.tint = MATRIX_CONFIG.COLOR_FLASH;
            glyph.alpha = this.alphaMult;
          } else {
            const tailProgress = gi / Math.max(1, column.glyphs.length);
            glyph.tint = this.getStreamColor(column.hue, gi === 0, tailProgress, column.x);
            glyph.alpha = column.glitchAlpha * this.alphaMult;
          }
        }

        // Hide bloom glyph during glitch
        if (bloomGlyphForCol) {
          bloomGlyphForCol.visible = false;
        }

        // Glitch complete - release all glyphs and reset
        if (column.glitchTimer <= 0) {
          for (const g of column.glyphs) {
            this.releaseGlyph(g);
          }
          column.glyphs.length = 0;
          column.glitching = false;
          column.active = false;
          column.spawnTimer = this.getSpawnDelay();
        }
        continue;
      }

      // Inactive column - wait for spawn timer
      if (!column.active) {
        // Hide bloom glyph when inactive
        if (bloomGlyphForCol) {
          bloomGlyphForCol.visible = false;
        }

        column.spawnTimer -= dt;
        if (column.spawnTimer <= 0) {
          column.active = true;
          // Spawn from top (normal) or bottom (reverse)
          column.headY = this.reverseGravity
            ? gridHeight + Math.random() * 5
            : -Math.random() * 5;
          column.speed = this.getRandomSpeed();
          column.length = this.getRandomLength();
          column.hue = this.globalHueCounter;
          this.globalHueCounter = (this.globalHueCounter + 15) % 360;
        }
        continue;
      }

      // Move head (down for normal, up for reverse)
      column.headY += column.speed * dt * direction;

      // Check collision at head position
      const screenY = column.headY * this.fontSize;
      if (this.checkCollision(column.x, screenY)) {
        // Trigger audio first to get beat quantization info
        const beatInfo = this.onCollision?.(column.x, screenY);

        column.glitching = true;
        column.glitchTimer = MATRIX_CONFIG.GLITCH_DURATION;
        column.glitchAlpha = 1;
        // Only big flash on-beat; off-beat = no flash (just scramble)
        column.flashTimer = beatInfo?.onBeat ? MATRIX_CONFIG.GLITCH_FLASH_DURATION : 0;
        continue;
      }

      // Spawn new glyph at head position
      const gridY = Math.floor(column.headY);
      const validY = this.reverseGravity ? gridY < gridHeight : gridY >= 0;
      const needsNewGlyph = column.glyphs.length === 0 ||
        (this.reverseGravity
          ? gridY < Math.floor(column.glyphs[0]!.y / this.fontSize)
          : gridY > Math.floor(column.glyphs[0]!.y / this.fontSize));

      if (validY && needsNewGlyph) {
        const glyph = this.acquireGlyph();
        if (glyph) {
          glyph.text = this.getRandomGlyph();
          glyph.x = column.x;
          glyph.y = gridY * this.fontSize;
          glyph.tint = this.getStreamColor(column.hue, true, 0, column.x);
          glyph.alpha = this.alphaMult;
          column.glyphs.unshift(glyph);
        }
      }

      // Update existing glyphs (colors and alpha)
      for (let i = 0; i < column.glyphs.length; i++) {
        const glyph = column.glyphs[i]!;

        // Random mutation based on glitchiness (throttled to 30Hz)
        if (doMutations && Math.random() < this.getMutationChance()) {
          glyph.text = this.getRandomGlyph();
        }

        const tailProgress = i / column.length;
        let tint = this.getStreamColor(column.hue, i === 0, tailProgress, column.x);

        // Color flicker at high glitchiness (throttled to mutation ticks)
        if (doMutations && this.glitchiness > 0.5 && Math.random() < (this.glitchiness - 0.5) * 0.1) {
          // Random bright flash: shift green channel or add cyan/white flicker
          const flickerType = Math.random();
          if (flickerType < 0.4) {
            tint = 0x00FFFF; // Cyan flash
          } else if (flickerType < 0.7) {
            tint = 0xFFFFFF; // White flash
          } else {
            tint = 0x40FF40; // Bright green flash
          }
        }

        glyph.tint = tint;
        glyph.alpha = Math.max(0, (1 - tailProgress)) * this.alphaMult;
      }

      // Sync bloom glyph with head (for glow effect)
      const bloomGlyph = bloomGlyphForCol;
      const headGlyph = column.glyphs[0];
      if (bloomGlyph && headGlyph) {
        bloomGlyph.visible = true;
        bloomGlyph.x = headGlyph.x;
        bloomGlyph.y = headGlyph.y;
        // Only update text if changed (avoids BitmapText recalculation)
        if (bloomGlyph.text !== headGlyph.text) {
          bloomGlyph.text = headGlyph.text;
        }
        bloomGlyph.alpha = headGlyph.alpha;
        // Use Trans / Gaytrix hue / custom / default glow color
        if (this.transMode) {
          bloomGlyph.tint = this.getTransColor(column.x, true, 0);
        } else if (this.gaytrixMode) {
          bloomGlyph.tint = this.hslToRgb(column.hue, 80, 70);
        } else if (this.customColor !== null) {
          bloomGlyph.tint = this.brightenColor(this.customColor, 100);
        } else {
          bloomGlyph.tint = MATRIX_CONFIG.COLOR_LEAD;
        }
      } else if (bloomGlyph) {
        bloomGlyph.visible = false;
      }

      // Remove glyphs beyond tail length
      while (column.glyphs.length > column.length) {
        const old = column.glyphs.pop()!;
        this.releaseGlyph(old);
      }

      // Fizzle (random early death) after passing 50% screen height
      const progressRatio = this.reverseGravity
        ? (gridHeight - column.headY) / gridHeight
        : column.headY / gridHeight;
      const fizzleChance = progressRatio > MATRIX_CONFIG.FIZZLE_HEIGHT_RATIO
        ? this.getFizzleChance()
        : 0;

      // Check if stream has exited screen
      const exitedScreen = this.reverseGravity
        ? column.headY < -column.length
        : column.headY > gridHeight + column.length;

      if (Math.random() < fizzleChance || exitedScreen) {
        // Stream died - release all glyphs
        for (const g of column.glyphs) {
          this.releaseGlyph(g);
        }
        column.glyphs.length = 0;
        column.active = false;
        column.spawnTimer = this.getSpawnDelay();
      }
    }
  }

  render(): void {
    // Guard: Pixi Application.render() crashes if called before init() resolves
    // (this.app.renderer is undefined until the async init completes)
    if (!this.initialized || !this.app) return;
    this.app.render();
  }

  resize(width: number, height: number): void {
    if (!this.app) return;
    this.config.width = width;
    this.config.height = height;
    this.floorY = height;
    this.app.renderer.resize(width, height);

    // Release all glyphs and reinit columns
    for (const col of this.columns) {
      for (const g of col.glyphs) {
        this.releaseGlyph(g);
      }
    }
    this.initColumns();
  }

  destroy(): void {
    // Disable filters before teardown
    if (this.app) {
      this.app.stage.filters = [];
    }

    // Clean up bloom glyphs (remove from container before destroying)
    for (const g of this.headBloomGlyphs) {
      g.removeFromParent();
      g.destroy();
    }
    this.headBloomGlyphs.length = 0;
    this.bloomFilter = null;
    this.bloomContainer = null;
    this.crtFilter = null;
    this.crtEnabled = false;

    // Release all column glyphs back to pool
    for (const col of this.columns) {
      for (const g of col.glyphs) {
        this.releaseGlyph(g);
      }
      col.glyphs.length = 0;
    }

    if (this.app) {
      this.app.destroy(false, { children: true, texture: true });
      this.app = null;
    }
    this.columns.length = 0;
    this.glyphPool.length = 0;
    this.initialized = false;
  }
}
