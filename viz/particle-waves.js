// Particle Waves — 400 particles on Lissajous-ish orbits with beat-triggered
// radial kicks from random anchors. Additive blending ('lighter' composite)
// makes stacked particles read as a glowing field. Hue drifts with mid; on
// every beat the palette jumps forward 40-120 degrees and every particle
// gets a decaying radial push away from a random anchor.
//
// Render strategy: Canvas 2D.
//   CPU: 400 particles, each with phase + speed + amp + per-beat kick state.
//   Trails: translucent dark fillRect each frame instead of clearRect. The
//           alpha is user-tunable (Trail slider) and treble-modulated.
//   Composite: 'lighter' during particle draw so overlaps brighten rather
//           than occlude; restored to 'source-over' at end of frame.
//
// Reads: frame.bass / mid / treble / beatPulse / isBeatNow
//
// Port of /StudioJoeMusic/.claude/skills/studiojoe-viz/showcase/particle-waves.html
// — fakeFrame replaced with the real AudioFrame; reactivity and trail exposed
// as controls; idle state (no audio) still animates via base orbital motion.

(() => {
  if (!window.Viz) return;

  const N = 400;
  let particles = null;
  let hueBase = 0;
  let lastBeat = 0;
  let lastT = 0;

  function initParticles() {
    particles = new Array(N);
    for (let i = 0; i < N; i++) {
      particles[i] = {
        phase:     Math.random() * Math.PI * 2,
        speed:     0.3 + Math.random() * 0.9,
        yPhase:    Math.random() * Math.PI * 2,
        ySpeed:    0.7 + Math.random() * 1.5,
        amp:       20 + Math.random() * 80,
        hueOffset: Math.random() * 60,
        size:      1.2 + Math.random() * 2.2,
        kick:      0,    // 0..1 — decays each frame once a beat fires
        kickX:     0,
        kickY:     0,
      };
    }
  }

  function init() {
    if (!particles) initParticles();
    // Reset per-session accumulators so re-entering the viz starts from a
    // calm state instead of mid-kick or mid-hue-drift.
    hueBase  = 0;
    lastBeat = 0;
    lastT    = 0;
  }

  // No GPU resources to free — particles stay allocated so Canvas reuse is
  // cheap on re-entry. init() resets the clocks.
  function teardown() { /* noop */ }

  function render(t, frame) {
    const ctx = window.ctx;
    if (!ctx) return;
    if (!particles) initParticles();

    // dt clamp — first frame gives 0; also cap at 0.1s so a stutter doesn't
    // launch particles across the viewport.
    const dt = lastT === 0 ? 0 : Math.min(0.1, t - lastT);
    lastT = t;

    const f       = frame || {};
    const bass    = f.bass      ?? 0;
    const mid     = f.mid       ?? 0;
    const treble  = f.treble    ?? 0;
    const beat    = f.beatPulse ?? 0;
    const isBeat  = !!f.isBeatNow;

    const W = window.innerWidth;
    const H = window.innerHeight;

    const reactivity = window.Viz.controlValue('particle-waves', 'reactivity');
    const trailBase  = window.Viz.controlValue('particle-waves', 'trail');

    // Trail layer — translucent dark fill each frame instead of clearing.
    // Low alpha = long, smeared trails. High alpha = crisp, no trails.
    // Treble adds a tiny bump so hi-hats feel the scene tighten slightly.
    const trailAlpha = Math.max(0.02, Math.min(0.5, trailBase + treble * 0.06));
    ctx.fillStyle = `rgba(5, 5, 12, ${trailAlpha})`;
    ctx.fillRect(0, 0, W, H);

    // Beat onset → fire a radial kick from a random anchor in the central
    // 40% of the viewport. 200ms debounce prevents double-fires when
    // isBeatNow latches for multiple frames. Hue jumps so the scene reads
    // as a new phrase.
    if (isBeat && t - lastBeat > 0.2) {
      lastBeat = t;
      const kx = W * (0.3 + Math.random() * 0.4);
      const ky = H * (0.3 + Math.random() * 0.4);
      for (let i = 0; i < N; i++) {
        const p = particles[i];
        p.kickX = kx;
        p.kickY = ky;
        p.kick  = 1.0;
      }
      hueBase = (hueBase + 40 + Math.random() * 80) % 360;
    }

    // Base hue drift — mids accelerate so melodic phrases shift palette
    // faster than bass-only sections. Idle with no audio still drifts at
    // 10°/sec so the viz doesn't look frozen.
    hueBase = (hueBase + dt * (10 + mid * 25)) % 360;

    const cx = W * 0.5, cy = H * 0.5;
    ctx.globalCompositeOperation = 'lighter';

    for (let i = 0; i < N; i++) {
      const p = particles[i];
      const ang = p.phase + t * p.speed;

      // Base orbital motion — Lissajous-ish with per-particle phase offsets.
      // rX and rY expand with bass / treble; i-dependent offset spreads the
      // field so particles don't collapse into a single ring.
      const rX = 260 + bass * 180 * reactivity + i * 0.25;
      const rY = 140 + treble * 120 * reactivity + Math.sin(t * 0.3 + i * 0.02) * 40;
      let x = cx + Math.cos(ang) * rX + Math.sin(ang * 2 + p.yPhase + t * p.ySpeed) * p.amp;
      let y = cy + Math.sin(ang) * rY * 0.7 + Math.cos(ang * 3 + p.yPhase) * p.amp * 0.6;

      // Radial kick — decaying push from the last beat anchor. Uses
      // exponential decay so the effect tapers smoothly rather than ending
      // on an arbitrary frame.
      if (p.kick > 0.001) {
        const dx = x - p.kickX, dy = y - p.kickY;
        const d = Math.hypot(dx, dy) + 0.01;
        const push = p.kick * 260 * reactivity;
        x += (dx / d) * push;
        y += (dy / d) * push;
        p.kick *= Math.exp(-dt * 2.5);
      }

      // Kicked particles temporarily get a 180° hue shift for visual
      // contrast against the base field — reads as "something just fired".
      const hue = (hueBase + p.hueOffset + (p.kick > 0.1 ? 180 : 0)) % 360;
      const lum = 55 + beat * 20;
      const sz  = p.size * (1 + bass * 0.6 * reactivity + p.kick * 1.5);

      ctx.fillStyle = `hsl(${hue}, 85%, ${lum}%)`;
      ctx.beginPath();
      ctx.arc(x, y, sz, 0, Math.PI * 2);
      ctx.fill();
    }

    // Restore — other viz / the trail fill next frame expect 'source-over'.
    ctx.globalCompositeOperation = 'source-over';
  }

  window.Viz.register({
    id:       'particle-waves',
    label:    'Particle Waves',
    kind:     '2d',
    initFn:   init,
    renderFn: render,
    teardownFn: teardown,
    controls: [
      { id: 'reactivity', label: 'Reactive', min: 0,    max: 2.0, step: 0.05, default: 1.0 },
      { id: 'trail',      label: 'Trail',    min: 0.02, max: 0.5, step: 0.01, default: 0.14 },
    ],
  });
})();
