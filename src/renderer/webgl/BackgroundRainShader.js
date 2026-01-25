/**
 * BackgroundRainShader - Procedural atmospheric rain layer
 *
 * Renders behind physics particles using scrolling noise.
 * Linked to Sheet sound layer - both respond to intensity/particle count.
 * No physics/collision - purely visual atmosphere.
 */

// Vertex shader: simple full-screen quad
const BACKGROUND_RAIN_VERT = `#version 300 es
precision highp float;

in vec2 a_position;
out vec2 v_uv;

void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    // Map clip space (-1 to 1) to UV (0 to 1)
    v_uv = a_position * 0.5 + 0.5;
}
`;

// Fragment shader: layered procedural rain
const BACKGROUND_RAIN_FRAG = `#version 300 es
precision highp float;

uniform float u_time;
uniform float u_intensity;    // 0.0 - 1.0
uniform float u_wind;         // -1.0 to 1.0 (normalized from -100 to 100)
uniform vec2 u_resolution;
uniform float u_layerCount;   // 1.0 - 5.0
uniform float u_speed;        // Speed multiplier

in vec2 v_uv;
out vec4 fragColor;

// Simple hash function for pseudo-random values
float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// Value noise
float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);

    // Smooth interpolation
    f = f * f * (3.0 - 2.0 * f);

    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));

    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Layered rain effect
float rainLayer(vec2 uv, float layerIndex, float time, float wind) {
    // Each layer has different scale and speed for parallax depth
    float depthFactor = 1.0 - layerIndex * 0.15;  // Farther layers are slower
    float scale = 80.0 + layerIndex * 40.0;       // Farther layers are finer

    // Apply wind slant - shift horizontally based on vertical position
    float slant = wind * 0.5;
    uv.x += uv.y * slant;

    // Stretch UV for rain streaks (taller than wide)
    vec2 rainUV = vec2(uv.x * scale, uv.y * scale * 0.15);

    // Scroll downward (with time), adjusted by depth
    rainUV.y -= time * 8.0 * depthFactor;

    // Add slight horizontal drift from wind
    rainUV.x += time * wind * 2.0 * depthFactor;

    // Sample noise for this layer
    float n = noise(rainUV);

    // Multiple noise octaves for variation
    n += noise(rainUV * 2.3 + vec2(layerIndex * 7.0, 0.0)) * 0.5;
    n += noise(rainUV * 4.7 + vec2(0.0, layerIndex * 11.0)) * 0.25;
    n /= 1.75;

    // Sharp threshold for distinct rain lines (higher = fewer lines)
    float threshold = 0.85 - layerIndex * 0.05;
    float rain = smoothstep(threshold, threshold + 0.05, n);

    // Fade farther layers
    rain *= depthFactor;

    return rain;
}

void main() {
    vec2 uv = v_uv;

    // Early exit if intensity is zero (no rain)
    if (u_intensity < 0.01) {
        fragColor = vec4(0.0);
        return;
    }

    float totalRain = 0.0;
    int layers = int(u_layerCount);

    // Accumulate rain from each layer
    for (int i = 0; i < 5; i++) {
        if (i >= layers) break;

        float layerRain = rainLayer(uv, float(i), u_time * u_speed, u_wind);

        // Layer blending: closer layers are more opaque
        float layerOpacity = 1.0 - float(i) * 0.18;
        totalRain += layerRain * layerOpacity;
    }

    // Clamp and apply intensity
    totalRain = min(totalRain, 1.0) * u_intensity;

    // Rain color - subtle blue-white, semi-transparent
    vec3 rainColor = vec3(0.6, 0.75, 0.9);

    // Final opacity based on rain amount (capped for subtlety)
    float alpha = totalRain * 0.25;

    // Discard nearly-invisible pixels
    if (alpha < 0.005) {
        fragColor = vec4(0.0);
        return;
    }

    // Premultiplied alpha output
    fragColor = vec4(rainColor * alpha, alpha);
}
`;

/**
 * Background rain renderer using procedural shaders.
 * Designed to integrate with WebGLRainRenderer's framebuffer system.
 */
class BackgroundRainShader {
    constructor(gl) {
        this.gl = gl;
        this.program = null;
        this.vao = null;
        this.vertexBuffer = null;

        // Uniform locations
        this.uniforms = {
            time: null,
            intensity: null,
            wind: null,
            resolution: null,
            layerCount: null,
            speed: null
        };

        // Configurable parameters
        this.config = {
            intensity: 0.5,     // 0.0 - 1.0
            wind: 0.0,          // -1.0 to 1.0
            layerCount: 3,      // 1 - 5
            speed: 1.0,         // Speed multiplier
            enabled: true
        };

        // Animation time (independent of physics)
        this.time = 0;
    }

