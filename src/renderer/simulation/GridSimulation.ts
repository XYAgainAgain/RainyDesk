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
    // Configuration:
    private config: SimulationConfig;

    // Grid scale (configurable: 0.25 = 1:4, 0.125 = 1:8)
    private readonly gridScale: number;
    private readonly screenScale: number; // Inverse of gridScale for converting back
    // Normalization factor for consistent screen-space visuals across grid scales
    // Config values are tuned for scale 0.25 (Normal). This factor adjusts them.
    // At 0.125 (Chunky): factor = 0.5 (smaller logic radius → same screen size)
    // At 0.5 (Detailed): factor = 2.0 (larger logic radius → same screen size)
    private readonly scaleNormFactor: number;

    // Grid dimensions (logic space)
    private readonly gridWidth: number;
    private readonly gridHeight: number;
    private readonly globalOffsetX: number;
    private readonly globalOffsetY: number;

    // Grid state (Eulerian layer)
    private grid: Uint8Array;
    private gridBuffer: Uint8Array;      // Double buffer for consistent reads
    private waterEnergy: Float32Array;
    private waterEnergyBuffer: Float32Array;
    private waterMomentumX: Float32Array;
    private waterMomentumXBuffer: Float32Array;
    private waterDepth: Float32Array;      // Water depth per cell (stacking)
    private waterDepthBuffer: Float32Array;
    private processedThisFrame: Uint8Array;

    // Void mask & spawn/floor maps
    private voidMask: Uint8Array | null = null;        // 1 = void, 0 = usable
    private spawnMap: Int16Array | null = null;        // Per-column spawn Y (-1 = no spawn)
    private originalSpawnMap: Int16Array | null = null; // Original spawn map before dynamic void
    private floorMap: Int16Array | null = null;        // Per-column splash floor Y (work area bottom)
    private displayFloorMap: Int16Array | null = null; // Per-column puddle floor Y (display bottom)

    // Rain particles (Lagrangian layer)
    private dropsX: Float32Array;
    private dropsY: Float32Array;
    private dropsPrevX: Float32Array;
    private dropsPrevY: Float32Array;
    private dropsVelX: Float32Array;
    private dropsVelY: Float32Array;
    private dropsRadius: Float32Array;
    private dropsOpacity: Float32Array;
    private dropCount = 0;

    // Splash particles
    private splashX: Float32Array;
    private splashY: Float32Array;
    private splashVelX: Float32Array;
    private splashVelY: Float32Array;
    private splashLife: Float32Array;
    private splashCount = 0;

    // Timing accumulators
    private rainAccumulator = 0;
    private puddleAccumulator = 0;
    private spawnAccumulator = 0;

    // Evaporation system
    private evaporationTimer = 0;  // Total time elapsed since simulation start

    // Splash throttling
    private splashesThisFrame = 0;
    private readonly MAX_SPLASHES_PER_FRAME = 20;

    // Puddle dirty tracking (skip GPU upload when nothing changed)
    private _puddlesDirty = true;

    // Spatial hash for drop merge (pre-allocated, zero-GC)
    private mergeHashCells: Int16Array;    // Flat bucket storage (cellCount × bucketCap)
    private mergeHashCounts: Int16Array;   // Per-cell drop count
    private mergeCellSize = 0;            // Grid units per hash cell
    private mergeGridCols = 0;            // Hash grid dimensions
    private mergeGridRows = 0;
    private readonly MERGE_BUCKET_CAP = 16; // Max drops per cell (overflow silently skipped)

    // Audio callback
    public onCollision: CollisionCallback | null = null;

    // Reusable event object (zero-GC pattern)
    private readonly collisionEvent: CollisionEvent = {
        velocity: 0,
        dropRadius: 0,
        impactAngle: 0,
        surfaceType: 'default',
        mass: 1.0,
        position: { x: 0, y: 0 },
        collisionSurface: 'top',
    };

    // Audio throttling
    private lastAudioTime = 0;
    private readonly AUDIO_MIN_INTERVAL = 8; // ms

    // DEBUG: Movement bias tracking
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
     * @param logicWidth Grid width in logic pixels
     * @param logicHeight Grid height in logic pixels
     * @param globalOffsetX X offset from global coordinate origin
     * @param globalOffsetY Y offset from global coordinate origin
     * @param config Optional configuration overrides
     * @param voidMask Optional void mask (1 = void/wall, 0 = usable)
     * @param spawnMap Optional spawn map (per-column spawn Y, -1 = no spawn)
     * @param floorMap Optional splash floor map (per-column work area bottom)
     * @param displayFloorMap Optional puddle floor map (per-column display bottom)
     * @param gridScale Grid scale factor (0.5 = 1:2, 0.25 = 1:4, 0.125 = 1:8). Default 0.25.
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
        displayFloorMap?: Int16Array,
        gridScale = 0.25
    ) {
        this.gridScale = gridScale;
        this.screenScale = 1 / gridScale; // For converting back to screen space
        // Normalization: config is tuned for 0.25 scale
        // scaleNormFactor converts screen-space intent to logic-space values
        this.scaleNormFactor = gridScale / 0.25;
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

        // Spatial hash for merge: cell size = max interaction distance
        // Max radius after merge can grow, but practical cap is ~6 at default scale.
        // Cell must be >= 2*maxPossibleRadius + mergeThreshold so neighbors cover all pairs.
        this.mergeCellSize = Math.ceil((this.config.radiusMax * 2 + 2.0) * this.scaleNormFactor * 2);
        this.mergeCellSize = Math.max(this.mergeCellSize, 8); // Floor at 8 grid units
        this.mergeGridCols = Math.ceil(this.gridWidth / this.mergeCellSize);
        this.mergeGridRows = Math.ceil(this.gridHeight / this.mergeCellSize);
        const cellCount = this.mergeGridCols * this.mergeGridRows;
        this.mergeHashCells = new Int16Array(cellCount * this.MERGE_BUCKET_CAP);
        this.mergeHashCounts = new Int16Array(cellCount);
    }

    // Public API

    /* Advance sim by delta time */
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

    /* Window zone update logic */
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

    /* Simple window rasterization! Just cells, no displacement */
    private rasterizeWindowSimple(win: WindowZone, cellType: number, grid: Uint8Array): void {
        const scale = this.gridScale;
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

        const scale = this.gridScale;
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
        // Intensity 0–1 maps to spawn rate; floor of 1% prevents silent spawn death
        // (use a layer toggle to fully disable rain, not intensity 0)
        const clamped = Number.isFinite(intensity) ? Math.max(0.01, intensity) : 0.01;
        this.config.spawnRate = clamped * 200; // 2–200 drops/sec
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
     * Get current gravity value.
     */
    getGravity(): number {
        return this.config.gravity;
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
     * Get current maximum drop radius.
     */
    getDropMaxRadius(): number {
        return this.config.radiusMax;
    }

    /**
     * Get current evaporation (puddle drain) rate.
     */
    getEvaporationRate(): number {
        return this.config.evaporationRate;
    }

    /**
     * Enable or disable reverse gravity mode.
     * @param reversed true = rain falls up, false = normal
     */
    setReverseGravity(reversed: boolean): void {
        this.config.reverseGravity = reversed;
    }

    isReverseGravity(): boolean {
        return this.config.reverseGravity;
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

    // Getters for renderer access

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
        const dirty = this._puddlesDirty;
        this._puddlesDirty = false; // Reset on read (renderer consumes it)
        return {
            data: this.grid,
            depth: this.waterDepth,
            width: this.gridWidth,
            height: this.gridHeight,
            floorMap: this.floorMap,
            displayFloorMap: this.displayFloorMap,
            dirty,
        };
    }

    // Private methods

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
            // Side spawn: drops enter from OFF-SCREEN on the windward side
            // They appear to be a natural extension of rain that was falling above/beside the visible area
            const spawnFromLeft = windBase > 0;

            // Spawn off-screen: 5-20 cells outside the visible grid
            // Spread across a zone to prevent "hose" effect
            const offscreenDistance = 5 + Math.floor(Math.random() * 15);

            if (spawnFromLeft) {
                // Wind blowing right → drops enter from left (negative X)
                spawnX = -offscreenDistance;
            } else {
                // Wind blowing left → drops enter from right (beyond gridWidth)
                spawnX = this.gridWidth + offscreenDistance;
            }

            // Distribute Y across the visible height
            // These drops have been "falling" for a while, so they can be anywhere vertically
            if (reverseGravity) {
                // Reverse: distribute from bottom up (they've been rising)
                // Cap at 90% to avoid immediate floor collisions
                spawnY = this.gridHeight * (0.3 + Math.random() * 0.6);
            } else {
                // Normal: distribute from top down (they've been falling)
                spawnY = this.gridHeight * Math.random() * 0.7;
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
                        spawnY = Math.min(this.gridHeight - 1, mapFloorY + 2);
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

        // Random radius - normalized for consistent screen-space size
        // scaleNormFactor adjusts so drops appear same size regardless of grid scale
        const normRadius = (radiusMin + Math.random() * (radiusMax - radiusMin)) * this.scaleNormFactor;
        this.dropsRadius[i] = normRadius;

        // Initial velocity - normalized for consistent screen-space speed
        // Wind and vertical velocity both scale with grid scale
        const normFactor = this.scaleNormFactor;
        this.dropsVelX[i] = (windBase + (Math.random() - 0.5) * windTurbulence) * normFactor;

        // Vertical velocity depends on gravity direction
        // Wind adds up to 50% more fall speed (windier = faster diagonal trajectory)
        const windSpeed = Math.abs(windBase) * 0.5;
        if (reverseGravity) {
            this.dropsVelY[i] = -(200 + Math.random() * 150 + windSpeed) * normFactor;
        } else {
            this.dropsVelY[i] = (200 + Math.random() * 150 + windSpeed) * normFactor;
        }

        // Full opacity
        this.dropsOpacity[i] = 1.0;
    }

    private stepRain(dt: number): void {
        const { gravity, windBase, slipThreshold, reverseGravity } = this.config;
        // Normalize gravity for consistent screen-space acceleration
        // Config gravity is tuned for scale 0.25; adjust for current scale
        const normGravity = gravity * this.scaleNormFactor;
        // Terminal velocity scales with gravity (default: 980 → 350 logic px/s at scale 0.25)
        // Also normalized for consistent screen-space speed
        const terminalVelocity = Math.max(50 * this.scaleNormFactor, 350 * (gravity / 980) * this.scaleNormFactor);
        // Effective gravity direction (negative when reversed)
        const effectiveGravity = reverseGravity ? -normGravity : normGravity;

        for (let i = 0; i < this.dropCount; i++) {
            // Store previous position for collision detection
            this.dropsPrevX[i] = this.dropsX[i]!;
            this.dropsPrevY[i] = this.dropsY[i]!;

            // Apply gravity (reversed when in reverse mode)
            // Windier conditions = slightly faster fall (wind pushes drops along)
            const normWind = windBase * this.scaleNormFactor;
            const windGravityBoost = Math.abs(normWind) * 0.3;
            this.dropsVelY[i] = this.dropsVelY[i]! + (effectiveGravity + windGravityBoost * Math.sign(effectiveGravity)) * dt;

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

            // Apply wind (lerp toward target, faster response) - reuses normWind from above
            this.dropsVelX[i] = this.dropsVelX[i]! + (normWind - this.dropsVelX[i]!) * 0.3 * dt * 60;

            // Apply turbulence (wind gusts) during flight - normalized
            if (this.config.windTurbulence > 0) {
                const normTurbulence = this.config.windTurbulence * this.scaleNormFactor;
                this.dropsVelX[i]! += (Math.random() - 0.5) * normTurbulence * dt * 3.0;
            }

            // Integrate position
            this.dropsX[i] = this.dropsX[i]! + this.dropsVelX[i]! * dt;
            this.dropsY[i] = this.dropsY[i]! + this.dropsVelY[i]! * dt;

            // Check boundaries and collisions
            if (reverseGravity) {
                // In reverse mode, drops impact the screen top (y=0) like a ceiling
                if (this.dropsY[i]! < 0) {
                    this.triggerAudio(i, CELL_GLASS, this.dropsX[i]!, 0, 'top');
                    this.spawnSplash(this.dropsX[i]!, 0, this.dropsVelX[i]!, this.dropsVelY[i]!);
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

            // Side boundary check: only despawn if moving AWAY from screen
            // Drops entering from off-screen (wind side-spawn) should survive until they drift in
            const dropX = this.dropsX[i]!;
            const velX = this.dropsVelX[i]!;
            if (dropX < 0 && velX < 0) {
                // Off left side AND moving left — will never enter, despawn
                this.despawnDrop(i);
                i--;
                continue;
            }
            if (dropX >= this.gridWidth && velX > 0) {
                // Off right side AND moving right — will never enter, despawn
                this.despawnDrop(i);
                i--;
                continue;
            }
            // Also despawn if WAY off-screen (fell off one side, blew off the other)
            if (dropX < -50 || dropX >= this.gridWidth + 50) {
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

            // Floor collision: check if we've hit the work area boundary (taskbar)
            // Only in normal gravity — in reverse gravity, the taskbar is the spawn
            // side so drops shouldn't collide with it. Screen-top impacts are handled above.
            if (this.floorMap && !reverseGravity) {
                const floorY = this.floorMap[cellX];
                if (floorY !== undefined) {
                    const hitFloor = cellY >= floorY && this.dropsPrevY[i]! < floorY;

                    if (hitFloor) {
                        this.triggerAudio(i, CELL_GLASS, this.dropsX[i]!, floorY, 'top');
                        this.spawnSplash(this.dropsX[i]!, floorY, this.dropsVelX[i]!, this.dropsVelY[i]!);

                        // Place water just above the floor
                        const waterY = floorY - 1;
                        if (waterY >= 0 && waterY < this.gridHeight) {
                            const waterIndex = waterY * this.gridWidth + cellX;
                            if (waterIndex >= 0 && waterIndex < this.grid.length) {
                                const impactSpeed = Math.sqrt(
                                    this.dropsVelX[i]! * this.dropsVelX[i]! +
                                    this.dropsVelY[i]! * this.dropsVelY[i]!
                                );
                                const dropRadius = this.dropsRadius[i]!;
                                const depthGain = 1.0 + (dropRadius * dropRadius * dropRadius) * 2.0;
                                if (this.grid[waterIndex] === CELL_AIR) {
                                    this.grid[waterIndex] = CELL_WATER;
                                    this.waterDepth[waterIndex] = Math.min(15.0, depthGain);
                                } else if (this.grid[waterIndex] === CELL_WATER) {
                                    this.waterDepth[waterIndex] = Math.min(15.0, this.waterDepth[waterIndex]! + depthGain);
                                }
                                this.waterEnergy[waterIndex] = Math.min(impactSpeed * 0.01, 0.6);
                                this.waterMomentumX[waterIndex] = Math.max(-1, Math.min(1, this.dropsVelX[i]! * 0.01));
                                this._puddlesDirty = true;
                            }
                        }

                        this.despawnDrop(i);
                        i--;
                        continue;
                    }
                }
            }

            // Reverse gravity: skip collisions in the taskbar zone.
            // Drops spawn below the taskbar and must pass through it upward,
            // mirroring the normal-gravity floorMap skip above.
            if (this.floorMap && reverseGravity) {
                const floorY = this.floorMap[cellX];
                if (floorY !== undefined && cellY >= floorY) {
                    // Still in the taskbar zone — let the drop keep rising
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
                const wasInAir = prevCellX < 0 || prevCellX >= this.gridWidth ||
                                 prevCellY < 0 || prevCellY >= this.gridHeight ||
                                 this.grid[prevCellY * this.gridWidth + prevCellX] === CELL_AIR;

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
                            } else if (collision.surface === 'bottom') {
                                // Walk upward from prev to find first solid cell
                                for (let y = prevCellY - 1; y >= effectiveCellY; y--) {
                                    const idx = y * this.gridWidth + effectiveCellX;
                                    if (idx >= 0 && idx < this.grid.length && this.grid[idx] !== CELL_AIR) {
                                        waterY = y + 1; // Place water just below the surface
                                        waterX = effectiveCellX;
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
                                // Mass-based depth: larger drops = more depth (r^3 scaling)
                                const dropRadius = this.dropsRadius[i]!;
                                const depthGain = 1.0 + (dropRadius * dropRadius * dropRadius) * 2.0;
                                if (this.grid[waterIndex] === CELL_AIR) {
                                    this.grid[waterIndex] = CELL_WATER;
                                    this.waterDepth[waterIndex] = Math.min(15.0, depthGain);
                                } else if (this.grid[waterIndex] === CELL_WATER) {
                                    // Stack on existing water
                                    this.waterDepth[waterIndex] = Math.min(15.0, this.waterDepth[waterIndex]! + depthGain);
                                }
                                this.waterEnergy[waterIndex] = Math.min(impactSpeed * 0.01, 0.6);
                                this.waterMomentumX[waterIndex] = Math.max(-1, Math.min(1, this.dropsVelX[i]! * 0.01));
                                this._puddlesDirty = true;

                                // Large drops spread horizontally (radius > 1.0)
                                const spreadRadius = Math.min(3, Math.floor(dropRadius));
                                if (spreadRadius > 0) {
                                    const spreadDepth = depthGain * 0.4; // Spread cells get 40% depth
                                    for (let dx = -spreadRadius; dx <= spreadRadius; dx++) {
                                        if (dx === 0) continue;
                                        const spreadX = waterX + dx;
                                        if (spreadX < 0 || spreadX >= this.gridWidth) continue;
                                        const spreadIdx = waterY * this.gridWidth + spreadX;
                                        if (spreadIdx < 0 || spreadIdx >= this.grid.length) continue;
                                        if (this.grid[spreadIdx] === CELL_AIR) {
                                            this.grid[spreadIdx] = CELL_WATER;
                                            this.waterDepth[spreadIdx] = Math.min(15.0, spreadDepth);
                                        } else if (this.grid[spreadIdx] === CELL_WATER) {
                                            this.waterDepth[spreadIdx] = Math.min(15.0, this.waterDepth[spreadIdx]! + spreadDepth * 0.5);
                                        }
                                    }
                                }
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
     * Uses spatial hashing — O(n) rebuild + O(n*k) neighbor checks instead of O(n^2).
     */
    private mergeNearbyDrops(): void {
        if (this.dropCount < 2) return;

        const mergeThreshold = 2.0 * this.scaleNormFactor;
        const cols = this.mergeGridCols;
        const rows = this.mergeGridRows;
        const cellSize = this.mergeCellSize;
        const cap = this.MERGE_BUCKET_CAP;
        const cells = this.mergeHashCells;
        const counts = this.mergeHashCounts;

        // Clear bucket counts (single typed array fill — fast)
        counts.fill(0);

        // Insert all drops into spatial hash
        for (let i = 0; i < this.dropCount; i++) {
            const cx = Math.min(((this.dropsX[i]! / cellSize) | 0), cols - 1);
            const cy = Math.min(((this.dropsY[i]! / cellSize) | 0), rows - 1);
            const ci = (cx < 0 ? 0 : cx) + (cy < 0 ? 0 : cy) * cols;
            const n = counts[ci]!;
            if (n < cap) {
                cells[ci * cap + n] = i;
                counts[ci] = n + 1;
            }
        }

        // Check each cell + its right/below/diagonal neighbors (avoids double-checking)
        // Offsets: self, right, below-left, below, below-right
        const neighborDx = [0, 1, -1, 0, 1];
        const neighborDy = [0, 0,  1, 1, 1];

        for (let cy = 0; cy < rows; cy++) {
            for (let cx = 0; cx < cols; cx++) {
                const ci = cx + cy * cols;
                const countA = counts[ci]!;
                if (countA === 0) continue;

                for (let ni = 0; ni < 5; ni++) {
                    const nx = cx + neighborDx[ni]!;
                    const ny = cy + neighborDy[ni]!;
                    if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
                    const nci = nx + ny * cols;
                    const countB = counts[nci]!;
                    if (countB === 0) continue;

                    const offsetA = ci * cap;
                    const offsetB = nci * cap;
                    // Same cell: triangular iteration; different cells: full cross
                    const sameCell = (ni === 0);

                    for (let a = 0; a < countA; a++) {
                        const i = cells[offsetA + a]!;
                        if (i < 0) continue; // Merged away
                        const x1 = this.dropsX[i]!;
                        const y1 = this.dropsY[i]!;
                        const r1 = this.dropsRadius[i]!;

                        const bStart = sameCell ? a + 1 : 0;
                        for (let b = bStart; b < countB; b++) {
                            const j = cells[offsetB + b]!;
                            if (j < 0 || j === i) continue; // Merged away or self

                            const dx = this.dropsX[j]! - x1;
                            const dy = this.dropsY[j]! - y1;
                            const distSq = dx * dx + dy * dy;
                            const touchDist = r1 + this.dropsRadius[j]! + mergeThreshold;

                            if (distSq < touchDist * touchDist) {
                                // Merge j into i (mass-weighted)
                                const r2 = this.dropsRadius[j]!;
                                const m1 = r1 * r1 * r1;
                                const m2 = r2 * r2 * r2;
                                const totalMass = m1 + m2;

                                this.dropsRadius[i] = Math.cbrt(totalMass);
                                this.dropsX[i] = (x1 * m1 + this.dropsX[j]! * m2) / totalMass;
                                this.dropsY[i] = (y1 * m1 + this.dropsY[j]! * m2) / totalMass;
                                this.dropsVelX[i] = (this.dropsVelX[i]! * m1 + this.dropsVelX[j]! * m2) / totalMass;
                                this.dropsVelY[i] = (this.dropsVelY[i]! * m1 + this.dropsVelY[j]! * m2) / totalMass;

                                // Mark j as merged in hash (-1 sentinel)
                                cells[offsetB + b] = -1;
                                this.despawnDrop(j);

                                // despawnDrop swaps last drop into j's slot. If that drop is
                                // in our hash, its index is now j instead of dropCount.
                                // Update the hash entry so we don't miss or double-process it.
                                const swapped = this.dropCount; // After despawn, this is the old last index
                                if (swapped !== j) {
                                    // Find swapped drop in hash and update its index
                                    const scx = Math.min(((this.dropsX[j]! / cellSize) | 0), cols - 1);
                                    const scy = Math.min(((this.dropsY[j]! / cellSize) | 0), rows - 1);
                                    const sci = (scx < 0 ? 0 : scx) + (scy < 0 ? 0 : scy) * cols;
                                    const sOffset = sci * cap;
                                    const sCount = counts[sci]!;
                                    for (let s = 0; s < sCount; s++) {
                                        if (cells[sOffset + s] === swapped) {
                                            cells[sOffset + s] = j;
                                            break;
                                        }
                                    }
                                }

                                // Refresh r1 for subsequent checks against i
                                break; // Re-scan neighbors for i on next tick
                            }
                        }
                    }
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
    ): { x: number; y: number; surface: 'top' | 'left' | 'right' | 'bottom' } | null {
        const vx = this.dropsVelX[dropIndex]!;
        const vy = this.dropsVelY[dropIndex]!;
        const speed = Math.sqrt(vx * vx + vy * vy);
        const horizontalRatio = Math.abs(vx) / (speed + 0.001);

        const enteredFromAbove = prevCellY < cellY;
        const enteredFromBelow = prevCellY > cellY;
        const enteredFromLeft = prevCellX < cellX;
        const enteredFromRight = prevCellX > cellX;

        // Top collision (normal gravity: drop hits top of window)
        if (enteredFromAbove && vy > 0) {
            // Pass-through check: if moving very horizontally, slip under
            if (horizontalRatio >= slipThreshold) {
                return null; // Slip under
            }
            return { x: this.dropsX[dropIndex]!, y: cellY, surface: 'top' };
        }

        // Bottom collision (reverse gravity: drop hits underside of window)
        if (enteredFromBelow && vy < 0) {
            if (horizontalRatio >= slipThreshold) {
                return null; // Slip past
            }
            return { x: this.dropsX[dropIndex]!, y: cellY + 1, surface: 'bottom' };
        }

        // Left side collision
        if (enteredFromLeft && vx > 0) {
            return { x: cellX, y: this.dropsY[dropIndex]!, surface: 'left' };
        }

        // Right side collision
        if (enteredFromRight && vx < 0) {
            return { x: cellX + 1, y: this.dropsY[dropIndex]!, surface: 'right' };
        }

        // No valid collision (edge case)
        return null;
    }

    private stepPuddles(_dt: number): void {
        // Copy current state to buffer (double buffering for consistent reads)
        this.gridBuffer.set(this.grid);
        this.waterEnergyBuffer.set(this.waterEnergy);
        this.waterMomentumXBuffer.set(this.waterMomentumX);
        this.waterDepthBuffer.set(this.waterDepth);
        this.processedThisFrame.fill(0);

        const energyDecay = 0.95;
        const restThreshold = 0.02;     // Very low threshold - water almost always flows
        const minFallEnergy = 0.05;     // Energy boost on fall
        const baseEnergy = 0.05;        // Minimum energy water always has (for gravity)

        // Gravity direction: +1 = down (normal), -1 = up (reverse)
        const gravDir = this.config.reverseGravity ? -1 : 1;

        // Scan order: process cells starting from the gravity-target side
        // Normal: bottom-up (so water below is processed first)
        // Reverse: top-down (so water above is processed first)
        const yStart = this.config.reverseGravity ? 1 : this.gridHeight - 2;
        const yEnd = this.config.reverseGravity ? this.gridHeight : -1;
        const yStep = this.config.reverseGravity ? 1 : -1;

        for (let y = yStart; y !== yEnd; y += yStep) {
            // Alternate scan direction by row (FLIPPED to test bias direction)
            const scanLeft = y % 2 !== 0;
            const startX = scanLeft ? 0 : this.gridWidth - 1;
            const endX = scanLeft ? this.gridWidth : -1;
            const stepX = scanLeft ? 1 : -1;

            for (let x = startX; x !== endX; x += stepX) {
                const index = y * this.gridWidth + x;
                if (this.grid[index] !== CELL_WATER) continue;

                // Water exists, so the puddle grid needs a GPU re-upload
                this._puddlesDirty = true;

                // Skip cells already processed this frame (prevents cascade bugs)
                if (this.processedThisFrame[index]) continue;

                // Ensure minimum energy so water always tries to flow
                let energy = Math.max(baseEnergy, this.waterEnergy[index]!);

                // Check surface type for adhesion (only on WINDOW surfaces, not floor)
                const sittingOnWindow = this.hasSupportingWall(x, y);
                const besideVerticalWall = this.hasVerticalWall(x, y);

                // Adhesion only applies to window surfaces - floor water flows freely
                // This creates the "puddle on window top" effect without slowing floor puddles
                if (sittingOnWindow || besideVerticalWall) {
                    const isSettling = energy < 0.2;
                    const surfaceAdhesion = isSettling ? 0.08 : 0.02; // Window tops
                    const verticalAdhesion = 0.01; // Vertical walls - fast dribble
                    const effectiveAdhesion = sittingOnWindow ? surfaceAdhesion : verticalAdhesion;
                    if (Math.random() < effectiveAdhesion) {
                        this.waterEnergyBuffer[index] = energy * energyDecay;
                        continue;
                    }
                }

                // Get momentum for sloshing
                let momentum = this.waterMomentumX[index]!;

                // Per-tick momentum decay
                this.waterMomentumXBuffer[index] = momentum * 0.97;

                // BOUNCE: If high energy, try to move against gravity
                if (energy > 0.4 && Math.random() < energy * 0.5) {
                    if (this.tryMoveWaterWithEnergy(index, x, x, y - gravDir, energy * 0.4)) {
                        continue;
                    }
                    // Bounce failed (blocked), convert some energy to horizontal
                    const bounceDir = Math.random() > 0.5 ? 1 : -1;
                    if (this.tryMoveWaterWithEnergy(index, x, x + bounceDir, y - gravDir, energy * 0.3)) {
                        continue;
                    }
                    // Bounce completely blocked - spawn splash!
                    if (energy > 0.5) {
                        this.spawnPuddleSplash(x, y, energy);
                    }
                }

                // MOMENTUM SLOSH: Horizontal push from accumulated momentum
                if (Math.abs(momentum) > 0.08 && energy > 0.10) {
                    const pushDir = momentum > 0 ? 1 : -1;
                    const pushStrength = Math.abs(momentum);
                    if (this.tryMoveWaterWithEnergy(index, x, x + pushDir, y, energy * 0.9)) {
                        continue;
                    }
                    // High momentum + high energy = wave crest (diagonal against-gravity push)
                    if (pushStrength > 0.15 && energy > 0.2) {
                        if (this.tryMoveWaterWithEnergy(index, x, x + pushDir, y - gravDir, energy * 0.7)) {
                            continue;
                        }
                    }
                }

                // COHESION: Count nearby water for mass-based speed
                const nearbyMass = this.countNearbyWater(x, y);
                const massBonus = Math.min(4, Math.floor(nearbyMass / 2));

                // GRAVITY: Try to move in gravity direction
                // Normalized for consistent screen-space puddle flow across grid scales
                const gravityScale = this.config.gravity / 980;
                const baseFall = Math.floor((2 + energy * 6) * gravityScale * this.scaleNormFactor);
                const fallDist = Math.min(12, baseFall + massBonus);
                let fell = false;
                for (let dy = fallDist; dy >= 1; dy--) {
                    if (this.tryMoveWaterWithEnergy(index, x, x, y + dy * gravDir, energy * energyDecay + minFallEnergy)) {
                        fell = true;
                        break;
                    }
                }
                if (fell) continue;

                // DIAGONAL DOWN (wall-aware dribble)
                // Only attempt diagonal on ~50% of frames to prevent 45-degree gliding.
                // Water should dribble/drip, not slide. Energy decays without bonus
                // so diagonal movement naturally stops after a few cells.
                this.debugMoveContext = 'diag';
                if (Math.random() < 0.5) {
                    // Check for walls on each side
                    const wallLeft = x > 0 && (this.grid[y * this.gridWidth + (x - 1)] === CELL_GLASS || this.grid[y * this.gridWidth + (x - 1)] === CELL_VOID);
                    const wallRight = x < this.gridWidth - 1 && (this.grid[y * this.gridWidth + (x + 1)] === CELL_GLASS || this.grid[y * this.gridWidth + (x + 1)] === CELL_VOID);

                    // Determine preferred direction: away from wall, or random if no wall
                    let preferredDir: number;
                    if (wallLeft && !wallRight) {
                        preferredDir = 1;  // Wall on left, go right
                    } else if (wallRight && !wallLeft) {
                        preferredDir = -1; // Wall on right, go left
                    } else {
                        preferredDir = Math.random() > 0.5 ? -1 : 1; // No wall or both, random
                    }

                    // Diagonal moves decay energy with no bonus — prevents perpetual gliding
                    if (this.tryMoveWaterWithEnergy(index, x, x + preferredDir, y + gravDir, energy * energyDecay * 0.8)) {
                        this.debugMoveContext = 'other';
                        continue;
                    }
                    if (this.tryMoveWaterWithEnergy(index, x, x - preferredDir, y + gravDir, energy * energyDecay * 0.8)) {
                        this.debugMoveContext = 'other';
                        continue;
                    }
                }
                this.debugMoveContext = 'other';

                // Check if water has settled (something in gravity direction OR at display floor level)
                const gravTargetY = y + gravDir;
                const atFloor = this.displayFloorMap && this.displayFloorMap[x] !== undefined &&
                    (this.config.reverseGravity ? y <= this.displayFloorMap[x]! + 1 : y >= this.displayFloorMap[x]! - 1);
                const hasSupport = atFloor || gravTargetY < 0 || gravTargetY >= this.gridHeight ||
                    (gravTargetY >= 0 && gravTargetY < this.gridHeight && this.grid[gravTargetY * this.gridWidth + x] !== CELL_AIR);

                // VERTICAL STACKING (COHESION)
                // Water WANTS to merge with other water - transfer in gravity direction
                if (hasSupport) {
                    const belowIndex = gravTargetY * this.gridWidth + x;
                    if (belowIndex >= 0 && belowIndex < this.grid.length && this.grid[belowIndex] === CELL_WATER) {
                        const currentDepth = this.waterDepth[index] || 1.0;
                        const belowDepth = this.waterDepthBuffer[belowIndex] || 1.0;
                        if (belowDepth < 15.0) {
                            // Transfer 80% of depth DOWN - water wants to merge!
                            const transfer = currentDepth * 0.8;
                            this.waterDepthBuffer[belowIndex] = Math.min(15.0, belowDepth + transfer);
                            this.waterDepthBuffer[index] = currentDepth - transfer;
                            // If we transferred most of our depth, we might evaporate
                            if (this.waterDepthBuffer[index]! < 0.5) {
                                this.gridBuffer[index] = CELL_AIR;
                                this.waterDepthBuffer[index] = 0;
                                this.waterEnergyBuffer[index] = 0;
                            } else {
                                this.waterEnergyBuffer[index] = energy * energyDecay;
                            }
                            continue;
                        }
                    }
                }

                // COHESION-BASED HORIZONTAL SPREAD
                // Only spread if we have enough depth - thin water stays put and builds up
                const currentDepth = this.waterDepth[index] || 1.0;
                const depthThreshold = atFloor ? 2.5 : 1.5; // Lower threshold for more active spreading
                const baseSpreadChance = atFloor ? 0.04 : 0.06; // Higher chance for more visible spreading
                const depthBonus = currentDepth > depthThreshold ? (currentDepth - depthThreshold) * 0.03 : 0;

                if (hasSupport && currentDepth > depthThreshold && Math.random() < baseSpreadChance + depthBonus) {
                    this.debugMoveContext = 'spread';

                    // Use weaker cohesion at floor level to reduce runaway accumulation
                    // Floor puddles should still seek lowest point but not aggressively hoard
                    const rawCohesion = this.findCohesionDirection(x, y);
                    const cohesionDir = (atFloor && Math.random() < 0.5) ? 0 : rawCohesion;
                    let spread = false;

                    // Spread distance scales with scaleNormFactor for consistent screen-space behavior
                    const maxSpreadDist = Math.max(2, Math.round(3 * this.scaleNormFactor));
                    for (let dist = 1; dist <= maxSpreadDist && !spread; dist++) {
                        if (cohesionDir !== 0) {
                            // Flow toward other water mass (cohesion!)
                            if (this.tryMoveWaterWithEnergy(index, x, x + cohesionDir * dist, y, energy * energyDecay)) {
                                spread = true;
                            }
                        } else {
                            // No cohesion preference, try both directions
                            const tryLeft = Math.random() > 0.5;
                            const dir1 = tryLeft ? -1 : 1;
                            if (this.tryMoveWaterWithEnergy(index, x, x + dir1 * dist, y, energy * energyDecay)) {
                                spread = true;
                            } else if (this.tryMoveWaterWithEnergy(index, x, x - dir1 * dist, y, energy * energyDecay)) {
                                spread = true;
                            }
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

        // Drain puddles at floor level (only if evaporation is enabled)
        if (this.floorMap && this.config.evaporationRate > 0) {
            for (let x = 0; x < this.gridWidth; x++) {
                const floorY: number | undefined = this.floorMap[x];
                if (floorY === undefined || floorY >= this.gridHeight) continue;

                const index = floorY * this.gridWidth + x;
                if (this.grid[index] === CELL_WATER) {
                    // Floor drain: removes water at work area edge
                    // Scaled by evaporation rate (0.5% base × rate)
                    if (Math.random() < 0.005 * this.config.evaporationRate) {
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

    /**
     * Find direction toward largest nearby water mass (cohesion).
     * Water flows toward other water - this is the primary behavior of real water.
     * Returns -1 (left), 0 (no preference), or 1 (right).
     */
    private findCohesionDirection(x: number, y: number): number {
        const searchRadius = 3;
        let leftMass = 0;
        let rightMass = 0;

        for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= this.gridHeight) continue;

            for (let dx = 1; dx <= searchRadius; dx++) {
                // Check left
                const lx = x - dx;
                if (lx >= 0) {
                    const lIdx = ny * this.gridWidth + lx;
                    if (this.grid[lIdx] === CELL_WATER) {
                        // Weight by depth AND proximity (closer = stronger pull)
                        const depth = this.waterDepth[lIdx] || 1.0;
                        leftMass += depth * (searchRadius - dx + 1);
                    }
                }

                // Check right
                const rx = x + dx;
                if (rx < this.gridWidth) {
                    const rIdx = ny * this.gridWidth + rx;
                    if (this.grid[rIdx] === CELL_WATER) {
                        const depth = this.waterDepth[rIdx] || 1.0;
                        rightMass += depth * (searchRadius - dx + 1);
                    }
                }
            }
        }

        const diff = rightMass - leftMass;
        if (diff > 1) return 1;   // Flow right toward larger mass
        if (diff < -1) return -1; // Flow left toward larger mass
        return 0;
    }

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
        const newMomentum = Math.max(-1, Math.min(1, oldMomentum * 0.97));
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
        const checkY = this.config.reverseGravity ? y - 1 : y + 1;
        if (checkY >= 0 && checkY < this.gridHeight) {
            const cell = this.grid[checkY * this.gridWidth + x]!;
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
        // Splashes affected by gravity - normalized for consistent screen-space acceleration
        const baseGravity = this.config.gravity * 0.5 * this.scaleNormFactor;
        const gravity = this.config.reverseGravity ? -baseGravity : baseGravity;

        for (let i = 0; i < this.splashCount; i++) {
            // Apply gravity (respects reverse gravity direction)
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

            // Spray away from surface (flips direction in reverse gravity)
            const baseAngle = this.config.reverseGravity ? Math.PI / 2 : -Math.PI / 2;
            const angle = baseAngle + (Math.random() - 0.5) * Math.PI * 0.8;
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
        // Convert grid energy to splash speed (energy 0.5 → ~60 speed at scale 0.25)
        // Normalized for consistent screen-space splash velocity
        const baseSpeed = energy * 120 * this.scaleNormFactor;

        for (let j = 0; j < count; j++) {
            if (this.splashCount >= this.config.maxSplashes) break;
            if (this.splashesThisFrame >= this.MAX_SPLASHES_PER_FRAME) break;

            const i = this.splashCount++;
            this.splashesThisFrame++;
            this.splashX[i] = x;
            this.splashY[i] = y;

            // Random spray direction (away from surface, wider spread than raindrop splashes)
            const baseAngle = this.config.reverseGravity ? Math.PI / 2 : -Math.PI / 2;
            const angle = baseAngle + (Math.random() - 0.5) * Math.PI * 1.2;
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
        const displacementEnergy = 0.7; // Higher energy for more slosh
        const originalIndex = y * this.gridWidth + x;

        // Preserve original depth - this is the key to not losing water mass!
        const originalDepth = this.waterDepth[originalIndex] || 1.0;
        this.waterDepth[originalIndex] = 0; // Clear source depth

        // Always spawn splash for visual feedback (scaled by depth)
        this.spawnPuddleSplash(x, y, displacementEnergy * Math.min(2, originalDepth / 5));

        // Randomize left/right to prevent directional bias
        const lr = Math.random() > 0.5 ? 1 : -1;

        // Helper to place water at destination with preserved depth and ACCUMULATED momentum
        const placeWater = (nx: number, ny: number, dx: number, dy: number): boolean => {
            const neighborIndex = ny * this.gridWidth + nx;
            if (this.grid[neighborIndex] === CELL_AIR) {
                this.grid[neighborIndex] = CELL_WATER;
                // More energy when falling down (gravity assist)
                this.waterEnergy[neighborIndex] = displacementEnergy + (dy > 0 ? 0.15 : 0);
                this.waterDepth[neighborIndex] = originalDepth; // PRESERVE DEPTH!
                // Strong momentum in push direction
                const pushMomentum = dx > 0 ? 0.95 : dx < 0 ? -0.95 : (Math.random() > 0.5 ? 0.3 : -0.3);
                this.waterMomentumX[neighborIndex] = pushMomentum;
                return true;
            }
            return false;
        };

        // Helper to merge into existing water (adds depth AND momentum)
        const mergeWater = (nx: number, ny: number, dx: number): boolean => {
            const neighborIndex = ny * this.gridWidth + nx;
            if (this.grid[neighborIndex] === CELL_WATER) {
                // ADD depth to existing water - mass is conserved!
                this.waterDepth[neighborIndex] = Math.min(15.0, (this.waterDepth[neighborIndex] || 1.0) + originalDepth);
                this.waterEnergy[neighborIndex] = Math.min(1.0, (this.waterEnergy[neighborIndex] || 0) + displacementEnergy * 0.7);
                // ACCUMULATE momentum - this creates the slosh wave!
                const pushMomentum = dx > 0 ? 0.7 : dx < 0 ? -0.7 : 0;
                this.waterMomentumX[neighborIndex] = Math.max(-1, Math.min(1, (this.waterMomentumX[neighborIndex] || 0) + pushMomentum));
                return true;
            }
            return false;
        };

        // PRIORITY 1: Check DIRECTLY BELOW first (no shuffle - gravity always wins)
        for (let dy = 1; dy <= 4; dy++) {
            const ny = y + dy;
            if (ny >= this.gridHeight) break;
            // Check center, then left/right
            for (const dx of [0, -1 * lr, 1 * lr]) {
                const nx = x + dx;
                if (nx < 0 || nx >= this.gridWidth) continue;
                if (placeWater(nx, ny, dx, dy)) return;
            }
        }

        // PRIORITY 2: Sideways at same level or slightly below (for slosh effect)
        for (let dist = 1; dist <= 6; dist++) {
            // Slight downward bias
            for (const dy of [1, 0, 2]) {
                const ny = y + dy;
                if (ny < 0 || ny >= this.gridHeight) continue;
                // Try both directions with random preference
                const dir1 = lr;
                const dir2 = -lr;
                for (const dir of [dir1, dir2]) {
                    const nx = x + dist * dir;
                    if (nx < 0 || nx >= this.gridWidth) continue;
                    if (placeWater(nx, ny, dist * dir, dy)) return;
                }
            }
        }

        // PRIORITY 3: Wider search including upward (radius 5-16)
        for (let radius = 5; radius <= 16; radius++) {
            const candidates: { dx: number; dy: number }[] = [];

            // Downward first, then sideways, then upward
            for (let dx = -radius; dx <= radius; dx++) {
                candidates.push({ dx: dx * lr, dy: radius });  // Down
            }
            for (let dy = -radius + 1; dy < radius; dy++) {
                candidates.push({ dx: radius * lr, dy });
                candidates.push({ dx: -radius * lr, dy });
            }
            for (let dx = -radius; dx <= radius; dx++) {
                candidates.push({ dx: dx * lr, dy: -radius }); // Up (last resort)
            }

            // Light shuffle to prevent patterns but preserve general priority
            for (let i = candidates.length - 1; i > candidates.length / 2; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
            }

            for (const { dx, dy } of candidates) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || nx >= this.gridWidth || ny < 0 || ny >= this.gridHeight) continue;
                if (placeWater(nx, ny, dx, dy)) return;
            }
        }

        // Still trapped after radius 16 in air - try to MERGE into nearby water (local only, no teleportation)
        // This conserves mass while preventing grid-wide teleportation
        for (let radius = 1; radius <= 8; radius++) {
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || nx >= this.gridWidth || ny < 0 || ny >= this.gridHeight) continue;

                    if (mergeWater(nx, ny, dx)) return; // Merges depth, conserves mass locally
                }
            }
        }

        // Truly trapped with no nearby air or water - convert to splash particles
        // This only happens when area is completely blocked (rare)
        const splashEnergy = displacementEnergy * Math.min(3, originalDepth / 3);
        this.spawnPuddleSplash(x, y, splashEnergy);
    }

    private triggerAudio(
        dropIndex: number,
        gridValue: number,
        impactX: number,
        impactY: number,
        collisionSurface: 'top' | 'left' | 'right' | 'bottom'
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

        // Scale to screen space
        const speedScreen = speed * this.screenScale;
        const radiusScreen = radius * this.screenScale;

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
        evt.position.x = impactX * this.screenScale;
        evt.position.y = impactY * this.screenScale;
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
        // @ts-expect-error Intentional cleanup
        this.mergeHashCells = this.mergeHashCounts = null;
    }
}
