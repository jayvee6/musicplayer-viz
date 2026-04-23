// Rorschach — bilateral-symmetric metaball inkblot breathing on parchment.
// Ported from Packages/Core/Sources/Core/Rendering/Shaders/Rorschach.metal.
//
// Render strategy: single full-screen quad fragment shader. CPU only passes
// uniforms — no accumulators. The 7-node metaball SDF, 3-octave FBM ink
// texture, and bilateral fold all happen per-pixel in GLSL.
//
// Depends on:
//   window.Viz, window.AudioEngine, window.vizGL, THREE

(() => {
  if (typeof THREE === 'undefined' || !window.Viz) return;

  const VS = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  `;

  // Straight port of Rorschach.metal. Metal → GLSL: float2/3 → vec2/3,
  // `static float foo(...)` → `float foo(...)`. FBM loop is a fixed 3
  // iterations (constant bounds) so it compiles under GLSL ES 1.0 too.
  const FS = `
    precision highp float;

    varying vec2 vUv;

    // u_time: monotonic real time — drives edge noise animation so splatter
    // never plays backwards. u_nodeT: oscillating "drift" time — sweeps
    // forward and back so the metaball node positions slosh like ink under
    // a tilting canvas, matching how the drift slider feels when scrubbed.
    uniform float u_time;
    uniform float u_nodeT;
    uniform float u_bass;
    uniform float u_mid;
    uniform float u_treble;
    uniform vec2  u_resolution;
    uniform float u_beatPulse;
    uniform float u_valence;
    uniform float u_energy;
    uniform float u_danceability;
    uniform float u_sizeMul;
    // Raw (non-smoothed) beatPulse for sharp per-beat drop punches. The
    // main shape reads u_beatPulse which is EMA-smoothed; u_beatSharp keeps
    // the decay snappy so outlier splatter nodes bloom-and-shrink with each
    // detected onset, matching "ink drops in sync with the music".
    uniform float u_beatSharp;

    // Polynomial smooth minimum (Inigo Quilez)
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
      return mix(mix(hash2(i),               hash2(i + vec2(1.0, 0.0)), u.x),
                 mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
    }

    // 3-octave FBM, centred at 0 so it only perturbs the SDF boundary.
    float fbm3(vec2 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 3; i++) {
        v += a * (vnoise(p) - 0.5);
        p   = p * 2.1 + vec2(2.71, 1.83);
        a  *= 0.5;
      }
      return v;
    }

    // 9-node metaball SDF on the right half-plane (mirrored to form a true
    // bilateral inkblot). Node layout spread wider in x so the shape uses
    // horizontal canvas space; smin radius is small enough that distinct
    // blobs form with narrow ink bridges between them — matching the
    // fragmented character of real Rorschach cards rather than a single
    // monolithic lump.
    //
    // The beat arg is the raw beatPulse — it punches outlier splatter
    // nodes to sync visible drops with each detected onset.
    float inkSDF(vec2 p, float t, float scale, float speed, float beat) {
      float d = 1e6;

      // 0: central spine — small, anchors the seam without dominating
      {
        vec2 n = vec2(0.025, 0.000)
               + vec2(sin(t * 0.31 * speed)        * 0.018,
                      cos(t * 0.27 * speed)        * 0.025);
        d = smin(d, length(p - n) - 0.085 * scale, 0.045);
      }
      // 1: upper inner wing (pushed outward from 0.110 → 0.220)
      {
        vec2 n = vec2(0.220, 0.145)
               + vec2(sin(t * 0.41 * speed + 1.10) * 0.032,
                      cos(t * 0.37 * speed + 2.30) * 0.028);
        d = smin(d, length(p - n) - 0.078 * scale, 0.045);
      }
      // 2: lower inner wing
      {
        vec2 n = vec2(0.225, -0.150)
               + vec2(sin(t * 0.29 * speed + 3.70) * 0.030,
                      cos(t * 0.43 * speed + 0.90) * 0.028);
        d = smin(d, length(p - n) - 0.076 * scale, 0.045);
      }
      // 3: outer upper tip (0.175 → 0.330)
      {
        vec2 n = vec2(0.330, 0.075)
               + vec2(sin(t * 0.53 * speed + 2.10) * 0.038,
                      cos(t * 0.23 * speed + 4.10) * 0.032);
        d = smin(d, length(p - n) - 0.062 * scale, 0.040);
      }
      // 4: outer lower tip
      {
        vec2 n = vec2(0.315, -0.088)
               + vec2(sin(t * 0.47 * speed + 5.10) * 0.036,
                      cos(t * 0.61 * speed + 1.70) * 0.032);
        d = smin(d, length(p - n) - 0.060 * scale, 0.040);
      }
      // 5: upper head — up above the wings
      {
        vec2 n = vec2(0.075, 0.365)
               + vec2(sin(t * 0.36 * speed + 0.50) * 0.025,
                      cos(t * 0.51 * speed + 3.30) * 0.032);
        d = smin(d, length(p - n) - 0.072 * scale, 0.040);
      }
      // 6: lower tail
      {
        vec2 n = vec2(0.068, -0.355)
               + vec2(sin(t * 0.33 * speed + 4.20) * 0.022,
                      cos(t * 0.44 * speed + 1.20) * 0.028);
        d = smin(d, length(p - n) - 0.066 * scale, 0.038);
      }
      // Beat-driven pulse on the outlier nodes: near-invisible at rest
      // (0.35× radius) → big-drop at beat peak (~2.0× radius). Gives the
      // ink-drops-on-the-beat feel without affecting the core shape.
      float beatPulseR = 0.35 + beat * 1.65;

      // 7: outlier splatter (upper-far) — bloom-and-shrink with each onset
      {
        vec2 n = vec2(0.410, 0.240)
               + vec2(sin(t * 0.57 * speed + 1.80) * 0.050,
                      cos(t * 0.39 * speed + 3.10) * 0.050);
        d = smin(d, length(p - n) - 0.036 * scale * beatPulseR, 0.028);
      }
      // 8: outlier splatter (lower-far)
      {
        vec2 n = vec2(0.395, -0.235)
               + vec2(sin(t * 0.49 * speed + 4.60) * 0.045,
                      cos(t * 0.33 * speed + 0.70) * 0.050);
        d = smin(d, length(p - n) - 0.034 * scale * beatPulseR, 0.028);
      }

      // 9: tiny tertiary droplet (upper-far-outer) — only visible on strong
      // beats, giving the classic "splash of far-flung drops" look.
      if (beat > 0.25) {
        vec2 n = vec2(0.490, 0.180)
               + vec2(sin(t * 0.71 + 2.40) * 0.030,
                      cos(t * 0.43 + 0.90) * 0.030);
        d = smin(d, length(p - n) - 0.020 * scale * beat, 0.020);
      }
      // 10: tiny tertiary droplet (lower-far-outer)
      if (beat > 0.25) {
        vec2 n = vec2(0.480, -0.175)
               + vec2(sin(t * 0.63 + 5.10) * 0.030,
                      cos(t * 0.37 + 3.70) * 0.030);
        d = smin(d, length(p - n) - 0.018 * scale * beat, 0.020);
      }

      return d;
    }

    void main() {
      float aspect = u_resolution.x / u_resolution.y;
      vec2 uv = (vUv - 0.5) * vec2(aspect, 1.0);
      vec2 p  = vec2(abs(uv.x), uv.y);

      float t  = u_time;   // monotonic — for edge noise animation
      float nt = u_nodeT;  // oscillating — for node positions + breath

      // Slow breathing baseline — uses nodeT so breath inhales/exhales with
      // the same oscillating drift as the blob positions.
      float breath = 1.0 + sin(nt * 0.19) * 0.035 + cos(nt * 0.13) * 0.020;
      // u_bass / u_mid / u_treble / u_beatPulse are EMA-smoothed on the CPU
      // side (sub-second time constants) — still clearly audio-driven, but
      // without per-frame jitter. Weights chosen so a sustained bass hit
      // can grow the scale by ~50% and mid can ~double the drift speed.
      float scale  = breath * u_sizeMul * (1.0 + u_bass * 0.55 + u_beatPulse * 0.20);
      float speed  = 0.55 + u_mid * 1.30 + (u_danceability - 0.5) * 0.30;

      float d = inkSDF(p, nt, scale, speed, u_beatSharp);

      // Two-layer edge displacement — coarse drift + fine splatter — so the
      // boundary reads as jagged/torn ink rather than soft curves. Both
      // layers kick out further on beats for a per-beat "splash" feel.
      float splashKick = 1.0 + u_beatSharp * 0.6;
      vec2 nCoord1 = p * 8.0  + vec2(t * 0.20, t * 0.15);
      vec2 nCoord2 = p * 28.0 + vec2(t * 0.13, -t * 0.09);
      float coarse = fbm3(nCoord1) * (0.050 + u_treble * 0.035) * splashKick;
      float fine   = fbm3(nCoord2) * (0.018 + u_treble * 0.018) * splashKick;
      d += coarse + fine;

      // Tight edge threshold — lets the noise displacement read as crisp
      // jagged ink instead of a feathered halo.
      float edgeW   = 0.006;
      float inkMask = 1.0 - smoothstep(-edgeW, edgeW, d);

      // Interior is mostly flat black (matches real Rorschach cards); a
      // subtle navy only shows up far inside dense nodes, valence-modulated.
      float depth   = clamp(-d / 0.22, 0.0, 1.0);
      float navyAmt = depth * depth * clamp(0.9 - u_valence * 1.1, 0.0, 0.4);
      vec3 inkCol   = mix(vec3(0.0), vec3(0.04, 0.05, 0.20), navyAmt);

      // Warm parchment background — classic Rorschach card.
      vec3 bgCol = vec3(0.962, 0.952, 0.938);
      vec3 col   = mix(bgCol, inkCol, inkMask);

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  let scene = null;
  let mat   = null;

  // CPU-side EMA smoothing. Raw AudioFrame values jitter per-frame; Rorschach
  // wants an ink-drop feel that still clearly tracks the music. Short-enough
  // time constants to respond within a beat or two, long-enough to filter
  // frame noise. Treble is fastest since it only drives fine edge ripple.
  const TAU_BASS   = 0.5;  // seconds to ~63% of new value
  const TAU_MID    = 0.8;
  const TAU_TREBLE = 0.3;
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
        u_time:         { value: 0 },
        u_nodeT:        { value: 0 },
        u_bass:         { value: 0 },
        u_mid:          { value: 0 },
        u_treble:       { value: 0 },
        u_resolution:   { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        u_beatPulse:    { value: 0 },
        u_valence:      { value: 0.5 },
        u_energy:       { value: 0.5 },
        u_danceability: { value: 0.5 },
        u_sizeMul:      { value: 1.0 },
        u_beatSharp:    { value: 0 },
      },
      vertexShader:   VS,
      fragmentShader: FS,
    });
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  }

  function render(t, frame) {
    if (!scene) init();
    if (!scene) return;

    const dt = lastT === 0 ? (1 / 60) : Math.min(0.1, t - lastT);
    lastT = t;

    const f = frame || {};
    smBass   = ema(smBass,   f.bass      ?? 0, dt, TAU_BASS);
    smMid    = ema(smMid,    f.mid       ?? 0, dt, TAU_MID);
    smTreble = ema(smTreble, f.treble    ?? 0, dt, TAU_TREBLE);
    smBeat   = ema(smBeat,   f.beatPulse ?? 0, dt, TAU_BEAT);

    // User controls — read every frame so the UI feels instant.
    const drift  = window.Viz.controlValue('rorschach', 'drift');
    const size   = window.Viz.controlValue('rorschach', 'size');
    const react  = window.Viz.controlValue('rorschach', 'react');

    // Oscillating drift time — sum of two incommensurate sines so the ink
    // sloshes forward and back smoothly without exact repeats. This is what
    // "slowly scrubbing the drift slider" was actually producing: slowT
    // changes direction as drift does, not monotonic advance. Amplitude
    // scaled by `drift` slider (0.1× freeze → 2× faster sweep).
    const nodeT = (Math.sin(t * 0.30) * 6.0 + Math.sin(t * 0.19) * 3.0) * drift;

    const u = mat.uniforms;
    u.u_time.value         = t;       // monotonic (edge noise)
    u.u_nodeT.value        = nodeT;   // oscillating (node drift + breath)
    u.u_bass.value         = smBass * react;
    u.u_mid.value          = smMid * react;
    u.u_treble.value       = smTreble * react;
    u.u_resolution.value.set(window.innerWidth, window.innerHeight);
    u.u_beatPulse.value    = smBeat * react;
    u.u_valence.value      = f.valence      ?? 0.5;
    u.u_energy.value       = f.energy       ?? 0.5;
    u.u_danceability.value = f.danceability ?? 0.5;
    u.u_sizeMul.value      = size;
    // Raw beatPulse straight from the frame — not smoothed. We want each
    // detected beat to punch the drops sharply and let them decay naturally
    // via the OnsetBPMDetector's own exp(-8*dt) envelope.
    u.u_beatSharp.value    = (f.beatPulse ?? 0) * react;

    window.vizGL.renderer.render(scene, window.vizGL.camera);
  }

  window.Viz.register({
    id:       'rorschach',
    label:    'Rorschach',
    kind:     'webgl',
    initFn:   init,
    renderFn: render,
    controls: [
      { id: 'drift', label: 'Drift',   min: 0.1, max: 2.0, step: 0.05, default: 1.0 },
      { id: 'size',  label: 'Size',    min: 0.5, max: 1.5, step: 0.02, default: 1.0 },
      { id: 'react', label: 'React',   min: 0,   max: 2.0, step: 0.05, default: 1.0 },
    ],
  });
})();
