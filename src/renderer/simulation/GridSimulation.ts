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
    private gridBuffer: Uint8Array;      // Double buffer for consistent reads
    private waterEnergy: Float32Array;
    private waterEnergyBuffer: Float32Array;
    private waterMomentumX: Float32Array;
    private waterMomentumXBuffer: Float32Array;
    private waterDepth: Float32Array;      // Water depth per cell (stacking)
    private waterDepthBuffer: Float32Array;
    private processedThisFrame: Uint8Array;

    // === Void mask & spawn/floor maps (mega-window architecture) ===
    private voidMask: Uint8Array | null = null;        // 1 = void, 0 = usable
    private spawnMap: Int16Array | null = null;        // Per-column spawn Y (-1 = no spawn)
    private originalSpawnMap: Int16Array | null = null; // Original spawn map before dynamic void
    private floorMap: Int16Array | null = null;        // Per-column splash floor Y (work area bottom)
    private displayFloorMap: Int16Array | null = null; // Per-column puddle floor Y (display bottom)

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

    // === DEBUG: Movement bias tracking ===
    private debugLeftMoves = 0;
    private debugRightMoves = 0;
    private debugDownMoves = 0;
    private debugUpMoves = 0;
    private debugDiagL = 0;
    private debugDiagR = 0;
    private debugSpreadL = 0;
    private debugSpreadR = 0;
    private debugFrameCount = 0;
    private debugMoveContext: 'diag' | 'spread' | 'other' = 'other';
    public onDebugLog: ((msg: string) => void) | null = null;
    private _loggedWindows = false;

    /**
     * Create a new simulation.
     * @param logicWidth Grid width in logic pixels (screen width × 0.25)
     * @param logicHeight Grid height in logic pixels (screen height × 0.25)
     * @param globalOffsetX X offset from global coordinate origin
     * @param globalOffsetY Y offset from global coordinate origin
     * @param config Optional configuration overrides
     * @param voidMask Optional void mask (1 = void/wall, 0 = usable)
     * @param spawnMap Optional spawn map (per-column spawn Y, -1 = no spawn)
     * @param floorMap Optional splash floor map (per-column work area bottom)
     * @param displayFloorMap Optional puddle floor map (per-column display bottom)
     */
    constructor(
        logicWidth: number,
        logicHeight: number,
        globalOffsetX = 0,
        globalOffsetY = 0,
        config: Partial<SimulationConfig> = {},
        voidMask?: Uint8Array,
        spawnMap?: Int16Array,
        floorMap?: Int16Array,
        displayFloorMap?: Int16Array
    ) {
        this.gridWidth = Math.ceil(logicWidth);
        this.gridHeight = Math.ceil(logicHeight);
        this.globalOffsetX = globalOffsetX;
        this.globalOffsetY = globalOffsetY;
        this.config = { ...DEFAULT_CONFIG, ...config };

        // Store void/spawn/floor maps if provided
        this.voidMask = voidMask || null;
        this.spawnMap = spawnMap || null;
        this.originalSpawnMap = spawnMap ? new Int16Array(spawnMap) : null; // Copy for restoration
        this.floorMap = floorMap || null;
        this.displayFloorMap = displayFloorMap || null;

        // Allocate grid and energy arrays (double buffered)
        const gridSize = this.gridWidth * this.gridHeight;
        this.grid = new Uint8Array(gridSize);
        this.gridBuffer = new Uint8Array(gridSize);
        this.waterEnergy = new Float32Array(gridSize);
        this.waterEnergyBuffer = new Float32Array(gridSize);
        this.waterMomentumX = new Float32Array(gridSize);
        this.waterMomentumXBuffer = new Float32Array(gridSize);
        this.waterDepth = new Float32Array(gridSize);
        this.waterDepthBuffer = new Float32Array(gridSize);
        this.processedThisFrame = new Uint8Array(gridSize);

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
     * OPTION A: Dynamic void mask (true void - blocks spawn/flow)
     * Non-destructive update: only modifies cells that actually changed.
     * @param normalWindows Array of normal collision windows (CELL_GLASS)
     * @param voidWindows Array of void windows (CELL_VOID, blocks spawn)
     * @param spawnBlockWindows Array of windows that only block spawn (no grid painting)
     */
    updateWindowZones(normalWindows: WindowZone[], voidWindows: WindowZone[], spawnBlockWindows: WindowZone[] = []): void {
        // Build target grid state in temporary buffer (non-destructive approach)
        const targetGrid = new Uint8Array(this.grid.length);

        // Step 1: Start with air, apply static void mask
        targetGrid.fill(CELL_AIR);
        if (this.voidMask) {
            for (let i = 0; i < targetGrid.length; i++) {
                if (this.voidMask[i] === 1) {
                    targetGrid[i] = CELL_VOID;
                }
            }
        }

        // Step 2: Paint all windows (without displacement - just mark cells)
        for (const win of normalWindows) {
            this.rasterizeWindowSimple(win, CELL_GLASS, targetGrid);
        }
        for (const win of voidWindows) {
            this.rasterizeWindowSimple(win, CELL_VOID, targetGrid);
        }

        // Step 3: Find water that would be trapped inside windows and collect for displacement
        const waterToDisplace: { x: number; y: number }[] = [];
        for (let i = 0; i < this.grid.length; i++) {
            if (this.grid[i] === CELL_WATER) {
                // Water in current grid - check if target has window there
                if (targetGrid[i] === CELL_GLASS || targetGrid[i] === CELL_VOID) {
                    // Water would be inside window - needs displacement
                    const x = i % this.gridWidth;
                    const y = Math.floor(i / this.gridWidth);
                    waterToDisplace.push({ x, y });
                } else {
                    // Water can stay - copy to target
                    targetGrid[i] = CELL_WATER;
                }
            }
        }

        // Step 4: Commit target grid to main grid
        let changedCount = 0;
        for (let i = 0; i < this.grid.length; i++) {
            if (this.grid[i] !== targetGrid[i]) {
                this.grid[i] = targetGrid[i]!;
                changedCount++;
            }
        }

        // Step 5: Now displace water (grid is finalized, air cells are safe)
        for (const { x, y } of waterToDisplace) {
            this.displaceWater(x, y);
        }

        // DEBUG: Log all windows once on first update
        if (this.onDebugLog && !this._loggedWindows) {
            this._loggedWindows = true;
            this.onDebugLog(`[GridWindows] Painting ${normalWindows.length} normal + ${voidWindows.length} void windows (changed ${changedCount} cells, displaced ${waterToDisplace.length} water)`);
        }

        // Restore original spawn map before applying dynamic void
        if (this.spawnMap && this.originalSpawnMap) {
            this.spawnMap.set(this.originalSpawnMap);
        }

        // Update spawn map for void windows
        for (const win of voidWindows) {
            this.updateSpawnMapForVoidWindow(win);
        }

        // Update spawn map for spawn-block-only windows (snapped windows)
        for (const win of spawnBlockWindows) {
            this.updateSpawnMapForVoidWindow(win);
        }
    }

    /**
     * Simple window rasterization - just paint cells, no displacement.
     */
    private rasterizeWindowSimple(win: WindowZone, cellType: number, grid: Uint8Array): void {
        const scale = 0.25;
        const x1 = Math.floor((win.x - this.globalOffsetX) * scale);
        const y1 = Math.floor((win.y - this.globalOffsetY) * scale);
        const x2 = Math.ceil((win.x + win.width - this.globalOffsetX) * scale);
        const y2 = Math.ceil((win.y + win.height - this.globalOffsetY) * scale);

        const startX = Math.max(0, x1);
        const startY = Math.max(0, y1);
        const endX = Math.min(this.gridWidth, x2);
        const endY = Math.min(this.gridHeight, y2);

        for (let y = startY; y < endY; y++) {
            for (let x = startX; x < endX; x++) {
                const index = y * this.gridWidth + x;
                // Only paint if not void (preserve monitor gaps)
                if (grid[index] !== CELL_VOID) {
                    grid[index] = cellType;
                }
            }
        }
    }

    /**
     * Update spawn map to block spawning in void window zones.
     * Sets spawn Y to -1 for columns covered by void windows.
     */
    private updateSpawnMapForVoidWindow(win: WindowZone): void {
        if (!this.spawnMap) return;

        const scale = 0.25;
        const x1 = Math.floor((win.x - this.globalOffsetX) * scale);
        const x2 = Math.ceil((win.x + win.width - this.globalOffsetX) * scale);

        const startX = Math.max(0, x1);
        const endX = Math.min(this.gridWidth, x2);

        // Mark columns as no-spawn
        for (let x = startX; x < endX; x++) {
            this.spawnMap[x] = -1;
        }
    }

    // OPTION B: Visual masking only (commented out for future testing)
    // This would keep physics but mask rendering:
    // setVisualMaskZones(maskZones: WindowZone[]): void {
    //     // Store mask zones for renderer to use
    //     // Renderer would check if pixel is in mask zone and skip rendering
    //     // Physics continues underneath
    // }

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
     * Set splash scale (affects BOTH particle count AND visual size together).
     * @param scale 0.5-2.0 multiplier (1.0 = default)
     */
    setSplashScale(scale: number): void {
        this.config.splashScale = Math.max(0.5, Math.min(2.0, scale));
    }

    /**
     * Set turbulence (wind gust strength).
     * @param intensity 0-1 (0 = no gusts, 1 = strong gusts)
     */
    setTurbulence(intensity: number): void {
        this.config.windTurbulence = intensity * 50; // Scale to logic px/s variance
    }

    /**
     * Set evaporation rate multiplier.
     * @param rate 0-2 multiplier (1.0 = default, 0 = no evaporation, 2 = fast evaporation)
     */
    setEvaporationRate(rate: number): void {
        this.config.evaporationRate = Math.max(0, Math.min(2, rate));
    }

    /**
     * Set maximum drop radius.
     * @param max 1.0-4.0 in logic pixels
     */
    setDropMaxRadius(max: number): void {
        this.config.radiusMax = Math.max(1.0, Math.min(4.0, max));
    }

    /**
     * Enable or disable reverse gravity mode.
     * @param reversed true = rain falls up, false = normal
     */
    setReverseGravity(reversed: boolean): void {
        this.config.reverseGravity = reversed;
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
            depth: this.waterDepth,
            width: this.gridWidth,
            height: this.gridHeight,
            floorMap: this.floorMap,
            displayFloorMap: this.displayFloorMap,
        };
    }

    // === Private methods ===

    private spawnDrop(): void {
        if (this.dropCount >= this.config.maxDrops) return;

        const i = this.dropCount++;
        const { radiusMin, radiusMax, windBase, windTurbulence, reverseGravity } = this.config;

        // Wind threshold for side-spawning (25% of max wind = ~37.5 logic px/s)
        // At strong wind, some drops should come from the windward side
        const windThreshold = 37.5;
        const absWind = Math.abs(windBase);
        const sideSpawnChance = absWind > windThreshold
            ? Math.min(0.4, (absWind - windThreshold) / 100) // 0-40% chance based on wind strength
            : 0;

        let spawnX: number;
        let spawnY: number;

        // Decide spawn location: top/bottom or side
        if (sideSpawnChance > 0 && Math.random() < sideSpawnChance) {
            // Side spawn: simulate drops that fell from above and blew in from off-screen
            // They should look identical to top-spawned drops, just entering from the side
            const spawnFromLeft = windBase > 0;

            // Spread spawns across a zone at the edge (10% of screen width)
            // This prevents the "hose" effect of all drops at one column
            const zoneWidth = Math.max(5, Math.floor(this.gridWidth * 0.1));

            if (spawnFromLeft) {
                // Find valid columns in left zone
                let validX = 0;
                for (let attempt = 0; attempt < 10; attempt++) {
                    const tryX = Math.floor(Math.random() * zoneWidth);
                    if (!this.voidMask || this.voidMask[tryX] !== 1) {
                        validX = tryX;
                        break;
                    }
                }
                spawnX = validX;
            } else {
                // Find valid columns in right zone
                let validX = this.gridWidth - 1;
                for (let attempt = 0; attempt < 10; attempt++) {
                    const tryX = this.gridWidth - 1 - Math.floor(Math.random() * zoneWidth);
                    if (!this.voidMask || this.voidMask[tryX] !== 1) {
                        validX = tryX;
                        break;
                    }
                }
                spawnX = validX;
            }

            // Spawn position depends on gravity direction
            if (reverseGravity) {
                // In reverse mode, side-spawned drops enter from below
                spawnY = this.gridHeight + 2 + Math.random() * 10;
            } else {
                // Normal mode: start above screen
                spawnY = -2 - Math.random() * 10;
            }
        } else {
            // Normal spawn (top or bottom depending on gravity)
            spawnX = Math.floor(Math.random() * this.gridWidth);

            if (reverseGravity) {
                // Spawn from bottom in reverse gravity mode
                // Use displayFloorMap for bottom spawn position (below work area)
                spawnY = this.gridHeight + 2;
                if (this.displayFloorMap) {
                    const mapFloorY = this.displayFloorMap[spawnX];
                    if (mapFloorY !== undefined && mapFloorY >= 0) {
                        spawnY = mapFloorY + 2; // Start just below the floor
                    }
                }
            } else {
                // Normal top spawn
                spawnY = -2;
                if (this.spawnMap) {
                    const mapSpawnY = this.spawnMap[spawnX];
                    if (mapSpawnY === undefined || mapSpawnY < 0) {
                        // Column is entirely void or invalid, skip spawn
                        this.dropCount--; // Revert spawn
                        return;
                    }
                    spawnY = mapSpawnY;
                }
            }
        }

        this.dropsX[i] = spawnX + Math.random(); // Add sub-pixel offset
        this.dropsY[i] = spawnY;
        this.dropsPrevX[i] = this.dropsX[i];
        this.dropsPrevY[i] = this.dropsY[i];

        // Random radius
        this.dropsRadius[i] = radiusMin + Math.random() * (radiusMax - radiusMin);

        // Initial velocity (wind-influenced horizontal + gravity direction)
        this.dropsVelX[i] = windBase + (Math.random() - 0.5) * windTurbulence;

        // Vertical velocity depends on gravity direction
        if (reverseGravity) {
            // In reverse mode, start with upward momentum
            this.dropsVelY[i] = -(200 + Math.random() * 150); // Upward momentum (-350 to -200)
        } else {
            // Normal downward momentum (200-350)
            this.dropsVelY[i] = 200 + Math.random() * 150;
        }

        // Full opacity
        this.dropsOpacity[i] = 1.0;
    }

    private stepRain(dt: number): void {
        const { gravity, windBase, slipThreshold, reverseGravity } = this.config;
        // Terminal velocity scales with gravity (default: 980 → 350 logic px/s)
        // Higher gravity = faster terminal velocity, lower gravity = slower
        // Minimum of 50 prevents zero-gravity from freezing drops
        const terminalVelocity = Math.max(50, 350 * (gravity / 980));
        // Effective gravity direction (negative when reversed)
        const effectiveGravity = reverseGravity ? -gravity : gravity;

        for (let i = 0; i < this.dropCount; i++) {
            // Store previous position for collision detection
            this.dropsPrevX[i] = this.dropsX[i]!;
            this.dropsPrevY[i] = this.dropsY[i]!;

            // Apply gravity (reversed when in reverse mode)
            this.dropsVelY[i] = this.dropsVelY[i]! + effectiveGravity * dt;

            // Cap at terminal velocity (both directions)
            if (reverseGravity) {
                if (this.dropsVelY[i]! < -terminalVelocity) {
                    this.dropsVelY[i] = -terminalVelocity;
                }
            } else {
                if (this.dropsVelY[i]! > terminalVelocity) {
                    this.dropsVelY[i] = terminalVelocity;
                }
            }

            // Apply wind (lerp toward target, faster response)
            this.dropsVelX[i] = this.dropsVelX[i]! + (windBase - this.dropsVelX[i]!) * 0.3 * dt * 60;

            // Apply turbulence (wind gusts) during flight
            if (this.config.windTurbulence > 0) {
                this.dropsVelX[i]! += (Math.random() - 0.5) * this.config.windTurbulence * dt * 3.0;
            }

            // Integrate position
            this.dropsX[i] = this.dropsX[i]! + this.dropsVelX[i]! * dt;
            this.dropsY[i] = this.dropsY[i]! + this.dropsVelY[i]! * dt;

            // Check boundaries and collisions
            if (reverseGravity) {
                // In reverse mode, drops exit at the top
                if (this.dropsY[i]! < 0) {
                    this.despawnDrop(i);
                    i--;
                    continue;
                }
            } else {
                // Normal mode: drops exit at the bottom
                if (this.dropsY[i]! >= this.gridHeight) {
                    this.despawnDrop(i);
                    i--;
                    continue;
                }
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

                    // Create water ABOVE the floor (floorY - 1) so it can settle there
                    // Water at floorY would be inside the floor boundary
                    const waterY = floorY - 1;
                    if (waterY >= 0) {
                        const waterIndex = waterY * this.gridWidth + cellX;
                        if (waterIndex >= 0 && waterIndex < this.grid.length) {
                            const impactSpeed = Math.sqrt(
                                this.dropsVelX[i]! * this.dropsVelX[i]! +
                                this.dropsVelY[i]! * this.dropsVelY[i]!
                            );
                            if (this.grid[waterIndex] === CELL_AIR) {
                                this.grid[waterIndex] = CELL_WATER;
                                this.waterDepth[waterIndex] = 1.0;
                            } else if (this.grid[waterIndex] === CELL_WATER) {
                                // Stack on existing water
                                this.waterDepth[waterIndex] = Math.min(15.0, this.waterDepth[waterIndex]! + 1.0);
                            }
                            this.waterEnergy[waterIndex] = Math.min(impactSpeed * 0.01, 0.6);
                            this.waterMomentumX[waterIndex] = Math.max(-1, Math.min(1, this.dropsVelX[i]! * 0.01));
                        }
                    }

                    this.despawnDrop(i);
                    i--;
                    continue;
                }
            }

            // SWEEP COLLISION: Check all cells between prev and current to catch fast drops
            // This prevents drops from tunneling through thin windows
            let hitCell = -1;
            let hitCellX = cellX;
            let hitCellY = cellY;
            let hitValue = cellValue;

            if (prevCellY < cellY) {
                // Falling downward - scan each row between prev and current
                for (let scanY = prevCellY + 1; scanY <= cellY; scanY++) {
                    // Interpolate X position for this Y
                    const t = (scanY - prevCellY) / (cellY - prevCellY);
                    const scanX = Math.floor(prevCellX + (cellX - prevCellX) * t);

                    if (scanX >= 0 && scanX < this.gridWidth && scanY >= 0 && scanY < this.gridHeight) {
                        const scanIndex = scanY * this.gridWidth + scanX;
                        const scanValue = this.grid[scanIndex]!;
                        if (scanValue !== CELL_AIR) {
                            hitCell = scanIndex;
                            hitCellX = scanX;
                            hitCellY = scanY;
                            hitValue = scanValue;
                            break; // Found first collision
                        }
                    }
                }
            } else if (prevCellY > cellY) {
                // Rising upward (reverse gravity) - scan each row between prev and current
                for (let scanY = prevCellY - 1; scanY >= cellY; scanY--) {
                    // Interpolate X position for this Y
                    const t = (prevCellY - scanY) / (prevCellY - cellY);
                    const scanX = Math.floor(prevCellX + (cellX - prevCellX) * t);

                    if (scanX >= 0 && scanX < this.gridWidth && scanY >= 0 && scanY < this.gridHeight) {
                        const scanIndex = scanY * this.gridWidth + scanX;
                        const scanValue = this.grid[scanIndex]!;
                        if (scanValue !== CELL_AIR) {
                            hitCell = scanIndex;
                            hitCellX = scanX;
                            hitCellY = scanY;
                            hitValue = scanValue;
                            break; // Found first collision
                        }
                    }
                }
            }

            // Use sweep result if we found a hit, otherwise use current cell
            const effectiveCellX = hitCell >= 0 ? hitCellX : cellX;
            const effectiveCellY = hitCell >= 0 ? hitCellY : cellY;
            const effectiveValue = hitCell >= 0 ? hitValue : cellValue;

            // Check for Air→Glass/Water transition
            if (effectiveValue !== CELL_AIR) {
                const prevIndex = prevCellY * this.gridWidth + prevCellX;
                const wasInAir = prevIndex < 0 || prevIndex >= this.grid.length ||
                                 this.grid[prevIndex] === CELL_AIR;

                if (wasInAir) {
                    // Determine collision surface and apply pass-through logic
                    const collision = this.resolveCollision(i, effectiveCellX, effectiveCellY, prevCellX, prevCellY, slipThreshold);

                    if (collision) {
                        // Trigger audio
                        this.triggerAudio(i, effectiveValue, collision.x, collision.y, collision.surface);

                        // Spawn splash
                        this.spawnSplash(collision.x, collision.y, this.dropsVelX[i]!, this.dropsVelY[i]!);

                        // Convert to puddle if hitting glass wall
                        // Find the ACTUAL surface position by walking from prev to current
                        if (effectiveValue === CELL_GLASS) {
                            let waterX = prevCellX;
                            let waterY = prevCellY;

                            // Find precise collision point based on surface type
                            if (collision.surface === 'top') {
                                // Walk downward from prev to find first solid cell
                                for (let y = prevCellY + 1; y <= effectiveCellY; y++) {
                                    const idx = y * this.gridWidth + effectiveCellX;
                                    if (idx >= 0 && idx < this.grid.length && this.grid[idx] !== CELL_AIR) {
                                        waterY = y - 1; // Place water just above the surface
                                        waterX = effectiveCellX; // Use collision X
                                        break;
                                    }
                                }
                            } else if (collision.surface === 'left') {
                                // Walk rightward from prev to find first solid cell
                                for (let x = prevCellX + 1; x <= effectiveCellX; x++) {
                                    const idx = effectiveCellY * this.gridWidth + x;
                                    if (idx >= 0 && idx < this.grid.length && this.grid[idx] !== CELL_AIR) {
                                        waterX = x - 1; // Place water just left of surface
                                        waterY = effectiveCellY;
                                        break;
                                    }
                                }
                            } else if (collision.surface === 'right') {
                                // Walk leftward from prev to find first solid cell
                                for (let x = prevCellX - 1; x >= effectiveCellX; x--) {
                                    const idx = effectiveCellY * this.gridWidth + x;
                                    if (idx >= 0 && idx < this.grid.length && this.grid[idx] !== CELL_AIR) {
                                        waterX = x + 1; // Place water just right of surface
                                        waterY = effectiveCellY;
                                        break;
                                    }
                                }
                            }

                            const waterIndex = waterY * this.gridWidth + waterX;
                            if (waterIndex >= 0 && waterIndex < this.grid.length) {
                                const impactSpeed = Math.sqrt(
                                    this.dropsVelX[i]! * this.dropsVelX[i]! +
                                    this.dropsVelY[i]! * this.dropsVelY[i]!
                                );
                                if (this.grid[waterIndex] === CELL_AIR) {
                                    this.grid[waterIndex] = CELL_WATER;
                                    this.waterDepth[waterIndex] = 1.0;
                                } else if (this.grid[waterIndex] === CELL_WATER) {
                                    // Stack on existing water
                                    this.waterDepth[waterIndex] = Math.min(15.0, this.waterDepth[waterIndex]! + 1.0);
                                }
                                this.waterEnergy[waterIndex] = Math.min(impactSpeed * 0.01, 0.6);
                                this.waterMomentumX[waterIndex] = Math.max(-1, Math.min(1, this.dropsVelX[i]! * 0.01));
                            }
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
        // Copy current state to buffer (double buffering for consistent reads)
        this.gridBuffer.set(this.grid);
        this.waterEnergyBuffer.set(this.waterEnergy);
        this.waterMomentumXBuffer.set(this.waterMomentumX);
        this.waterDepthBuffer.set(this.waterDepth);
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

                // Check surface type for adhesion (sitting ON vs beside wall)
                const sittingOnSurface = this.hasSupportingWall(x, y);
                const besideVerticalWall = this.hasVerticalWall(x, y);

                // Surface adhesion: water sitting ON a window top sticks more when settling
                // Only apply higher adhesion when energy is low (water is resting, not just landed)
                // High energy water (just landed) should flow/splash first
                const isSettling = energy < 0.2;
                const surfaceAdhesion = isSettling ? 0.25 : 0.08; // 25% when settling, 8% when energetic
                const effectiveAdhesion = sittingOnSurface ? surfaceAdhesion : wallAdhesion;
                if ((sittingOnSurface || besideVerticalWall) && Math.random() < effectiveAdhesion) {
                    this.waterEnergyBuffer[index] = energy * energyDecay;
                    continue;
                }

                // Get momentum for sloshing
                let momentum = this.waterMomentumX[index]!;

                // Per-tick momentum decay
                this.waterMomentumXBuffer[index] = momentum * 0.959;

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

                // === MOMENTUM SLOSH: Horizontal push from accumulated momentum ===
                if (Math.abs(momentum) > 0.15 && energy > 0.10) {
                    const pushDir = momentum > 0 ? 1 : -1;
                    const pushStrength = Math.abs(momentum);
                    if (this.tryMoveWaterWithEnergy(index, x, x + pushDir, y, energy * 0.9)) {
                        continue;
                    }
                    // High momentum + high energy = wave crest (diagonal up-push)
                    if (pushStrength > 0.4 && energy > 0.2) {
                        if (this.tryMoveWaterWithEnergy(index, x, x + pushDir, y - 1, energy * 0.7)) {
                            continue;
                        }
                    }
                }

                // === COHESION: Count nearby water for mass-based speed ===
                const nearbyMass = this.countNearbyWater(x, y);
                const massBonus = Math.min(4, Math.floor(nearbyMass / 2));

                // === GRAVITY: Try to move down (scale by gravity setting) ===
                const gravityScale = this.config.gravity / 980;
                const baseFall = Math.floor((2 + energy * 6) * gravityScale);
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
                // Independent coin flip: try both directions in random order
                // This breaks scan-order correlation
                this.debugMoveContext = 'diag';
                {
                    const tryLeft = Math.random() > 0.5;
                    const dir1 = tryLeft ? -1 : 1;
                    const dir2 = tryLeft ? 1 : -1;
                    if (this.tryMoveWaterWithEnergy(index, x, x + dir1, y + 1, energy * energyDecay + minFallEnergy * 0.5)) {
                        this.debugMoveContext = 'other';
                        continue;
                    }
                    if (this.tryMoveWaterWithEnergy(index, x, x + dir2, y + 1, energy * energyDecay + minFallEnergy * 0.5)) {
                        this.debugMoveContext = 'other';
                        continue;
                    }
                }
                this.debugMoveContext = 'other';

                // Check if water has settled (something below it OR at display floor level)
                const atFloor = this.displayFloorMap && this.displayFloorMap[x] !== undefined && y >= this.displayFloorMap[x]! - 1;
                const hasSupport = atFloor || y + 1 >= this.gridHeight ||
                    (y + 1 < this.gridHeight && this.grid[(y + 1) * this.gridWidth + x] !== CELL_AIR);

                // === VERTICAL STACKING ===
                // Before spreading, try to stack on existing water (creates thicker puddles)
                // Higher priority than horizontal spread
                if (hasSupport && energy > 0.05) {
                    const belowIndex = (y + 1) * this.gridWidth + x;
                    if (belowIndex < this.grid.length && this.grid[belowIndex] === CELL_WATER) {
                        // Water below us - increase depth instead of spreading
                        const currentDepth = this.waterDepth[index] || 1.0;
                        const belowDepth = this.waterDepthBuffer[belowIndex] || 1.0;
                        // Transfer depth downward if not at max
                        if (belowDepth < 15.0) {
                            this.waterDepthBuffer[belowIndex] = Math.min(15.0, belowDepth + currentDepth * 0.3);
                            // Reduce our depth after transfer
                            this.waterDepthBuffer[index] = currentDepth * 0.7;
                            this.waterEnergyBuffer[index] = energy * energyDecay;
                            continue; // Skip spread attempt
                        }
                    }
                }

                // === HORIZONTAL SPREAD ===
                // Spread when supported. Use probability to reduce excessive oscillation.
                // Much lower chance for thicker puddles - only spread when necessary
                const spreadChance = atFloor ? 0.04 : 0.12;
                const energyBonus = Math.min(0.15, energy * 0.3);
                if (hasSupport && Math.random() < spreadChance + energyBonus) {
                    this.debugMoveContext = 'spread';
                    let spread = false;
                    for (let dist = 1; dist <= 3 && !spread; dist++) {
                        // Fresh coin flip at each distance
                        const tryLeft = Math.random() > 0.5;
                        const dir1 = tryLeft ? -1 : 1;
                        const dir2 = tryLeft ? 1 : -1;
                        if (this.tryMoveWaterWithEnergy(index, x, x + dir1 * dist, y, energy * energyDecay)) {
                            spread = true;
                        } else if (this.tryMoveWaterWithEnergy(index, x, x + dir2 * dist, y, energy * energyDecay)) {
                            spread = true;
                        }
                    }
                    this.debugMoveContext = 'other';
                    if (spread) continue;
                }

                // No valid moves → water stays, decay energy
                // High-energy water that's completely stuck creates splash (impact spray)
                if (energy > 0.45 && Math.random() < 0.3) {
                    this.spawnPuddleSplash(x, y, energy);
                }
                this.waterEnergyBuffer[index] = Math.max(restThreshold, energy * energyDecay);
            }
        }

        // Drain puddles at floor level
        if (this.floorMap) {
            for (let x = 0; x < this.gridWidth; x++) {
                const floorY: number | undefined = this.floorMap[x];
                if (floorY === undefined || floorY >= this.gridHeight) continue;

                const index = floorY * this.gridWidth + x;
                if (this.grid[index] === CELL_WATER) {
                    // Floor drain: removes water at work area edge
                    // Lower chance (5%) for thicker puddles that linger
                    if (Math.random() < 0.05) {
                        this.gridBuffer[index] = CELL_AIR;
                        this.waterEnergyBuffer[index] = 0;
                        this.waterMomentumXBuffer[index] = 0;
                        this.waterDepthBuffer[index] = 0;
                    }
                }
            }
        }

        // DEBUG: Log movement bias every 120 frames (~2 seconds at 60Hz)
        this.debugFrameCount++;
        if (this.debugFrameCount >= 120) {
            // Count water cells for debugging
            let waterCount = 0;
            for (let i = 0; i < this.grid.length; i++) {
                if (this.grid[i] === CELL_WATER) waterCount++;
            }

            const total = this.debugLeftMoves + this.debugRightMoves;
            if (this.onDebugLog) {
                const ratio = total > 0 ? (this.debugRightMoves / Math.max(1, this.debugLeftMoves)) : 0;
                const diagRatio = this.debugDiagR / Math.max(1, this.debugDiagL);
                const spreadRatio = this.debugSpreadR / Math.max(1, this.debugSpreadL);
                // Combined log: water count + evap timer + bias stats
                this.onDebugLog(`[BiasDebug] Water: ${waterCount} | Evap: ${this.evaporationTimer.toFixed(0)}s | L/R: ${this.debugLeftMoves}/${this.debugRightMoves} (${ratio.toFixed(2)}) | Diag: ${this.debugDiagL}/${this.debugDiagR} (${diagRatio.toFixed(2)}) | Spread: ${this.debugSpreadL}/${this.debugSpreadR} (${spreadRatio.toFixed(2)})`);
            }
            this.debugLeftMoves = 0;
            this.debugRightMoves = 0;
            this.debugDownMoves = 0;
            this.debugUpMoves = 0;
            this.debugDiagL = 0;
            this.debugDiagR = 0;
            this.debugSpreadL = 0;
            this.debugSpreadR = 0;
            this.debugFrameCount = 0;
        }

        // Swap buffers (commits all moves from this frame)
        [this.grid, this.gridBuffer] = [this.gridBuffer, this.grid];
        [this.waterEnergy, this.waterEnergyBuffer] = [this.waterEnergyBuffer, this.waterEnergy];
        [this.waterMomentumX, this.waterMomentumXBuffer] = [this.waterMomentumXBuffer, this.waterMomentumX];
        [this.waterDepth, this.waterDepthBuffer] = [this.waterDepthBuffer, this.waterDepth];
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
        srcX: number,
        destX: number,
        destY: number,
        newEnergy: number
    ): boolean {
        // Bounds check
        if (destX < 0 || destX >= this.gridWidth || destY < 0 || destY >= this.gridHeight) {
            return false;
        }

        // No floor boundary check - puddles fall through work area into taskbar zone
        // They stop at CELL_VOID (display bottom) or gridHeight naturally

        const destIndex = destY * this.gridWidth + destX;
        const destCell = this.grid[destIndex]!;

        // Can only flow into air
        if (destCell !== CELL_AIR) {
            return false;
        }

        // DEBUG: Track movement direction by context
        const dx = destX - srcX;
        const srcY = Math.floor(srcIndex / this.gridWidth);
        const dy = destY - srcY;
        if (dx > 0) {
            this.debugRightMoves++;
            if (this.debugMoveContext === 'diag') this.debugDiagR++;
            else if (this.debugMoveContext === 'spread') this.debugSpreadR++;
        } else if (dx < 0) {
            this.debugLeftMoves++;
            if (this.debugMoveContext === 'diag') this.debugDiagL++;
            else if (this.debugMoveContext === 'spread') this.debugSpreadL++;
        }
        if (dy > 0) this.debugDownMoves++;
        else if (dy < 0) this.debugUpMoves++;

        // Write to buffer (double buffering for consistent reads)
        this.gridBuffer[srcIndex] = CELL_AIR;
        this.gridBuffer[destIndex] = CELL_WATER;

        // Mark destination as processed
        this.processedThisFrame[destIndex] = 1;

        // Write energy to buffer
        this.waterEnergyBuffer[srcIndex] = 0;
        this.waterEnergyBuffer[destIndex] = newEnergy;

        // Write momentum to buffer with decay
        const oldMomentum = this.waterMomentumX[srcIndex]!;
        const newMomentum = Math.max(-1, Math.min(1, oldMomentum * 0.922));
        this.waterMomentumXBuffer[srcIndex] = 0;
        this.waterMomentumXBuffer[destIndex] = newMomentum;

        // Transfer depth to destination (or merge if dest already had water)
        const srcDepth = this.waterDepth[srcIndex] || 1.0;
        const destDepth = this.waterDepthBuffer[destIndex] || 0;
        this.waterDepthBuffer[srcIndex] = 0;
        this.waterDepthBuffer[destIndex] = Math.min(15.0, srcDepth + destDepth);

        return true;
    }

    /**
     * Check if water is SITTING ON a horizontal surface (wall directly below).
     * Used for stronger adhesion on window tops vs dribble on vertical walls.
     */
    private hasSupportingWall(x: number, y: number): boolean {
        if (y < this.gridHeight - 1) {
            const cell = this.grid[(y + 1) * this.gridWidth + x]!;
            return cell === CELL_GLASS || cell === CELL_VOID;
        }
        return false;
    }

    /**
     * Check if water has vertical wall beside it (for dribble, not sitting).
     */
    private hasVerticalWall(x: number, y: number): boolean {
        if (x > 0) {
            const cell = this.grid[y * this.gridWidth + (x - 1)]!;
            if (cell === CELL_GLASS || cell === CELL_VOID) return true;
        }
        if (x < this.gridWidth - 1) {
            const cell = this.grid[y * this.gridWidth + (x + 1)]!;
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
        // Scale splash count by config.splashScale (0.5-2.0)
        const baseCount = 2 + Math.floor(Math.random() * 3);
        const count = Math.max(1, Math.round(baseCount * this.config.splashScale));
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

        // Scale splash count by config.splashScale (0.5-2.0)
        const baseCount = 1 + Math.floor(energy * 2);
        const count = Math.max(1, Math.round(baseCount * this.config.splashScale));
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

    /**
     * Displace water when a window moves into it.
     * Searches wide radius for air in ALL directions, never destroys water.
     */
    private displaceWater(x: number, y: number): void {
        const displacementEnergy = 0.55;

        // Always spawn splash for visual feedback
        this.spawnPuddleSplash(x, y, displacementEnergy);

        // Randomize left/right to prevent directional bias
        const lr = Math.random() > 0.5 ? 1 : -1;

        // Search in expanding rings up to radius 16 (ALL directions including down)
        for (let radius = 1; radius <= 16; radius++) {
            const candidates: { dx: number; dy: number }[] = [];

            // Full ring at this radius (all 4 directions)
            for (let dx = -radius; dx <= radius; dx++) {
                candidates.push({ dx: dx * lr, dy: -radius }); // Up
                candidates.push({ dx: dx * lr, dy: radius });  // Down
            }
            for (let dy = -radius + 1; dy < radius; dy++) {
                candidates.push({ dx: radius * lr, dy });      // Right
                candidates.push({ dx: -radius * lr, dy });     // Left
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
                    this.waterDepth[neighborIndex] = 1.0;
                    const pushMomentum = dx > 0 ? 0.9 : dx < 0 ? -0.9 : (Math.random() > 0.5 ? 0.5 : -0.5);
                    this.waterMomentumX[neighborIndex] = pushMomentum;
                    return;
                }
            }
        }

        // Still trapped after radius 16 - find nearest grid edge and place there
        // This ensures water is NEVER destroyed, just pushed to boundaries
        const edgeCandidates: { x: number; y: number; dist: number }[] = [];

        // Check all 4 edges for the nearest air cell
        // Top edge
        for (let ex = 0; ex < this.gridWidth; ex++) {
            if (this.grid[ex] === CELL_AIR) {
                edgeCandidates.push({ x: ex, y: 0, dist: Math.abs(ex - x) + y });
            }
        }
        // Bottom edge
        for (let ex = 0; ex < this.gridWidth; ex++) {
            const ey = this.gridHeight - 1;
            const idx = ey * this.gridWidth + ex;
            if (this.grid[idx] === CELL_AIR) {
                edgeCandidates.push({ x: ex, y: ey, dist: Math.abs(ex - x) + Math.abs(ey - y) });
            }
        }
        // Left edge
        for (let ey = 0; ey < this.gridHeight; ey++) {
            if (this.grid[ey * this.gridWidth] === CELL_AIR) {
                edgeCandidates.push({ x: 0, y: ey, dist: x + Math.abs(ey - y) });
            }
        }
        // Right edge
        for (let ey = 0; ey < this.gridHeight; ey++) {
            const ex = this.gridWidth - 1;
            const idx = ey * this.gridWidth + ex;
            if (this.grid[idx] === CELL_AIR) {
                edgeCandidates.push({ x: ex, y: ey, dist: Math.abs(ex - x) + Math.abs(ey - y) });
            }
        }

        // Sort by distance and place at nearest edge
        if (edgeCandidates.length > 0) {
            edgeCandidates.sort((a, b) => a.dist - b.dist);
            const best = edgeCandidates[0]!;
            const idx = best.y * this.gridWidth + best.x;
            this.grid[idx] = CELL_WATER;
            this.waterEnergy[idx] = displacementEnergy;
            this.waterDepth[idx] = 1.0;
            // Momentum towards center (it was pushed outward)
            this.waterMomentumX[idx] = best.x < x ? 0.5 : best.x > x ? -0.5 : 0;
            return;
        }

        // Absolute last resort: energize nearest water (rare edge case)
        for (let radius = 1; radius <= 8; radius++) {
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
        // If we get here, the grid is completely full - water is lost (shouldn't happen)
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
     * Floor-targeted evaporation - only evaporates water at or near the floor level.
     * This allows puddles to accumulate on windows while draining from the taskbar.
     * Timeline:
     *   0-30s: No evaporation (warmup, puddles accumulate)
     *   30-60s: Evaporation ramps from 0% to 100% (gentle transition)
     *   60s+: Full evaporation at floor level only
     */
    private applyEvaporation(dt: number): void {
        // Early exit if evaporation is disabled via config
        if (this.config.evaporationRate <= 0) return;

        const warmupTime = 15;  // First 15 seconds: no evaporation (shorter warmup)
        const rampTime = 20;    // Next 20 seconds: gentle ramp to full effect

        // Calculate evaporation rate based on elapsed time
        let evaporationRate = 0;
        if (this.evaporationTimer > warmupTime) {
            const rampProgress = Math.min(1, (this.evaporationTimer - warmupTime) / rampTime);
            // Drain rate 0.8x spawn rate, scaled by config evaporationRate
            evaporationRate = this.config.spawnRate * rampProgress * 0.8 * this.config.evaporationRate;
        }

        if (evaporationRate < 0.01) return;

        // Evaporate water at display floor level (inside taskbar zone)
        // This drains puddles while preserving window puddles
        if (!this.displayFloorMap) return;

        // Count floor water only (in taskbar zone)
        let floorWaterCount = 0;
        for (let x = 0; x < this.gridWidth; x++) {
            const displayFloorY: number | undefined = this.displayFloorMap[x];
            if (displayFloorY === undefined || displayFloorY >= this.gridHeight) continue;

            // Check a band just above display floor where puddles sit
            for (let dy = 1; dy <= 5; dy++) {
                const y: number = displayFloorY - dy;
                if (y < 0) continue;
                const index = y * this.gridWidth + x;
                if (this.grid[index] === CELL_WATER) floorWaterCount++;
            }
        }

        if (floorWaterCount === 0) return;

        // Calculate evaporation chance for floor water
        const particlesToEvaporate = evaporationRate * dt;
        const evaporationChance = Math.min(0.02, particlesToEvaporate / floorWaterCount);

        // Only evaporate floor water (in taskbar zone)
        for (let x = 0; x < this.gridWidth; x++) {
            const displayFloorY2: number | undefined = this.displayFloorMap[x];
            if (displayFloorY2 === undefined || displayFloorY2 >= this.gridHeight) continue;

            for (let dy = 1; dy <= 5; dy++) {
                const y2: number = displayFloorY2 - dy;
                if (y2 < 0) continue;
                const index = y2 * this.gridWidth + x;
                if (this.grid[index] === CELL_WATER && Math.random() < evaporationChance) {
                    // Reduce depth instead of removing water
                    this.waterDepth[index] = (this.waterDepth[index] || 1.0) - 1.0;
                    if (this.waterDepth[index]! <= 0) {
                        this.grid[index] = CELL_AIR;
                        this.waterEnergy[index] = 0;
                        this.waterMomentumX[index] = 0;
                        this.waterDepth[index] = 0;
                    }
                }
            }
        }
    }

    /**
     * Get current simulation stats for debug display.
     */
    getStats(): { waterCount: number; activeDrops: number; puddleCells: number; splashCount: number } {
        let waterCount = 0;
        if (this.grid) {
            for (let i = 0; i < this.grid.length; i++) {
                if (this.grid[i] === CELL_WATER) waterCount++;
            }
        }

        return {
            waterCount,
            activeDrops: this.dropCount,
            puddleCells: waterCount,  // Same as waterCount for now
            splashCount: this.splashCount,
        };
    }

    /**
     * Clean up resources.
     */
    dispose(): void {
        // TypedArrays are garbage collected, but we can help by nulling references
        // @ts-expect-error Intentional cleanup
        this.grid = this.waterEnergy = this.waterMomentumX = this.waterDepth = this.processedThisFrame = null;
        // @ts-expect-error Intentional cleanup
        this.dropsX = this.dropsY = this.dropsPrevX = this.dropsPrevY = null;
        // @ts-expect-error Intentional cleanup
        this.dropsVelX = this.dropsVelY = this.dropsRadius = this.dropsOpacity = null;
        // @ts-expect-error Intentional cleanup
        this.splashX = this.splashY = this.splashVelX = this.splashVelY = this.splashLife = null;
    }
}
