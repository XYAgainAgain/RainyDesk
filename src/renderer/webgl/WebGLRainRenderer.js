/**
 * WebGL 2 Instanced Rain Renderer
 * Renders all raindrops and splashes with minimal draw calls
 */

// Shader source code (embedded as strings)
const RAINDROP_VERT = `#version 300 es
precision highp float;

// Per-vertex (unit quad)
in vec2 a_position;

// Per-instance (from Float32Array each frame)
in vec2 a_instancePosition;
in vec2 a_instanceVelocity;
in float a_instanceRadius;
in float a_instanceLength;
in float a_instanceOpacity;

uniform vec2 u_resolution;

out float v_opacity;
out vec2 v_uv;
out vec2 v_dims;

void main() {
    // Calculate rotation angle from velocity
    float speed = length(a_instanceVelocity);
    // Rotation fix: Subtract PI/2 to align vertical quad with velocity
    float angle = atan(a_instanceVelocity.y, a_instanceVelocity.x) - 1.57079632679;

    v_dims = vec2(a_instanceRadius, a_instanceLength);

    // Stretch quad: X is radius (width), Y is length (height)
    vec2 stretched = vec2(
        a_position.x * a_instanceRadius * 2.0,
        a_position.y * a_instanceLength
    );

    // Rotate by velocity angle
    float cosA = cos(angle);
    float sinA = sin(angle);
    vec2 rotated = vec2(
        stretched.x * cosA - stretched.y * sinA,
        stretched.x * sinA + stretched.y * cosA
    );

    // Offset by instance position
    vec2 worldPos = a_instancePosition + rotated;

    // Convert to clip space (-1 to 1) with Y-flip
    vec2 clipPos = (worldPos / u_resolution) * 2.0 - 1.0;
    clipPos.y = -clipPos.y;

    gl_Position = vec4(clipPos, 0.0, 1.0);

    v_opacity = a_instanceOpacity;
    v_uv = a_position + 0.5; // Map -0.5..0.5 to 0..1
}
`;

const RAINDROP_FRAG = `#version 300 es
precision highp float;

in float v_opacity;
in vec2 v_uv;
in vec2 v_dims;

out vec4 fragColor;

const vec3 RAIN_COLOR = vec3(0.627, 0.769, 0.910); // rgb(160, 196, 232)

void main() {
    float radius = v_dims.x;
    float len = v_dims.y;

    // Head center in UV space (Y moves from 0 at tail to 1 at head)
    float headCenterY = 1.0 - (radius / len);

    // --- Trail Logic ---
    // Trail is a cone from y=0 (width 0) to y=headCenterY (width radius)
    // It must be clipped above headCenterY so it doesn't overlap the top of the circle
    
    // Normalized position along the trail section (0.0 to 1.0)
    float trailHigh = max(headCenterY, 0.001);
    float trailProgress = clamp(v_uv.y / trailHigh, 0.0, 1.0);
    
    // Tapered width: 0.0 at tail -> 0.5 at equator
    float halfWidth = 0.5 * trailProgress;
    
    // Distance from center line
    float xDist = abs(v_uv.x - 0.5);
    
    // Smooth trail edges
    float blur = 0.05;
    float trailAlpha = 1.0 - smoothstep(halfWidth - blur, halfWidth, xDist);
    
    // Fade the tail transparency slightly for speed effect
    trailAlpha *= smoothstep(0.0, 0.2, v_uv.y);
    
    // Hard clip the trail above the equator (circle handles the top)
    trailAlpha *= step(v_uv.y, headCenterY);


    // --- Head Logic ---
    float dx = (v_uv.x - 0.5) * (radius * 2.0);
    float dy = (v_uv.y - headCenterY) * len;
    float distSq = dx*dx + dy*dy;
    
    // Circle alpha
    float headAlpha = 1.0 - smoothstep(radius * radius * 0.5, radius * radius, distSq);

    // Combine: The circle "caps" the cone
    float shapeAlpha = max(headAlpha, trailAlpha);

    // Combined alpha
    float alpha = v_opacity * shapeAlpha;

    if (alpha < 0.01) discard;

    // Premultiplied alpha output
    fragColor = vec4(RAIN_COLOR * alpha, alpha);
}
`;

