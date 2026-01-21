/**
 * RainyDesk Physics System
 * Matter.js-based physics for enhanced rain simulation
 */

import Matter from 'https://cdn.skypack.dev/matter-js@0.20.0';
import audioSystem from './audioSystem.js';

class RainPhysicsSystem {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.floorY = height; // Default floor to bottom of canvas

    // New TypeScript audio system (set externally)
    this.newAudioSystem = null;

    // Create Matter.js engine
    this.engine = Matter.Engine.create({
      gravity: { x: 0, y: 1 } // Will be scaled for rain
    });

    // Configuration (slower than legacy for more realistic fall)
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

    // Window exclusion zones (for collision detection)
    this.windowZones = [];

    // No ground body needed - using position-based removal instead

    console.log('Physics system initialized with Matter.js');
  }

  /**
   * Create a raindrop body
   */
  createRaindrop(x, y, mass = 1) {
    const radius = 2 + (mass * 3);
    const length = radius * (4 + Math.random() * 4);

    // Create circular body for physics
    const body = Matter.Bodies.circle(x, y, radius, {
      density: this.config.dropDensity,
      friction: this.config.dropFriction,
      frictionAir: this.config.dropFrictionAir,
      restitution: this.config.dropRestitution,
      label: 'raindrop'
    });

    // Initial velocity - slower start
    Matter.Body.setVelocity(body, {
      x: (this.config.wind / 100) * 50 + (Math.random() - 0.5) * 20,
      y: 100 + Math.random() * 100
    });

    Matter.World.add(this.engine.world, body);

    // Store with visual properties
    const raindrop = {
      body,
      mass,
      radius,
      length,
      opacity: 0.3 + Math.random() * 0.4,
      trailPoints: [] // For smooth trails
    };

    this.raindrops.push(raindrop);
    return raindrop;
  }

  /**
   * Create splash particles
   */
  createSplash(x, y, impactVelocity) {
    const count = 5 + Math.floor(Math.random() * 8); // More particles

    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI;
      const speed = 80 + Math.random() * impactVelocity * 0.5; // Faster/bigger splash

      const splash = {
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: 1.5 + Math.random() * 2.5, // Bigger particles
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
    const windForce = (this.config.wind / 100) * 0.001;
    this.raindrops.forEach(drop => {
      // Lighter drops affected more by wind
      const windEffect = windForce * (1 / drop.mass);
      Matter.Body.applyForce(drop.body, drop.body.position, {
        x: windEffect,
        y: 0
      });

      // Apply terminal velocity cap (like legacy physics)
      const velocity = drop.body.velocity;
      const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
      if (speed > this.config.terminalVelocity) {
        const scale = this.config.terminalVelocity / speed;
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

            // Check if hit any window top (windows act as umbrellas)
            for (let i = 0; i < this.windowZones.length; i++) {
              const zone = this.windowZones[i];
              // Check if raindrop is horizontally within window bounds
              if (pos.x >= zone.x && pos.x <= zone.x + zone.width) {
                // Check if raindrop has reached or crossed the window's top edge
                if (pos.y >= zone.y) {
                  const velocity = drop.body.velocity;
                  const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
                  
                  // Visual splash
                  this.createSplash(pos.x, zone.y, speed);

                  // Audio impact (both old and new systems)
                  this.triggerAudioImpact(drop, speed, 'window');

                  Matter.World.remove(this.engine.world, drop.body);
                  return false;
                }
              }
            }
      
            // Check if hit ground (remove early to prevent pileup)
            // Dynamically detect taskbar position/height via this.floorY
            if (pos.y >= this.floorY) {
              const velocity = drop.body.velocity;
              const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
              
              // Visual splash
              this.createSplash(pos.x, this.floorY, speed);

              // Audio impact (both old and new systems)
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
    this.splashParticles = this.splashParticles.filter(particle => {
      // Simple gravity
      particle.vy += this.config.gravity * 0.5 * dt;

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
    this.config.wind = value;
  }

  /**
   * Set window exclusion zones for collision detection
   * Each zone: { x, y, width, height } in local canvas coordinates
   */
  setWindowZones(zones) {
    this.windowZones = zones;
  }

  /**
   * Set the new TypeScript audio system for collision events
   */
  setNewAudioSystem(audioSystem) {
    this.newAudioSystem = audioSystem;
  }

  /**
   * Trigger audio impact on both old and new systems
   */
  triggerAudioImpact(drop, speed, surfaceType = 'default') {
    // Old system
    const velocityScale = Math.min(speed / this.config.terminalVelocity, 1.0);
    audioSystem.triggerImpact(drop.mass, velocityScale);

    // New system (if available)
    if (this.newAudioSystem) {
      // Convert to collision event for new system
      const collisionEvent = {
        dropRadius: drop.radius || 2, // radius in pixels, convert to mm
        velocity: speed, // speed in pixels/second, convert to m/s (roughly /100)
        mass: drop.mass,
        surfaceType: surfaceType,
        position: { x: drop.body.position.x, y: drop.body.position.y },
        impactAngle: Math.atan2(drop.body.velocity.y, drop.body.velocity.x)
      };

      try {
        this.newAudioSystem.handleCollision(collisionEvent);
      } catch (err) {
        console.error('[New Audio] Collision error:', err);
      }
    }
  }

  /**
   * Resize physics world
   */
  resize(width, height, floorY = null) {
    this.width = width;
    this.height = height;
    if (floorY !== null) {
      this.floorY = floorY;
    } else {
      this.floorY = height;
    }
    // No ground body to update
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
