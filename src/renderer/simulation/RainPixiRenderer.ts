/**
 * RainPixiRenderer — Pixi.js v8 renderer for the hybrid simulation.
 *
 * Renders three layers:
 * 1. Puddle layer (grid texture)
 * 2. Rain layer (particle sprites)
 * 3. Splash layer (particle sprites)
 *
 * See .dev/PIXI-PHYSICS-MIGRATION-PLAN.md for full architecture.
 */

import { Application, Container, Sprite, Texture, Graphics } from 'pixi.js';
import { GridSimulation } from './GridSimulation';
import { CELL_WATER } from './types';

/** Configuration for the renderer */
export interface RendererConfig {
    /** Canvas element to render to */
    canvas: HTMLCanvasElement;
    /** Width in screen pixels */
    width: number;
    /** Height in screen pixels */
    height: number;
    /** Local offset X (for multi-monitor slicing) */
    localOffsetX: number;
    /** Local offset Y (for multi-monitor slicing) */
    localOffsetY: number;
    /** Background color (0 for transparent) */
    backgroundColor: number;
    /** Whether to use WebGPU if available */
    preferWebGPU: boolean;
}

export class RainPixiRenderer {
    private app: Application | null = null;
    private initialized = false;

    // Configuration
    private readonly config: RendererConfig;
    private readonly logicScale = 0.25; // Logic space is 25% of screen space

    // Containers
    private puddleContainer: Container | null = null;
    private rainContainer: Container | null = null;
    private splashContainer: Container | null = null;

    // Sprite pools
    private rainSprites: Sprite[] = [];
    private splashSprites: Sprite[] = [];

    // Textures
    private dropTexture: Texture | null = null;
    private splashTexture: Texture | null = null;

    // Puddle texture system
    private puddleCanvas: HTMLCanvasElement | null = null;
    private puddleCtx: CanvasRenderingContext2D | null = null;
    private puddleImageData: ImageData | null = null;
    private puddlePixelBuffer: Uint32Array | null = null;
    private puddleTexture: Texture | null = null;
    private puddleSprite: Sprite | null = null;

    constructor(config: Partial<RendererConfig> & { canvas: HTMLCanvasElement }) {
        this.config = {
            canvas: config.canvas,
            width: config.width ?? config.canvas.width,
            height: config.height ?? config.canvas.height,
            localOffsetX: config.localOffsetX ?? 0,
            localOffsetY: config.localOffsetY ?? 0,
            backgroundColor: config.backgroundColor ?? 0x000000,
            preferWebGPU: config.preferWebGPU ?? true,
        };
    }

    /**
     * Initialize the Pixi application.
     * Must be called before render().
     */
    async init(): Promise<void> {
        if (this.initialized) return;

        this.app = new Application();

        await this.app.init({
            canvas: this.config.canvas,
            width: this.config.width,
            height: this.config.height,
            backgroundColor: this.config.backgroundColor,
            backgroundAlpha: 0, // Transparent background
            antialias: false,   // Pixelated aesthetic
            preference: this.config.preferWebGPU ? 'webgpu' : 'webgl',
            powerPreference: 'high-performance',
        });

        // Create containers in render order
        this.puddleContainer = new Container();
        this.rainContainer = new Container();
        this.splashContainer = new Container();

        this.app.stage.addChild(this.puddleContainer);
        this.app.stage.addChild(this.rainContainer);
        this.app.stage.addChild(this.splashContainer);

        // Scale stage for 4× upscale (logic → screen)
        this.app.stage.scale.set(1 / this.logicScale);

        // Create simple textures for particles
        this.createTextures();

        // Initialize puddle buffer (will be sized on first render)
        this.initPuddleBuffer();

        this.initialized = true;
    }

    /**
     * Initialize the puddle texture buffer system.
     */
    private initPuddleBuffer(): void {
        // Buffer will be created on first render when we know grid size
        // For now, just set up the canvas
        this.puddleCanvas = document.createElement('canvas');
        this.puddleCtx = this.puddleCanvas.getContext('2d', {
            willReadFrequently: false, // We write, not read
        });
    }

    /**
     * Render the current simulation state.
     * @param simulation The GridSimulation to render
     */
    render(simulation: GridSimulation): void {
        if (!this.initialized || !this.app) return;

        const alpha = simulation.getRainInterpolationAlpha();
        this.renderRain(simulation, alpha);
        this.renderSplashes(simulation);
        this.renderPuddles(simulation);
    }

