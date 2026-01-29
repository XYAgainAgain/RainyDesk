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
    private waterEnergy: Float32Array;  // Energy per cell for bounce effect

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
        this.dropsVelY[i] = 150 + Math.random() * 100; // Start with good downward momentum

        // Full opacity
        this.dropsOpacity[i] = 1.0;
    }

    private stepRain(dt: number): void {
        const { gravity, windBase, slipThreshold } = this.config;
        const terminalVelocity = 300; // Logic px/s (~1200 screen px/s, realistic rain)

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

                        // Convert to puddle if hitting wall (but not void)
                        if (cellValue === CELL_GLASS) {
                            this.grid[cellIndex] = CELL_WATER;
                            // Set initial energy based on impact velocity (for bounce)
                            // Reduced multiplier for less jitter
                            const impactSpeed = Math.sqrt(
                                this.dropsVelX[i]! * this.dropsVelX[i]! +
                                this.dropsVelY[i]! * this.dropsVelY[i]!
                            );
                            this.waterEnergy[cellIndex] = Math.min(impactSpeed * 0.008, 0.5);
                        } else if (cellValue === CELL_VOID) {
                            // Void cells stay void (no puddling in gaps between monitors)
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

        const { wallAdhesion } = this.config;
        const energyDecay = 0.7;        // Faster decay for quicker settling
        const restThreshold = 0.05;     // Below this, water is at rest
        const minFallEnergy = 0.02;     // Minimum energy added on fall (was 0.2)

        // Bottom-up iteration (skip bottom row as it has nowhere to flow)
        for (let y = this.gridHeight - 2; y >= 0; y--) {
            // Randomize horizontal scan direction each row (prevents bias)
            const scanLeft = Math.random() > 0.5;
            const startX = scanLeft ? 0 : this.gridWidth - 1;
            const endX = scanLeft ? this.gridWidth : -1;
            const stepX = scanLeft ? 1 : -1;

            for (let x = startX; x !== endX; x += stepX) {
                const index = y * this.gridWidth + x;
                if (this.grid[index] !== CELL_WATER) continue;

                let energy = this.waterEnergy[index]!;

                // Check if adjacent to wall (triggers adhesion mechanic)
                const hasWallNeighbor = this.hasAdjacentWall(x, y);

                // Wall adhesion: water "sticks" to walls with probabilistic friction
                if (hasWallNeighbor && Math.random() < wallAdhesion) {
                    this.waterEnergy[index] = energy * energyDecay;
                    continue;
                }

                // === REST STATE: Skip processing if energy is negligible ===
                // Only check gravity - if we can fall, we're not at rest
                const belowIndex = (y + 1) * this.gridWidth + x;
                const canFall = y + 1 < this.gridHeight && this.grid[belowIndex] === CELL_AIR;

                if (energy < restThreshold && !canFall) {
                    // Truly at rest - zero out energy and skip
                    this.waterEnergy[index] = 0;
                    continue;
                }

                // === BOUNCE: If high energy, try to move UP first ===
                if (energy > 0.3 && Math.random() < energy) {
                    if (this.tryMoveWaterWithEnergy(index, x, y - 1, energy * 0.5)) {
                        continue;
                    }
                    // Bounce failed (blocked), convert some energy to horizontal
                    const bounceDir = Math.random() > 0.5 ? 1 : -1;
                    if (this.tryMoveWaterWithEnergy(index, x + bounceDir, y - 1, energy * 0.4)) {
                        continue;
                    }
                }

                // === COHESION: Count nearby water for mass-based speed ===
                const nearbyMass = this.countNearbyWater(x, y);
                const massBonus = Math.min(4, Math.floor(nearbyMass / 2));

                // === GRAVITY: Try to move down (multiple cells for speed) ===
                const baseFall = 2 + Math.floor(energy * 3);
                const fallDist = Math.min(12, baseFall + massBonus);
                let fell = false;
                for (let dy = fallDist; dy >= 1; dy--) {
                    // Minimal energy boost on fall, mostly preserve with decay
                    if (this.tryMoveWaterWithEnergy(index, x, y + dy, energy * energyDecay + minFallEnergy)) {
                        fell = true;
                        break;
                    }
                }
                if (fell) continue;

                // === DIAGONAL DOWN ===
                const tryLeftFirst = Math.random() > 0.5;
                const diag1X = tryLeftFirst ? x - 1 : x + 1;
                const diag2X = tryLeftFirst ? x + 1 : x - 1;

                // Try diagonal at multiple distances
                for (let dy = Math.min(3, 1 + massBonus); dy >= 1; dy--) {
                    if (this.tryMoveWaterWithEnergy(index, diag1X, y + dy, energy * energyDecay)) { fell = true; break; }
                    if (this.tryMoveWaterWithEnergy(index, diag2X, y + dy, energy * energyDecay)) { fell = true; break; }
                }
                if (fell) continue;

                // === COHESION: Move toward nearby water masses (only if energy allows) ===
                if (energy > restThreshold) {
                    const cohesionDir = this.findCohesionDirection(x, y);
                    if (cohesionDir !== 0) {
                        // Single cell movement toward mass, no energy boost
                        if (this.tryMoveWaterWithEnergy(index, x + cohesionDir, y, energy * energyDecay)) {
                            continue;
                        }
                    }

                    // === HORIZONTAL SPREAD ===
                    const side1X = tryLeftFirst ? x - 1 : x + 1;
                    const side2X = tryLeftFirst ? x + 1 : x - 1;

                    if (this.tryMoveWaterWithEnergy(index, side1X, y, energy * energyDecay)) continue;
                    if (this.tryMoveWaterWithEnergy(index, side2X, y, energy * energyDecay)) continue;
                }

                // No valid moves → water stays, decay energy
                this.waterEnergy[index] = energy * energyDecay;
            }
        }

        // Drain puddles at floor level
        if (this.floorMap) {
            for (let x = 0; x < this.gridWidth; x++) {
                const floorY: number | undefined = this.floorMap[x];
                if (floorY === undefined || floorY >= this.gridHeight) continue;

                const index = floorY * this.gridWidth + x;
                if (this.grid[index] === CELL_WATER) {
                    // 60% drain chance per tick
                    if (Math.random() < 0.60) {
                        this.grid[index] = CELL_AIR;
                        this.waterEnergy[index] = 0;
                    }
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

    /**
     * Find direction toward largest nearby water mass (cohesion).
     * Returns -1 (left), 0 (no preference), or 1 (right).
     */
    private findCohesionDirection(x: number, y: number): number {
        // Count water cells in a small radius on each side
        const searchRadius = 3;
        let leftCount = 0;
        let rightCount = 0;

        for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= this.gridHeight) continue;

            // Check left side
            for (let dx = 1; dx <= searchRadius; dx++) {
                const nx = x - dx;
                if (nx < 0) break;
                if (this.grid[ny * this.gridWidth + nx] === CELL_WATER) {
                    leftCount += (searchRadius - dx + 1); // Weight closer cells more
                }
            }

            // Check right side
            for (let dx = 1; dx <= searchRadius; dx++) {
                const nx = x + dx;
                if (nx >= this.gridWidth) break;
                if (this.grid[ny * this.gridWidth + nx] === CELL_WATER) {
                    rightCount += (searchRadius - dx + 1);
                }
            }
        }

        // Return direction toward larger mass (with threshold to avoid jitter)
        const diff = rightCount - leftCount;
        if (diff > 2) return 1;
        if (diff < -2) return -1;
        return 0;
    }

    /**
     * Move water and transfer energy.
     */
    private tryMoveWaterWithEnergy(
        srcIndex: number,
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

        // Transfer energy
        this.waterEnergy[srcIndex] = 0;
        this.waterEnergy[destIndex] = newEnergy;

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
     * 80% push to adjacent air, 20% destroy.
     */
    private displaceWater(x: number, y: number): void {
        // 20% chance to just destroy (squeezed out)
        if (Math.random() < 0.2) return;

        // 80% try to push - upward priority, then sideways
        const directions = [
            { dx: 0, dy: -1 }, // Up
            { dx: -1, dy: -1 }, // Up-left
            { dx: 1, dy: -1 },  // Up-right
            { dx: 0, dy: -2 }, // Up 2
            { dx: -1, dy: 0 }, // Left
            { dx: 1, dy: 0 },  // Right
            { dx: -2, dy: 0 }, // Left 2
            { dx: 2, dy: 0 },  // Right 2
        ];

        for (const { dx, dy } of directions) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= this.gridWidth || ny < 0 || ny >= this.gridHeight) continue;

            const neighborIndex = ny * this.gridWidth + nx;
            if (this.grid[neighborIndex] === CELL_AIR) {
                this.grid[neighborIndex] = CELL_WATER;
                this.waterEnergy[neighborIndex] = 0.15; // Reduced bounce energy
                return;
            }
        }
        // No valid destination - water is destroyed (squeezed out)
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
     * Clean up resources.
     */
    dispose(): void {
        // TypedArrays are garbage collected, but we can help by nulling references
        // @ts-expect-error Intentional cleanup
        this.grid = this.waterEnergy = null;
        // @ts-expect-error Intentional cleanup
        this.dropsX = this.dropsY = this.dropsPrevX = this.dropsPrevY = null;
        // @ts-expect-error Intentional cleanup
        this.dropsVelX = this.dropsVelY = this.dropsRadius = this.dropsOpacity = null;
        // @ts-expect-error Intentional cleanup
        this.splashX = this.splashY = this.splashVelX = this.splashVelY = this.splashLife = null;
    }
}
