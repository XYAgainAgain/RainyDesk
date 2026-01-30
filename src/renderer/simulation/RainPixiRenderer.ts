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

        // Create teardrop texture using Canvas 2D for proper gradients
        // This mimics the WebGL shader's smooth tapered cone + circular head
        this.dropTexture = this.createTeardropTexture();

        // Create a soft circular splash with radial gradient
        const splashGraphics = new Graphics();
        splashGraphics.circle(0, 0, 1.5);  // Smaller splash (was 3)
        splashGraphics.fill({ color: 0xa0c4e8, alpha: 0.35 });
        this.splashTexture = this.app.renderer.generateTexture(splashGraphics);
    }

    /**
     * Create a high-quality teardrop texture using Canvas 2D gradients.
     * Mimics the WebGL shader's smooth tapered cone with circular head.
     */
    private createTeardropTexture(): Texture {
        const canvas = document.createElement('canvas');
        const width = 16;
        const height = 48;  // Tall for motion blur tail
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d')!;

        // Clear to transparent
        ctx.clearRect(0, 0, width, height);

        // Raindrop color: rgb(160, 196, 232)
        const centerX = width / 2;
        const headRadius = 3;
        const headCenterY = height - headRadius - 2;

        // Draw tapered tail using multiple strokes with decreasing width
        // This creates the smooth taper effect the WebGL shader achieves
        const tailTipY = 4;
        const segments = 20;

        for (let i = 0; i < segments; i++) {
            const t = i / segments;  // 0 at tip, 1 at head
            const y = tailTipY + (headCenterY - tailTipY) * t;
            const nextT = (i + 1) / segments;
            const nextY = tailTipY + (headCenterY - tailTipY) * nextT;

            // Width tapers from 0 at tip to headRadius at head
            // Use easeOutQuad for natural taper: t * (2 - t)
            const easedT = t * (2 - t);
            const halfWidth = headRadius * easedT;

            // Alpha fades toward tip for motion blur effect
            const alpha = 0.15 + 0.45 * t;

            ctx.beginPath();
            ctx.moveTo(centerX - halfWidth, y);
            ctx.lineTo(centerX + halfWidth, y);
            ctx.lineTo(centerX + headRadius * (nextT * (2 - nextT)), nextY);
            ctx.lineTo(centerX - headRadius * (nextT * (2 - nextT)), nextY);
            ctx.closePath();
            ctx.fillStyle = `rgba(160, 196, 232, ${alpha})`;
            ctx.fill();
        }

        // Draw circular head with radial gradient for soft edges
        const gradient = ctx.createRadialGradient(
            centerX, headCenterY, 0,
            centerX, headCenterY, headRadius + 1
        );
        gradient.addColorStop(0, 'rgba(160, 196, 232, 0.7)');
        gradient.addColorStop(0.6, 'rgba(160, 196, 232, 0.5)');
        gradient.addColorStop(1, 'rgba(160, 196, 232, 0)');

        ctx.beginPath();
        ctx.arc(centerX, headCenterY, headRadius + 1, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();

        // Create Pixi texture from canvas
        const texture = Texture.from(canvas);
        texture.source.scaleMode = 'nearest'; // Pixelated aesthetic
        return texture;
    }

    private renderRain(simulation: GridSimulation, alpha: number): void {
        if (!this.rainContainer || !this.dropTexture) return;

        const drops = simulation.drops;
        const offsetX = this.config.localOffsetX * this.logicScale;
        const offsetY = this.config.localOffsetY * this.logicScale;

        // Ensure we have enough sprites
        while (this.rainSprites.length < drops.count) {
            const sprite = new Sprite(this.dropTexture);
            sprite.anchor.set(0.5, 0.9); // Anchor at head (near bottom of teardrop)
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

            // Calculate velocity for rotation and stretch
            const dx = drops.x[i]! - drops.prevX[i]!;
            const dy = drops.y[i]! - drops.prevY[i]!;
            const speed = Math.sqrt(dx * dx + dy * dy);

            // Rotation: tail points opposite to motion direction
            // Texture has tail at -Y (up). For falling down (dy>0), tail should point up.
            const angle = Math.atan2(dy, dx) - Math.PI / 2;
            sprite.rotation = angle;

            // Scale based on radius AND velocity
            const radius = drops.radius[i]!;
            const baseScale = radius * 0.15;  // Base width scale

            // Stretch Y (length) based on speed - faster = longer tail
            // Speed of ~5 logic units/tick is typical falling speed
            const speedFactor = Math.min(2.5, 0.5 + speed * 0.25);
            const scaleX = baseScale;
            const scaleY = baseScale * speedFactor;

            sprite.scale.set(scaleX, scaleY);
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
     * Applies bottom-fade for taskbar visibility.
     */
    private updatePuddleBuffer(grid: Uint8Array): void {
        if (!this.puddlePixelBuffer || !this.puddleCanvas) return;

        const buffer = this.puddlePixelBuffer;
        const width = this.puddleCanvas.width;
        const height = this.puddleCanvas.height;

        // Color components (RGB: 99, aa, bb in AABBGGRR format)
        const COLOR_AIR = 0x00000000;
        const waterR = 0x99;
        const waterG = 0xaa;
        const waterB = 0xbb;
        const baseAlpha = 0xA0; // ~63% opacity

        // Bottom fade: start fading at 85% height, reach minimum at 100%
        const fadeStartY = Math.floor(height * 0.85);
        const minAlpha = 0x0D; // ~5% opacity (95% transparent)

        for (let i = 0; i < grid.length; i++) {
            const cellValue = grid[i]!;

            if (cellValue === CELL_WATER) {
                const y = Math.floor(i / width);

                // Calculate alpha with bottom fade
                let alpha = baseAlpha;
                if (y > fadeStartY) {
                    const fadeProgress = (y - fadeStartY) / (height - fadeStartY);
                    alpha = Math.floor(baseAlpha - (baseAlpha - minAlpha) * fadeProgress);
                }

                // Pack as AABBGGRR (little-endian)
                buffer[i] = (alpha << 24) | (waterB << 16) | (waterG << 8) | waterR;
            } else {
                buffer[i] = COLOR_AIR;
            }
        }
    }
}
