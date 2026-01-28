/**
 * RainyDesk Physics System
 * Matter.js-based physics for enhanced rain simulation
 */

import Matter from 'https://cdn.skypack.dev/matter-js@0.20.0';

class RainPhysicsSystem {
  constructor(width, height, scaleFactor = 1.0) {
    // Display (screen) dimensions
    this.displayWidth = width;
    this.displayHeight = height;

    // Scale factor for pixelated rendering (0.25 = 25% resolution)
    this.scaleFactor = scaleFactor;

    // Physics dimensions (scaled down)
    this.width = Math.floor(width * scaleFactor);
    this.height = Math.floor(height * scaleFactor);
    this.floorY = this.height; // Default floor to bottom of physics space

    // Audio system (set externally via setAudioSystem)
    this.audioSystem = null;

    // Create Matter.js engine
    this.engine = Matter.Engine.create({
      gravity: { x: 0, y: 0.98 } // 980/1000 for realistic rain fall
    });

    // Physics configuration
    this.config = {
      gravity: 980,
      wind: 0,
      airResistance: 0.02,
      dropDensity: 0.001,
      dropFriction: 0,
      dropFrictionAir: 0.05, // Increased air resistance = slower fall
      dropRestitution: 0.0, // No bounce - rain splashes instead
      terminalVelocity: 400 // Reduced max fall speed
    };

    // Particle tracking
    this.raindrops = [];
    this.splashParticles = [];

    // Window exclusion zones (for collision detection, in physics space)
    this.windowZones = [];

    // No ground body needed - using position-based removal instead

    console.log(`Physics system initialized at ${this.width}x${this.height} (${scaleFactor * 100}% scale)`);
  }

  /**
   * Get display scale factor for rendering (inverse of physics scale)
   * Used by renderer to upscale from physics coords to screen coords
   */
  getDisplayScale() {
    return 1 / this.scaleFactor;
  }

  /**
   * Get the physics scale factor
   */
  getScaleFactor() {
    return this.scaleFactor;
  }

  /**
   * Create a raindrop body
   * x, y should be in screen coordinates (will be scaled to physics space)
   */
  createRaindrop(x, y, mass = 1) {
    // Scale position from screen space to physics space
    const scaledX = x * this.scaleFactor;
    const scaledY = y * this.scaleFactor;

    // Calculate base radius (unscaled) - used for audio calculations
    const baseRadius = 2 + (mass * 3);
    // Scale radius for physics/rendering space
    const radius = baseRadius * this.scaleFactor;
    const length = radius * (4 + Math.random() * 4);

    // Create circular body for physics (in scaled coordinates)
    const body = Matter.Bodies.circle(scaledX, scaledY, radius, {
      density: this.config.dropDensity,
      friction: this.config.dropFriction,
      frictionAir: this.config.dropFrictionAir,
      restitution: this.config.dropRestitution,
      label: 'raindrop'
    });

    // Initial velocity (scaled for physics space)
    const baseVelX = (this.config.wind / 100) * 50 + (Math.random() - 0.5) * 20;
    const baseVelY = 100 + Math.random() * 100;
    Matter.Body.setVelocity(body, {
      x: baseVelX * this.scaleFactor,
      y: baseVelY * this.scaleFactor
    });

    Matter.World.add(this.engine.world, body);

    // Store with visual AND audio properties
    const raindrop = {
      body,
      mass,
      radius,           // Scaled radius for rendering
      audioRadius: baseRadius,  // Unscaled radius for audio (Minnaert frequency)
      length,
      opacity: 0.3 + Math.random() * 0.4,
      trailPoints: [] // For smooth trails
    };

    this.raindrops.push(raindrop);
    return raindrop;
  }

