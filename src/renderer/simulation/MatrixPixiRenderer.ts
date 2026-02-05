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
  FIZZLE_HEIGHT_RATIO: 0.5,
  FIZZLE_CHANCE: 0.002,
};

// Authentic glyph set (Matrix Code NFI characters + alphanumerics)
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*+=<>?/\\|[]{}';

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

  // Column data
  private columns: MatrixColumn[] = [];

  // Object pool
  private glyphPool: BitmapText[] = [];
  private fontReady = false;

  // Color modes
  private gaytrixMode = false;
  private globalHueCounter = 0;
  private customColor: number | null = null;

  // Window zones (for collision)
  private windowZones: WindowZone[] = [];
  private floorY = 0;

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

    await this.initBitmapFont();
    // Pool size calculation: columns × max_tail_length × 1.5 safety margin
    // For 6200px @ 20px spacing = 310 columns × 24 max tail × 1.5 = ~11,000
    const columnCount = Math.ceil(this.config.width / MATRIX_CONFIG.COLUMN_SPACING);
    const poolSize = Math.max(8000, columnCount * MATRIX_CONFIG.MAX_TAIL * 2);
    this.initGlyphPool(poolSize);
    this.initColumns();
    this.floorY = this.config.height;

    this.initialized = true;
  }

  private async initBitmapFont(): Promise<void> {
    // Wait for web fonts to load (Matrix Code NFI loaded via CSS)
    await document.fonts.ready;

    // Check if Matrix Code NFI loaded
    const fontLoaded = document.fonts.check('20px "Matrix Code NFI"');
    console.log('[Matrix] Font check "Matrix Code NFI":', fontLoaded);

    // Create bitmap font from the loaded web font
    BitmapFont.install({
      name: 'MatrixBitmapFont',
      style: {
        fontFamily: fontLoaded ? 'Matrix Code NFI' : 'monospace',
        fontSize: MATRIX_CONFIG.FONT_SIZE,
        fill: '#ffffff', // Use string format for Pixi v8
      },
      chars: GLYPHS.split(''),
    });

    console.log('[Matrix] BitmapFont installed');
    this.fontReady = true;
  }

  private initGlyphPool(size: number): void {
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
    const columnCount = Math.floor(this.config.width / MATRIX_CONFIG.COLUMN_SPACING);
    this.columns = [];

    for (let i = 0; i < columnCount; i++) {
      const baseX = i * MATRIX_CONFIG.COLUMN_SPACING + MATRIX_CONFIG.COLUMN_SPACING / 2;
      const jitter = (Math.random() - 0.5) * MATRIX_CONFIG.X_JITTER * 2;

      this.columns.push({
        x: baseX + jitter,
        headY: -Math.random() * 20,
        speed: this.getRandomSpeed(),
        length: this.getRandomLength(),
        active: Math.random() > 0.3,
        glyphs: [],
        spawnTimer: Math.random() * 0.5,
        hue: 0,
        glitching: false,
        glitchTimer: 0,
        glitchAlpha: 1,
        flashTimer: 0,
      });
    }
  }

  private getRandomSpeed(): number {
    return (MATRIX_CONFIG.MIN_SPEED + Math.random() * (MATRIX_CONFIG.MAX_SPEED - MATRIX_CONFIG.MIN_SPEED)) * this.speedMult;
  }

  private getRandomLength(): number {
    return MATRIX_CONFIG.MIN_TAIL + Math.floor(Math.random() * (MATRIX_CONFIG.MAX_TAIL - MATRIX_CONFIG.MIN_TAIL));
  }

  setGaytrixMode(enabled: boolean): void {
    this.gaytrixMode = enabled;
  }

  setRainColor(hex: string): void {
    // Parse hex color like "#FF6B6B" to number
    const cleanHex = hex.replace('#', '');
    this.customColor = parseInt(cleanHex, 16);
  }

  clearCustomColor(): void {
    this.customColor = null;
  }

  updateWindowZones(zones: WindowZone[]): void {
    this.windowZones = zones;
  }

  setFloorY(y: number): void {
    this.floorY = y;
  }

  private getRandomGlyph(): string {
    return GLYPHS[Math.floor(Math.random() * GLYPHS.length)] || 'A';
  }

  private acquireGlyph(): BitmapText | null {
    let glyph = this.glyphPool.pop();
    if (!glyph) {
      // Pool exhausted - expand it (emergency allocation)
      console.warn('[Matrix] Glyph pool exhausted, expanding...');
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

  private checkCollision(x: number, y: number): boolean {
    if (!this.collisionEnabled) return false;

    // Check floor (taskbar)
    if (y >= this.floorY) return true;

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

  /** Get color for a glyph based on mode and position in stream */
  private getStreamColor(hue: number, isHead: boolean, tailProgress: number): number {
    // Priority: Gaytrix > Custom Color > Default Green
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

    try {
      this.updateColumns(dt);
    } catch (err) {
      console.error('[Matrix] Update error:', err instanceof Error ? err.message : String(err));
    }
  }

  private updateColumns(dt: number): void {
    const gridHeight = Math.ceil(this.config.height / MATRIX_CONFIG.FONT_SIZE);

    for (const column of this.columns) {
      // Handle glitching state (collision happened)
      if (column.glitching) {
        column.glitchTimer -= dt;
        column.flashTimer -= dt;
        column.glitchAlpha = Math.max(0, column.glitchTimer / MATRIX_CONFIG.GLITCH_DURATION);

        // During flash phase: bright white tint
        const isFlashing = column.flashTimer > 0;

        // Scramble glyphs rapidly (faster than normal mutation)
        for (const glyph of column.glyphs) {
          if (Math.random() < MATRIX_CONFIG.GLITCH_SCRAMBLE_RATE * dt) {
            glyph.text = this.getRandomGlyph();
          }

          // Flash: white tint, then fade back through green
          if (isFlashing) {
            glyph.tint = MATRIX_CONFIG.COLOR_FLASH;
            glyph.alpha = this.alphaMult;
          } else {
            // Fade out with green tint
            glyph.tint = MATRIX_CONFIG.COLOR_BODY;
            glyph.alpha = column.glitchAlpha * this.alphaMult;
          }
        }

        // Glitch complete - release all glyphs and reset
        if (column.glitchTimer <= 0) {
          for (const g of column.glyphs) {
            this.releaseGlyph(g);
          }
          column.glyphs = [];
          column.glitching = false;
          column.active = false;
          column.spawnTimer = 0.1 + Math.random() * 0.2;
        }
        continue;
      }

      // Inactive column - wait for spawn timer
      if (!column.active) {
        column.spawnTimer -= dt;
        if (column.spawnTimer <= 0) {
          column.active = true;
          column.headY = -Math.random() * 5;
          column.speed = this.getRandomSpeed();
          column.length = this.getRandomLength();
          column.hue = this.globalHueCounter;
          this.globalHueCounter = (this.globalHueCounter + 15) % 360;
        }
        continue;
      }

      // Move head down
      column.headY += column.speed * dt;

      // Check collision at head position
      const screenY = column.headY * MATRIX_CONFIG.FONT_SIZE;
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
      const shouldSpawn = gridY >= 0 && (
        column.glyphs.length === 0 ||
        gridY > Math.floor(column.glyphs[0]!.y / MATRIX_CONFIG.FONT_SIZE)
      );

      if (shouldSpawn) {
        const glyph = this.acquireGlyph();
        if (glyph) {
          glyph.text = this.getRandomGlyph();
          glyph.x = column.x;
          glyph.y = gridY * MATRIX_CONFIG.FONT_SIZE;
          glyph.tint = this.getStreamColor(column.hue, true, 0);
          glyph.alpha = this.alphaMult;
          column.glyphs.unshift(glyph);
        }
      }

      // Update existing glyphs (colors and alpha)
      for (let i = 0; i < column.glyphs.length; i++) {
        const glyph = column.glyphs[i]!;

        // Random mutation (character change)
        if (Math.random() < MATRIX_CONFIG.MUTATION_CHANCE) {
          glyph.text = this.getRandomGlyph();
        }

        const tailProgress = i / column.length;
        glyph.tint = this.getStreamColor(column.hue, i === 0, tailProgress);
        glyph.alpha = Math.max(0, (1 - tailProgress)) * this.alphaMult;
      }

      // Remove glyphs beyond tail length
      while (column.glyphs.length > column.length) {
        const old = column.glyphs.pop()!;
        this.releaseGlyph(old);
      }

      // Fizzle (random early death) after passing 50% screen height
      const fizzleChance = column.headY > gridHeight * MATRIX_CONFIG.FIZZLE_HEIGHT_RATIO
        ? MATRIX_CONFIG.FIZZLE_CHANCE
        : 0;
      if (Math.random() < fizzleChance || column.headY > gridHeight + column.length) {
        // Stream died - release all glyphs
        for (const g of column.glyphs) {
          this.releaseGlyph(g);
        }
        column.glyphs = [];
        column.active = false;
        column.spawnTimer = 0.05 + Math.random() * 0.15;
      }
    }
  }

  render(): void {
    // Manually render the stage (autoStart is false)
    if (this.app) {
      this.app.render();
    }
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
    if (this.app) {
      this.app.destroy(false, { children: true, texture: true });
      this.app = null;
    }
    this.columns = [];
    this.glyphPool = [];
    this.initialized = false;
  }
}
