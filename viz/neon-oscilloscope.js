// Neon Oscilloscope — registry wrapper around prototypes/neon-oscilloscope.html.
// 4 Z-stacked ribbons (cyan / magenta / blue / purple) rendered additively
// with a glowing UnrealBloomPass. Symmetric-pinch wave + sin(πu) taper so
// each ribbon stays a thin strip that hits zero height at both ends.
//
// Audio reactivity (on top of the prototype's math):
//   - bass     → master amplitude (1.0 baseline + 1.8× at peak)
//   - treble   → noise contribution (0.4 baseline + 1.2× at peak)
//   - beatPulse → bloom strength kick (+0.8 over 1.5 baseline per beat)
//
// Owns its own PerspectiveCamera (shared window.vizGL.camera is ortho) and
// its own EffectComposer. Saves/restores renderer tone mapping + pixel ratio
// so disco-chrome's ACES state doesn't leak in and vice-versa.

(() => {
  if (typeof THREE === 'undefined' || !window.Viz) return;
  if (!THREE.EffectComposer || !THREE.UnrealBloomPass) {
    console.warn('[neon-oscilloscope] EffectComposer/UnrealBloomPass not loaded');
    return;
  }

  // Each ribbon is dedicated to a frequency band so you can read the
  // spectrum at a glance: magenta lows pumping with the bass, cyan mids
  // riding vocals, purple highs sparkling on hats / treble, blue ribbon
  // carrying the full-mix envelope.
  const RIBBON_Z      = [-7.5, -2.5, 2.5, 7.5];
  const RIBBON_COLORS = [0xff2bd6, 0x00ffff, 0xb44bff, 0x3d6bff];
  const RIBBON_BANDS  = ['lows', 'mids', 'highs', 'full'];
  const RIBBON_GAIN   = [6.5,    5.8,    5.0,     4.2];
  const PLANE_WIDTH    = 100;
  const PLANE_HEIGHT   = 2;
  const WIDTH_SEGMENTS = 200;

  let scene     = null;
  let camera    = null;
  let ribbons   = null;
  let composer  = null;
  let bloomPass = null;
  let startT    = null;

  // Token from window.vizGL.pushRendererState — snapshot of the renderer
  // keys we mutated so teardown can restore them (so we don't leak neon
  // linear output into other viz).
  let rendererToken = null;

  function init() {
    if (!window.vizGL && typeof window.initThree === 'function') window.initThree();
    if (!window.vizGL) { console.warn('[neon-oscilloscope] renderer not ready'); return; }
    const renderer = window.vizGL.renderer;

    // Reinhard tone mapping (`c / (c + 1)`) before bloom — recommended by
    // Daniel Sandner's Audio Shader Studio guide for exactly this setup:
    // additive neon + UnrealBloomPass tends to whiteout without HDR
    // compression. ACES (disco-chrome's default) would crush neon
    // saturation; NoToneMapping lets bright peaks peg at 1.0. Reinhard
    // keeps saturation AND prevents the pure-white core we saw. sRGB
    // output encoding handles the gamma on top.
    rendererToken = window.vizGL.pushRendererState({
      toneMapping:         THREE.ReinhardToneMapping,
      toneMappingExposure: 1.0,
      outputEncoding:      THREE.sRGBEncoding,
      pixelRatio:          Math.min(window.devicePixelRatio, 2),
    });

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000005);

    camera = new THREE.PerspectiveCamera(
      45, window.innerWidth / window.innerHeight, 0.1, 500
    );
    // Pulled in from z=55 to z=28 so peaks actually read tall on-screen.
    // At z=55 the plane (100 wide × ±peakHeight tall) sits so far back that
    // even a 3-unit peak is under 5% of the visible height. At z=28 the
    // same peak covers ~15% — reads as a real spike instead of a ripple.
    camera.position.set(0, 3, 28);
    camera.lookAt(0, 0, 0);

    ribbons = RIBBON_Z.map((z, i) => {
      const geom = new THREE.PlaneGeometry(PLANE_WIDTH, PLANE_HEIGHT, WIDTH_SEGMENTS, 1);
      const mat  = new THREE.MeshBasicMaterial({
        color:       RIBBON_COLORS[i],
        transparent: true,
        opacity:     0.5,
        blending:    THREE.AdditiveBlending,
        depthWrite:  false,
        side:        THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.z = z;
      scene.add(mesh);

      // Cache original X (once) + original Y (for pinch sign) per vertex.
      // Using raw array access in render instead of pos.getX/setY is ~30%
      // faster on the 1,608 verts/frame path (4 ribbons × 402 verts).
      const pos   = geom.attributes.position;
      const arr   = pos.array; // interleaved [x,y,z, x,y,z, ...]
      const origX = new Float32Array(pos.count);
      const origY = new Float32Array(pos.count);
      for (let v = 0; v < pos.count; v++) {
        origX[v] = arr[v * 3];
        origY[v] = arr[v * 3 + 1];
      }
      mesh.userData.origX = origX;
      mesh.userData.origY = origY;
      mesh.userData.idx   = i;
      return mesh;
    });

    composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));
    // The prototype's (1.5, 1.0, 0.1) assumed a blank scene with just a few
    // low-amplitude ribbons. With FFT-driven peaks + 4 colors additively
    // stacking, anything over ~threshold 0.3 is already bright; the low
    // threshold was making every pixel of every ribbon bloom. Tighter
    // values isolate the bloom to actual peaks.
    bloomPass = new THREE.UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.7, 0.6, 0.45
    );
    bloomPass.renderToScreen = true;
    composer.addPass(bloomPass);
  }

  function teardown() {
    if (!window.vizGL) return;
    window.vizGL.popRendererState(rendererToken);
    rendererToken = null;
    // Release GPU resources (playbook: TeardownFn disposes on mode-out).
    // 4 ribbons × PlaneGeometry(200 segs) + bloom MRT chain — noticeable
    // if we leave it alive across 15 mode switches.
    if (ribbons) {
      for (const r of ribbons) {
        if (r.geometry) r.geometry.dispose();
        if (r.material) r.material.dispose();
      }
    }
    if (composer && typeof composer.dispose === 'function') composer.dispose();
    scene     = null;
    camera    = null;
    ribbons   = null;
    composer  = null;
    bloomPass = null;
    // Reset startT so re-entering the viz doesn't jolt the elapsed-time
    // clock with whatever stale value the previous session left behind.
    startT = null;
  }

  // Envelope sample of the time-domain waveform at position `x`. Takes the
  // absolute value of 5 adjacent samples and averages — this is a boxcar
  // low-pass in amplitude space, so opposite-sign swings within the window
  // don't cancel (like a naive average would) but successive-sample
  // jaggedness smooths into the Siri-waveform envelope curve. Per-ribbon
  // sample shift so each color hits a slightly different slice of the
  // buffer and the 4 lines stack with visible misalignment.
  function waveAt(x, waveform, idx) {
    if (!waveform || !waveform.length) return 0;
    const xNorm = (x + PLANE_WIDTH / 2) / PLANE_WIDTH; // 0..1
    const clamped = xNorm < 0 ? 0 : (xNorm > 1 ? 1 : xNorm);
    const shift  = idx * 13;    // per-ribbon sample offset
    const center = Math.floor(clamped * (waveform.length - 1)) + shift;
    // 5-tap window — wide enough to kill single-sample jitter, narrow enough
    // to keep the individual peaks distinguishable (9-tap smeared them).
    const WIN = 2;
    let sum = 0;
    for (let k = -WIN; k <= WIN; k++) {
      const i = ((center + k) % waveform.length + waveform.length) % waveform.length;
      const v = waveform[i] || 0;
      sum += v < 0 ? -v : v;
    }
    return sum / (WIN * 2 + 1);
  }

  // Non-zero iff the analyser has real audio (local playback, mic, tab
  // capture). DRM Spotify playback leaves waveform all zeros — detect that
  // so we can fall back to synthetic spikes.
  function waveformHasSignal(waveform) {
    if (!waveform) return false;
    let peak = 0;
    // Step 16 — cheap check, buffer is highly autocorrelated at that scale.
    for (let i = 0; i < waveform.length; i += 16) {
      const a = waveform[i] < 0 ? -waveform[i] : waveform[i];
      if (a > peak) peak = a;
      if (peak > 0.01) return true;
    }
    return false;
  }

  // Amplitude at X for a single ribbon. Real waveform when the analyser has
  // signal, synthetic spiky pattern (triple-sine product raised to a power)
  // when it's silent. `bandVal` is the ribbon's assigned band energy
  // (bass / mid / treble / avg) — scales peak height so each ribbon only
  // spikes when its frequency range is actually loud. Ambient dual-sine
  // breath keeps the ribbon alive regardless of audio source.
  function waveAmplitude(x, t, idx, waveform, hasSignal, bandVal, bandGain, beat) {
    const phase = idx * 1.7;
    const speed = 1.0 + idx * 0.15;

    const ambient = Math.sin(x * 0.20 + t * 2.0 * speed + phase)       * 0.12
                  + Math.sin(x * 0.55 - t * 1.5 * speed + phase * 1.3) * 0.07;

    // Band-driven peak scale: a small floor so the ribbon isn't flat when
    // its band is quiet, plus the band's current energy times its per-ribbon
    // gain. Beat adds a universal kick so drops read across all ribbons.
    const peakScale = 0.15 + bandVal * bandGain + beat * 0.7;

    if (hasSignal) {
      // waveAt returns an already-smoothed envelope (0..1ish). Raised to
      // power 2.0 so only the actual peaks stand tall — mid-envelope gets
      // crushed toward the baseline, matching the reference's "mostly low,
      // a few narrow spikes" distribution.
      const env = waveAt(x, waveform, idx);
      const shaped = env * env;
      return ambient + shaped * peakScale;
    }

    // Synthetic fallback — triple-sine product mostly near 0, occasionally
    // aligns into a narrow tall peak. Same shape whether or not there's
    // live audio, so DRM Spotify playback still spikes on beats.
    const xSlow  = x * 1.3 + t * 0.7 + idx * 2.4;
    const sp     = Math.sin(xSlow * 0.50)
                 * Math.sin(xSlow * 0.93 + idx)
                 * Math.sin(xSlow * 1.47 + idx * 2);
    const spikes = Math.pow(sp < 0 ? -sp : sp, 3);
    return ambient + spikes * peakScale;
  }

  function taper(xNorm) {
    const s = Math.sin(Math.PI * xNorm);
    return s > 0 ? s : 0;
  }

  function render(t, frame) {
    // All-or-nothing: `composer` is the last field init() sets, so if it's
    // truthy every other field (scene / camera / ribbons / bloomPass) is
    // populated too. If init failed partway (missing window.vizGL, shader
    // compile error, OOM, etc.) composer is still null and we bail cleanly
    // instead of throwing on `ribbons.forEach` / `bloomPass.strength` etc.
    if (!composer) init();
    if (!composer || !scene || !ribbons || !bloomPass) return;
    if (startT === null) startT = t;
    const elapsed = t - startT;

    const f    = frame || {};
    const bass     = f.bass      || 0;
    const mid      = f.mid       || 0;
    const treble   = f.treble    || 0;
    const beat     = f.beatPulse || 0;
    const waveform = f.waveform;
    const hasSig   = waveformHasSignal(waveform);

    const react = window.Viz.controlValue('neon-oscilloscope', 'react');
    const avg   = (bass + mid + treble) / 3;
    // Band value per ribbon — matches RIBBON_BANDS order.
    const BAND_VAL = [bass, mid, treble, avg];

    const invW = 1 / PLANE_WIDTH;
    for (const ribbon of ribbons) {
      const pos   = ribbon.geometry.attributes.position;
      const arr   = pos.array; // raw Float32Array, stride 3 (x,y,z)
      const origX = ribbon.userData.origX;
      const origY = ribbon.userData.origY;
      const idx   = ribbon.userData.idx;
      const bandVal  = BAND_VAL[idx] * react;
      const bandGain = RIBBON_GAIN[idx];
      const count = pos.count;
      for (let v = 0; v < count; v++) {
        const x     = origX[v];
        const xNorm = (x + PLANE_WIDTH / 2) * invW;
        const amp   = waveAmplitude(
          x, elapsed, idx, waveform, hasSig,
          bandVal, bandGain, beat * react,
        ) * taper(xNorm);
        const sign  = origY[v] >= 0 ? 1 : -1;
        arr[v * 3 + 1] = sign * amp;
      }
      pos.needsUpdate = true;
    }

    // Bloom punches briefly on every detected beat, on top of the 0.7 baseline.
    bloomPass.strength = 0.7 + beat * 0.3 * react;

    const w = window.innerWidth, h = window.innerHeight;
    if (camera.aspect !== w / h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    composer.setSize(w, h);
    // Bloom at half-res (playbook) — composer.setSize resizes all passes
    // including bloom to w,h, so override must follow it each frame.
    bloomPass.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));

    composer.render();
  }

  window.Viz.register({
    id:         'neon-oscilloscope',
    label:      'Neon Osc',
    kind:       'webgl',
    initFn:     init,
    renderFn:   render,
    teardownFn: teardown,
    controls: [
      { id: 'react', label: 'React', min: 0, max: 2.0, step: 0.05, default: 1.0 },
    ],
  });
})();