const SPLASH_VERT = `#version 300 es
precision highp float;

in vec2 a_position;

in vec2 a_instancePosition;
in float a_instanceRadius;
in float a_instanceOpacity;

uniform vec2 u_resolution;

out float v_opacity;
out vec2 v_uv;

void main() {
    // Scale by radius
    vec2 scaled = a_position * a_instanceRadius * 2.0;

    // Offset by instance position
    vec2 worldPos = a_instancePosition + scaled;

    // Convert to clip space with Y-flip
    vec2 clipPos = (worldPos / u_resolution) * 2.0 - 1.0;
    clipPos.y = -clipPos.y;

    gl_Position = vec4(clipPos, 0.0, 1.0);

    v_opacity = a_instanceOpacity;
    v_uv = a_position + 0.5;
}
`;

const SPLASH_FRAG = `#version 300 es
precision highp float;

in float v_opacity;
in vec2 v_uv;

out vec4 fragColor;

const vec3 RAIN_COLOR = vec3(0.627, 0.769, 0.910);

void main() {
    // Distance from center for circular soft edge
    float dist = length(v_uv - 0.5) * 2.0;

    // Smooth circular falloff
    float alpha = v_opacity * smoothstep(1.0, 0.5, dist);

    if (alpha < 0.01) discard;

    // Premultiplied alpha
    fragColor = vec4(RAIN_COLOR * alpha, alpha);
}
`;

// Upscale shader for pixelated rendering (nearest-neighbor)
const UPSCALE_VERT = `#version 300 es
precision highp float;

in vec2 a_position;
out vec2 v_texCoord;

void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    // Map clip space (-1 to 1) to texture coords (0 to 1)
    // No Y flip needed - framebuffer already has correct orientation
    v_texCoord = a_position * 0.5 + 0.5;
}
`;

const UPSCALE_FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_texture;
in vec2 v_texCoord;
out vec4 fragColor;