    /**
     * Resize the renderer.
     */
    resize(width: number, height: number): void {
        if (!this.app) return;
        this.app.renderer.resize(width, height);
    }

    /**
     * Update local offset (for multi-monitor support).
     */
    setLocalOffset(x: number, y: number): void {
        (this.config as RendererConfig).localOffsetX = x;
        (this.config as RendererConfig).localOffsetY = y;
    }

    /**
     * Clean up resources.
     */
    destroy(): void {
        // Clean up puddle resources
        if (this.puddleTexture) {
            this.puddleTexture.destroy(true);
            this.puddleTexture = null;
        }
        this.puddleCanvas = null;
        this.puddleCtx = null;
        this.puddleImageData = null;
        this.puddlePixelBuffer = null;
        this.puddleSprite = null;

        // Clean up Pixi app
        if (this.app) {
            this.app.destroy(true, { children: true, texture: true });
            this.app = null;
        }
        this.initialized = false;
    }

    // === Private methods ===

    private createTextures(): void {
        if (!this.app) return;

        // Create a tapered teardrop shape matching the WebGL shader style
        // Color: rgb(160, 196, 232) = 0xa0c4e8 - light blue-grey from WebGL version
        const dropGraphics = new Graphics();

        // Draw teardrop: circle head at bottom, tapering cone tail upward
        const headRadius = 1.5;
        const tailLength = 12; // Longer tail for motion blur effect

        // Draw the tapered tail (triangle from tip to head width)
        dropGraphics.moveTo(0, -tailLength);           // Tip of tail
        dropGraphics.lineTo(-headRadius, 0);           // Left side of head
        dropGraphics.lineTo(headRadius, 0);            // Right side of head
        dropGraphics.closePath();
        dropGraphics.fill({ color: 0xa0c4e8, alpha: 0.5 });

        // Draw circular head
        dropGraphics.circle(0, headRadius * 0.5, headRadius);
        dropGraphics.fill({ color: 0xa0c4e8, alpha: 0.6 });

        this.dropTexture = this.app.renderer.generateTexture(dropGraphics);

        // Create a soft circular splash
        const splashGraphics = new Graphics();
        splashGraphics.circle(0, 0, 2);
        splashGraphics.fill({ color: 0xa0c4e8, alpha: 0.4 });
        this.splashTexture = this.app.renderer.generateTexture(splashGraphics);
    }

    private renderRain(simulation: GridSimulation, alpha: number): void {
        if (!this.rainContainer || !this.dropTexture) return;

        const drops = simulation.drops;
        const offsetX = this.config.localOffsetX * this.logicScale;
        const offsetY = this.config.localOffsetY * this.logicScale;

        // Ensure we have enough sprites
        while (this.rainSprites.length < drops.count) {
            const sprite = new Sprite(this.dropTexture);
            sprite.anchor.set(0.5, 0.8); // Anchor near head (bottom of teardrop)
            this.rainContainer.addChild(sprite);
            this.rainSprites.push(sprite);
        }

        // Update visible sprites
        for (let i = 0; i < drops.count; i++) {
            const sprite = this.rainSprites[i]!;
            sprite.visible = true;

            // Interpolate position for smooth rendering
            const x = drops.prevX[i]! + (drops.x[i]! - drops.prevX[i]!) * alpha;
            const y = drops.prevY[i]! + (drops.y[i]! - drops.prevY[i]!) * alpha;

            sprite.x = x - offsetX;
            sprite.y = y - offsetY;
            sprite.alpha = drops.opacity[i]!;

            // Calculate velocity direction for rotation (tail points opposite to motion)
            const dx = drops.x[i]! - drops.prevX[i]!;
            const dy = drops.y[i]! - drops.prevY[i]!;
            // Texture has tail at -Y (up). For falling down (dy>0), we want tail pointing up (no rotation).
            // atan2(dy,dx) for down = PI/2, so subtract PI/2 to get 0 rotation
            const angle = Math.atan2(dy, dx) - Math.PI / 2;
            sprite.rotation = angle;

            // Scale based on radius - keep consistent size like WebGL version
            const baseScale = drops.radius[i]! * 0.4;
            sprite.scale.set(baseScale);
        }

        // Hide unused sprites
        for (let i = drops.count; i < this.rainSprites.length; i++) {
            this.rainSprites[i]!.visible = false;
        }
    }

