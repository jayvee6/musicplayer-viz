// DVD Mode — bouncing album art with AABB physics, corner-hit particle
// bursts, rainbow hue cycle, and a glow pulse on beats. Ported from
// Packages/Core/Sources/Core/UI/Components/DVDPhysics.swift and the
// SwiftUI DVDModeView.
//
// Render strategy: Canvas 2D, reuses the global `canvas2d` + `ctx` that
// app.js's legacy 2D viz share. No shader. CPU physics only.
//
// Depends on:
//   window.Viz          (packet B1)   — registry
//   window.AudioEngine                — frame.bass / frame.beatPulse
//   canvas2d / ctx      (app.js)      — shared 2D surface

(() => {
  if (!window.Viz) return;

  const ART_SIZE     = 216;   // 20% larger than the iOS 180px baseline
  const BASE_HUE_RATE = 0.20;   // cycles/s at rest

  // Physics state — persists across init/teardown so re-entering the mode
  // picks up where it left off (artwork, velocity direction).
  let x = 100, y = 120;
  let vx = 72, vy = 58;
  let speedBoost  = 0;
  let hue         = Math.random();  // seed so re-enter doesn't always start red
  let glowPulse   = 0;
  let screenFlash = 0;
  let cornerHits  = 0;
  let cornerLabelUntil = 0;
  let particles   = [];
  let lastT       = 0;
  let artImg      = null;       // Image element, loaded lazily from #album-art
  let artSrcSeen  = null;       // cache to avoid reloading on every frame
  let reduceMotion = false;

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function loadArtFromDOM() {
    const el = document.getElementById('album-art');
    const src = el && el.getAttribute('src');
    if (!src || src === artSrcSeen) return;
    artSrcSeen = src;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => { artImg = img; };
    img.onerror = () => { artImg = null; };
    img.src = src;
  }

  function init() {
    reduceMotion = prefersReducedMotion();
    const canvas = document.getElementById('canvas-2d');
    const W = canvas ? canvas.clientWidth  : window.innerWidth;
    const H = canvas ? canvas.clientHeight : window.innerHeight;
    x = W * 0.30;
    y = H * 0.25;
    // Reduced motion = much slower baseline speed.
    const mag = reduceMotion ? 18 : Math.sqrt(72 * 72 + 58 * 58);
    const dir = Math.atan2(vy, vx);
    vx = Math.cos(dir) * mag;
    vy = Math.sin(dir) * mag;
    particles = [];
    glowPulse = 0;
    screenFlash = 0;
    lastT = 0;
    loadArtFromDOM();
  }

  function spawnCornerBurst(px, py) {
    cornerHits  += 1;
    glowPulse    = 1.0;
    screenFlash  = 0.35;
    cornerLabelUntil = performance.now() + 1800;
    const count = Math.round(window.Viz.controlValue('dvd', 'particles'));
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 100 + Math.random() * 160;
      particles.push({
        x: px, y: py,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 60,
        age: 0,
        life: 0.7 + Math.random() * 0.9,
        size: 5 + Math.random() * 8,
      });
    }
  }

  function render(t, frame) {
    const ctx    = window.ctx;
    const canvas = document.getElementById('canvas-2d');
    if (!ctx || !canvas) return;

    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const dt = lastT === 0 ? (1 / 60) : Math.min(0.05, t - lastT);
    lastT = t;

    loadArtFromDOM();
    const bass      = frame ? frame.bass      || 0 : 0;
    const beatPulse = frame ? frame.beatPulse || 0 : 0;

    // Bass hits briefly accelerate the rainbow + physics.
    if (!reduceMotion && bass > 0.55) {
      speedBoost = Math.min(speedBoost + bass * 0.5, 2.5);
    }
    speedBoost = Math.max(0, speedBoost - dt * 1.8);
    // User-adjustable base speed; reduce-motion ignores the slider and locks low.
    const userSpeed = window.Viz.controlValue('dvd', 'speed');
    const baseSpeed = reduceMotion ? 18 : userSpeed;
    const curSpeed  = baseSpeed + speedBoost * 45;

    // Normalize velocity to the current target speed.
    const len = Math.hypot(vx, vy);
    if (len > 0) {
      vx = vx / len * curSpeed;
      vy = vy / len * curSpeed;
    }

    let nx = x + vx * dt;
    let ny = y + vy * dt;
    let bx = false, by = false;
    const maxX = W - ART_SIZE;
    const maxY = H - ART_SIZE;

    if (nx < 0)       { nx = 0;    vx =  Math.abs(vx); bx = true; }
    else if (nx > maxX) { nx = maxX; vx = -Math.abs(vx); bx = true; }
    if (ny < 0)       { ny = 0;    vy =  Math.abs(vy); by = true; }
    else if (ny > maxY) { ny = maxY; vy = -Math.abs(vy); by = true; }

    x = nx; y = ny;

    if (bx && by) {
      const originX = x < 1 ? 0 : x + ART_SIZE;
      const originY = y < 1 ? 0 : y + ART_SIZE;
      spawnCornerBurst(originX, originY);
    }

    glowPulse   = Math.max(0, glowPulse   - dt * 2.5);
    screenFlash = Math.max(0, screenFlash - dt * 3.0);

    const hueRate = BASE_HUE_RATE + speedBoost * 0.35;
    hue = (hue + hueRate * dt) % 1;

    // Particle integration — gravity + aging.
    const gravity = 200;
    if (particles.length) {
      const alive = [];
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.x  += p.vx * dt;
        p.y  += p.vy * dt;
        p.vy += gravity * dt;
        p.age += dt;
        if (p.age < p.life) alive.push(p);
      }
      particles = alive;
    }

    // ── Draw ────────────────────────────────────────────────────────────
    ctx.clearRect(0, 0, W, H);

    // Screen flash overlay (corner-hit warm glow).
    if (screenFlash > 0.001) {
      ctx.fillStyle = `rgba(255, 220, 180, ${screenFlash})`;
      ctx.fillRect(0, 0, W, H);
    }

    // Accent colour drives the glow + particle colour.
    const accent = `hsl(${hue * 360}, 95%, 55%)`;

    // Glow halo — soft radial gradient sized in proportion to the album.
    // Always breathes (continuous sine) so silent DRM tracks still animate;
    // bass + beatPulse add reactivity on top.
    const breath    = 0.5 + 0.5 * Math.sin(t * 1.6);           // 0..1, ~0.25 Hz
    const reaction  = Math.max(bass, beatPulse);               // 0..~1
    const glowScale = breath * 0.15 + reaction * 0.40 + glowPulse * 0.30;
    const glowMul   = window.Viz.controlValue('dvd', 'glow');
    const glowR     = ART_SIZE * (0.65 + glowScale) * glowMul; // user-scaled
    const cx        = x + ART_SIZE / 2;
    const cy        = y + ART_SIZE / 2;

    const grd = ctx.createRadialGradient(cx, cy, ART_SIZE * 0.25, cx, cy, glowR);
    const coreAlpha = Math.min(0.95, 0.55 + glowScale * 0.35);
    grd.addColorStop(0,   `hsla(${hue * 360}, 95%, 60%, ${coreAlpha})`);
    grd.addColorStop(0.45,`hsla(${(hue * 360 + 25) % 360}, 95%, 55%, ${coreAlpha * 0.55})`);
    grd.addColorStop(1,   `hsla(${(hue * 360 + 60) % 360}, 95%, 55%, 0)`);
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
    ctx.fill();

    // Secondary beat flash — quick white wash tucked close to the art so it
    // reads as a punch, not a burn. Shrinks with beatPulse decay.
    if (beatPulse > 0.05) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const flashR = ART_SIZE * (0.55 + beatPulse * 0.35);
      const flashGrd = ctx.createRadialGradient(cx, cy, ART_SIZE * 0.3, cx, cy, flashR);
      flashGrd.addColorStop(0, `rgba(255,255,255,${beatPulse * 0.18})`);
      flashGrd.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = flashGrd;
      ctx.beginPath();
      ctx.arc(cx, cy, flashR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Album art, or fallback rect if nothing loaded yet.
    if (artImg && artImg.complete) {
      ctx.drawImage(artImg, x, y, ART_SIZE, ART_SIZE);
    } else {
      ctx.fillStyle = accent;
      ctx.fillRect(x, y, ART_SIZE, ART_SIZE);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.font = '600 18px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('♪', x + ART_SIZE / 2, y + ART_SIZE / 2);
    }

    // Particles.
    if (particles.length) {
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        const alpha = 1 - (p.age / p.life);
        ctx.fillStyle = `hsla(${(hue + i * 0.017) % 1 * 360}, 95%, 60%, ${alpha})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Corner hit counter — fades in for ~1.8s after each corner.
    if (performance.now() < cornerLabelUntil) {
      const remaining = (cornerLabelUntil - performance.now()) / 1800;
      ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, remaining * 1.5)})`;
      ctx.font = '700 32px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`Corner ${cornerHits}!`, W / 2, H / 2);
    }
  }

  // Expose ctx globally so our render can reuse app.js's 2D context without
  // re-querying every frame. app.js already defines `ctx` at module scope;
  // we publish it on window for our sibling viz files.
  // (This is idempotent — if ctx isn't ready yet when viz/dvd-mode.js loads,
  // render() will short-circuit on its `if (!ctx)` guard until bootstrap.)
  const pub = () => {
    if (!window.ctx && typeof ctx !== 'undefined') window.ctx = ctx; // no-op in browser
  };
  try { pub(); } catch { /* ctx is module-scoped in app.js; see render() */ }

  window.Viz.register({
    id:     'dvd',
    label:  'DVD',
    kind:   '2d',
    initFn: init,
    renderFn: render,
    controls: [
      { id: 'speed',     label: 'Speed',     min: 30,  max: 160, step: 5,    default: 80  },
      { id: 'glow',      label: 'Glow',      min: 0,   max: 2.0, step: 0.05, default: 1.0 },
      { id: 'particles', label: 'Particles', min: 10,  max: 120, step: 5,    default: 50  },
    ],
  });
})();
