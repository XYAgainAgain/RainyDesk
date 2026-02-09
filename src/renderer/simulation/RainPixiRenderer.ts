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
    /** Grid scale factor (0.125 = 1:8, 0.25 = 1:4). Default 0.125. */
    gridScale: number;
}

export class RainPixiRenderer {
    private app: Application | null = null;
    private initialized = false;

    // Configuration
    private readonly config: RendererConfig;
    private readonly logicScale: number; // Logic space scale (0.125 = 1:8)

    // Color and Gay Mode
    private rainColor: number = 0xa0c4e8; // Default blue
    private gayMode: boolean = false;
    private gayModeHue: number = 0;  // 0-360 degrees

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
            gridScale: config.gridScale ?? 0.25,
        };
        this.logicScale = this.config.gridScale;
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

        // Clean up Pixi app (keep canvas - we reuse it on reinit)
        if (this.app) {
            this.app.destroy(false, { children: true, texture: true });
            this.app = null;
        }
        this.initialized = false;
    }

    /**
     * Set the rain color (hex string like "#4a9eff").
     */
    setRainColor(hex: string): void {
        // Parse hex color to number
        const cleanHex = hex.replace('#', '');
        this.rainColor = parseInt(cleanHex, 16);
    }

    /**
     * Enable or disable Gay Mode (rainbow cycling).
     * Cycle time: 60 seconds for a full rainbow.
     */
    setGayMode(enabled: boolean): void {
        this.gayMode = enabled;
    }

    /**
     * Get current rain color as hex string.
     */
    getRainColor(): string {
        return '#' + this.rainColor.toString(16).padStart(6, '0');
    }

    /**
     * Check if Gay Mode is enabled.
     */
    isGayMode(): boolean {
        return this.gayMode;
    }

    /**
     * Get the current tint color (either static rainColor or animated gayMode hue).
     * Call this during render to get the appropriate color.
     */
    private getCurrentTintColor(): number {
        if (!this.gayMode) {
            return this.rainColor;
        }

        // Use absolute time for sync with background shader (60-second cycle)
        // Matches shader formula: mod(u_time * 0.0167, 1.0) where u_time ≈ performance.now()/1000
        const now = performance.now();
        this.gayModeHue = ((now / 60000) % 1.0) * 360; // 60000ms = 60 sec cycle

        // Convert HSL to RGB (saturation=70%, lightness=70% to match shader's HSV(h, 0.7, 0.95))
        return this.hslToHex(this.gayModeHue, 70, 70);
    }

    /**
     * Convert HSL to hex color number.
     */
    private hslToHex(h: number, s: number, l: number): number {
        s /= 100;
        l /= 100;

        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs((h / 60) % 2 - 1));
        const m = l - c / 2;

        let r = 0, g = 0, b = 0;
        if (h < 60) { r = c; g = x; b = 0; }
        else if (h < 120) { r = x; g = c; b = 0; }
        else if (h < 180) { r = 0; g = c; b = x; }
        else if (h < 240) { r = 0; g = x; b = c; }
        else if (h < 300) { r = x; g = 0; b = c; }
        else { r = c; g = 0; b = x; }

        const rInt = Math.round((r + m) * 255);
        const gInt = Math.round((g + m) * 255);
        const bInt = Math.round((b + m) * 255);

        return (rInt << 16) | (gInt << 8) | bInt;
    }

    // Private methods

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

        // Get current tint color (static or gay mode animated)
        const tintColor = this.getCurrentTintColor();

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

            // Apply tint color
            sprite.tint = tintColor;

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

        // Get current tint color for splashes (same as rain)
        const tintColor = this.getCurrentTintColor();

        // Normalize splash sprite scale for consistent screen size across grid scales
        // Stage is scaled by 1/logicScale, so we compensate with logicScale/0.25
        const splashScale = this.logicScale / 0.25;

        // Update visible sprites
        for (let i = 0; i < splashes.count; i++) {
            const sprite = this.splashSprites[i]!;
            sprite.visible = true;
            sprite.x = splashes.x[i]! - offsetX;
            sprite.y = splashes.y[i]! - offsetY;
            sprite.alpha = splashes.life[i]!;
            sprite.tint = tintColor;
            sprite.scale.set(splashScale);
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

        // Skip expensive GPU upload when puddles haven't changed
        if (grid.dirty) {
            // Convert grid to pixel buffer (Uint8Array → Uint32Array RGBA)
            this.updatePuddleBuffer(grid.data, grid.width, grid.displayFloorMap, grid.depth);

            // Upload to GPU
            this.puddleCtx!.putImageData(this.puddleImageData!, 0, 0);

            // Update texture from canvas
            if (this.puddleTexture) {
                this.puddleTexture.source.update();
            }
        }

        // Always update sprite position (may change on reinit/resize)
        if (this.puddleSprite) {
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
     * Uses depth for opacity modulation (stacked water = more opaque).
     */
    private updatePuddleBuffer(grid: Uint8Array, width: number, floorMap: Int16Array | null, depth: Float32Array | null): void {
        if (!this.puddlePixelBuffer || !this.puddleCanvas) return;

        const buffer = this.puddlePixelBuffer;

        // Get current tint color for puddles (tintColor is 0xRRGGBB format)
        const tintColor = this.getCurrentTintColor();
        const waterR = (tintColor >> 16) & 0xFF;
        const waterG = (tintColor >> 8) & 0xFF;
        const waterB = tintColor & 0xFF;

        const COLOR_AIR = 0x00000000;
        const minDepthAlpha = 0x90; // ~56% opacity at depth 1 (was 38%)
        const maxDepthAlpha = 0xF0; // ~94% opacity at max depth (was 88%)

        // Bottom fade based on distance to floor/void
        const minAlpha = 0x33; // ~20% opacity
        const fadeDistance = 72; // Fade over ~72 cells

        for (let i = 0; i < grid.length; i++) {
            const cellValue = grid[i]!;

            if (cellValue === CELL_WATER) {
                const x = i % width;
                const y = Math.floor(i / width);

                // Base alpha from depth (higher depth = more opaque)
                const cellDepth = depth ? Math.min(15, depth[i] || 1) : 1;
                const depthFactor = (cellDepth - 1) / 14; // 0 at depth 1, 1 at depth 15
                let alpha = Math.floor(minDepthAlpha + (maxDepthAlpha - minDepthAlpha) * depthFactor);

                // Apply bottom-fade based on distance to floor
                if (floorMap) {
                    const floorY = floorMap[x];
                    if (floorY !== undefined) {
                        const distToFloor = floorY - y;
                        if (distToFloor < fadeDistance) {
                            const fadeProgress = 1 - (distToFloor / fadeDistance);
                            alpha = Math.floor(alpha - (alpha - minAlpha) * fadeProgress);
                        }
                    }
                }

                // Pack as AABBGGRR (little-endian)
                buffer[i] = (alpha << 24) | (waterB << 16) | (waterG << 8) | waterR;
            } else {
                buffer[i] = COLOR_AIR;
            }
        }
    }
}