    private renderSplashes(simulation: GridSimulation): void {
        if (!this.splashContainer || !this.splashTexture) return;

        const splashes = simulation.splashes;
        const offsetX = this.config.localOffsetX * this.logicScale;
        const offsetY = this.config.localOffsetY * this.logicScale;

        // Ensure we have enough sprites
        while (this.splashSprites.length < splashes.count) {
            const sprite = new Sprite(this.splashTexture);
            sprite.anchor.set(0.5);
            this.splashContainer.addChild(sprite);
            this.splashSprites.push(sprite);
        }

        // Update visible sprites
        for (let i = 0; i < splashes.count; i++) {
            const sprite = this.splashSprites[i]!;
            sprite.visible = true;
            sprite.x = splashes.x[i]! - offsetX;
            sprite.y = splashes.y[i]! - offsetY;
            sprite.alpha = splashes.life[i]!;
        }

        // Hide unused sprites
        for (let i = splashes.count; i < this.splashSprites.length; i++) {
            this.splashSprites[i]!.visible = false;
        }
    }

    private renderPuddles(simulation: GridSimulation): void {
        if (!this.puddleContainer || !this.app) return;

        const grid = simulation.gridState;
        const offsetX = this.config.localOffsetX * this.logicScale;
        const offsetY = this.config.localOffsetY * this.logicScale;

        // Initialize buffer on first render
        if (!this.puddlePixelBuffer || !this.puddleCanvas || !this.puddleCtx) {
            this.createPuddleTexture(grid.width, grid.height);
        }

        // Ensure buffer matches grid size (handles dynamic resize)
        if (this.puddleCanvas!.width !== grid.width || this.puddleCanvas!.height !== grid.height) {
            this.createPuddleTexture(grid.width, grid.height);
        }

        // Convert grid to pixel buffer (Uint8Array → Uint32Array RGBA)
        this.updatePuddleBuffer(grid.data);

        // Upload to GPU
        this.puddleCtx!.putImageData(this.puddleImageData!, 0, 0);

        // Update texture from canvas
        if (this.puddleTexture && this.puddleSprite) {
            // Force texture update
            this.puddleTexture.source.update();

            // Position sprite to account for monitor offset
            this.puddleSprite.x = -offsetX;
            this.puddleSprite.y = -offsetY;
        }
    }

    /**
     * Create or recreate the puddle texture with given dimensions.
     */
    private createPuddleTexture(width: number, height: number): void {
        if (!this.app || !this.puddleContainer || !this.puddleCanvas || !this.puddleCtx) return;

        // Resize canvas
        this.puddleCanvas.width = width;
        this.puddleCanvas.height = height;

        // Create ImageData and get buffer view
        this.puddleImageData = this.puddleCtx.createImageData(width, height);
        this.puddlePixelBuffer = new Uint32Array(this.puddleImageData.data.buffer);

        // Destroy old texture if exists
        if (this.puddleTexture) {
            this.puddleTexture.destroy(true);
        }

        // Create texture from canvas
        this.puddleTexture = Texture.from(this.puddleCanvas);

        // Set to nearest-neighbor for pixelated aesthetic
        this.puddleTexture.source.scaleMode = 'nearest';

        // Create or update sprite
        if (!this.puddleSprite) {
            this.puddleSprite = new Sprite(this.puddleTexture);
            this.puddleContainer.addChild(this.puddleSprite);
        } else {
            this.puddleSprite.texture = this.puddleTexture;
        }
    }

    /**
     * Update the pixel buffer from grid data.
     * Converts Uint8Array cell values to RGBA colors.
     */
    private updatePuddleBuffer(grid: Uint8Array): void {
        if (!this.puddlePixelBuffer) return;

        const buffer = this.puddlePixelBuffer;

        // Color mapping (ABGR format for Uint32Array on little-endian)
        const COLOR_AIR = 0x00000000;        // Transparent
        const COLOR_WATER = 0xA0bbaa99;      // Semi-transparent grey-blue (AABBGGRR) - matches raindrop color

        for (let i = 0; i < grid.length; i++) {
            const cellValue = grid[i]!;

            // Map cell type to color
            if (cellValue === CELL_WATER) {
                buffer[i] = COLOR_WATER;
            } else {
                buffer[i] = COLOR_AIR; // Air and glass both transparent
            }
        }
    }
}
