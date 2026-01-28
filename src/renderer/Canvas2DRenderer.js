/**
 * Canvas 2D Rain Renderer (Fallback)
 * Used when WebGL 2 is not available
 * Supports pixelated rendering via offscreen canvas upscaling
 */

class Canvas2DRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = null;

        // Display dimensions
        this.logicalWidth = 0;
        this.logicalHeight = 0;
        this.dpr = 1;

        // Low-res rendering dimensions
        this.lowResWidth = 0;
        this.lowResHeight = 0;
        this.scaleFactor = 1.0;

        // Offscreen canvas for low-res rendering
        this.offscreenCanvas = null;
        this.offscreenCtx = null;
    }

    /**
     * Initialize Canvas 2D context
     */
    init() {
        this.ctx = this.canvas.getContext('2d');
        if (!this.ctx) {
            throw new Error('Canvas 2D not supported');
        }
        return true;
    }

    /**
     * Initialize offscreen canvas for scaled rendering
     */
    _initOffscreenCanvas() {
        this.offscreenCanvas = document.createElement('canvas');
        this.offscreenCanvas.width = this.lowResWidth;
        this.offscreenCanvas.height = this.lowResHeight;
        this.offscreenCtx = this.offscreenCanvas.getContext('2d');
        console.log(`Canvas2D: ${this.lowResWidth}x${this.lowResHeight} -> ${this.logicalWidth}x${this.logicalHeight}`);
    }

    /**
     * Render a single raindrop (uses main context)
     */
    _renderRaindrop(drop) {
        this._renderRaindropToCtx(drop, this.ctx);
    }

    /**
     * Render a single raindrop to specified context
     */
    _renderRaindropToCtx(drop, ctx) {
        const pos = drop.body.position;
        const velocity = drop.body.velocity;
        const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);

        if (speed < 0.1) return;

        const normalizedVx = velocity.x / speed;
        const normalizedVy = velocity.y / speed;

        const trailLength = Math.min(drop.length, speed * 0.03);
        const endX = pos.x - normalizedVx * trailLength;
        const endY = pos.y - normalizedVy * trailLength;

        ctx.strokeStyle = `rgba(160, 196, 232, ${drop.opacity})`;
        ctx.lineWidth = drop.radius;
        ctx.lineCap = 'round';

        ctx.beginPath();
        ctx.moveTo(endX, endY);
        ctx.lineTo(pos.x, pos.y);
        ctx.stroke();
    }

    /**
     * Render a single splash particle (uses main context)
     */
    _renderSplash(particle) {
        this._renderSplashToCtx(particle, this.ctx);
    }

    /**
     * Render a single splash particle to specified context
     */
    _renderSplashToCtx(particle, ctx) {
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(160, 196, 232, ${particle.opacity})`;
        ctx.fill();
    }

    /**
     * Clear the canvas to transparent
     */
    clear() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    /**
     * Clear the offscreen canvas to transparent
     */
    _clearOffscreen() {
        this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
    }

    /**
     * Render all particles from physics system
     * Uses offscreen canvas for pixelated upscaling when scaleFactor < 1
     */
    render(physicsSystem) {
        // Skip offscreen path if not using scaled rendering
        if (this.scaleFactor >= 1.0 || !this.offscreenCtx) {
            this.clear();
            this._renderParticles(physicsSystem, this.ctx);
            return;
        }

        // PASS 1: Render to low-res offscreen canvas
        this._clearOffscreen();
        this._renderParticles(physicsSystem, this.offscreenCtx);

        // PASS 2: Upscale to display canvas with nearest-neighbor
        this.clear();
        this.ctx.save();

        // Disable image smoothing for pixelated look
        this.ctx.imageSmoothingEnabled = false;

        // Scale up from low-res to display resolution
        this.ctx.drawImage(
            this.offscreenCanvas,
            0, 0, this.lowResWidth, this.lowResHeight,
            0, 0, this.canvas.width, this.canvas.height
        );

        this.ctx.restore();
    }

    /**
     * Render particles to given context (used by both direct and offscreen paths)
     */
    _renderParticles(physicsSystem, ctx) {
        // Render raindrops
        for (let i = 0; i < physicsSystem.raindrops.length; i++) {
            this._renderRaindropToCtx(physicsSystem.raindrops[i], ctx);
        }

        // Render splashes
        for (let i = 0; i < physicsSystem.splashParticles.length; i++) {
            this._renderSplashToCtx(physicsSystem.splashParticles[i], ctx);
        }
    }

    /**
     * Handle canvas resize
     * @param {number} width - Display width in CSS pixels
     * @param {number} height - Display height in CSS pixels
     * @param {number} dpr - Device pixel ratio
     * @param {number} scaleFactor - Render scale (0.25 = 25% resolution)
     */
    resize(width, height, dpr, scaleFactor = 1.0) {
        this.logicalWidth = width;
        this.logicalHeight = height;
        this.dpr = dpr;
        this.scaleFactor = scaleFactor;

        // Set display canvas size
        this.canvas.width = width * dpr;
        this.canvas.height = height * dpr;
        this.canvas.style.width = width + 'px';
        this.canvas.style.height = height + 'px';

        // Calculate low-res rendering dimensions
        this.lowResWidth = Math.max(1, Math.floor(width * scaleFactor));
        this.lowResHeight = Math.max(1, Math.floor(height * scaleFactor));

        // Initialize offscreen canvas for scaled rendering
        if (scaleFactor < 1.0) {
            this._initOffscreenCanvas();
        }

        // Reset and apply DPR scaling for direct rendering mode
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.scale(dpr, dpr);
    }

    /**
     * Cleanup
     */
    dispose() {
        this.ctx = null;
        this.offscreenCanvas = null;
        this.offscreenCtx = null;
    }
}

export default Canvas2DRenderer;
