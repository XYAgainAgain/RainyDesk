/**
 * GridSimulation — Hybrid Lagrangian-Eulerian physics simulation.
 *
 * Lagrangian: Rain particles as Float32Array (position, velocity, radius)
 * Eulerian: Grid-based puddle simulation via cellular automata
 *
 * See .dev/PIXI-PHYSICS-MIGRATION-PLAN.md for full architecture.
 */

import {
    CollisionCallback,
    CollisionEvent,
    SimulationConfig,
    WindowZone,
    DEFAULT_CONFIG,
    CELL_AIR,
    CELL_GLASS,
    CELL_WATER,
    RAIN_TICK,
    PUDDLE_TICK,
} from './types';

export class GridSimulation {
    // === Configuration ===
    private config: SimulationConfig;

    // === Grid dimensions (logic space, 0.25× screen) ===
    private readonly gridWidth: number;
    private readonly gridHeight: number;
    private readonly globalOffsetX: number;
    private readonly globalOffsetY: number;

    // === Grid state (Eulerian layer) ===
    private grid: Uint8Array;

    // === Rain particles (Lagrangian layer) ===
    private dropsX: Float32Array;
    private dropsY: Float32Array;
    private dropsPrevX: Float32Array;
    private dropsPrevY: Float32Array;
    private dropsVelX: Float32Array;
    private dropsVelY: Float32Array;
    private dropsRadius: Float32Array;
    private dropsOpacity: Float32Array;
    private dropCount = 0;

    // === Splash particles (visual-only) ===
    private splashX: Float32Array;
    private splashY: Float32Array;
    private splashVelX: Float32Array;
    private splashVelY: Float32Array;
    private splashLife: Float32Array;
    private splashCount = 0;

    // === Timing accumulators ===
    private rainAccumulator = 0;
    private puddleAccumulator = 0;
    private spawnAccumulator = 0;

    // === Audio callback ===
    public onCollision: CollisionCallback | null = null;

    // === Reusable event object (zero-GC pattern) ===
    private readonly collisionEvent: CollisionEvent = {
        velocity: 0,
        dropRadius: 0,
        impactAngle: 0,
        surfaceType: 'default',
        mass: 1.0,
        position: { x: 0, y: 0 },
        collisionSurface: 'top',
    };

    // === Audio throttling ===
    private lastAudioTime = 0;
    private readonly AUDIO_MIN_INTERVAL = 8; // ms

    /**
     * Create a new simulation.
     * @param logicWidth Grid width in logic pixels (screen width × 0.25)
     * @param logicHeight Grid height in logic pixels (screen height × 0.25)
     * @param globalOffsetX X offset from global coordinate origin
     * @param globalOffsetY Y offset from global coordinate origin
     * @param config Optional configuration overrides
     */
    constructor(
        logicWidth: number,
        logicHeight: number,
        globalOffsetX = 0,
        globalOffsetY = 0,
        config: Partial<SimulationConfig> = {}
    ) {
        this.gridWidth = Math.ceil(logicWidth);
        this.gridHeight = Math.ceil(logicHeight);
        this.globalOffsetX = globalOffsetX;
        this.globalOffsetY = globalOffsetY;
        this.config = { ...DEFAULT_CONFIG, ...config };

        // Allocate grid
        this.grid = new Uint8Array(this.gridWidth * this.gridHeight);

        // Allocate rain particle arrays
        const maxDrops = this.config.maxDrops;
        this.dropsX = new Float32Array(maxDrops);
        this.dropsY = new Float32Array(maxDrops);
        this.dropsPrevX = new Float32Array(maxDrops);
        this.dropsPrevY = new Float32Array(maxDrops);
        this.dropsVelX = new Float32Array(maxDrops);
        this.dropsVelY = new Float32Array(maxDrops);
        this.dropsRadius = new Float32Array(maxDrops);
        this.dropsOpacity = new Float32Array(maxDrops);

        // Allocate splash particle arrays
        const maxSplashes = this.config.maxSplashes;
        this.splashX = new Float32Array(maxSplashes);
        this.splashY = new Float32Array(maxSplashes);
        this.splashVelX = new Float32Array(maxSplashes);
        this.splashVelY = new Float32Array(maxSplashes);
        this.splashLife = new Float32Array(maxSplashes);
    }

    // === Public API ===

