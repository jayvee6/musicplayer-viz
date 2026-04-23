// Rorschach — registry port of
// /Users/jdot/Documents/Development/StudioJoeMusic/.claude/skills/studiojoe-viz/showcase/fluid-ink.html
//
// Bilateral metaball SDF (7 nodes mirrored across the y-axis) with polynomial
// smin, 2-layer FBM edge displacement, and the dual-time drift pattern
// (monotonic `u_time` for noise, oscillating `u_nodeT` for node positions).
// Cyan → magenta interior gradient over a near-black background with a subtle
// blue edge glow — the original "Rorschach inkblot on parchment" look was
// replaced here because the fluid-ink rendering is strictly better (richer
// palette, true edge glow, cleaner SDF with fewer structural nodes).
//
// Prod extensions on top of the showcase:
//   - `drift` / `size` / `react` sliders
//   - CPU-side EMA smoothing on bass/mid/treble/beat so ink responds musical-
//     ly rather than twitching on per-frame jitter.
//
// Uses the shared window.vizGL.renderer + its ortho camera (fullscreen quad).

(() => {
  if (typeof THREE === 'undefined' || !window.Viz) return;

  const VS = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  `;

  const FS = `
    precision highp float;
    varying vec2 vUv;

    // u_time:  monotonic real time — drives edge noise so FBM animation
    //          never plays backwards even when u_nodeT sweeps back.
    // u_nodeT: oscillating drift time — sweeps forward and back so the
    //          metaball node positions slosh like ink under a tilting
    //          canvas. Amplitude set CPU-side by the drift slider.
    uniform float u_time;
    uniform float u_nodeT;
    uniform float u_bass;
    uniform float u_treble;
    uniform float u_beatSharp;
    uniform float u_sizeMul;
    uniform vec2  u_resolution;

    float smin(float a, float b, float k) {
      float h = max(k - abs(a - b), 0.0) / k;
      return min(a, b) - h * h * k * 0.25;
    }
    float hash2(vec2 p) {
      p = fract(p * vec2(127.1, 311.7));
      p += dot(p, p + 19.19);
      return fract(p.x * p.y);
    }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x),
                 mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm3(vec2 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 3; i++) {
        v += a * (vnoise(p) - 0.5);
        p = p * 2.1 + vec2(2.71, 1.83);
        a *= 0.5;
      }
      return v;
    }

    // 7 metaball nodes on the right half-plane. Bilateral fold (abs(uv.x))
    // mirrors them across the y-axis for true symmetric ink.
    float inkSDF(vec2 p, float nt, float scale, float speed, float beat) {
      float d = 1e6;

      // Central spine — anchors the seam without dominating.
      {
        vec2 n = vec2(0.030, 0.000)
               + vec2(sin(nt * 0.31 * speed) * 0.018,
                      cos(nt * 0.27 * speed) * 0.025);
        d = smin(d, length(p - n) - 0.090 * scale, 0.045);
      }
      // Inner upper wing.
      {
        vec2 n = vec2(0.220, 0.145)
               + vec2(sin(nt * 0.41 * speed + 1.1) * 0.032,
                      cos(nt * 0.37 * speed + 2.3) * 0.028);
        d = smin(d, length(p - n) - 0.078 * scale, 0.045);
      }
      // Inner lower wing.
      {
        vec2 n = vec2(0.225, -0.150)
               + vec2(sin(nt * 0.29 * speed + 3.7) * 0.030,
                      cos(nt * 0.43 * speed + 0.9) * 0.028);
        d = smin(d, length(p - n) - 0.076 * scale, 0.045);
      }
      // Outer upper tip.
      {
        vec2 n = vec2(0.330, 0.075)
               + vec2(sin(nt * 0.53 * speed + 2.1) * 0.038,
                      cos(nt * 0.23 * speed + 4.1) * 0.032);
        d = smin(d, length(p - n) - 0.062 * scale, 0.040);
      }
      // Outer lower tip.
      {
        vec2 n = vec2(0.315, -0.088)
               + vec2(sin(nt * 0.47 * speed + 5.1) * 0.036,
                      cos(nt * 0.61 * speed + 1.7) * 0.032);
        d = smin(d, length(p - n) - 0.060 * scale, 0.040);
      }

      // Outlier splatter nodes — punched by raw beat so each detected onset
      // momentarily bulges these two droplets beyond the main shape.
      float beatPulseR = 0.35 + beat * 1.65;
      {
        vec2 n = vec2(0.410, 0.240)
               + vec2(sin(nt * 0.57 * speed + 1.8) * 0.050,
                      cos(nt * 0.39 * speed + 3.1) * 0.050);
        d = smin(d, length(p - n) - 0.036 * scale * beatPulseR, 0.028);
      }
      {
        vec2 n = vec2(0.395, -0.235)
               + vec2(sin(nt * 0.49 * speed + 4.6) * 0.045,
                      cos(nt * 0.33 * speed + 0.7) * 0.050);
        d = smin(d, length(p - n) - 0.034 * scale * beatPulseR, 0.028);
      }
      return d;
    }

    void main() {
      float aspect = u_resolution.x / u_resolution.y;
      vec2 uv = (vUv - 0.5) * vec2(aspect, 1.0);
      vec2 p  = vec2(abs(uv.x), uv.y);   // bilateral fold → symmetric ink

      float t  = u_time;
      float nt = u_nodeT;

      // Breath — very slow sine, almost imperceptible on its own but keeps
      // the ink from looking plastic during quiet passages.
      float breath = 1.0 + sin(nt * 0.19) * 0.035 + cos(nt * 0.13) * 0.020;
      float scale  = breath * (1.0 + u_bass * 0.55 + u_beatSharp * 0.20) * u_sizeMul;
      float speed  = 0.65 + u_bass * 0.80;

      float d = inkSDF(p, nt, scale, speed, u_beatSharp);

      // Two-layer FBM edge displacement — coarse wobble + fine grain. Both
      // kicked by beat so splatter explodes outward on drops.
      float splashKick = 1.0 + u_beatSharp * 0.6;
      vec2 nCoord1 = p * 8.0  + vec2(t * 0.20, t *  0.15);
      vec2 nCoord2 = p * 28.0 + vec2(t * 0.13, t * -0.09);
      float coarse = fbm3(nCoord1) * (0.050 + u_treble * 0.035) * splashKick;
      float fine   = fbm3(nCoord2) * (0.018 + u_treble * 0.018) * splashKick;
      d += coarse + fine;

      float edgeW   = 0.006;
      float inkMask = 1.0 - smoothstep(-edgeW, edgeW, d);

      // Cyan → magenta depth gradient. `depth` grows as we move deeper inside
      // the shape; outer edge reads cool (cyan/blue) and interior core reads
      // warm (magenta). Squared for a softer rolloff near the edge.
      float depth    = clamp(-d / 0.25, 0.0, 1.0);
      vec3 inkInner  = mix(vec3(0.05, 0.90, 0.98), vec3(0.95, 0.35, 0.90), depth);
      vec3 inkEdge   = vec3(0.06, 0.50, 0.85);
      vec3 inkCol    = mix(inkEdge, inkInner, depth * depth);

      vec3 bgCol = vec3(0.02, 0.03, 0.06);
      vec3 col   = mix(bgCol, inkCol, inkMask);

      // Edge glow — exp-decay from the zero-crossing. Beat kicks the glow
      // intensity so each onset briefly flares around the ink.
      float glow = exp(-abs(d) * 30.0) * 0.6;
      col += vec3(0.3, 0.6, 0.9) * glow * (0.5 + u_beatSharp * 1.2);

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  let scene = null;
  let mat   = null;

  // CPU EMA smoothing (kept from the earlier rorschach). VizEnv would be a
  // one-liner here but this predates it; preserving the time-constants that
  // the design settled on (bass/treble snap fast; mid for pacing; beat raw).
  const TAU_BASS   = 0.25;
  const TAU_MID    = 0.40;
  const TAU_TREBLE = 0.30;
  const TAU_BEAT   = 0.25;
  let smBass = 0, smMid = 0, smTreble = 0, smBeat = 0;
  let lastT  = 0;

  function ema(cur, target, dt, tau) {
    const k = 1 - Math.exp(-dt / tau);
    return cur + (target - cur) * k;
  }

  function init() {
    if (!window.vizGL && typeof window.initThree === 'function') window.initThree();
    const gl = window.vizGL;
    if (!gl) { console.warn('[rorschach] window.vizGL not ready'); return; }
    scene = new THREE.Scene();
    mat = new THREE.ShaderMaterial({
      uniforms: {
        u_time:       { value: 0 },
        u_nodeT:      { value: 0 },
        u_bass:       { value: 0 },
        u_treble:     { value: 0 },
        u_beatSharp:  { value: 0 },
        u_sizeMul:    { value: 1.0 },
        u_resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
      },
      vertexShader:   VS,
      fragmentShader: FS,
    });
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  }

  function render(t, frame) {
    if (!scene) init();
    if (!scene) return;

    const dt = lastT === 0 ? (1 / 60) : Math.min(0.1, Math.max(0.001, t - lastT));
    lastT = t;

    const f = frame || {};
    smBass   = ema(smBass,   f.bass      || 0, dt, TAU_BASS);
    smMid    = ema(smMid,    f.mid       || 0, dt, TAU_MID);
    smTreble = ema(smTreble, f.treble    || 0, dt, TAU_TREBLE);
    smBeat   = ema(smBeat,   f.beatPulse || 0, dt, TAU_BEAT);

    const drift = window.Viz.controlValue('rorschach', 'drift');
    const size  = window.Viz.controlValue('rorschach', 'size');
    const react = window.Viz.controlValue('rorschach', 'react');

    // Dual-time drift: u_time advances monotonically (FBM never plays back),
    // u_nodeT sums two incommensurate sines × drift slider so node positions
    // slosh forward and back like ink under a tilting canvas.
    const nodeT = (Math.sin(t * 0.30) * 6.0 + Math.sin(t * 0.19) * 3.0) * drift;

    const u = mat.uniforms;
    u.u_time.value      = t;
    u.u_nodeT.value     = nodeT;
    u.u_bass.value      = smBass   * react;
    u.u_treble.value    = smTreble * react;
    // Raw beat (not smoothed) so each detected onset punches the splatter
    // and the glow sharply; the smBeat path would dampen that feel.
    u.u_beatSharp.value = (f.beatPulse || 0) * react;
    u.u_sizeMul.value   = size;
    u.u_resolution.value.set(window.innerWidth, window.innerHeight);
    void smMid;  // mid is ema-tracked but not currently mapped to an uniform;
                 // kept smoothed here for future pacing hooks without a warmup spike.

    window.vizGL.renderer.render(scene, window.vizGL.camera);
  }

  window.Viz.register({
    id:       'rorschach',
    label:    'Rorschach',
    kind:     'webgl',
    initFn:   init,
    renderFn: render,
    controls: [
      { id: 'drift', label: 'Drift', min: 0.1, max: 2.0, step: 0.05, default: 1.0 },
      { id: 'size',  label: 'Size',  min: 0.5, max: 1.5, step: 0.02, default: 1.0 },
      { id: 'react', label: 'React', min: 0,   max: 2.0, step: 0.05, default: 1.0 },
    ],
  });
})();