  /**
   * Create splash particles
   * x, y are already in physics space (from particle collision)
   */
  createSplash(x, y, impactVelocity) {
    const count = 5 + Math.floor(Math.random() * 8); // More particles

    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI;
      // Scale speed for physics space
      const baseSpeed = 80 + Math.random() * impactVelocity * 0.5;
      const speed = baseSpeed * this.scaleFactor;

      // Scale radius for physics space
      const baseRadius = 1.5 + Math.random() * 2.5;

      const splash = {
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: baseRadius * this.scaleFactor,
        opacity: 0.7,
        life: 0.4 + Math.random() * 0.4 // Last longer
      };

      this.splashParticles.push(splash);
    }
  }

  /**
   * Update physics simulation
   */
  update(dt) {
    // Update Matter.js engine with proper delta time
    // Matter.js expects delta in milliseconds, clamped to 16.667ms (60fps) max
    const deltaMs = Math.min(dt * 1000, 16.667);
    Matter.Engine.update(this.engine, deltaMs);

    // Apply wind force and terminal velocity to raindrops
    // Scale wind force for physics space
    const windForce = (this.config.wind / 100) * 0.001 * this.scaleFactor;

    // Scale terminal velocity for physics space
    const scaledTerminalVelocity = this.config.terminalVelocity * this.scaleFactor;

    this.raindrops.forEach(drop => {
      // Lighter drops affected more by wind
      const windEffect = windForce * (1 / drop.mass);
      Matter.Body.applyForce(drop.body, drop.body.position, {
        x: windEffect,
        y: 0
      });

      // Apply terminal velocity cap
      const velocity = drop.body.velocity;
      const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
      if (speed > scaledTerminalVelocity) {
        const scale = scaledTerminalVelocity / speed;
        Matter.Body.setVelocity(drop.body, {
          x: velocity.x * scale,
          y: velocity.y * scale
        });
      }

      // Store trail points for rendering
      drop.trailPoints.push({ ...drop.body.position });
      if (drop.trailPoints.length > 5) {
        drop.trailPoints.shift();
      }
    });

    // Remove raindrops that are off-screen or hit ground/windows
    this.raindrops = this.raindrops.filter(drop => {
      const pos = drop.body.position;

            // Check if hit any window (top or sides, with pass-through for wind-blown drops)
            for (let i = 0; i < this.windowZones.length; i++) {
              const zone = this.windowZones[i];
              const velocity = drop.body.velocity;
              const zoneRight = zone.x + zone.width;
              const zoneBottom = zone.y + zone.height;

              // Check if raindrop is inside window bounds
              const insideX = pos.x >= zone.x && pos.x <= zoneRight;
              const insideY = pos.y >= zone.y && pos.y <= zoneBottom;

              if (insideX && insideY) {
                // Calculate distance from each edge to find likely entry point
                const distFromTop = pos.y - zone.y;
                const distFromBottom = zoneBottom - pos.y;
                const distFromLeft = pos.x - zone.x;
                const distFromRight = zoneRight - pos.x;

                const minDist = Math.min(distFromTop, distFromBottom, distFromLeft, distFromRight);

                let shouldCollide = false;
                let splashX = pos.x;
                let splashY = pos.y;

                // Only collide if drop is moving toward its closest edge
                if (minDist === distFromTop && velocity.y > 0) {
                  // Entered from top, moving down → hit top
                  shouldCollide = true;
                  splashY = zone.y;
                } else if (minDist === distFromLeft && velocity.x > 0) {
                  // Entered from left, moving right → hit left side
                  shouldCollide = true;
                  splashX = zone.x;
                } else if (minDist === distFromRight && velocity.x < 0) {
                  // Entered from right, moving left → hit right side
                  shouldCollide = true;
                  splashX = zoneRight;
                }
                // If closest to bottom or moving away from entry edge → pass through

                if (shouldCollide) {
                  const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
                  this.createSplash(splashX, splashY, speed);
                  this.triggerAudioImpact(drop, speed, 'window');
                  Matter.World.remove(this.engine.world, drop.body);
                  return false;
                }
                // Drop passes through (blown under/through the window)
              }
            }
      
            // Check if hit ground (remove early to prevent pileup)
            // Dynamically detect taskbar position/height via this.floorY
            if (pos.y >= this.floorY) {
              const velocity = drop.body.velocity;
              const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
              
              // Visual splash
              this.createSplash(pos.x, this.floorY, speed);

              // Audio impact
              this.triggerAudioImpact(drop, speed, 'ground');

              Matter.World.remove(this.engine.world, drop.body);
              return false;
            }
      // Check if off-screen horizontally
      if (pos.x < -50 || pos.x > this.width + 50) {
        Matter.World.remove(this.engine.world, drop.body);
        return false;
      }

      return true;
    });

    // Update splash particles (not physics-based, just visual)
    // Scale gravity for physics space
    const scaledGravity = this.config.gravity * this.scaleFactor;

    this.splashParticles = this.splashParticles.filter(particle => {
      // Simple gravity (scaled for physics space)
      particle.vy += scaledGravity * 0.5 * dt;

      // Update position
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;

      // Fade out
      particle.life -= dt;
      particle.opacity = Math.max(0, particle.life * 2);

      return particle.life > 0;
    });
  }

  /**
   * Set gravity (pixels per second squared)
   */
  setGravity(value) {
    this.config.gravity = value;
    // Update Matter.js gravity (normalized to 0-1 scale)
    this.engine.gravity.y = value / 1000;
  }

  /**
   * Set wind (-100 to 100)
   */
  setWind(value) {
    this.config.wind = Math.max(-100, Math.min(100, value));
  }

  /**
   * Set terminal velocity (pixels per second)
   */
  setTerminalVelocity(value) {
    this.config.terminalVelocity = Math.max(50, Math.min(2000, value));
  }

  /**
   * Set window exclusion zones for collision detection
   * Each zone: { x, y, width, height } in screen coordinates (will be scaled to physics space)
   */
  setWindowZones(zones) {
    // Scale from screen space to physics space
    this.windowZones = zones.map(z => ({
      x: Math.floor(z.x * this.scaleFactor),
      y: Math.floor(z.y * this.scaleFactor),
      width: Math.floor(z.width * this.scaleFactor),
      height: Math.floor(z.height * this.scaleFactor)
    }));
  }

  /**
   * Set the audio system for collision events
   */
  setAudioSystem(audio) {
    this.audioSystem = audio;
  }

  /**
   * Trigger audio impact
   */
  triggerAudioImpact(drop, speed, surfaceType = 'default') {
    if (!this.audioSystem) return;

    // Use unscaled values for consistent audio regardless of render scale
    const unscaledSpeed = speed / this.scaleFactor;

    const collisionEvent = {
      dropRadius: drop.audioRadius || drop.radius || 2,
      velocity: unscaledSpeed,
      mass: drop.mass,
      surfaceType: surfaceType,
      position: { x: drop.body.position.x, y: drop.body.position.y },
      impactAngle: Math.atan2(drop.body.velocity.y, drop.body.velocity.x)
    };

    try {
      this.audioSystem.handleCollision(collisionEvent);
    } catch (err) {
      console.error('[Audio] Collision error:', err);
    }
  }

  /**
   * Resize physics world
   * Input dimensions are in screen space (will be scaled to physics space)
   */
  resize(width, height, floorY = null) {
    // Store display dimensions
    this.displayWidth = width;
    this.displayHeight = height;

    // Scale to physics dimensions
    this.width = Math.floor(width * this.scaleFactor);
    this.height = Math.floor(height * this.scaleFactor);

    // Scale floorY from screen space to physics space
    if (floorY !== null) {
      this.floorY = Math.floor(floorY * this.scaleFactor);
    } else {
      this.floorY = this.height;
    }
    // No ground body to update
  }

  /**
   * Update the render scale factor at runtime
   * Requires a resize call afterward to apply new dimensions
   */
  setScaleFactor(scaleFactor) {
    this.scaleFactor = scaleFactor;
    // Recalculate physics dimensions
    this.width = Math.floor(this.displayWidth * this.scaleFactor);
    this.height = Math.floor(this.displayHeight * this.scaleFactor);
    this.floorY = Math.floor(this.floorY / this.scaleFactor * scaleFactor); // Preserve relative position
    console.log(`Physics scale updated to ${scaleFactor * 100}% (${this.width}x${this.height})`);
  }

  /**
   * Clear all particles
   */
  clear() {
    this.raindrops.forEach(drop => {
      Matter.World.remove(this.engine.world, drop.body);
    });
    this.raindrops = [];
    this.splashParticles = [];
  }

  /**
   * Get current particle count
   */
  getParticleCount() {
    return this.raindrops.length + this.splashParticles.length;
  }

  /**
   * Dispose of physics system
   */
  dispose() {
    this.clear();
    Matter.World.clear(this.engine.world);
    Matter.Engine.clear(this.engine);
    console.log('Physics system disposed');
  }
}

export default RainPhysicsSystem;