    /**
     * Advance the simulation by dt seconds.
     * Called every frame; internally uses fixed timestep accumulators.
     */
    step(dt: number): void {
        this.rainAccumulator += dt;
        this.puddleAccumulator += dt;
        this.spawnAccumulator += dt;

        // Spawn new drops
        while (this.spawnAccumulator >= 1 / this.config.spawnRate) {
            this.spawnDrop();
            this.spawnAccumulator -= 1 / this.config.spawnRate;
        }

        // Rain physics at 60Hz
        while (this.rainAccumulator >= RAIN_TICK) {
            this.stepRain(RAIN_TICK);
            this.rainAccumulator -= RAIN_TICK;
        }

        // Puddle automata at 30Hz
        while (this.puddleAccumulator >= PUDDLE_TICK) {
            this.stepPuddles(PUDDLE_TICK);
            this.puddleAccumulator -= PUDDLE_TICK;
        }

        // Splashes every frame (visual-only)
        this.stepSplashes(dt);
    }

    /**
     * Update window zones from Tauri window data.
     * Clears existing walls (keeps water), then paints new walls.
     * @param windows Array of window zones in global screen coordinates
     */
    updateWindowZones(windows: WindowZone[]): void {
        // Clear walls but preserve water
        for (let i = 0; i < this.grid.length; i++) {
            if (this.grid[i] !== CELL_WATER) {
                this.grid[i] = CELL_AIR;
            }
        }

        // Paint new walls
        for (const win of windows) {
            this.rasterizeWindow(win);
        }
    }

    /**
     * Set rain intensity (affects spawn rate).
     */
    setIntensity(intensity: number): void {
        // Intensity 0–1 maps to spawn rate
        this.config.spawnRate = intensity * 200; // 0–200 drops/sec
    }

    /**
     * Set wind strength.
     */
    setWind(wind: number): void {
        this.config.windBase = wind;
    }

    /**
     * Get active drop count (for SheetLayer modulation).
     */
    getActiveDropCount(): number {
        return this.dropCount;
    }

    /**
     * Get interpolation alpha for smooth rendering.
     * Returns 0–1 representing progress through current physics tick.
     */
    getRainInterpolationAlpha(): number {
        return this.rainAccumulator / RAIN_TICK;
    }

    // === Getters for renderer access ===

    get drops() {
        return {
            x: this.dropsX,
            y: this.dropsY,
            prevX: this.dropsPrevX,
            prevY: this.dropsPrevY,
            radius: this.dropsRadius,
            opacity: this.dropsOpacity,
            count: this.dropCount,
        };
    }

    get splashes() {
        return {
            x: this.splashX,
            y: this.splashY,
            life: this.splashLife,
            count: this.splashCount,
        };
    }

    get gridState() {
        return {
            data: this.grid,
            width: this.gridWidth,
            height: this.gridHeight,
        };
    }

    // === Private methods ===

    private spawnDrop(): void {
        if (this.dropCount >= this.config.maxDrops) return;

        const i = this.dropCount++;
        const { radiusMin, radiusMax, windBase, windTurbulence } = this.config;

        // Random position along top edge
        this.dropsX[i] = Math.random() * this.gridWidth;
        this.dropsY[i] = -2; // Start slightly above screen
        this.dropsPrevX[i] = this.dropsX[i];
        this.dropsPrevY[i] = this.dropsY[i];

        // Random radius
        this.dropsRadius[i] = radiusMin + Math.random() * (radiusMax - radiusMin);

        // Initial velocity (slight horizontal from wind)
        this.dropsVelX[i] = windBase + (Math.random() - 0.5) * windTurbulence;
        this.dropsVelY[i] = 50 + Math.random() * 50; // Initial downward velocity

        // Full opacity
        this.dropsOpacity[i] = 1.0;
    }

