// Siri Waveform — audio-reactive port of prototypes/siri-waveform-canvas.html
// into the viz registry. 4 semi-transparent neon layers drawn additively
// (globalCompositeOperation = 'lighter') with parabolic attenuation so each
// line pinches to zero at the edges. Per-layer two-pass stroke (wide dim
// glow + narrow bright core) approximates bloom without a postprocess
// pipeline — perfect for the 2D canvas path.
//
// Audio reactivity: a single "globalAmp" scalar drives how tall the waves
// reach. Baseline is a slow chaotic sine so the wave breathes during
// silence; bass + beat punch the amplitude on drops; treble subtly bumps
// layer frequencies so the wave feels tighter on busy passages.
//
// Depends on: window.Viz, window.AudioEngine, window.ctx / window.canvas2d.

(() => {
  if (!window.Viz) return;

  // Per-layer config. Each layer reads a DIFFERENT mel-bin band so the four
  // strands move on independent audio rhythms — bass drop swells magenta,
  // hi-hats punch violet, vocals push cyan. Without the per-band split,
  // every layer rode the same bass-heavy global amp and swayed in lockstep.
  const LAYERS = [
    { r: 255, g:  43, b: 214, a: 0.50, speed: 0.00060, amplitude: 0.22, frequency: 2.8, phase: 0.0, bandLo:  0, bandHi:  4 }, // magenta — sub/bass
    { r:   0, g: 229, b: 255, a: 0.50, speed: 0.00095, amplitude: 0.20, frequency: 4.2, phase: 1.7, bandLo:  5, bandHi: 12 }, // cyan — low-mids
    { r:  61, g: 107, b: 255, a: 0.50, speed: 0.00078, amplitude: 0.17, frequency: 5.6, phase: 3.1, bandLo: 13, bandHi: 20 }, // blue — mids
    { r: 200, g: 115, b: 255, a: 0.50, speed: 0.00130, amplitude: 0.15, frequency: 7.9, phase: 4.8, bandLo: 21, bandHi: 31 }, // violet — treble
  ];

  // Two-pass stroke per layer — wide dim glow + narrow bright core. With
  // 'lighter' compositing, the glow halos cross-mix into warm neon color
  // when layers overlap, while the thin cores keep the silhouette crisp.
  const PASSES = [
    { width: 10, alpha: 0.12 },
    { width:  2, alpha: 1.00 },
  ];

  // Per-layer idle breath — each layer seeded with its own phase offset so
  // even during silence the 4 strands don't sway together.
  function idleBreath(t, seed) {
    return 0.35
      + 0.12 * Math.sin(t * 0.00071 + seed * 1.3)
      + 0.08 * Math.sin(t * 0.00134 + 1.3 + seed * 2.1)
      + 0.05 * Math.sin(t * 0.00262 + 2.7 + seed * 0.7);
  }

  // Mean magnitude across a mel-bin band. AudioEngine's mags are 0..1 post-AGC
  // so no further normalization needed.
  function bandEnergy(mags, lo, hi) {
    if (!mags || !mags.length) return 0;
    const hiClamp = Math.min(hi, mags.length - 1);
    let sum = 0, n = 0;
    for (let i = lo; i <= hiClamp; i++) { sum += mags[i]; n++; }
    return n > 0 ? sum / n : 0;
  }

  function render(t, frame) {
    const ctx = window.ctx;
    const canvas = window.canvas2d;
    if (!ctx || !canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const w   = canvas.width / dpr;
    const h   = canvas.height / dpr;
    const cy  = h / 2;

    const f      = frame || {};
    const beat   = f.beatPulse || 0;
    const mags   = f.magnitudesSmooth || f.magnitudes;

    const react = window.Viz.controlValue('siri-waveform', 'react');

    // Beat is broadband — it still nudges every layer together on drops,
    // but scaled way down so each strand's band-energy dominates its motion.
    const beatKick = beat * 0.35 * react;

    // Isolate canvas state via save/restore — without this, our 'lighter'
    // globalCompositeOperation leaked into whichever 2D viz the user
    // switched to next, causing frames to accumulate additively instead of
    // replacing (emoji / mandala / etc read as a giant white blob).
    ctx.save();

    // Clear. Canvas is DPR-scaled on the physical buffer but we're drawing
    // in logical pixels via ctx.setTransform from app.js's resizeCanvas.
    // Fill in source-over, then flip to additive for the layer strokes.
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#0B0B1A';
    ctx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';

    const stepX = 2;
    const time  = Date.now();

    for (let li = 0; li < LAYERS.length; li++) {
      const layer = LAYERS[li];
      const baseAmpPx = layer.amplitude * h; // amplitude as fraction of viewport

      // Per-layer band energy — this is what makes the four strands move on
      // their own rhythm. Bass band energy for magenta, treble for violet,
      // etc. Idle breath seeded by layer index so even in silence the
      // baselines don't oscillate together.
      const bandE = bandEnergy(mags, layer.bandLo, layer.bandHi);
      const amp   = Math.max(
        0.15,
        idleBreath(time, li) + bandE * 1.8 * react + beatKick,
      );
      // Treble within this layer's band tightens its own frequency — so
      // busy bands pack more ripples, idle bands stay loose.
      const freq  = layer.frequency * (1.0 + bandE * 0.5 * react);

      for (const pass of PASSES) {
        ctx.beginPath();
        ctx.lineWidth   = pass.width;
        const alpha     = layer.a * pass.alpha;
        ctx.strokeStyle = `rgba(${layer.r}, ${layer.g}, ${layer.b}, ${alpha})`;

        for (let x = 0; x <= w; x += stepX) {
          // Normalize to [-1, 1] with 0 at screen center.
          const nx  = (x / w) * 2 - 1;
          // Parabolic attenuation — exactly zero at ±1, exactly 1 at 0.
          const att = 1 - nx * nx;
          const wave = Math.sin(nx * freq + time * layer.speed + layer.phase);
          const y    = cy + wave * att * baseAmpPx * amp;
          if (x === 0) ctx.moveTo(x, y);
          else         ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  window.Viz.register({
    id:       'siri-waveform',
    label:    'Siri',
    kind:     '2d',
    renderFn: render,
    controls: [
      { id: 'react', label: 'React', min: 0, max: 2.0, step: 0.05, default: 1.0 },
    ],
  });
})();
