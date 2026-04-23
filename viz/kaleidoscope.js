// Kaleidoscope — 6-fold polar tunnel with rings, spokes, and gem-flare
// intersections. Ported from KaleidoScope.metal in the StudioJoeMusic iOS app.
//
// Render strategy: single full-screen quad shader. CPU accumulates camZ (tunnel
// depth), hue (palette rotation), and twist (mid-driven fold rotation) each
// frame. GPU does the polar fold, ring pattern, spoke Gaussians, HSL colour,
// and vignette.
//
// Depends on:
//   window.Viz       (packet B1)   — registry API
//   window.AudioEngine             — AudioFrame w/ bass/mid/treble/valence/energy
//   window.vizGL                   — shared Three.js renderer + ortho camera
//   THREE global                   — loaded via CDN in index.html

(() => {
  if (typeof THREE === 'undefined' || !window.Viz) return;

  const VS = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  `;

  // Straight port of KaleidoScope.metal::kaleido_fs. Metal → GLSL translation:
  //   float3 → vec3, fmod → mod, atan2(y,x) → atan(y,x), saturate → clamp(0,1),
  //   M_PI_F → PI constant. HSL→RGB port is 1:1 (works in either language).
  const FS = `
    precision highp float;

    varying vec2 vUv;

    uniform float u_camZ;
    uniform float u_hue;
    uniform float u_bass;
    uniform float u_mid;
    uniform float u_treble;
    uniform float u_twist;
    uniform vec2  u_resolution;
    uniform float u_valence;
    uniform float u_energy;

    const float PI = 3.14159265359;

    vec3 hsl2rgb(float h, float s, float l) {
      vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0,
                       0.0, 1.0);
      float c = (1.0 - abs(2.0 * l - 1.0)) * s;
      return vec3(l) + c * (rgb - 0.5);
    }

    void main() {
      float asp = u_resolution.x / u_resolution.y;
      vec2 p  = (vUv - 0.5) * vec2(asp, 1.0);

      float r = length(p);
      if (r < 0.002) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

      float a = atan(p.y, p.x);

      // Tunnel coord: 1/r maps centre to infinite depth; camZ advances forward.
      float depth   = 1.0 / r;
      float tunnelV = depth + u_camZ;

      // 6-fold kaleidoscope fold with mid-freq twist that grows with depth.
      const float K = 6.0;
      const float sector = (2.0 * PI) / K;
      float twisted_a = a + u_twist * (depth * 0.04);
      float fa = mod(twisted_a + 2.0 * PI * 4.0, sector);
      float mirrored_a = (fa > sector * 0.5) ? (sector - fa) : fa;
      float tunnelU = mirrored_a / (sector * 0.5);

      // Ring pattern — bright bands every 2 depth units, sharpened by cube.
      float ringPhase  = fract(tunnelV * 0.5) * 2.0 * PI;
      float ringBright = 0.5 + 0.5 * cos(ringPhase);
      ringBright = ringBright * ringBright * ringBright;

      float ring2Phase   = fract(tunnelV * 1.5 + 0.25) * 2.0 * PI;
      float ring2Bright  = max(0.0, 0.5 + 0.5 * cos(ring2Phase));
      ring2Bright       *= ring2Bright;

      // Spoke Gaussians along mirror plane + sector mid-line.
      float spokeMirror = exp(-tunnelU * tunnelU * 14.0);
      float spokeMiddle = exp(-(1.0 - tunnelU) * (1.0 - tunnelU) * 14.0) * 0.55;
      float spokeBright = spokeMirror + spokeMiddle;
      float gemBright   = spokeBright * ringBright;

      // Colour: hue cycles with time + depth + sector angle + bass; valence nudges warm/cool.
      float hue = u_hue + tunnelV * 0.10 + tunnelU * 0.55 + u_bass * 0.12;
      hue += (u_valence - 0.5) * 0.20;

      float sat = 0.88 + u_bass * 0.12;
      float lum = 0.12 + ringBright * 0.22 + ring2Bright * 0.08 + spokeBright * 0.18;
      lum *= (0.65 + u_energy * 0.70);
      lum  = min(lum, 0.85);

      vec3 col = hsl2rgb(fract(hue), sat, lum);

      // Hot gem flare at ring/spoke intersections.
      col += gemBright * vec3(0.90, 0.95, 1.00) * 0.75 * (0.6 + u_treble * 0.6);

      // Central fog + edge vignette.
      float centerFade = smoothstep(0.0, 0.06, r);
      col *= centerFade;
      float vignette = 1.0 - smoothstep(0.42, 0.52, r / max(asp, 1.0 / asp));
      col *= vignette;

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `;

  let scene = null;
  let mesh  = null;
  let mat   = null;
  // CPU-accumulated state — survives init/teardown cycles so switching away
  // and back doesn't reset the tunnel rotation.
  let camZ  = 0;
  let hue   = 0;
  let twist = 0;
  let lastT = 0;

  function init() {
    const gl = window.vizGL;
    if (!gl) {
      console.warn('[kaleidoscope] window.vizGL not ready — Blob mode must run first to bootstrap renderer');
      return;
    }
    scene = new THREE.Scene();
    mat = new THREE.ShaderMaterial({
      uniforms: {
        u_camZ:       { value: 0 },
        u_hue:        { value: 0 },
        u_bass:       { value: 0 },
        u_mid:        { value: 0 },
        u_treble:     { value: 0 },
        u_twist:      { value: 0 },
        u_resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        u_valence:    { value: 0.5 },
        u_energy:     { value: 0.5 },
      },
      vertexShader:   VS,
      fragmentShader: FS,
    });
    mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    scene.add(mesh);
  }

  function render(t, frame) {
    // Lazy bootstrap — Kaleidoscope can be the first WebGL mode activated, in
    // which case window.vizGL is still null because Blob's initThree() hasn't
    // run. Trigger it via the registry's blob initFn pathway if needed.
    if (!window.vizGL && typeof window.initThree === 'function') window.initThree();
    if (!scene) init();
    if (!scene) return; // still not ready (no THREE? no GL?)

    // CPU accumulators — frame-rate-independent via dt.
    const dt = lastT === 0 ? 0 : Math.min(0.1, t - lastT);
    lastT = t;

    const f = frame || {};
    const bass   = f.bass   ?? 0;
    const mid    = f.mid    ?? 0;
    const treble = f.treble ?? 0;

    camZ  += dt * (0.4 + bass * 2.0);
    hue   += dt * 0.05;
    twist += dt * mid * 0.3;

    const u = mat.uniforms;
    u.u_camZ.value       = camZ;
    u.u_hue.value        = hue;
    u.u_bass.value       = bass;
    u.u_mid.value        = mid;
    u.u_treble.value     = treble;
    u.u_twist.value      = twist;
    u.u_resolution.value.set(window.innerWidth, window.innerHeight);
    u.u_valence.value    = f.valence ?? 0.5;
    u.u_energy.value     = f.energy  ?? 0.5;

    window.vizGL.renderer.render(scene, window.vizGL.camera);
  }

  window.Viz.register({
    id:     'kaleidoscope',
    label:  'Kaleidoscope',
    kind:   'webgl',
    initFn: init,
    renderFn: render,
  });
})();