    private stepRain(dt: number): void {
        const { gravity, windBase, slipThreshold } = this.config;

        for (let i = 0; i < this.dropCount; i++) {
            // Store previous position for collision detection
            this.dropsPrevX[i] = this.dropsX[i]!;
            this.dropsPrevY[i] = this.dropsY[i]!;

            // Apply gravity
            this.dropsVelY[i] = this.dropsVelY[i]! + gravity * dt;

            // Apply wind (lerp toward target)
            this.dropsVelX[i] = this.dropsVelX[i]! + (windBase - this.dropsVelX[i]!) * 0.1 * dt * 60;

            // Integrate position
            this.dropsX[i] = this.dropsX[i]! + this.dropsVelX[i]! * dt;
            this.dropsY[i] = this.dropsY[i]! + this.dropsVelY[i]! * dt;

            // Check boundaries and collisions
            if (this.dropsY[i]! >= this.gridHeight) {
                // Silent void despawn (fell off bottom)
                this.despawnDrop(i);
                i--;
                continue;
            }

            if (this.dropsX[i]! < 0 || this.dropsX[i]! >= this.gridWidth) {
                // Off sides — despawn silently
                this.despawnDrop(i);
                i--;
                continue;
            }

            // Grid collision detection
            const cellX = Math.floor(this.dropsX[i]!);
            const cellY = Math.floor(this.dropsY[i]!);
            const prevCellX = Math.floor(this.dropsPrevX[i]!);
            const prevCellY = Math.floor(this.dropsPrevY[i]!);

            if (cellX < 0 || cellX >= this.gridWidth || cellY < 0 || cellY >= this.gridHeight) {
                continue;
            }

            const cellIndex = cellY * this.gridWidth + cellX;
            const cellValue = this.grid[cellIndex]!;

            // Check for Air→Wall transition
            if (cellValue !== CELL_AIR) {
                const prevIndex = prevCellY * this.gridWidth + prevCellX;
                const wasInAir = prevIndex < 0 || prevIndex >= this.grid.length ||
                                 this.grid[prevIndex] === CELL_AIR;

                if (wasInAir) {
                    // Determine collision surface and apply pass-through logic
                    const collision = this.resolveCollision(i, cellX, cellY, prevCellX, prevCellY, slipThreshold);

                    if (collision) {
                        // Trigger audio
                        this.triggerAudio(i, cellValue, collision.x, collision.y, collision.surface);

                        // Spawn splash
                        this.spawnSplash(collision.x, collision.y, this.dropsVelX[i]!, this.dropsVelY[i]!);

                        // Convert to puddle if hitting wall
                        if (cellValue === CELL_GLASS) {
                            this.grid[cellIndex] = CELL_WATER;
                        }

                        // Despawn drop
                        this.despawnDrop(i);
                        i--;
                    }
                    // else: pass-through, drop continues
                }
            }
        }
    }

    private resolveCollision(
        dropIndex: number,
        cellX: number,
        cellY: number,
        prevCellX: number,
        prevCellY: number,
        slipThreshold: number
    ): { x: number; y: number; surface: 'top' | 'left' | 'right' } | null {
        const vx = this.dropsVelX[dropIndex]!;
        const vy = this.dropsVelY[dropIndex]!;
        const speed = Math.sqrt(vx * vx + vy * vy);
        const horizontalRatio = Math.abs(vx) / (speed + 0.001);

        const enteredFromAbove = prevCellY < cellY;
        const enteredFromLeft = prevCellX < cellX;
        const enteredFromRight = prevCellX > cellX;

        // Top collision
        if (enteredFromAbove && vy > 0) {
            // Pass-through check: if moving very horizontally, slip under
            if (horizontalRatio >= slipThreshold) {
                return null; // Slip under
            }
            return { x: this.dropsX[dropIndex]!, y: cellY, surface: 'top' };
        }

        // Left side collision
        if (enteredFromLeft && vx > 0) {
            return { x: cellX, y: this.dropsY[dropIndex]!, surface: 'left' };
        }

        // Right side collision
        if (enteredFromRight && vx < 0) {
            return { x: cellX + 1, y: this.dropsY[dropIndex]!, surface: 'right' };
        }

        // No valid collision (entered from below or other edge case)
        return null;
    }

    private stepPuddles(_dt: number): void {
        // TODO: Implement cellular automata for puddle flow
        // - Iterate bottom-up
        // - Water flows: down → down-diag → side
        // - Wall adhesion: 30% chance to stick next to walls
    }

    private stepSplashes(dt: number): void {
        const gravity = this.config.gravity * 0.5; // Splashes affected by gravity

        for (let i = 0; i < this.splashCount; i++) {
            // Apply gravity
            this.splashVelY[i] = this.splashVelY[i]! + gravity * dt;

            // Integrate position
            this.splashX[i] = this.splashX[i]! + this.splashVelX[i]! * dt;
            this.splashY[i] = this.splashY[i]! + this.splashVelY[i]! * dt;

            // Decay life
            this.splashLife[i] = this.splashLife[i]! - dt * 3; // ~0.33 second lifetime

            // Despawn dead splashes
            if (this.splashLife[i]! <= 0) {
                this.despawnSplash(i);
                i--;
            }
        }
    }

    private spawnSplash(x: number, y: number, impactVelX: number, impactVelY: number): void {
        // Spawn 3–5 splash particles
        const count = 3 + Math.floor(Math.random() * 3);
        const speed = Math.sqrt(impactVelX * impactVelX + impactVelY * impactVelY);

        for (let j = 0; j < count; j++) {
            if (this.splashCount >= this.config.maxSplashes) break;

            const i = this.splashCount++;
            this.splashX[i] = x;
            this.splashY[i] = y;

            // Random upward spray
            const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.8;
            const splashSpeed = speed * (0.2 + Math.random() * 0.3);
            this.splashVelX[i] = Math.cos(angle) * splashSpeed;
            this.splashVelY[i] = Math.sin(angle) * splashSpeed;

            this.splashLife[i] = 1.0;
        }
    }

