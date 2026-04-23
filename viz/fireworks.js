// Fireworks — interactive firework display visualizer. Every launch picks a
// fresh random angle (~±22° from vertical for a visible arc), a fresh random
// explosion point below the theoretical peak, a random depth layer (back /
// mid / front — smaller+dimmer far away, larger+brighter up close), and a
// random emoji theme (rocket + related debris).
//
// Not a direct iOS port — born on the web. Uses manual physics integration
// for both the rocket ascent (so the arc is truly parabolic) and the debris.
//
// Depends on:
//   window.Viz        (packet B1)   — registry with text+button controls
//   window.ctx        (app.js)      — shared 2D canvas context

(() => {
  if (!window.Viz) return;

  const GRAVITY = 520;            // px/s² — felt right for a screen-sized canvas
  const LAUNCH_SPEED_UNIT = 180;  // maps slider 0–10 → pixel/s base speed
  const EXPLOSION_UNIT = 260;     // maps slider 0–10 → pixel/s particle radial speed
  const ANGLE_RANGE_DEG = 20;     // ±20° from vertical — mild arc, consistent with distance

  // Perceived z-depth. Pulled 20% closer to the audience — nearest rockets
  // reach ~1.3× scale with 0.98 opacity; farthest are ~0.70× and dimmer.
  // Still feels like a show, not like fireworks in your face.
  function zToScale(z) { return 0.72 + z * 0.60; }   // 0.72× .. 1.32×
  function zToAlpha(z) { return 0.70 + z * 0.28; }   // 0.70   .. 0.98

  // Launch zone + apex zone — both shifted ~20% down so the show is closer
  // to the viewer. Rockets still never touch the top of the canvas.
  const HORIZON_Y_FRAC       = 0.90;   // launch from 90% down — close horizon
  const HORIZON_X_SPREAD     = 0.22;   // ± percentage of canvas width
  // Explosion band — 50% to 85% of sky height above the horizon. In canvas
  // coords (0 = top, 1 = bottom) that's 0.15–0.50 Y-fraction. Bursts can
  // now reach pretty high in the sky for a grander display.
  const APEX_MIN_FRAC        = 0.15;   // explosions never rise above 15% from top (85% sky)
  const APEX_MAX_FRAC        = 0.50;   // …and never lower than 50% down

  const rockets   = [];  // {x, y, emoji}
  const particles = []; // {x, y, vx, vy, age, life, emoji, size}

  // Emoji themes — each launch picks one at random so the rocket's debris
  // reads as thematically related ("rocket → sparkles", "heart → hearts",
  // "pumpkin → ghosts"). Adding new themes here is zero-friction.
  const THEMES = [
    { rocket: '🚀', debris: ['✨','💥','🌟','🎉']       },
    { rocket: '💘', debris: ['💖','💕','❤️','💗','💝']  },
    { rocket: '🪄', debris: ['✨','🌟','💫','⭐','✴️']   },
    { rocket: '🎃', debris: ['👻','🦇','🕸️','🕷️','🍬']  },
    { rocket: '🍾', debris: ['🎉','🎊','🥂','🎈']       },
    { rocket: '🌈', debris: ['🦄','💖','⭐','🌟','✨']   },
    { rocket: '🌸', debris: ['🌼','🌺','🌷','🌻','🏵️']  },
    { rocket: '👽', debris: ['🛸','⭐','🌙','🪐','💫']   },
    { rocket: '🐙', debris: ['🐠','🐡','🐟','🐚','🌊']   },
    { rocket: '🎊', debris: ['🎉','🎈','🥳','🪩','🍰']   },
    { rocket: '🎄', debris: ['🎁','🎅','❄️','⛄','🎀']   },
    { rocket: '🍄', debris: ['🌿','🍃','🌳','🌱','☘️']   },
    { rocket: '⚡', debris: ['⭐','✨','💫','🌟','☄️']   },
    { rocket: '🐉', debris: ['🔥','💥','✨','⚔️','🐲']   },
  ];

  function pickTheme() {
    return THEMES[(Math.random() * THEMES.length) | 0];
  }

  // Randomize within [min, max).
  function rand(min, max) { return min + Math.random() * (max - min); }

  function launch() {
    const ctx = window.ctx;
    const canvas = document.getElementById('canvas-2d');
    if (!ctx || !canvas) return;
    const W = canvas.clientWidth, H = canvas.clientHeight;

    // Hard-coded defaults — the show looks great without user tuning.
    const launchSpeed    = 7;    // slider units 0..10
    const explosionForce = 6;
    const particleCount  = 50;
    const yVariance      = 0.3;

    // Pick a random theme for this launch — rocket + matching debris set.
    const theme = pickTheme();

    // Random launch angle — wider spread than pure-vertical so the parabolic
    // arc reads visually. 90° = straight up.
    const angleDeg = rand(90 - ANGLE_RANGE_DEG, 90 + ANGLE_RANGE_DEG);
    const angleRad = angleDeg * Math.PI / 180;

    // Depth layer sampled once per launch — relative front/back within a
    // distant display (not close/far camera). Back layer reads as slightly
    // farther back on the same horizon plane.
    const z = Math.random();
    const depthScale = zToScale(z);

    // Launch speed scales with depthScale too so distant rockets move more
    // slowly on screen (parallax-consistent). Jitter keeps them from all
    // reaching the same apex.
    const jitter = rand(0.85, 1.15) * depthScale;
    const speed  = launchSpeed * LAUNCH_SPEED_UNIT * jitter;

    const vx =  speed * Math.cos(angleRad);
    const vy = -speed * Math.sin(angleRad);

    // Compressed launch zone along a "horizon" band. Back layer offset
    // slightly higher and narrower for mild parallax.
    const xSpread = HORIZON_X_SPREAD * (0.75 + z * 0.35);
    const startX  = W * 0.5 + rand(-W * xSpread, W * xSpread);
    const startY  = H * (HORIZON_Y_FRAC - (1 - z) * 0.03);

    // Explosions happen in the upper-middle — never at the top of the canvas
    // (the show is far away, so fireworks don't fill the entire sky), and
    // never near the horizon either. Random within [APEX_MIN, APEX_MAX].
    const apexMinY = H * APEX_MIN_FRAC;
    const apexMaxY = H * APEX_MAX_FRAC;
    // yVariance tightens the band: at 0, all bursts land at the mid of this
    // range; at 1 they're spread across the full band.
    const mid   = (apexMinY + apexMaxY) * 0.5;
    const half  = (apexMaxY - apexMinY) * 0.5;
    const explosionY = mid + rand(-1, 1) * half * yVariance;

    // Spawn the rocket object. Physics integrated per-frame in render() so
    // the trajectory is a real parabola, not a linear tween with easing.
    rockets.push({
      x: startX, y: startY, vx, vy,
      explosionY,
      emoji: theme.rocket,
      theme,
      z,
      depthScale,
      force: explosionForce,
      count: particleCount,
    });
  }

  function spawnBurst(cx, cy, forceSlider, count, emojis, z, depthScale) {
    // Deeper (smaller z) bursts spread a bit less because they're "farther";
    // closer ones hit full radial reach.
    const speed = forceSlider * EXPLOSION_UNIT * 0.1 * (0.80 + z * 0.35);
    for (let i = 0; i < count; i++) {
      const theta = (i / count) * Math.PI * 2 + rand(-0.12, 0.12);
      const mag   = speed * rand(0.6, 1.3);
      particles.push({
        x:  cx,
        y:  cy,
        vx: Math.cos(theta) * mag,
        vy: Math.sin(theta) * mag - rand(20, 80),
        age:  0,
        life: rand(1.2, 2.0),
        emoji: emojis[(Math.random() * emojis.length) | 0],
        size:  rand(26, 38) * depthScale,
        z,
        depthScale,
      });
    }
  }

  let lastT = 0;
  // Last auto-fire timestamp (seconds) — used for the idle fallback so the
  // show keeps running when no music is playing. Music beats override: a
  // detected onset fires immediately and resets this clock.
  let lastAutoFireT = -999;
  const IDLE_INTERVAL = 1.8;  // seconds between rockets with no music

  function render(t, frame) {
    const ctx = window.ctx;
    const canvas = document.getElementById('canvas-2d');
    if (!ctx || !canvas) return;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const dt = lastT === 0 ? (1 / 60) : Math.min(0.05, t - lastT);
    lastT = t;

    // Auto-fire: beat-driven when music is playing, timer-driven when idle.
    // frame.isBeatNow fires on the exact frame an onset is detected.
    if (frame && frame.isBeatNow) {
      launch();
      lastAutoFireT = t;
    } else if (t - lastAutoFireT > IDLE_INTERVAL) {
      launch();
      lastAutoFireT = t;
    }

    // Dark sky background — slight trail effect via translucent fill so
    // particles leave a short comet tail behind them.
    ctx.fillStyle = 'rgba(4, 6, 16, 0.30)';
    ctx.fillRect(0, 0, W, H);

    // ── Rocket physics (true parabolic arc) ────────────────────────────
    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      r.vy += GRAVITY * dt;
      r.x  += r.vx * dt;
      r.y  += r.vy * dt;
      if (r.y <= r.explosionY) {
        // Reached (or passed) the apex — detonate.
        rockets.splice(i, 1);
        spawnBurst(r.x, r.y, r.force, r.count, r.theme.debris, r.z, r.depthScale);
      }
    }

    // ── Particle physics ───────────────────────────────────────────────
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      if (p.age >= p.life) { particles.splice(i, 1); continue; }
      p.vy += GRAVITY * dt * 0.65;
      p.x  += p.vx * dt;
      p.y  += p.vy * dt;
    }

    // ── Draw — z-sorted so far rockets/particles render behind near ones ──
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Combine rockets + particles into one z-sorted draw list. Cheap at
    // typical counts (<100 items).
    const drawList = rockets.concat(particles);
    drawList.sort((a, b) => a.z - b.z);

    for (let i = 0; i < drawList.length; i++) {
      const item = drawList[i];
      const isRocket = !('life' in item);
      if (isRocket) {
        const size = 36 * item.depthScale;
        ctx.globalAlpha = zToAlpha(item.z);
        ctx.font = `${size}px -apple-system, system-ui, sans-serif`;
        ctx.fillText(item.emoji, item.x, item.y);
      } else {
        const remaining = Math.max(0, 1 - item.age / item.life);
        ctx.globalAlpha = remaining * remaining * zToAlpha(item.z);
        ctx.font = `${item.size}px -apple-system, system-ui, sans-serif`;
        ctx.fillText(item.emoji, item.x, item.y);
      }
    }
    ctx.globalAlpha = 1;
  }

  function reset() {
    rockets.length   = 0;
    particles.length = 0;
    lastAutoFireT    = -999;
  }

  window.Viz.register({
    id:    'fireworks',
    label: 'Fireworks',
    kind:  '2d',
    initFn:     reset,
    renderFn:   render,
    teardownFn: reset,
  });
})();
