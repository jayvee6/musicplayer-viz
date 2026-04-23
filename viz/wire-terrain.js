// Wire Terrain — registry port of
// /Users/jdot/Documents/Development/StudioJoeMusic/.claude/skills/studiojoe-viz/showcase/wire-terrain.html
//
// 3-octave FBM done on the GPU (vertex shader) displaces a 30×30 plane with
// 128×128 subdivisions. Height → color gradient (violet valleys → cyan
// peaks) in the fragment shader + a solid-fill glow layer beneath the
// wireframe via polygon-offset so the grid reads structured, not uniform.
// Camera orbits on an oscillating angle so the scene sweeps back and forth
// rather than purely circling.
//
// Audio reactivity pulls real frame.bass / frame.treble / frame.beatPulse
// from the AudioEngine instead of the showcase's fakeFrame synthesizer.
// Bass inflates peak height + bumps the lookAt target so the whole scene
// "breathes" on drops. Beat kicks a brief brightness pulse.
//
// Uses shared window.vizGL.renderer with its own PerspectiveCamera + Scene.
// Saves/restores renderer fog-related state (doesn't touch toneMapping —
// uses whatever the renderer has).

(() => {
  if (typeof THREE === 'undefined' || !window.Viz) return;

  const VS = `
    uniform float u_time;
    uniform float u_bass;
    uniform float u_treble;
    uniform float u_beatPulse;
    varying float vHeight;
    varying vec2  vXZ;

    float hash2(vec2 p) {
      p = fract(p * vec2(127.1, 311.7));
      p += dot(p, p + 19.19);
      return fract(p.x * p.y);
    }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash2(i),               hash2(i + vec2(1.0, 0.0)), u.x),
                 mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm(vec2 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 4; i++) {
        v += a * vnoise(p);
        p = p * 2.0 + vec2(3.14, 1.59);
        a *= 0.5;
      }
      return v;
    }

    void main() {
      vec3 pos = position;
      // Scroll the noise on the Y-of-XZ axis over time — gives the
      // "flying over terrain" feel without moving the camera along the
      // terrain's own axis.
      vec2 p  = pos.xz * 0.15 + vec2(0.0, u_time * 0.35);
      float n  = fbm(p);
      float n2 = fbm(p * 2.7 + vec2(7.1, 3.3));
      float h  = (n - 0.5) * (2.5 + u_bass * 3.5)
               + (n2 - 0.5) * (0.6 + u_treble * 0.8);
      h += u_beatPulse * 0.9;
      pos.y = h;

      vHeight = h;
      vXZ     = pos.xz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    }
  `;

  const FS = `
    precision highp float;
    uniform float u_beatPulse;
    uniform float u_bass;
    varying float vHeight;
    varying vec2  vXZ;

    void main() {
      // Height → hue: deep valleys violet, peaks cyan.
      float h01 = clamp((vHeight + 2.5) / 6.0, 0.0, 1.0);
      vec3 low  = vec3(0.55, 0.10, 0.75);
      vec3 mid  = vec3(0.20, 0.40, 0.95);
      vec3 high = vec3(0.20, 0.95, 0.90);
      vec3 col  = mix(low, mid, smoothstep(0.0, 0.55, h01));
      col       = mix(col, high, smoothstep(0.45, 1.0, h01));

      // Subtle grid-cell tint so wireframe reads structured, not uniform.
      float cell = sin(vXZ.x * 2.0) * sin(vXZ.y * 2.0);
      col *= 0.85 + 0.15 * cell;

      // Bass punches overall brightness; beat adds a quick flash.
      col *= 0.8 + u_bass * 0.45 + u_beatPulse * 0.3;

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  // Glow fill beneath the wireframe — polygon-offset nudges this mesh
  // slightly deeper than the wireframe so the grid lines aren't z-
  // fighting and the solid shading glows through the triangles.
  const GLOW_FS = `
    precision highp float;
    varying float vHeight;
    void main() {
      float h01 = clamp((vHeight + 2.5) / 6.0, 0.0, 1.0);
      gl_FragColor = vec4(vec3(0.03, 0.01, 0.08) + vec3(0.05, 0.02, 0.12) * h01, 1.0);
    }
  `;

  let scene     = null;
  let camera    = null;
  let wireMesh  = null;
  let glowMesh  = null;
  let sharedUni = null;
  let startT    = null;

  // Savings/restore. Fog + background are scene-local so no renderer-
  // level state leaks. Keep pixel ratio in case a peer viz set it.
  let prevPixelRatio = null;

  function init() {
    if (!window.vizGL && typeof window.initThree === 'function') window.initThree();
    if (!window.vizGL) { console.warn('[wire-terrain] renderer not ready'); return; }
    const renderer = window.vizGL.renderer;
    prevPixelRatio = renderer.getPixelRatio();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000008);
    // Dense fog — at density 0.035 the horizon fades inside ~30 world
    // units, which matches the showcase and keeps hills in the distance
    // from visually stacking into a noisy mess.
    scene.fog = new THREE.FogExp2(0x000008, 0.035);

    camera = new THREE.PerspectiveCamera(
      55, window.innerWidth / window.innerHeight, 0.1, 200
    );
    camera.position.set(0, 8, 16);
    camera.lookAt(0, 0, 0);

    // Geometry: 30×30 plane with dense subdivisions. Same VS runs on
    // wireframe + glow meshes so their heights stay in sync.
    const geo = new THREE.PlaneGeometry(30, 30, 128, 128);
    geo.rotateX(-Math.PI / 2);

    sharedUni = {
      u_time:      { value: 0 },
      u_bass:      { value: 0 },
      u_treble:    { value: 0 },
      u_beatPulse: { value: 0 },
    };

    const wireMat = new THREE.ShaderMaterial({
      uniforms: sharedUni,
      vertexShader: VS,
      fragmentShader: FS,
      wireframe: true,
    });
    wireMesh = new THREE.Mesh(geo, wireMat);
    scene.add(wireMesh);

    const glowMat = new THREE.ShaderMaterial({
      uniforms: sharedUni,   // share so glow tracks wireframe height
      vertexShader: VS,
      fragmentShader: GLOW_FS,
      side: THREE.DoubleSide,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    glowMesh = new THREE.Mesh(geo, glowMat);
    scene.add(glowMesh);
  }

  function teardown() {
    if (!window.vizGL) return;
    const renderer = window.vizGL.renderer;
    if (prevPixelRatio !== null) renderer.setPixelRatio(prevPixelRatio);
    // Reset startT so re-entering the viz doesn't jolt the noise phase
    // with whatever stale elapsed time the previous session left behind.
    startT = null;
  }

  function render(t, frame) {
    if (!scene) init();
    if (!scene) return;
    if (startT === null) startT = t;
    const elapsed = t - startT;

    const f    = frame || {};
    const bass = f.bass      || 0;
    const treb = f.treble    || 0;
    const beat = f.beatPulse || 0;

    const react = window.Viz.controlValue('wire-terrain', 'react');

    // Uniform push. Scale reactive audio by the React slider so idle
    // silence stays barely-moving and cranking React makes drops punch
    // much taller peaks.
    sharedUni.u_time.value      = elapsed;
    sharedUni.u_bass.value      = bass * react;
    sharedUni.u_treble.value    = treb  * react;
    sharedUni.u_beatPulse.value = beat  * react;

    // Orbit camera — oscillating angle drifts back and forth instead of
    // purely circling, so any viewing angle gets sweep through it.
    const cAng = Math.sin(elapsed * 0.08) * 0.9 + elapsed * 0.05;
    const r    = 14.0;
    camera.position.set(
      Math.cos(cAng) * r,
      7.5 + Math.sin(elapsed * 0.3) * 1.2,
      Math.sin(cAng) * r
    );
    camera.lookAt(0, 1.0 + bass * react * 0.8, 0);

    const w = window.innerWidth, h = window.innerHeight;
    if (camera.aspect !== w / h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    window.vizGL.renderer.render(scene, camera);
  }

  window.Viz.register({
    id:         'wire-terrain',
    label:      'Terrain',
    kind:       'webgl',
    initFn:     init,
    renderFn:   render,
    teardownFn: teardown,
    controls: [
      { id: 'react', label: 'React', min: 0, max: 2.0, step: 0.05, default: 1.0 },
    ],
  });
})();
