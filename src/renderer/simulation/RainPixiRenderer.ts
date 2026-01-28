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

    // Grid texture for puddles (will be BufferImageSource in full implementation)
    // puddleSprite will be added when we implement BufferImageSource

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

        this.initialized = true;
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
        if (this.app) {
            this.app.destroy(true, { children: true, texture: true });
            this.app = null;
        }
        this.initialized = false;
    }

    // === Private methods ===

    private createTextures(): void {
        if (!this.app) return;

        // Create a simple circle texture for raindrops
        const dropGraphics = new Graphics();
        dropGraphics.circle(0, 0, 4); // 4px radius at screen scale
        dropGraphics.fill({ color: 0x4488ff, alpha: 0.8 });
        this.dropTexture = this.app.renderer.generateTexture(dropGraphics);

        // Create a smaller circle for splashes
        const splashGraphics = new Graphics();
        splashGraphics.circle(0, 0, 2);
        splashGraphics.fill({ color: 0x66aaff, alpha: 0.6 });
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
            sprite.anchor.set(0.5);
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

            // Scale based on radius
            const scale = drops.radius[i]! / 1.0; // Normalize to base radius
            sprite.scale.set(scale);
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
        if (!this.puddleContainer) return;

        const grid = simulation.gridState;
        const offsetX = this.config.localOffsetX * this.logicScale;
        const offsetY = this.config.localOffsetY * this.logicScale;

        // TODO: Implement efficient grid-to-texture rendering
        // For now, use simple Graphics drawing (will be replaced with BufferImageSource)

        // Clear previous puddle graphics
        this.puddleContainer.removeChildren();

        const graphics = new Graphics();

        // Draw water cells as blue pixels
        for (let y = 0; y < grid.height; y++) {
            for (let x = 0; x < grid.width; x++) {
                const index = y * grid.width + x;
                if (grid.data[index] === CELL_WATER) {
                    graphics.rect(x - offsetX, y - offsetY, 1, 1);
                }
            }
        }

        graphics.fill({ color: 0x4488ff, alpha: 0.5 });
        this.puddleContainer.addChild(graphics);
    }
}
