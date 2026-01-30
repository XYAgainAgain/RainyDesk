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
    CELL_VOID,
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
    private waterEnergy: Float32Array;    // Energy per cell for bounce effect
    private waterMomentumX: Float32Array; // Horizontal momentum (-1 to 1) for sloshing
    private processedThisFrame: Uint8Array; // Cascade prevention: marks moved cells

    // === Void mask & spawn/floor maps (mega-window architecture) ===
    private voidMask: Uint8Array | null = null;        // 1 = void, 0 = usable
    private spawnMap: Int16Array | null = null;        // Per-column spawn Y (-1 = no spawn)
    private floorMap: Int16Array | null = null;        // Per-column floor Y

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

    // === Evaporation system ===
    private evaporationTimer = 0;  // Total time elapsed since simulation start

    // === Splash throttling ===
    private splashesThisFrame = 0;
    private readonly MAX_SPLASHES_PER_FRAME = 20;

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
     * @param voidMask Optional void mask (1 = void/wall, 0 = usable)
     * @param spawnMap Optional spawn map (per-column spawn Y, -1 = no spawn)
     * @param floorMap Optional floor map (per-column floor Y)
     */
    constructor(
        logicWidth: number,
        logicHeight: number,
        globalOffsetX = 0,
        globalOffsetY = 0,
        config: Partial<SimulationConfig> = {},
        voidMask?: Uint8Array,
        spawnMap?: Int16Array,
        floorMap?: Int16Array
    ) {
        this.gridWidth = Math.ceil(logicWidth);
        this.gridHeight = Math.ceil(logicHeight);
        this.globalOffsetX = globalOffsetX;
        this.globalOffsetY = globalOffsetY;
        this.config = { ...DEFAULT_CONFIG, ...config };

        // Store void/spawn/floor maps if provided
        this.voidMask = voidMask || null;
        this.spawnMap = spawnMap || null;
        this.floorMap = floorMap || null;

        // Allocate grid and energy arrays
        this.grid = new Uint8Array(this.gridWidth * this.gridHeight);
        this.waterEnergy = new Float32Array(this.gridWidth * this.gridHeight);
        this.waterMomentumX = new Float32Array(this.gridWidth * this.gridHeight);
        this.processedThisFrame = new Uint8Array(this.gridWidth * this.gridHeight);

        // Initialize grid with void cells if void mask provided
        if (this.voidMask) {
            for (let i = 0; i < this.grid.length; i++) {
                this.grid[i] = this.voidMask[i] === 1 ? CELL_VOID : CELL_AIR;
            }
        }

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
        this.evaporationTimer += dt;
        this.splashesThisFrame = 0; // Reset splash throttle

        // Spawn new drops
        while (this.spawnAccumulator >= 1 / this.config.spawnRate) {
            this.spawnDrop();
            this.spawnAccumulator -= 1 / this.config.spawnRate;
        }

        // Rain physics at 60Hz
        while (this.rainAccumulator >= RAIN_TICK) {
            this.stepRain(RAIN_TICK);
            this.mergeNearbyDrops(); // Cohesion: merge colliding drops
            this.rainAccumulator -= RAIN_TICK;
        }

        // Puddle automata at 60Hz
        while (this.puddleAccumulator >= PUDDLE_TICK) {
            this.stepPuddles(PUDDLE_TICK);
            this.puddleAccumulator -= PUDDLE_TICK;
        }

        // Global evaporation (gentle equilibrium system)
        this.applyEvaporation(dt);

        // Splashes every frame (visual-only)
        this.stepSplashes(dt);
    }

    /**
     * Update window zones from Tauri window data.
     * Clears existing walls (keeps water), then paints new walls.
     * @param windows Array of window zones in global screen coordinates
     */
    updateWindowZones(windows: WindowZone[]): void {
        // Clear walls but preserve water AND void
        for (let i = 0; i < this.grid.length; i++) {
            const cell = this.grid[i]!;
            if (cell !== CELL_WATER && cell !== CELL_VOID) {
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
     * Set wind strength (0-100 slider value).
     * Scaled to logic pixels/sec for noticeable effect.
     */
    setWind(wind: number): void {
        // Scale: 0 = no wind, 100 = strong wind (150 logic px/sec = 600 screen px/sec)
        this.config.windBase = wind * 1.5;
    }

    /**
     * Set gravity (real-time adjustable).
     * @param gravity Gravity in logic pixels/sec² (default 980)
     */
    setGravity(gravity: number): void {
        this.config.gravity = gravity;
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

        // Random column
        const x = Math.floor(Math.random() * this.gridWidth);

        // Spawn at top of valid region for this column (or -2 if no spawn map)
        let spawnY = -2;
        if (this.spawnMap) {
            const mapSpawnY = this.spawnMap[x];
            if (mapSpawnY === undefined || mapSpawnY < 0) {
                // Column is entirely void or invalid, skip spawn
                this.dropCount--; // Revert spawn
                return;
            }
            spawnY = mapSpawnY;
        }

        this.dropsX[i] = x + Math.random(); // Add sub-pixel offset
        this.dropsY[i] = spawnY;
        this.dropsPrevX[i] = this.dropsX[i];
        this.dropsPrevY[i] = this.dropsY[i];

        // Random radius
        this.dropsRadius[i] = radiusMin + Math.random() * (radiusMax - radiusMin);

        // Initial velocity (slight horizontal from wind)
        this.dropsVelX[i] = windBase + (Math.random() - 0.5) * windTurbulence;
        this.dropsVelY[i] = 200 + Math.random() * 150; // Start with good downward momentum (200-350)

        // Full opacity
        this.dropsOpacity[i] = 1.0;
    }

    private stepRain(dt: number): void {
        const { gravity, windBase, slipThreshold } = this.config;
        // Terminal velocity scales with gravity (default: 980 → 350 logic px/s)
        // Higher gravity = faster terminal velocity, lower gravity = slower
        // Minimum of 50 prevents zero-gravity from freezing drops
        const terminalVelocity = Math.max(50, 350 * (gravity / 980));

        for (let i = 0; i < this.dropCount; i++) {
            // Store previous position for collision detection
            this.dropsPrevX[i] = this.dropsX[i]!;
            this.dropsPrevY[i] = this.dropsY[i]!;

            // Apply gravity
            this.dropsVelY[i] = this.dropsVelY[i]! + gravity * dt;

            // Cap at terminal velocity
            if (this.dropsVelY[i]! > terminalVelocity) {
                this.dropsVelY[i] = terminalVelocity;
            }

            // Apply wind (lerp toward target, faster response)
            this.dropsVelX[i] = this.dropsVelX[i]! + (windBase - this.dropsVelX[i]!) * 0.3 * dt * 60;

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

            // VOID cells: immediate despawn with splash (no air-transition check needed)
            // This handles rain falling off monitor edges into gaps
            if (cellValue === CELL_VOID) {
                // Spawn splash at edge
                this.spawnSplash(this.dropsX[i]!, this.dropsY[i]!, this.dropsVelX[i]!, this.dropsVelY[i]!);
                this.despawnDrop(i);
                i--;
                continue;
            }

            // Floor collision: check if we've hit the work area floor
            if (this.floorMap) {
                const floorY = this.floorMap[cellX];
                if (floorY !== undefined && cellY >= floorY && this.dropsPrevY[i]! < floorY) {
                    // Hit the floor - spawn splash and create puddle
                    this.triggerAudio(i, CELL_GLASS, this.dropsX[i]!, floorY, 'top');
                    this.spawnSplash(this.dropsX[i]!, floorY, this.dropsVelX[i]!, this.dropsVelY[i]!);

                    // Create water at floor if cell is air
                    const floorIndex = floorY * this.gridWidth + cellX;
                    if (floorIndex >= 0 && floorIndex < this.grid.length && this.grid[floorIndex] === CELL_AIR) {
                        this.grid[floorIndex] = CELL_WATER;
                        const impactSpeed = Math.sqrt(
                            this.dropsVelX[i]! * this.dropsVelX[i]! +
                            this.dropsVelY[i]! * this.dropsVelY[i]!
                        );
                        this.waterEnergy[floorIndex] = Math.min(impactSpeed * 0.01, 0.6);
                        // Set initial momentum from rain's horizontal velocity
                        this.waterMomentumX[floorIndex] = Math.max(-1, Math.min(1, this.dropsVelX[i]! * 0.01));
                    }

                    this.despawnDrop(i);
                    i--;
                    continue;
                }
            }

            // Check for Air→Glass/Water transition
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

                        // Convert to puddle if hitting glass wall
                        if (cellValue === CELL_GLASS) {
                            this.grid[cellIndex] = CELL_WATER;
                            // Set initial energy based on impact velocity
                            const impactSpeed = Math.sqrt(
                                this.dropsVelX[i]! * this.dropsVelX[i]! +
                                this.dropsVelY[i]! * this.dropsVelY[i]!
                            );
                            this.waterEnergy[cellIndex] = Math.min(impactSpeed * 0.01, 0.6);
                            // Set initial momentum from rain's horizontal velocity (normalized to -1..1)
                            this.waterMomentumX[cellIndex] = Math.max(-1, Math.min(1, this.dropsVelX[i]! * 0.01));
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

    /**
     * Merge nearby drops that are colliding (cohesion for falling rain).
     * Uses spatial proximity - if two drops are within touching distance, combine them.
     */
    private mergeNearbyDrops(): void {
        const mergeThreshold = 2.0; // Logic units - drops within this distance merge

        // Simple O(n²) collision check - could optimize with spatial hashing for large counts
        for (let i = 0; i < this.dropCount; i++) {
            const x1 = this.dropsX[i]!;
            const y1 = this.dropsY[i]!;
            const r1 = this.dropsRadius[i]!;

            for (let j = i + 1; j < this.dropCount; j++) {
                const x2 = this.dropsX[j]!;
                const y2 = this.dropsY[j]!;
                const r2 = this.dropsRadius[j]!;

                // Distance between centers
                const dx = x2 - x1;
                const dy = y2 - y1;
                const distSq = dx * dx + dy * dy;
                const touchDist = r1 + r2 + mergeThreshold;

                if (distSq < touchDist * touchDist) {
                    // Merge: combine into larger drop (keep drop i, remove drop j)
                    // Mass is proportional to radius³
                    const m1 = r1 * r1 * r1;
                    const m2 = r2 * r2 * r2;
                    const totalMass = m1 + m2;

                    // New radius from combined mass
                    this.dropsRadius[i] = Math.cbrt(totalMass);

                    // Weighted average position
                    this.dropsX[i] = (x1 * m1 + x2 * m2) / totalMass;
                    this.dropsY[i] = (y1 * m1 + y2 * m2) / totalMass;

                    // Weighted average velocity
                    this.dropsVelX[i] = (this.dropsVelX[i]! * m1 + this.dropsVelX[j]! * m2) / totalMass;
                    this.dropsVelY[i] = (this.dropsVelY[i]! * m1 + this.dropsVelY[j]! * m2) / totalMass;

                    // Remove drop j
                    this.despawnDrop(j);
                    j--; // Recheck this index since we swapped in the last drop
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
        // Cellular automata with bounce and cohesion
        // Water has energy (bounce) and is attracted to nearby water (cohesion)

        // Reset processed flag array (prevents cascade bugs)
        this.processedThisFrame.fill(0);

        const { wallAdhesion } = this.config;
        const energyDecay = 0.922;
        const restThreshold = 0.02;     // Very low threshold - water almost always flows
        const minFallEnergy = 0.05;     // Energy boost on fall
        const baseEnergy = 0.05;        // Minimum energy water always has (for gravity)

        // Bottom-up iteration (skip bottom row as it has nowhere to flow)
        for (let y = this.gridHeight - 2; y >= 0; y--) {
            // Alternate scan direction by row (FLIPPED to test bias direction)
            const scanLeft = y % 2 !== 0;
            const startX = scanLeft ? 0 : this.gridWidth - 1;
            const endX = scanLeft ? this.gridWidth : -1;
            const stepX = scanLeft ? 1 : -1;

            for (let x = startX; x !== endX; x += stepX) {
                const index = y * this.gridWidth + x;
                if (this.grid[index] !== CELL_WATER) continue;

                // Skip cells already processed this frame (prevents cascade bugs)
                if (this.processedThisFrame[index]) continue;

                // Ensure minimum energy so water always tries to flow
                let energy = Math.max(baseEnergy, this.waterEnergy[index]!);

                // Check if adjacent to wall (triggers adhesion mechanic)
                const hasWallNeighbor = this.hasAdjacentWall(x, y);

                // Wall adhesion: water "sticks" to walls with probabilistic friction
                if (hasWallNeighbor && Math.random() < wallAdhesion) {
                    this.waterEnergy[index] = energy * energyDecay;
                    continue;
                }

                // Get momentum for sloshing
                let momentum = this.waterMomentumX[index]!;

                // Per-tick momentum decay (idle decay at 60 Hz)
                this.waterMomentumX[index] = momentum * 0.959;

                // === BOUNCE: If high energy, try to move UP first ===
                if (energy > 0.4 && Math.random() < energy * 0.5) {
                    if (this.tryMoveWaterWithEnergy(index, x, x, y - 1, energy * 0.4)) {
                        continue;
                    }
                    // Bounce failed (blocked), convert some energy to horizontal
                    const bounceDir = Math.random() > 0.5 ? 1 : -1;
                    if (this.tryMoveWaterWithEnergy(index, x, x + bounceDir, y - 1, energy * 0.3)) {
                        continue;
                    }
                    // Bounce completely blocked - spawn splash!
                    if (energy > 0.5) {
                        this.spawnPuddleSplash(x, y, energy);
                    }
                }

                // === MOMENTUM SLOSH: DISABLED for bias testing ===
                // if (Math.abs(momentum) > 0.3 && energy > 0.15) {
                //     const pushDir = momentum > 0 ? 1 : -1;
                //     const pushStrength = Math.abs(momentum);
                //     if (this.tryMoveWaterWithEnergy(index, x, x + pushDir, y, energy * 0.9)) {
                //         continue;
                //     }
                //     if (pushStrength > 0.6 && energy > 0.3) {
                //         if (this.tryMoveWaterWithEnergy(index, x, x + pushDir, y - 1, energy * 0.7)) {
                //             continue;
                //         }
                //     }
                // }

                // === COHESION: Count nearby water for mass-based speed ===
                const nearbyMass = this.countNearbyWater(x, y);
                const massBonus = Math.min(4, Math.floor(nearbyMass / 2));

                // === GRAVITY: Try to move down (multiple cells for speed) ===
                // Always try to fall - gravity works regardless of energy
                const baseFall = 2 + Math.floor(energy * 6);
                const fallDist = Math.min(12, baseFall + massBonus);
                let fell = false;
                for (let dy = fallDist; dy >= 1; dy--) {
                    // Energy boost on fall keeps water flowing
                    if (this.tryMoveWaterWithEnergy(index, x, x, y + dy, energy * energyDecay + minFallEnergy)) {
                        fell = true;
                        break;
                    }
                }
                if (fell) continue;

                // === DIAGONAL DOWN ===
                // Pure random direction (checkerboard had subtle bias with scan order)
                const diagDir = Math.random() > 0.5 ? -1 : 1;
                if (this.tryMoveWaterWithEnergy(index, x, x + diagDir, y + 1, energy * energyDecay + minFallEnergy * 0.5)) {
                    continue;
                }
                if (this.tryMoveWaterWithEnergy(index, x, x - diagDir, y + 1, energy * energyDecay + minFallEnergy * 0.5)) {
                    continue;
                }

                // Check if water has settled (something below it)
                const hasSupport = y + 1 >= this.gridHeight ||
                    (y + 1 < this.gridHeight && this.grid[(y + 1) * this.gridWidth + x] !== CELL_AIR);

                // === HORIZONTAL SPREAD: Aggressive spreading for fluid-like behavior ===
                // Water seeks its own level - spread until height equalizes
                if (hasSupport) {
                    const spreadDir = Math.random() > 0.5 ? -1 : 1;
                    let spread = false;
                    // Try spreading up to 3 cells horizontally (finds gaps in puddles)
                    for (let dist = 1; dist <= 3; dist++) {
                        if (this.tryMoveWaterWithEnergy(index, x, x + spreadDir * dist, y, energy * energyDecay)) {
                            spread = true;
                            break;
                        }
                    }
                    if (spread) continue;
                    // If first direction blocked, try the other
                    for (let dist = 1; dist <= 3; dist++) {
                        if (this.tryMoveWaterWithEnergy(index, x, x - spreadDir * dist, y, energy * energyDecay)) {
                            spread = true;
                            break;
                        }
                    }
                    if (spread) continue;
                }

                // No valid moves → water stays, decay energy
                // High-energy water that's completely stuck creates splash (impact spray)
                if (energy > 0.45 && Math.random() < 0.3) {
                    this.spawnPuddleSplash(x, y, energy);
                }
                this.waterEnergy[index] = Math.max(restThreshold, energy * energyDecay);
                // Note: Momentum already decayed per-tick earlier in loop
            }
        }

        // Drain puddles at floor level
        if (this.floorMap) {
            for (let x = 0; x < this.gridWidth; x++) {
                const floorY: number | undefined = this.floorMap[x];
                if (floorY === undefined || floorY >= this.gridHeight) continue;

                const index = floorY * this.gridWidth + x;
                if (this.grid[index] === CELL_WATER) {
                    // Floor drain DISABLED for testing - evaporation only
                    // if (Math.random() < 0.05) {
                    //     this.grid[index] = CELL_AIR;
                    //     this.waterEnergy[index] = 0;
                    // }
                }
            }
        }
    }

    /**
     * Count nearby water cells (for mass-based fall speed).
     */
    private countNearbyWater(x: number, y: number): number {
        let count = 0;
        const radius = 2;

        for (let dy = -radius; dy <= radius; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= this.gridHeight) continue;

            for (let dx = -radius; dx <= radius; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = x + dx;
                if (nx < 0 || nx >= this.gridWidth) continue;

                if (this.grid[ny * this.gridWidth + nx] === CELL_WATER) {
                    count++;
                }
            }
        }
        return count;
    }

    // === COHESION FUNCTION DISABLED FOR BIAS TESTING ===
    // /**
    //  * Find direction toward largest nearby water mass (cohesion).
    //  * Returns -1 (left), 0 (no preference), or 1 (right).
    //  */
    // private findCohesionDirection(x: number, y: number): number {
    //     const searchRadius = 2;
    //     let leftCount = 0;
    //     let rightCount = 0;
    //     for (let dy = -1; dy <= 1; dy++) {
    //         const ny = y + dy;
    //         if (ny < 0 || ny >= this.gridHeight) continue;
    //         for (let dx = 1; dx <= searchRadius; dx++) {
    //             const nx = x - dx;
    //             if (nx < 0) break;
    //             if (this.grid[ny * this.gridWidth + nx] === CELL_WATER) {
    //                 leftCount += (searchRadius - dx + 1);
    //             }
    //         }
    //         for (let dx = 1; dx <= searchRadius; dx++) {
    //             const nx = x + dx;
    //             if (nx >= this.gridWidth) break;
    //             if (this.grid[ny * this.gridWidth + nx] === CELL_WATER) {
    //                 rightCount += (searchRadius - dx + 1);
    //             }
    //         }
    //     }
    //     const diff = rightCount - leftCount;
    //     if (diff > 2) return 1;
    //     if (diff < -2) return -1;
    //     return 0;
    // }

    /**
     * Move water, transfer energy, and update momentum.
     * @param srcX Source X coordinate (needed for momentum calculation)
     */
    private tryMoveWaterWithEnergy(
        srcIndex: number,
        _srcX: number,
        destX: number,
        destY: number,
        newEnergy: number
    ): boolean {
        // Bounds check
        if (destX < 0 || destX >= this.gridWidth || destY < 0 || destY >= this.gridHeight) {
            return false;
        }

        const destIndex = destY * this.gridWidth + destX;
        const destCell = this.grid[destIndex]!;

        // Can only flow into air
        if (destCell !== CELL_AIR) {
            return false;
        }

        // Move water
        this.grid[srcIndex] = CELL_AIR;
        this.grid[destIndex] = CELL_WATER;

        // Mark destination as processed (prevents cascade bugs)
        this.processedThisFrame[destIndex] = 1;

        // Transfer energy
        this.waterEnergy[srcIndex] = 0;
        this.waterEnergy[destIndex] = newEnergy;

        // Preserve momentum with decay (don't add gain - causes feedback loops)
        const oldMomentum = this.waterMomentumX[srcIndex]!;
        const newMomentum = Math.max(-1, Math.min(1, oldMomentum * 0.922));
        this.waterMomentumX[srcIndex] = 0;
        this.waterMomentumX[destIndex] = newMomentum;

        return true;
    }

    /**
     * Check if water cell has adjacent wall (triggers dribble mechanic).
     */
    private hasAdjacentWall(x: number, y: number): boolean {
        // Check 4 cardinal directions for glass or void walls
        if (x > 0) {
            const cell = this.grid[y * this.gridWidth + (x - 1)]!;
            if (cell === CELL_GLASS || cell === CELL_VOID) return true;
        }
        if (x < this.gridWidth - 1) {
            const cell = this.grid[y * this.gridWidth + (x + 1)]!;
            if (cell === CELL_GLASS || cell === CELL_VOID) return true;
        }
        if (y > 0) {
            const cell = this.grid[(y - 1) * this.gridWidth + x]!;
            if (cell === CELL_GLASS || cell === CELL_VOID) return true;
        }
        if (y < this.gridHeight - 1) {
            const cell = this.grid[(y + 1) * this.gridWidth + x]!;
            if (cell === CELL_GLASS || cell === CELL_VOID) return true;
        }
        return false;
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
        const count = 2 + Math.floor(Math.random() * 3);
        const speed = Math.sqrt(impactVelX * impactVelX + impactVelY * impactVelY);

        for (let j = 0; j < count; j++) {
            if (this.splashCount >= this.config.maxSplashes) break;

            const i = this.splashCount++;
            this.splashX[i] = x;
            this.splashY[i] = y;

            // Random upward spray
            const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.8;
            const splashSpeed = speed * (0.16 + Math.random() * 0.24);
            this.splashVelX[i] = Math.cos(angle) * splashSpeed;
            this.splashVelY[i] = Math.sin(angle) * splashSpeed;

            this.splashLife[i] = 1.0;
        }
    }

    /**
     * Spawn splash particles from puddle physics (energy-based).
     * Called when high-energy puddle water bounces or gets displaced.
     * Throttled to prevent flash floods.
     */
    private spawnPuddleSplash(x: number, y: number, energy: number): void {
        // Throttle: limit splashes per frame to prevent flash
        if (this.splashesThisFrame >= this.MAX_SPLASHES_PER_FRAME) return;

        // Fewer splashes, more conservative (1-2 based on energy)
        const count = 1 + Math.floor(energy * 2);
        // Convert grid energy to splash speed (energy 0.5 → ~60 speed)
        const baseSpeed = energy * 120;

        for (let j = 0; j < count; j++) {
            if (this.splashCount >= this.config.maxSplashes) break;
            if (this.splashesThisFrame >= this.MAX_SPLASHES_PER_FRAME) break;

            const i = this.splashCount++;
            this.splashesThisFrame++;
            this.splashX[i] = x;
            this.splashY[i] = y;

            // Random spray direction (mostly upward, but wider spread than raindrop splashes)
            const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.2;
            const splashSpeed = baseSpeed * (0.3 + Math.random() * 0.7);
            this.splashVelX[i] = Math.cos(angle) * splashSpeed;
            this.splashVelY[i] = Math.sin(angle) * splashSpeed;

            this.splashLife[i] = 0.8 + Math.random() * 0.4; // Slightly variable lifetime
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

        // Paint walls (but don't paint over void - windows can't exist in gaps between monitors)
        for (let y = startY; y < endY; y++) {
            for (let x = startX; x < endX; x++) {
                const index = y * this.gridWidth + x;
                const cell = this.grid[index]!;
                if (cell === CELL_AIR) {
                    this.grid[index] = CELL_GLASS;
                } else if (cell === CELL_WATER) {
                    // Window moved into water - push water out
                    this.displaceWater(x, y);
                    this.grid[index] = CELL_GLASS;
                }
                // CELL_VOID stays void (don't paint glass in monitor gaps)
            }
        }
    }

    /**
     * Displace water when a window moves into it.
     * Searches wide radius for air, energizes nearby water if trapped.
     */
    private displaceWater(x: number, y: number): void {
        const displacementEnergy = 0.55;

        // Always spawn splash for visual feedback
        this.spawnPuddleSplash(x, y, displacementEnergy);

        // Randomize left/right to prevent directional bias
        const lr = Math.random() > 0.5 ? 1 : -1;

        // Search in expanding rings up to radius 8
        for (let radius = 1; radius <= 8; radius++) {
            // Try cells at this radius (prioritize up, then sides)
            const candidates: { dx: number; dy: number }[] = [];

            // Up directions first (water rises when squeezed)
            for (let dx = -radius; dx <= radius; dx++) {
                candidates.push({ dx: dx * lr, dy: -radius });
            }
            // Side directions
            for (let dy = -radius + 1; dy <= 0; dy++) {
                candidates.push({ dx: radius * lr, dy });
                candidates.push({ dx: -radius * lr, dy });
            }

            // Shuffle candidates at this radius for fairness
            for (let i = candidates.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                const temp = candidates[i]!;
                candidates[i] = candidates[j]!;
                candidates[j] = temp;
            }

            for (const { dx, dy } of candidates) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || nx >= this.gridWidth || ny < 0 || ny >= this.gridHeight) continue;

                const neighborIndex = ny * this.gridWidth + nx;
                if (this.grid[neighborIndex] === CELL_AIR) {
                    this.grid[neighborIndex] = CELL_WATER;
                    this.waterEnergy[neighborIndex] = displacementEnergy;
                    const pushMomentum = dx > 0 ? 0.9 : dx < 0 ? -0.9 : (Math.random() > 0.5 ? 0.5 : -0.5);
                    this.waterMomentumX[neighborIndex] = pushMomentum;
                    return;
                }
            }
        }

        // Truly trapped - energize nearest water to create sloshing response
        for (let radius = 1; radius <= 4; radius++) {
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || nx >= this.gridWidth || ny < 0 || ny >= this.gridHeight) continue;

                    const neighborIndex = ny * this.gridWidth + nx;
                    if (this.grid[neighborIndex] === CELL_WATER) {
                        // Boost energy and momentum of nearby water
                        this.waterEnergy[neighborIndex] = Math.min(1, this.waterEnergy[neighborIndex]! + 0.4);
                        this.waterMomentumX[neighborIndex] = Math.max(-1, Math.min(1,
                            this.waterMomentumX[neighborIndex]! + (dx > 0 ? 0.5 : -0.5) * lr));
                        return;
                    }
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

        // Map grid value to material (must match MaterialManager keys)
        let surfaceType = 'default';
        if (gridValue === CELL_GLASS) surfaceType = 'glass_window';
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
     * Global evaporation system - maintains equilibrium with spawn rate.
     * Timeline:
     *   0-60s: No evaporation (warmup, puddles accumulate)
     *   60-120s: Evaporation ramps from 0% to 100% of spawn rate (gentle transition)
     *   120s+: Full evaporation at spawn rate (equilibrium)
     */
    private applyEvaporation(dt: number): void {
        const warmupTime = 60;  // First 60 seconds: no evaporation
        const rampTime = 60;    // Next 60 seconds: gentle ramp to full effect

        // Calculate evaporation rate based on elapsed time
        let evaporationRate = 0;
        if (this.evaporationTimer > warmupTime) {
            const rampProgress = Math.min(1, (this.evaporationTimer - warmupTime) / rampTime);
            // Barely past equilibrium for testing
            evaporationRate = this.config.spawnRate * rampProgress * 1.01;
        }

        // Calculate how many particles to evaporate this frame
        const particlesToEvaporate = evaporationRate * dt;
        if (particlesToEvaporate < 0.01) return; // Skip if negligible

        // Count total water particles
        let waterCount = 0;
        for (let i = 0; i < this.grid.length; i++) {
            if (this.grid[i] === CELL_WATER) waterCount++;
        }

        if (waterCount === 0) return;

        // Evaporate particles randomly across the grid
        // Probability per water particle = particlesToEvaporate / waterCount
        // Cap at 10% to prevent runaway evaporation at low water counts
        const evaporationChance = Math.min(0.1, particlesToEvaporate / waterCount);

        for (let i = 0; i < this.grid.length; i++) {
            if (this.grid[i] === CELL_WATER && Math.random() < evaporationChance) {
                this.grid[i] = CELL_AIR;
                this.waterEnergy[i] = 0;
                this.waterMomentumX[i] = 0;
            }
        }
    }

    /**
     * Clean up resources.
     */
    dispose(): void {
        // TypedArrays are garbage collected, but we can help by nulling references
        // @ts-expect-error Intentional cleanup
        this.grid = this.waterEnergy = this.waterMomentumX = this.processedThisFrame = null;
        // @ts-expect-error Intentional cleanup
        this.dropsX = this.dropsY = this.dropsPrevX = this.dropsPrevY = null;
        // @ts-expect-error Intentional cleanup
        this.dropsVelX = this.dropsVelY = this.dropsRadius = this.dropsOpacity = null;
        // @ts-expect-error Intentional cleanup
        this.splashX = this.splashY = this.splashVelX = this.splashVelY = this.splashLife = null;
    }
}
