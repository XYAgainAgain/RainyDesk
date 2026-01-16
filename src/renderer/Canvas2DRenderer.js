/**
 * Canvas 2D Rain Renderer (Fallback)
 * Used when WebGL 2 is not available
 */

class Canvas2DRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = null;
        this.logicalWidth = 0;
        this.logicalHeight = 0;
        this.dpr = 1;
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
     * Render a single raindrop
     */
    _renderRaindrop(drop) {
        const ctx = this.ctx;
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
     * Render a single splash particle
     */
    _renderSplash(particle) {
        const ctx = this.ctx;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(160, 196, 232, ${particle.opacity})`;
        ctx.fill();
    }

    /**
     * Render all particles from physics system
     */
    render(physicsSystem) {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Render raindrops
        for (let i = 0; i < physicsSystem.raindrops.length; i++) {
            this._renderRaindrop(physicsSystem.raindrops[i]);
        }

        // Render splashes
        for (let i = 0; i < physicsSystem.splashParticles.length; i++) {
            this._renderSplash(physicsSystem.splashParticles[i]);
        }
    }

    /**
     * Handle canvas resize
     */
    resize(width, height, dpr) {
        this.logicalWidth = width;
        this.logicalHeight = height;
        this.dpr = dpr;

        this.canvas.width = width * dpr;
        this.canvas.height = height * dpr;
        this.canvas.style.width = width + 'px';
        this.canvas.style.height = height + 'px';

        // Reset and apply DPR scaling
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.scale(dpr, dpr);
    }

    /**
     * Cleanup
     */
    dispose() {
        this.ctx = null;
    }
}

export default Canvas2DRenderer;