    private despawnDrop(index: number): void {
        // Swap with last drop (O(1) removal)
        const last = this.dropCount - 1;
        if (index !== last) {
            this.dropsX[index] = this.dropsX[last]!;
            this.dropsY[index] = this.dropsY[last]!;
            this.dropsPrevX[index] = this.dropsPrevX[last]!;
            this.dropsPrevY[index] = this.dropsPrevY[last]!;
            this.dropsVelX[index] = this.dropsVelX[last]!;
            this.dropsVelY[index] = this.dropsVelY[last]!;
            this.dropsRadius[index] = this.dropsRadius[last]!;
            this.dropsOpacity[index] = this.dropsOpacity[last]!;
        }
        this.dropCount--;
    }

    private despawnSplash(index: number): void {
        // Swap with last splash (O(1) removal)
        const last = this.splashCount - 1;
        if (index !== last) {
            this.splashX[index] = this.splashX[last]!;
            this.splashY[index] = this.splashY[last]!;
            this.splashVelX[index] = this.splashVelX[last]!;
            this.splashVelY[index] = this.splashVelY[last]!;
            this.splashLife[index] = this.splashLife[last]!;
        }
        this.splashCount--;
    }

    private rasterizeWindow(win: WindowZone): void {
        // Convert global screen coords to logic grid coords
        const scale = 0.25;
        const x1 = Math.floor((win.x - this.globalOffsetX) * scale);
        const y1 = Math.floor((win.y - this.globalOffsetY) * scale);
        const x2 = Math.ceil((win.x + win.width - this.globalOffsetX) * scale);
        const y2 = Math.ceil((win.y + win.height - this.globalOffsetY) * scale);

        // Clamp to grid bounds
        const startX = Math.max(0, x1);
        const startY = Math.max(0, y1);
        const endX = Math.min(this.gridWidth, x2);
        const endY = Math.min(this.gridHeight, y2);

        // Paint walls
        for (let y = startY; y < endY; y++) {
            for (let x = startX; x < endX; x++) {
                const index = y * this.gridWidth + x;
                if (this.grid[index] === CELL_AIR) {
                    this.grid[index] = CELL_GLASS; // Default material
                }
            }
        }
    }

    private triggerAudio(
        dropIndex: number,
        gridValue: number,
        impactX: number,
        impactY: number,
        collisionSurface: 'top' | 'left' | 'right'
    ): void {
        if (!this.onCollision) return;

        // Throttle audio events
        const now = performance.now();
        if (now - this.lastAudioTime < this.AUDIO_MIN_INTERVAL) return;
        this.lastAudioTime = now;

        const vx = this.dropsVelX[dropIndex]!;
        const vy = this.dropsVelY[dropIndex]!;
        const speed = Math.sqrt(vx * vx + vy * vy);
        const radius = this.dropsRadius[dropIndex]!;

        // Scale to screen space (4×)
        const speedScreen = speed * 4.0;
        const radiusScreen = radius * 4.0;

        // Attenuate velocity for side impacts
        let velocityMultiplier = 1.0;
        if (collisionSurface === 'left' || collisionSurface === 'right') {
            const horizontalRatio = Math.abs(vx) / (speed + 0.001);
            velocityMultiplier = 0.5 + 0.5 * horizontalRatio;
        }

        // Map grid value to material
        let surfaceType = 'default';
        if (gridValue === CELL_GLASS) surfaceType = 'glass';
        else if (gridValue === CELL_WATER) surfaceType = 'water';

        // Populate reusable event object
        const evt = this.collisionEvent;
        evt.velocity = speedScreen * velocityMultiplier;
        evt.dropRadius = radiusScreen;
        evt.impactAngle = Math.atan2(vy, vx);
        evt.surfaceType = surfaceType;
        evt.mass = Math.pow(radiusScreen, 3) * 0.01;
        evt.position.x = impactX * 4.0;
        evt.position.y = impactY * 4.0;
        evt.collisionSurface = collisionSurface;

        this.onCollision(evt);
    }

    /**
     * Clean up resources.
     */
    dispose(): void {
        // TypedArrays are garbage collected, but we can help by nulling references
        // @ts-expect-error Intentional cleanup
        this.grid = null;
        // @ts-expect-error Intentional cleanup
        this.dropsX = this.dropsY = this.dropsPrevX = this.dropsPrevY = null;
        // @ts-expect-error Intentional cleanup
        this.dropsVelX = this.dropsVelY = this.dropsRadius = this.dropsOpacity = null;
        // @ts-expect-error Intentional cleanup
        this.splashX = this.splashY = this.splashVelX = this.splashVelY = this.splashLife = null;
    }
}
