// Spectrogram — scrolling mel-over-time heatmap. X axis = time (most recent
// column on the right), Y axis = frequency (bass at the bottom, treble at
// the top), brightness + hue = magnitude. Reveals the structure of music:
// kick-drum columns punch the bottom, hi-hats flash the top, sustained
// synths paint horizontal bands.
//
// Pattern adapted from Sebastian Lague's Audio-Experiments spectrogram
// (MIT — https://github.com/SebLague/Audio-Experiments). We keep a
// CPU-side ring of the last 256 frames of 32-bin mel magnitudes, upload
// it as a 2D DataTexture each frame, and let the fragment shader paint
// the gradient.
//
// Render strategy: fullscreen quad with ortho camera (shared vizGL).
// No postprocess — the heatmap is bright enough on its own and bloom
// smears the column structure.

(() => {
  if (typeof THREE === 'undefined' || !window.Viz) return;

  const TIME_COLS = 256;
  const FREQ_ROWS = 32;

  const VS = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  `;

  // Multi-stop magma-ish gradient: near-black → deep violet → magenta →
  // amber → near-white. Keeps low values readable (subtle violet) while
  // peaks pop to near-white without blooming out.
  const FS = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D u_hist;
    uniform float u_bass;
    uniform float u_gamma;

    vec3 palette(float t) {
      // t in 0..1; map through dark-violet → magenta → amber → white.
      vec3 c0 = vec3(0.020, 0.005, 0.050);   // near-black violet
      vec3 c1 = vec3(0.260, 0.050, 0.380);   // deep purple
      vec3 c2 = vec3(0.850, 0.150, 0.580);   // magenta
      vec3 c3 = vec3(1.000, 0.650, 0.200);   // amber
      vec3 c4 = vec3(1.000, 0.980, 0.900);   // warm white
      vec3 col = mix(c0, c1, smoothstep(0.00, 0.28, t));
      col = mix(col, c2, smoothstep(0.25, 0.55, t));
      col = mix(col, c3, smoothstep(0.55, 0.82, t));
      col = mix(col, c4, smoothstep(0.82, 0.98, t));
      return col;
    }

    void main() {
      // Bass at the bottom of the frame → invert Y since mel bin 0 is bass
      // and we want it drawn low on screen.
      vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
      float amp = texture2D(u_hist, uv).r;

      // Gamma on amplitude. u_gamma < 1 flattens (makes quiet parts
      // readable), u_gamma > 1 crushes quiet parts so only peaks show.
      float shaped = pow(amp, u_gamma);

      vec3 col = palette(shaped);

      // Subtle bass-driven ambient pulse — whole image brightens slightly
      // on each kick so the "chest-punch" reads visually.
      col *= 1.0 + u_bass * 0.12;

      // Soft vertical edge fade so the top/bottom don't look hard-cut.
      float vfade = smoothstep(0.0, 0.04, vUv.y) * smoothstep(1.0, 0.96, vUv.y);
      col *= vfade;

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  let scene   = null;
  let mat     = null;
  let histTex = null;
  // Row-major Uint8Array: [col * FREQ_ROWS + row]. Upload order matches
  // DataTexture's expected memory layout (width = TIME_COLS, height = FREQ_ROWS,
  // row-major so row 0 is the first FREQ_ROWS bytes, i.e. all time columns
  // at frequency row 0).
  const hist = new Uint8Array(TIME_COLS * FREQ_ROWS);

  // The DataTexture memory layout needs to be (for each row y) all TIME_COLS
  // pixels concatenated. Our write-in strategy: keep a simple row-major
  // buffer where hist[y * TIME_COLS + x] is pixel (x, y). Each frame we
  // shift every row left by one (dropping the oldest sample) and write the
  // current mags into column TIME_COLS - 1. 32 × 256 = 8KB copy — fast.
  function pushFrame(mags) {
    if (!mags || !mags.length) {
      // No data — shift and seed zeros so the image decays cleanly.
      for (let y = 0; y < FREQ_ROWS; y++) {
        const rowOff = y * TIME_COLS;
        hist.copyWithin(rowOff, rowOff + 1, rowOff + TIME_COLS);
        hist[rowOff + TIME_COLS - 1] = 0;
      }
      return;
    }
    const n = Math.min(FREQ_ROWS, mags.length);
    for (let y = 0; y < FREQ_ROWS; y++) {
      const rowOff = y * TIME_COLS;
      hist.copyWithin(rowOff, rowOff + 1, rowOff + TIME_COLS);
      // Map row y to mag bin — flip so row 0 is bass, row FREQ_ROWS-1 is treble.
      // (The shader already inverts Y so bass ends up at the bottom.)
      const magIdx = y < n ? y : n - 1;
      const v = mags[magIdx];
      hist[rowOff + TIME_COLS - 1] =
        v <= 0 ? 0 : (v >= 1 ? 255 : Math.round(v * 255));
    }
  }

  function init() {
    if (!window.vizGL && typeof window.initThree === 'function') window.initThree();
    if (!window.vizGL) { console.warn('[spectrogram] renderer not ready'); return; }

    scene = new THREE.Scene();
    histTex = new THREE.DataTexture(
      hist, TIME_COLS, FREQ_ROWS, THREE.LuminanceFormat, THREE.UnsignedByteType
    );
    histTex.minFilter = THREE.LinearFilter;
    histTex.magFilter = THREE.LinearFilter;
    histTex.wrapS = THREE.ClampToEdgeWrapping;
    histTex.wrapT = THREE.ClampToEdgeWrapping;
    histTex.needsUpdate = true;

    mat = new THREE.ShaderMaterial({
      uniforms: {
        u_hist:  { value: histTex },
        u_bass:  { value: 0 },
        u_gamma: { value: 0.65 },
      },
      vertexShader:   VS,
      fragmentShader: FS,
    });
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  }

  function render(t, frame) {
    if (!scene) init();
    if (!scene) return;

    const f = frame || {};
    // Prefer the EMA-smoothed mags so column tips don't jitter frame-to-frame.
    // Falls back to raw mags for backwards-compat in case audio-engine.js
    // hasn't shipped the smoothed field yet.
    pushFrame(f.magnitudesSmooth || f.magnitudes);
    histTex.needsUpdate = true;

    const react = window.Viz.controlValue('spectrogram', 'react');
    const gammaCtl = window.Viz.controlValue('spectrogram', 'gamma');

    mat.uniforms.u_bass.value  = (f.bass || 0) * react;
    mat.uniforms.u_gamma.value = gammaCtl;

    window.vizGL.renderer.render(scene, window.vizGL.camera);
  }

  window.Viz.register({
    id:       'spectrogram',
    label:    'Spectro',
    kind:     'webgl',
    initFn:   init,
    renderFn: render,
    controls: [
      { id: 'react', label: 'React', min: 0,   max: 2.0, step: 0.05, default: 1.0 },
      // Gamma < 1 flattens (quiet parts readable); > 1 crushes (only peaks).
      { id: 'gamma', label: 'Gamma', min: 0.3, max: 1.6, step: 0.05, default: 0.65 },
    ],
  });
})();
