// Ferrofluid — spring-damper spike pool with tent-interpolated fragment.
// Ported from Packages/Core/Sources/Core/Rendering/FerroRenderer.swift +
// Packages/Core/Sources/Core/Rendering/Shaders/Ferrofluid.metal.
//
// Render strategy: fullscreen quad ShaderMaterial. CPU steps 48-spike
// spring-damper physics against the FFT magnitudes (32 bins linearly
// oversampled to 48 targets) and uploads heights[] as a uniform array.
// The fragment then draws pool / body / specular / shimmer regions
// sampling the tent influence window — same math as the Metal shader.
//
// Depends on:
//   window.Viz, window.AudioEngine, window.vizGL, THREE

(() => {
  if (typeof THREE === 'undefined' || !window.Viz) return;

  const N = 48;

  const VS = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  `;

  // GLSL port of Ferrofluid.metal. Dynamic indexing into uniform float
  // arrays is allowed in WebGL 1 so the tent influence loop compiles as-is.
  const FS = `
    precision highp float;

    #define N ${N}

    varying vec2 vUv;

    uniform float u_hue;
    uniform float u_bass;
    uniform float u_valence;
    uniform float u_energy;
    uniform float u_heights[N];

    vec3 hsl2rgb(float h, float s, float l) {
      vec3 rgb = clamp(
        abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0,
        0.0, 1.0);
      float c = (1.0 - abs(2.0 * l - 1.0)) * s;
      return vec3(l) + c * (rgb - 0.5);
    }

    float tent(float x) {
      float a = max(0.0, 1.0 - abs(x));
      return a * a * a;
    }

    void main() {
      vec2 uv = vUv;
      float Nf = float(N);

      float spikeX = uv.x * (Nf - 1.0);
      int iCenter = int(clamp(spikeX, 0.0, Nf - 1.0));

      // Tent influence window over ±2 neighbors. Divisor 0.75 narrows the
      // tent so single-bin peaks stay visually isolated — matches a real
      // audio waveform where one loud frequency stands tall against quiet
      // neighbors, rather than smearing across the pool.
      float surface = 0.0;
      for (int dx = -2; dx <= 2; dx++) {
        int idx = iCenter + dx;
        if (idx < 0)      idx = 0;
        if (idx > N - 1)  idx = N - 1;
        float offset = (float(idx) - spikeX) / 0.75;
        surface = max(surface, u_heights[idx] * tent(offset));
      }
      int iL = iCenter;
      int iR = iCenter + 1; if (iR > N - 1) iR = N - 1;
      // Lower valley coefficient so inter-spike gaps drop further, letting
      // the peaks feel proportionally taller.
      float valley = (u_heights[iL] + u_heights[iR]) * 0.18;
      surface = max(surface, valley);

      float poolY = 0.04;
      // Energy scales the displacement ceiling. Bumped from 0.55 → 0.85 so
      // loud moments reach near the top of the frame — matches how real
      // audio peaks dominate the visible vertical range.
      float energyMul = 0.6 + u_energy * 0.8;
      float maxH = 0.85 * energyMul;
      float surfaceY = poolY + surface * maxH;
      float pixelY = uv.y;

      vec4 outCol = vec4(0.0);

      if (pixelY < poolY) {
        float t = pixelY / poolY;
        vec3 poolDark = vec3(0.015, 0.018, 0.025);
        vec3 poolGlow = hsl2rgb(u_hue, 1.0, 0.22 + u_bass * 0.14);
        vec3 pool = poolDark + poolGlow * (0.40 + u_bass * 0.55) * (0.4 + t * 0.6);
        outCol = vec4(pool, 1.0);
      } else if (pixelY < surfaceY) {
        float tNorm = (pixelY - poolY) / max(surfaceY - poolY, 0.001);
        vec3 bodyLow  = hsl2rgb(u_hue, 0.20, 0.03);
        vec3 bodyMid  = hsl2rgb(u_hue, 0.22, 0.07);
        vec3 bodyHigh = hsl2rgb(u_hue, 0.25, 0.10);
        vec3 body = mix(bodyLow, bodyMid, smoothstep(0.0, 0.55, tNorm));
        body = mix(body, bodyHigh, smoothstep(0.55, 1.0, tNorm));

        // Specular streak on left face of each spike. Valence brightens
        // gloss on happy tracks, mutes it on sad ones (neutral 0.5 → 1.0).
        float valenceMul = 0.8 + u_valence * 0.4;
        float phase = spikeX - floor(spikeX);
        float leftFace = smoothstep(0.45, 0.05, phase);
        float upperHalf = smoothstep(0.40, 0.92, tNorm);
        float specAmount = leftFace * upperHalf * (0.55 + u_bass * 0.35) * valenceMul;
        float specL = 0.50 + u_bass * 0.30;
        vec3 specColor = hsl2rgb(u_hue, 0.65, specL);
        body = mix(body, specColor, specAmount);

        // Shimmer at the pool-body seam.
        float shimmer = smoothstep(0.02, 0.0, abs(pixelY - poolY));
        body += hsl2rgb(u_hue, 1.0, 0.30 + u_bass * 0.38) * shimmer;

        outCol = vec4(body, 1.0);
      }

      gl_FragColor = outCol;
    }
  `;

  let scene = null;
  let mat   = null;

  // CPU physics state. Float32Arrays so Three.js can upload heights as a
  // float[N] uniform without per-frame reboxing.
  const heights    = new Float32Array(N);
  const velocities = new Float32Array(N);
  let fluidHue = 0;
  let lastT    = 0;

  function init() {
    if (!window.vizGL && typeof window.initThree === 'function') window.initThree();
    const gl = window.vizGL;
    if (!gl) { console.warn('[ferrofluid] window.vizGL not ready'); return; }
    scene = new THREE.Scene();
    mat = new THREE.ShaderMaterial({
      uniforms: {
        u_hue:      { value: 0 },
        u_bass:     { value: 0 },
        u_valence:  { value: 0.5 },
        u_energy:   { value: 0.5 },
        // Three.js accepts a typed array directly for float[N] uniforms;
        // mutating the same buffer each frame avoids allocation churn.
        u_heights:  { value: heights },
      },
      vertexShader:   VS,
      fragmentShader: FS,
    });
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  }

  // 32 FFT bins → 48 spike targets. Linear oversampling is enough because
  // AudioEngine's magnitudes are already log-weighted at FFT time.
  function resampleMags(src, dst) {
    const sMax = (src ? src.length : 0) - 1;
    if (sMax < 1) { for (let i = 0; i < dst.length; i++) dst[i] = 0; return; }
    const dMax = dst.length - 1;
    for (let i = 0; i <= dMax; i++) {
      const f  = (i / dMax) * sMax;
      const lo = Math.min(sMax, f | 0);
      const hi = Math.min(sMax, lo + 1);
      const t  = f - lo;
      dst[i] = src[lo] * (1 - t) + src[hi] * t;
    }
  }

  const targets = new Float32Array(N);

  function render(t, frame) {
    if (!scene) init();
    if (!scene) return;

    const dt = lastT === 0 ? (1 / 60) : Math.max(0.001, Math.min(1 / 24, t - lastT));
    lastT = t;
    // Normalize the spring step to a 60fps-equivalent — keeps the pool from
    // getting jelly-slow on high-refresh displays or sluggish on dropped frames.
    const normDt = Math.min(2.5, dt * 60);

    const f = frame || {};
    const bass    = f.bass    || 0;
    const treble  = f.treble  || 0;  // not sampled by fragment but kept for parity
    const valence = f.valence != null ? f.valence : 0.5;
    const energy  = f.energy  != null ? f.energy  : 0.5;

    const react = window.Viz.controlValue('ferrofluid', 'react');

    resampleMags(f.magnitudes, targets);
    // Idle shimmer: baseline sine so the pool breathes between tracks.
    for (let i = 0; i < N; i++) {
      const idle = 0.04 * (0.4 + 0.6 * Math.sin(t * 0.7 + i * 0.52));
      if (targets[i] < idle) targets[i] = idle;
    }

    // Spring / damper per Metal spec. Stiffness ramps with bass so drops
    // punch the pool up; damping drops with bass so spikes ring longer.
    const reactiveBass = bass * react;
    const k    = 0.95 * (0.12 + reactiveBass * 2.8);
    const damp = Math.max(0.04, 0.60 - reactiveBass * 0.46);
    for (let i = 0; i < N; i++) {
      const force = (targets[i] - heights[i]) * k;
      velocities[i] = velocities[i] * (1.0 - damp * normDt) + force * normDt;
      const next = heights[i] + velocities[i] * normDt;
      heights[i] = next < 0 ? 0 : next;
    }

    // Hue drift + bass kick snap. Matches iOS: fluidHue += (0.06 + bass*1.8) deg/frame.
    fluidHue += (0.06 + reactiveBass * 1.8) * normDt / 360;
    fluidHue -= Math.floor(fluidHue);

    const u = mat.uniforms;
    u.u_hue.value     = fluidHue;
    u.u_bass.value    = reactiveBass;
    u.u_valence.value = valence;
    u.u_energy.value  = energy;
    // heights array is mutated in place — the uniform reference stays stable.

    window.vizGL.renderer.render(scene, window.vizGL.camera);
    // Silence unused-lint for treble; kept in scope so future tuning passes
    // can pull it into the fragment without re-reading the frame.
    void treble;
  }

  window.Viz.register({
    id:       'ferrofluid',
    label:    'Ferro 2',
    kind:     'webgl',
    initFn:   init,
    renderFn: render,
    controls: [
      { id: 'react', label: 'React', min: 0, max: 2.0, step: 0.05, default: 1.0 },
    ],
  });
})();