    /**
     * Initialize shader program and buffers
     */
    init() {
        const gl = this.gl;

        // Compile shaders
        const vertShader = this._compileShader(gl.VERTEX_SHADER, BACKGROUND_RAIN_VERT);
        const fragShader = this._compileShader(gl.FRAGMENT_SHADER, BACKGROUND_RAIN_FRAG);

        // Link program
        this.program = gl.createProgram();
        gl.attachShader(this.program, vertShader);
        gl.attachShader(this.program, fragShader);
        gl.linkProgram(this.program);

        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(this.program);
            throw new Error(`BackgroundRainShader program link error: ${log}`);
        }

        // Shaders can be deleted after linking
        gl.deleteShader(vertShader);
        gl.deleteShader(fragShader);

        // Get uniform locations
        this.uniforms.time = gl.getUniformLocation(this.program, 'u_time');
        this.uniforms.intensity = gl.getUniformLocation(this.program, 'u_intensity');
        this.uniforms.wind = gl.getUniformLocation(this.program, 'u_wind');
        this.uniforms.resolution = gl.getUniformLocation(this.program, 'u_resolution');
        this.uniforms.layerCount = gl.getUniformLocation(this.program, 'u_layerCount');
        this.uniforms.speed = gl.getUniformLocation(this.program, 'u_speed');

        // Create VAO and fullscreen quad
        this._initQuadBuffer();

        return true;
    }

    _compileShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error(`BackgroundRainShader compile error: ${log}`);
        }

        return shader;
    }

    _initQuadBuffer() {
        const gl = this.gl;

        // Create VAO
        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);

        // Fullscreen quad (clip space coordinates)
        const quadVerts = new Float32Array([
            -1.0, -1.0,
             1.0, -1.0,
            -1.0,  1.0,
             1.0,  1.0
        ]);

        this.vertexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

        const posLoc = gl.getAttribLocation(this.program, 'a_position');
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        gl.bindVertexArray(null);
    }

    /**
     * Update animation time
     * @param {number} dt - Delta time in seconds
     */
    update(dt) {
        this.time += dt;
    }

    /**
     * Render the background rain layer
     * @param {number} width - Render target width
     * @param {number} height - Render target height
     */
    render(width, height) {
        if (!this.config.enabled || this.config.intensity < 0.01) {
            return;
        }

        const gl = this.gl;

        gl.useProgram(this.program);

        // Set uniforms
        gl.uniform1f(this.uniforms.time, this.time);
        gl.uniform1f(this.uniforms.intensity, this.config.intensity);
        gl.uniform1f(this.uniforms.wind, this.config.wind);
        gl.uniform2f(this.uniforms.resolution, width, height);
        gl.uniform1f(this.uniforms.layerCount, this.config.layerCount);
        gl.uniform1f(this.uniforms.speed, this.config.speed);

        // Draw fullscreen quad
        gl.bindVertexArray(this.vao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    /**
     * Update shader configuration
     * @param {object} config - Configuration updates
     */
    updateConfig(config) {
        if (config.intensity !== undefined) {
            this.config.intensity = Math.max(0, Math.min(1, config.intensity));
        }
        if (config.wind !== undefined) {
            this.config.wind = Math.max(-1, Math.min(1, config.wind));
        }
        if (config.layerCount !== undefined) {
            this.config.layerCount = Math.max(1, Math.min(5, config.layerCount));
        }
        if (config.speed !== undefined) {
            this.config.speed = Math.max(0.1, Math.min(3, config.speed));
        }
        if (config.enabled !== undefined) {
            this.config.enabled = Boolean(config.enabled);
        }
    }

    /**
     * Get current configuration
     */
    getConfig() {
        return { ...this.config };
    }

    /**
     * Set intensity (0-1)
     * Used for linking to particle intensity
     */
    setIntensity(value) {
        this.config.intensity = Math.max(0, Math.min(1, value));
    }

    /**
     * Set wind (-1 to 1)
     * Used for linking to physics wind
     */
    setWind(value) {
        this.config.wind = Math.max(-1, Math.min(1, value));
    }

    /**
     * Cleanup WebGL resources
     */
    dispose() {
        const gl = this.gl;
        if (!gl) return;

        if (this.vao) gl.deleteVertexArray(this.vao);
        if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
        if (this.program) gl.deleteProgram(this.program);

        this.vao = null;
        this.vertexBuffer = null;
        this.program = null;
    }
}

export default BackgroundRainShader;