void main() {
    fragColor = texture(u_texture, v_texCoord);
}
`;

class WebGLRainRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = null;

        // Shader programs
        this.raindropProgram = null;
        this.splashProgram = null;
        this.upscaleProgram = null;

        // Vertex Array Objects
        this.raindropVAO = null;
        this.splashVAO = null;
        this.upscaleVAO = null;

        // Buffers
        this.raindropVertexBuffer = null;
        this.raindropInstanceBuffer = null;
        this.splashVertexBuffer = null;
        this.splashInstanceBuffer = null;
        this.upscaleVertexBuffer = null;

        // Framebuffer for low-res rendering
        this.framebuffer = null;
        this.fbTexture = null;

        // Uniform locations
        this.raindropResolutionLoc = null;
        this.splashResolutionLoc = null;
        this.upscaleTextureLoc = null;

        // Pre-allocated typed arrays for instance data
        this.maxRaindrops = 2000;
        this.maxSplashes = 1000;
        this.raindropData = new Float32Array(this.maxRaindrops * 7);
        this.splashData = new Float32Array(this.maxSplashes * 4);

        // Canvas dimensions (display resolution)
        this.logicalWidth = 0;
        this.logicalHeight = 0;
        this.dpr = 1;

        // Low-res rendering dimensions (physics space)
        this.lowResWidth = 0;
        this.lowResHeight = 0;
        this.scaleFactor = 1.0;
    }

    /**
     * Initialize WebGL context, shaders, and buffers
     */
    init() {
        // Get WebGL 2 context with transparency
        this.gl = this.canvas.getContext('webgl2', {
            alpha: true,
            premultipliedAlpha: true,
            antialias: false,
            depth: false,
            stencil: false,
            preserveDrawingBuffer: false
        });

        if (!this.gl) {
            throw new Error('WebGL 2 not supported');
        }

        const gl = this.gl;

        // Compile shaders and create programs
        this.raindropProgram = this._createProgram(RAINDROP_VERT, RAINDROP_FRAG);
        this.splashProgram = this._createProgram(SPLASH_VERT, SPLASH_FRAG);
        this.upscaleProgram = this._createProgram(UPSCALE_VERT, UPSCALE_FRAG);

        // Get uniform locations
        this.raindropResolutionLoc = gl.getUniformLocation(this.raindropProgram, 'u_resolution');
        this.splashResolutionLoc = gl.getUniformLocation(this.splashProgram, 'u_resolution');
        this.upscaleTextureLoc = gl.getUniformLocation(this.upscaleProgram, 'u_texture');

        // Create buffers and VAOs
        this._initRaindropBuffers();
        this._initSplashBuffers();
        this._initUpscaleBuffers();

        // Setup blending for transparency
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        return true;
    }

    /**
     * Initialize framebuffer for low-res rendering
     */
    _initFramebuffer() {
        const gl = this.gl;

        // Clean up existing framebuffer if any
        if (this.framebuffer) {
            gl.deleteFramebuffer(this.framebuffer);
            gl.deleteTexture(this.fbTexture);
        }

        // Create framebuffer
        this.framebuffer = gl.createFramebuffer();

        // Create texture for framebuffer
        this.fbTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.fbTexture);
        gl.texImage2D(
            gl.TEXTURE_2D, 0, gl.RGBA,
            this.lowResWidth, this.lowResHeight, 0,
            gl.RGBA, gl.UNSIGNED_BYTE, null
        );

        // CRITICAL: Nearest-neighbor filtering for pixelated look
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        // Attach texture to framebuffer
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
        gl.framebufferTexture2D(
            gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D, this.fbTexture, 0
        );

        // Check framebuffer status
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            console.error('Framebuffer not complete:', status);
        }

        // Unbind
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    /**
     * Initialize upscale fullscreen quad buffers
     */
    _initUpscaleBuffers() {
        const gl = this.gl;
        const program = this.upscaleProgram;

        // Create VAO
        this.upscaleVAO = gl.createVertexArray();
        gl.bindVertexArray(this.upscaleVAO);

        // Fullscreen quad (clip space coordinates)
        const quadVerts = new Float32Array([
            -1.0, -1.0,  // bottom-left
             1.0, -1.0,  // bottom-right
            -1.0,  1.0,  // top-left
             1.0,  1.0   // top-right
        ]);

        // Vertex buffer (static)
        this.upscaleVertexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.upscaleVertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

        const posLoc = gl.getAttribLocation(program, 'a_position');
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        gl.bindVertexArray(null);
    }

    /**
     * Compile shader from source
     */
    _compileShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error(`Shader compile error: ${log}`);
        }

        return shader;
    }

    /**
     * Create shader program from vertex and fragment source
     */
    _createProgram(vertSource, fragSource) {
        const gl = this.gl;

        const vertShader = this._compileShader(gl.VERTEX_SHADER, vertSource);
        const fragShader = this._compileShader(gl.FRAGMENT_SHADER, fragSource);

        const program = gl.createProgram();
        gl.attachShader(program, vertShader);
        gl.attachShader(program, fragShader);
        gl.linkProgram(program);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(program);
            gl.deleteProgram(program);
            throw new Error(`Program link error: ${log}`);
        }

        // Shaders can be deleted after linking
        gl.deleteShader(vertShader);
        gl.deleteShader(fragShader);

        return program;
    }

    /**
     * Initialize raindrop vertex and instance buffers
     */
    _initRaindropBuffers() {
        const gl = this.gl;
        const program = this.raindropProgram;

        // Create VAO
        this.raindropVAO = gl.createVertexArray();
        gl.bindVertexArray(this.raindropVAO);

        // Unit quad geometry (TRIANGLE_STRIP)
        const quadVerts = new Float32Array([
            -0.5, -0.5,  // bottom-left
             0.5, -0.5,  // bottom-right
            -0.5,  0.5,  // top-left
             0.5,  0.5   // top-right
        ]);

        // Vertex buffer (static)
        this.raindropVertexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.raindropVertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

        const posLoc = gl.getAttribLocation(program, 'a_position');
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
        // divisor = 0 (default) means per-vertex

        // Instance buffer (dynamic, updated each frame)
        this.raindropInstanceBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.raindropInstanceBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.raindropData.byteLength, gl.DYNAMIC_DRAW);

        // Instance attributes layout:
        // [posX, posY, velX, velY, radius, length, opacity] = 7 floats, 28 bytes stride
        const stride = 7 * 4;

        const instancePosLoc = gl.getAttribLocation(program, 'a_instancePosition');
        gl.enableVertexAttribArray(instancePosLoc);
        gl.vertexAttribPointer(instancePosLoc, 2, gl.FLOAT, false, stride, 0);
        gl.vertexAttribDivisor(instancePosLoc, 1); // per-instance

        const instanceVelLoc = gl.getAttribLocation(program, 'a_instanceVelocity');
        gl.enableVertexAttribArray(instanceVelLoc);
        gl.vertexAttribPointer(instanceVelLoc, 2, gl.FLOAT, false, stride, 2 * 4);
        gl.vertexAttribDivisor(instanceVelLoc, 1);

        const instanceRadiusLoc = gl.getAttribLocation(program, 'a_instanceRadius');
        gl.enableVertexAttribArray(instanceRadiusLoc);
        gl.vertexAttribPointer(instanceRadiusLoc, 1, gl.FLOAT, false, stride, 4 * 4);
        gl.vertexAttribDivisor(instanceRadiusLoc, 1);

        const instanceLengthLoc = gl.getAttribLocation(program, 'a_instanceLength');
        gl.enableVertexAttribArray(instanceLengthLoc);
        gl.vertexAttribPointer(instanceLengthLoc, 1, gl.FLOAT, false, stride, 5 * 4);
        gl.vertexAttribDivisor(instanceLengthLoc, 1);

        const instanceOpacityLoc = gl.getAttribLocation(program, 'a_instanceOpacity');
        gl.enableVertexAttribArray(instanceOpacityLoc);
        gl.vertexAttribPointer(instanceOpacityLoc, 1, gl.FLOAT, false, stride, 6 * 4);
        gl.vertexAttribDivisor(instanceOpacityLoc, 1);

        gl.bindVertexArray(null);
    }

    /**
     * Initialize splash vertex and instance buffers
     */
    _initSplashBuffers() {
        const gl = this.gl;
        const program = this.splashProgram;

        // Create VAO
        this.splashVAO = gl.createVertexArray();
        gl.bindVertexArray(this.splashVAO);

        // Unit quad geometry
        const quadVerts = new Float32Array([
            -0.5, -0.5,
             0.5, -0.5,
            -0.5,  0.5,
             0.5,  0.5
        ]);

        // Vertex buffer (static)
        this.splashVertexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.splashVertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

        const posLoc = gl.getAttribLocation(program, 'a_position');
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        // Instance buffer (dynamic)
        this.splashInstanceBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.splashInstanceBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.splashData.byteLength, gl.DYNAMIC_DRAW);

        // Instance attributes layout:
        // [posX, posY, radius, opacity] = 4 floats, 16 bytes stride
        const stride = 4 * 4;

        const instancePosLoc = gl.getAttribLocation(program, 'a_instancePosition');
        gl.enableVertexAttribArray(instancePosLoc);
        gl.vertexAttribPointer(instancePosLoc, 2, gl.FLOAT, false, stride, 0);
        gl.vertexAttribDivisor(instancePosLoc, 1);

        const instanceRadiusLoc = gl.getAttribLocation(program, 'a_instanceRadius');
        gl.enableVertexAttribArray(instanceRadiusLoc);
        gl.vertexAttribPointer(instanceRadiusLoc, 1, gl.FLOAT, false, stride, 2 * 4);
        gl.vertexAttribDivisor(instanceRadiusLoc, 1);

        const instanceOpacityLoc = gl.getAttribLocation(program, 'a_instanceOpacity');
        gl.enableVertexAttribArray(instanceOpacityLoc);
        gl.vertexAttribPointer(instanceOpacityLoc, 1, gl.FLOAT, false, stride, 3 * 4);
        gl.vertexAttribDivisor(instanceOpacityLoc, 1);

        gl.bindVertexArray(null);
    }

    /**
     * Update raindrop instance buffer from physics system
     * Returns number of active raindrops
     */
    _updateRaindropBuffer(raindrops) {
        const count = Math.min(raindrops.length, this.maxRaindrops);
        const data = this.raindropData;

        for (let i = 0; i < count; i++) {
            const drop = raindrops[i];
            const pos = drop.body.position;
            const vel = drop.body.velocity;
            const offset = i * 7;

            data[offset + 0] = pos.x;
            data[offset + 1] = pos.y;
            data[offset + 2] = vel.x;
            data[offset + 3] = vel.y;
            data[offset + 4] = drop.radius;
            data[offset + 5] = drop.length;
            data[offset + 6] = drop.opacity;
        }

        // Upload to GPU (only the used portion)
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.raindropInstanceBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, count * 7));

        return count;
    }

    /**
     * Update splash instance buffer from physics system
     * Returns number of active splashes
     */
    _updateSplashBuffer(splashParticles) {
        const count = Math.min(splashParticles.length, this.maxSplashes);
        const data = this.splashData;

        for (let i = 0; i < count; i++) {
            const particle = splashParticles[i];
            const offset = i * 4;

            data[offset + 0] = particle.x;
            data[offset + 1] = particle.y;
            data[offset + 2] = particle.radius;
            data[offset + 3] = particle.opacity;
        }

        // Upload to GPU
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.splashInstanceBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, count * 4));

        return count;
    }

    /**
     * Clear the canvas to transparent
     */
    clear() {
        const gl = this.gl;
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    /**
     * Render the upscale pass (framebuffer texture to screen)
     */
    _renderUpscale() {
        const gl = this.gl;

        gl.useProgram(this.upscaleProgram);

        // Bind framebuffer texture
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.fbTexture);
        gl.uniform1i(this.upscaleTextureLoc, 0);

        // Draw fullscreen quad
        gl.bindVertexArray(this.upscaleVAO);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    /**
     * Render all particles from physics system
     * Uses two-pass rendering: low-res framebuffer -> upscale to display
     */
    render(physicsSystem) {
        const gl = this.gl;

        // Skip framebuffer path if not using scaled rendering
        if (this.scaleFactor >= 1.0 || !this.framebuffer) {
            // Direct rendering (no scaling)
            this.clear();
            this._renderParticles(physicsSystem);
            return;
        }

        // PASS 1: Render to low-res framebuffer
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
        gl.viewport(0, 0, this.lowResWidth, this.lowResHeight);
        this.clear();
        this._renderParticles(physicsSystem);

        // PASS 2: Upscale to display
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        this.clear();
        this._renderUpscale();
    }

    /**
     * Render particles (used by both direct and framebuffer paths)
     */
    _renderParticles(physicsSystem) {
        const gl = this.gl;

        // Render raindrops (use low-res dimensions for coordinate conversion)
        const raindropCount = this._updateRaindropBuffer(physicsSystem.raindrops);
        if (raindropCount > 0) {
            gl.useProgram(this.raindropProgram);
            gl.uniform2f(this.raindropResolutionLoc, this.lowResWidth, this.lowResHeight);
            gl.bindVertexArray(this.raindropVAO);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, raindropCount);
        }

        // Render splashes
        const splashCount = this._updateSplashBuffer(physicsSystem.splashParticles);
        if (splashCount > 0) {
            gl.useProgram(this.splashProgram);
            gl.uniform2f(this.splashResolutionLoc, this.lowResWidth, this.lowResHeight);
            gl.bindVertexArray(this.splashVAO);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, splashCount);
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

        // Set canvas buffer size (display resolution)
        this.canvas.width = width * dpr;
        this.canvas.height = height * dpr;
        this.canvas.style.width = width + 'px';
        this.canvas.style.height = height + 'px';

        // Calculate low-res rendering dimensions (physics space)
        this.lowResWidth = Math.floor(width * scaleFactor);
        this.lowResHeight = Math.floor(height * scaleFactor);

        // Ensure minimum size of 1 pixel
        this.lowResWidth = Math.max(1, this.lowResWidth);
        this.lowResHeight = Math.max(1, this.lowResHeight);

        // Initialize/resize framebuffer for scaled rendering
        if (scaleFactor < 1.0) {
            this._initFramebuffer();
            console.log(`Renderer: ${this.lowResWidth}x${this.lowResHeight} -> ${width}x${height} (${scaleFactor * 100}% scale)`);
        }

        // Update viewport for display resolution
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    /**
     * Cleanup WebGL resources
     */
    dispose() {
        const gl = this.gl;
        if (!gl) return;

        // Clean up VAOs
        gl.deleteVertexArray(this.raindropVAO);
        gl.deleteVertexArray(this.splashVAO);
        gl.deleteVertexArray(this.upscaleVAO);

        // Clean up buffers
        gl.deleteBuffer(this.raindropVertexBuffer);
        gl.deleteBuffer(this.raindropInstanceBuffer);
        gl.deleteBuffer(this.splashVertexBuffer);
        gl.deleteBuffer(this.splashInstanceBuffer);
        gl.deleteBuffer(this.upscaleVertexBuffer);

        // Clean up programs
        gl.deleteProgram(this.raindropProgram);
        gl.deleteProgram(this.splashProgram);
        gl.deleteProgram(this.upscaleProgram);

        // Clean up framebuffer
        if (this.framebuffer) {
            gl.deleteFramebuffer(this.framebuffer);
            gl.deleteTexture(this.fbTexture);
        }

        this.gl = null;
    }
}

export default WebGLRainRenderer;
