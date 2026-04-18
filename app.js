// ─── Constants ────────────────────────────────────────────────────────────────

const EMOJIS = ['🐻','🦊','🦁','🐱','🐶','🐼','🤖','🐲','🦄','🐷','🐰','🐵'];

// ─── Audio engine ─────────────────────────────────────────────────────────────

let audioCtx, analyser, sourceNode, audioBuffer;
let frequencyData;
let isPlaying = false;
let startTime = 0;
let pauseOffset = 0;

let bass = 0, mid = 0, treble = 0;
const BASS_HISTORY_LEN = 16;
const bassHistory = new Array(BASS_HISTORY_LEN).fill(0);

function initAudio() {
  audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
  analyser   = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.8;
  frequencyData = new Uint8Array(analyser.frequencyBinCount);
  analyser.connect(audioCtx.destination);
}

function setTransportEnabled(on) {
  ['btn-rewind','play-pause','btn-fwd'].forEach(id => {
    document.getElementById(id).disabled = !on;
  });
}

function setTrackDisplayName(text) {
  const el = document.getElementById('track-name');
  el.classList.remove('ticker');
  el.style.removeProperty('--ticker-dist');
  el.style.removeProperty('--ticker-dur');
  el.textContent = text;
  // Double rAF ensures layout is settled before measuring
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const overflow = el.scrollWidth - el.offsetWidth;
    if (overflow > 4) {
      el.style.setProperty('--ticker-dist', `-${overflow + 12}px`);
      // ~40 px/s feels readable; minimum 4s so short overflows aren't frantic
      el.style.setProperty('--ticker-dur', `${Math.max(4, overflow / 40)}s`);
      el.classList.add('ticker');
    }
  }));
}

function loadAudio(file) {
  const reader = new FileReader();
  reader.onload = e => {
    audioCtx.decodeAudioData(e.target.result, buf => {
      audioBuffer = buf;
      setTransportEnabled(true);
    });
  };
  reader.readAsArrayBuffer(file);
}

function play() {
  if (!audioBuffer) return;
  if (sourceNode) { sourceNode.disconnect(); }
  sourceNode = audioCtx.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.connect(analyser);
  sourceNode.loop = true;
  sourceNode.start(0, pauseOffset % audioBuffer.duration);
  startTime = audioCtx.currentTime - pauseOffset;
  isPlaying = true;
}

function pause() {
  if (!sourceNode) return;
  pauseOffset = (audioCtx.currentTime - startTime) % audioBuffer.duration;
  sourceNode.stop();
  isPlaying = false;
}

function updateAudioValues() {
  if (!analyser) return;
  analyser.getByteFrequencyData(frequencyData);
  const len = frequencyData.length;

  const bassEnd  = Math.floor(len * 0.10);
  const midEnd   = Math.floor(len * 0.45);

  let bSum = 0, mSum = 0, tSum = 0;
  for (let i = 0;        i < bassEnd; i++) bSum += frequencyData[i];
  for (let i = bassEnd;  i < midEnd;  i++) mSum += frequencyData[i];
  for (let i = midEnd;   i < len;     i++) tSum += frequencyData[i];

  bass   = bSum / bassEnd  / 255;
  mid    = mSum / (midEnd - bassEnd) / 255;
  treble = tSum / (len - midEnd)     / 255;

  bassHistory.unshift(bass);
  bassHistory.pop();
}

// ─── Canvas 2D ───────────────────────────────────────────────────────────────

const canvas2d = document.getElementById('canvas-2d');
const ctx      = canvas2d.getContext('2d');

// Logical canvas dimensions (CSS pixels). Used by all render functions.
// Physical backing buffer = W*dpr × H*dpr so Chrome doesn't dim emoji.
let W = window.innerWidth;
let H = window.innerHeight;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  W = window.innerWidth;
  H = window.innerHeight;
  canvas2d.width  = Math.round(W * dpr);
  canvas2d.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // reset + scale in one call
}

// ── Mode 0: Geometric Mandala ──────────────────────────────────────────────

let mandalaRot = 0;
let mandalaHue = 0;

function drawPolygon(cx, cy, r, sides, rot) {
  ctx.beginPath();
  for (let i = 0; i <= sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function renderMandala() {
  ctx.globalAlpha = 1; ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(0, 0, W, H);

  const cx = W / 2, cy = H / 2;
  const maxR = Math.min(W, H) * 0.38;
  const scale = 0.4 + bass * 0.9;

  mandalaRot += 0.004 + treble * 0.06;
  mandalaHue  = (mandalaHue + 0.4 + treble * 2.5) % 360;

  const LAYERS = 6;
  for (let i = 0; i < LAYERS; i++) {
    const t      = (i + 1) / LAYERS;
    const r      = maxR * t * scale;
    const sides  = i % 2 === 0 ? 6 : 3;
    const dir    = i % 2 === 0 ? 1 : -1;
    const rot    = mandalaRot * dir + (i * Math.PI / LAYERS);
    const hue    = (mandalaHue + i * 42) % 360;
    const alpha  = 0.35 + bass * 0.65;

    ctx.save();
    ctx.strokeStyle = `hsla(${hue},100%,65%,${alpha})`;
    ctx.lineWidth   = 1.5 + bass * 4;
    ctx.shadowColor = `hsla(${hue},100%,65%,0.7)`;
    ctx.shadowBlur  = 8 + bass * 24;
    drawPolygon(cx, cy, r, sides, rot);
    ctx.stroke();

    // Second overlapping polygon offset by half a turn
    drawPolygon(cx, cy, r * 0.72, sides, rot + Math.PI / sides);
    ctx.stroke();
    ctx.restore();
  }
}

// ── Mode 1: Emoji Concentric Waves ─────────────────────────────────────────

let waveSpin      = 0;
let waveRingCount = 6;
let waveSpinSpeed = 1.0;
let waveSpacing   = 0.09;

function renderEmojiWaves() {
  ctx.globalAlpha = 1; ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
  ctx.fillStyle = '#fff';   // Reset: Chrome uses fillStyle alpha when drawing color emoji
  ctx.clearRect(0, 0, W, H);

  const cx = W / 2, cy = H / 2;
  waveSpin += 0.008 * waveSpinSpeed;

  // When spin is near zero the rings pulse like a subwoofer.
  // Only boost emoji SIZE — never touch ring radius so tightness is unaffected.
  const spinFactor = Math.min(1, waveSpinSpeed);    // 0 = stopped, 1 = full spin
  const sizeAmp    = 18 + (1 - spinFactor) * 46;   // 18 normal → 64 when stopped

  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  const RINGS = waveRingCount;
  for (let ring = 0; ring < RINGS; ring++) {
    // Outer rings read older bass values → undulating delay
    const delayedBass = ring === 0 ? bass : bassHistory[Math.min(ring * 2, BASS_HISTORY_LEN - 1)];
    const baseR  = (ring + 1) * Math.min(W, H) * waveSpacing;
    const r      = baseR * (1 + delayedBass * 0.45);
    const count  = ring === 0 ? 1 : ring * 6;
    const size   = 14 + ring * 3 + delayedBass * sizeAmp;
    const dir    = ring % 2 === 0 ? 1 : -1;

    ctx.font = `${size}px serif`;
    for (let j = 0; j < count; j++) {
      const angle = (j / count) * Math.PI * 2 + waveSpin * dir;
      ctx.fillText(EMOJIS[(ring * 4 + j) % EMOJIS.length],
        cx + r * Math.cos(angle),
        cy + r * Math.sin(angle));
    }
  }
}

// ── Mode 2: Emoji Spiral Vortex ───────────────────────────────────────────
// 12 arms radiating from a center hole, each arm = one emoji type.
// Polar layout: finalAngle = baseAngle + r * twistFactor + rotation
// creates curved pinwheel arms. Bass pumps size + twist tightness.

// Pre-render each emoji once at CACHE_SIZE px → reuse with drawImage (fast)
const CACHE_SIZE = 80;

const emojiCache = (() => {
  const map = {};
  EMOJIS.forEach(e => {
    const oc   = document.createElement('canvas');
    oc.width   = oc.height = CACHE_SIZE;
    const octx = oc.getContext('2d');
    octx.font         = `${CACHE_SIZE * 0.82}px serif`;
    octx.textAlign    = 'center';
    octx.textBaseline = 'middle';
    octx.fillText(e, CACHE_SIZE / 2, CACHE_SIZE / 2);
    map[e] = oc;
  });
  return map;
})();

let tunnelRot    = 0;
let phylloSpread = 18;   // Spread slider → twist tightness (higher = tighter spiral)
let phylloZoom   = 1.0;  // Z slider → overall scale (0.2–3.0; slider divides by 100)

const VORTEX_ARMS  = 12;
const VORTEX_STEPS = 13; // emojis per arm

// Bass-history ripple: each arm step reads bassHistory[step * rippleStepSize].
// Inner step reacts to current bass; outer steps react to older values.
// The delay IS the outward-traveling wave — no separate phase or energy state.
let rippleAmplitude = 12;  // Ripple slider: max px of radial displacement (0–30)
let rippleStepSize  = 1;   // Speed slider: history frames skipped per step (1–20)

function renderEmojiVortex() {
  ctx.globalAlpha = 1; ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
  ctx.clearRect(0, 0, W, H);
  const cx = W / 2,           cy = H / 2;

  tunnelRot += 0.004 + mid * 0.008;

  const shortSide = Math.min(W, H);
  const minR      = shortSide * 0.08;
  const maxR      = Math.sqrt(cx * cx + cy * cy) * 0.82 * phylloZoom;
  const twist     = phylloSpread * 0.00025;

  // ── Ripple engine ─────────────────────────────────────────────────────────
  // Same pattern as Emoji Waves: inner step reads current bass, each outer step
  // reads progressively older bassHistory values. The delay IS the outward wave.

  // ── Draw arms ─────────────────────────────────────────────────────────────
  for (let arm = 0; arm < VORTEX_ARMS; arm++) {
    const baseAngle = arm * (Math.PI * 2 / VORTEX_ARMS);
    const img       = emojiCache[EMOJIS[arm % EMOJIS.length]];

    for (let step = VORTEX_STEPS - 1; step >= 0; step--) {
      const t = step / (VORTEX_STEPS - 1);
      const r = minR + (maxR - minR) * t;

      // Inner step (0) reacts to current bass; each outer step reads an older
      // history entry — the delay creates the outward-traveling ripple.
      const delayedBass = step === 0 ? bass : bassHistory[Math.min(step * rippleStepSize, BASS_HISTORY_LEN - 1)];
      const displace    = delayedBass * rippleAmplitude;

      const finalAngle = baseAngle + r * twist + tunnelRot;
      const x = cx + (r + displace) * Math.cos(finalAngle);
      const y = cy + (r + displace) * Math.sin(finalAngle);

      // Treble (snare/cymbal) flashes a sharp size pop across all emojis at once.
      // No delay — the instant uniform flash contrasts the slow rolling bass ripple.
      const size = shortSide * (0.03 + t * 0.11) * (1 + treble * 1.2);
      const half = size / 2;

      ctx.globalAlpha = 0.35 + t * 0.65;
      ctx.drawImage(img, x - half, y - half, size, size);
    }
  }
  ctx.globalAlpha = 1;
}

// ── Mode 4: Hypno Rings ────────────────────────────────────────────────────
// Concentric rings zooming toward the viewer. Bass surges the speed.
// Alternating dark/light bands with a bass-reactive color accent.

let ringOffset     = 0;
let ringColorShift = 0;  // flips parity each time offset wraps — keeps bands seamless
let ringHue        = 0;

function renderHypnoRings() {
  ctx.globalAlpha = 1; ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
  const cx = W / 2, cy = H / 2;
  const maxR   = Math.sqrt(cx * cx + cy * cy) * 1.3;
  const SPACING = 46;

  // Advance offset; track wraps so color parity stays consistent
  ringOffset += (0.45 + bass * 7) * ringSpeed;
  while (ringOffset >= SPACING) {
    ringOffset     -= SPACING;
    ringColorShift += 1;
  }
  ringHue = (ringHue + 0.3 + treble * 2) % 360;

  const numRings = Math.ceil(maxR / SPACING) + 2;
  const colorPop = bass > 0.5
    ? `hsl(${ringHue},100%,${15 + bass * 30}%)`
    : '#111';

  // Fill canvas with dark color so area outside outermost ring is never bare
  ctx.fillStyle = colorPop;
  ctx.fillRect(0, 0, W, H);

  // Draw filled discs largest → smallest; parity uses ringColorShift offset.
  // Each ring reads a progressively older bassHistory value — the delay IS the
  // outward-traveling ripple, same pattern as Emoji Waves.
  for (let i = numRings; i >= 1; i--) {
    const histIdx     = Math.min(i - 1, BASS_HISTORY_LEN - 1);
    const delayedBass = bassHistory[histIdx];
    const r = i * SPACING - ringOffset + delayedBass * 18;
    if (r <= 0) continue;

    const isLight = (i + ringColorShift) % 2 === 0;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = isLight
      ? `hsl(0,0%,${82 + delayedBass * 18}%)`
      : colorPop;
    ctx.fill();
  }
}

// ── Mode 6: Subwoofer ─────────────────────────────────────────────────────────
// Realistic speaker cone viewed head-on.
// Zones: cabinet bg → basket/frame → wide rubber surround → smooth cone → dust cap
// The whole cone pumps in/out with bass. Bass-history ripple adds a subtle wave
// traveling from the voice coil outward through the cone surface.

function renderSubwoofer() {
  ctx.globalAlpha = 1; ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
  const cx = W / 2, cy = H / 2;
  const S = Math.min(W, H);

  // Speaker geometry (at rest)
  const frameR    = S * 0.46;          // outer edge of basket
  const surroundR = S * 0.43;          // outer edge of rubber surround
  const coneR     = S * 0.30;          // inner edge of surround / outer edge of cone
  const capR_rest = S * 0.09;          // dust cap rest radius

  // ── Whole-cone pump: bass pushes the cone face toward viewer ───────────────
  // Scale by depth position: surround flexes most, center flexes least (geometry)
  const pump = bass * 26;              // current bass = immediate piston movement

  // ── 1. Cabinet background ──────────────────────────────────────────────────
  ctx.fillStyle = '#060606';
  ctx.fillRect(0, 0, W, H);

  // ── 2. Basket / frame (cast metal ring) ────────────────────────────────────
  ctx.beginPath();
  ctx.arc(cx, cy, frameR, 0, Math.PI * 2);
  ctx.fillStyle = '#18160f';
  ctx.fill();

  // ── 3. Rubber surround ─────────────────────────────────────────────────────
  // Wide toroidal ring. Radial gradient fakes the curved cross-section:
  // shadow at inner junction, rising to a gloss highlight, falling to outer rim.
  // On bass the surround inner edge flexes outward (cone pumps forward).
  const surroundFlex  = bassHistory[Math.min(8, BASS_HISTORY_LEN - 1)] * 14;
  const surroundInner = coneR + surroundFlex;  // inner edge rides with the cone

  const sg = ctx.createRadialGradient(cx, cy, surroundInner, cx, cy, surroundR);
  sg.addColorStop(0,    `hsl(30,6%,${10 + surroundFlex * 0.4}%)`);  // inner shadow
  sg.addColorStop(0.25, `hsl(30,5%,${18 + surroundFlex * 0.6}%)`);  // rising
  sg.addColorStop(0.55, `hsl(30,6%,${34 + surroundFlex * 0.9}%)`);  // gloss peak
  sg.addColorStop(0.78, `hsl(30,5%,${22 + surroundFlex * 0.5}%)`);  // falling
  sg.addColorStop(1,    `hsl(30,4%,${11 + surroundFlex * 0.2}%)`);  // outer shadow

  ctx.beginPath();
  ctx.arc(cx, cy, surroundR, 0, Math.PI * 2);
  ctx.fillStyle = sg;
  ctx.fill();

  // ── 4. Cone surface ────────────────────────────────────────────────────────
  // Smooth funnel — radial gradient from rim (lighter, faces viewer) to center (dark, recedes).
  // A few faint concentric strokes hint at the cone's depth curvature.
  // The cone's apparent radius expands when it punches forward (pump).
  const coneEdge = surroundInner;   // cone outer edge tracks surround inner

  const cg = ctx.createRadialGradient(cx, cy, capR_rest * 1.1, cx, cy, coneEdge);
  cg.addColorStop(0,    `hsl(210,5%,${7  + bass * 6}%)`);   // dark center
  cg.addColorStop(0.35, `hsl(210,6%,${13 + bass * 10}%)`);  // mid
  cg.addColorStop(0.7,  `hsl(210,7%,${22 + bass * 14}%)`);  // near surround, catches light
  cg.addColorStop(1,    `hsl(210,6%,${17 + bass * 8}%)`);   // junction shadow with surround

  ctx.beginPath();
  ctx.arc(cx, cy, coneEdge, 0, Math.PI * 2);
  ctx.fillStyle = cg;
  ctx.fill();

  // Subtle depth lines — 3 faint strokes only, suggest curvature without looking like rings
  const NUM_DEPTH = 3;
  for (let i = 1; i <= NUM_DEPTH; i++) {
    const t           = i / (NUM_DEPTH + 1);
    const baseDepthR  = capR_rest * 1.4 + (coneEdge - capR_rest * 1.4) * t;
    const ripple      = bassHistory[Math.min(Math.round(t * (BASS_HISTORY_LEN - 1)), BASS_HISTORY_LEN - 1)];
    const dr          = baseDepthR + ripple * 28 * t;
    if (dr <= 0 || dr > coneEdge) continue;
    ctx.beginPath();
    ctx.arc(cx, cy, dr, 0, Math.PI * 2);
    ctx.strokeStyle = `hsla(210,5%,${6 + (1 - t) * 6 + mid * 8}%,0.55)`;
    ctx.lineWidth   = 1.8;
    ctx.stroke();
  }

  // ── 5. Dust cap ────────────────────────────────────────────────────────────
  // Large dome. Pumps with instantaneous bass (voice coil = fastest moving part).
  const capR = capR_rest + bass * capR_rest * 0.28;

  const dcg = ctx.createRadialGradient(
    cx - capR * 0.24, cy - capR * 0.26, capR * 0.05,
    cx, cy, capR
  );
  dcg.addColorStop(0,    `hsl(210,8%,${40 + bass * 30}%)`);   // specular highlight
  dcg.addColorStop(0.3,  `hsl(210,7%,${24 + bass * 18}%)`);   // dome surface
  dcg.addColorStop(0.65, `hsl(210,5%,${13 + bass * 10}%)`);   // dome shoulder
  dcg.addColorStop(1,    `hsl(210,4%,7%)`);                    // edge into cone

  ctx.beginPath();
  ctx.arc(cx, cy, capR, 0, Math.PI * 2);
  ctx.fillStyle = dcg;
  ctx.fill();

  // Cap rim line
  ctx.beginPath();
  ctx.arc(cx, cy, capR, 0, Math.PI * 2);
  ctx.strokeStyle = `hsla(210,8%,${20 + bass * 18}%,0.75)`;
  ctx.lineWidth   = 1.5;
  ctx.stroke();
}

// ── Mode 5: Spiral Rings ──────────────────────────────────────────────────────

let spiralOffset     = 0;
let spiralHue        = 0;

function renderSpiralRings() {
  ctx.globalAlpha = 1; ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
  const cx = W / 2, cy = H / 2;
  const maxR  = Math.sqrt(cx * cx + cy * cy) * 1.15;
  const PITCH = 50;
  const TURNS = Math.ceil(maxR / PITCH) + 2;
  const ARMS  = 2;
  const STEPS = 900;

  spiralOffset += (0.45 + bass * 7) * ringSpeed;
  while (spiralOffset >= PITCH) spiralOffset -= PITCH;
  spiralHue = (spiralHue + 0.3 + treble * 2) % 360;

  // Warm complementary background fills the gaps between arms
  const bgHue = (spiralHue + 25) % 360;
  const bgL   = 30 + bass * 8;
  ctx.fillStyle = `hsl(${bgHue},50%,${bgL}%)`;
  ctx.fillRect(0, 0, W, H);

  const lineW    = PITCH * 0.62;
  const thetaMax = TURNS * Math.PI * 2;

  // Build Path2D objects once per frame — stroke() reuses them across all 5 passes
  // without re-iterating the point list in JS each time.
  const armPaths = [];
  for (let arm = 0; arm < ARMS; arm++) {
    const armOff = arm * Math.PI;
    const path   = new Path2D();
    let   started = false;
    for (let s = 0; s <= STEPS; s++) {
      const theta = (s / STEPS) * thetaMax;
      const r     = spiralOffset + (theta / (Math.PI * 2)) * PITCH;
      if (r > maxR) break;
      const x = cx + r * Math.cos(theta + armOff);
      const y = cy + r * Math.sin(theta + armOff);
      if (!started) { path.moveTo(x, y); started = true; }
      else            path.lineTo(x, y);
    }
    if (started) armPaths.push(path);
  }

  function tracePaths() {
    for (const path of armPaths) ctx.stroke(path);
  }

  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  ctx.shadowBlur  = 0;
  ctx.shadowColor = 'transparent';

  // 1. Deep shadow border
  ctx.strokeStyle = `hsl(${spiralHue},80%,10%)`;
  ctx.lineWidth   = lineW + 8;
  tracePaths();

  // 2. Dark base
  ctx.strokeStyle = `hsl(${spiralHue},100%,28%)`;
  ctx.lineWidth   = lineW;
  tracePaths();

  // 3. Main mid-color with glow
  ctx.strokeStyle = `hsl(${spiralHue},100%,${50 + bass * 14}%)`;
  ctx.lineWidth   = lineW * 0.78;
  ctx.shadowColor = `hsl(${spiralHue},100%,65%)`;
  ctx.shadowBlur  = 5 + bass * 14;
  tracePaths();
  ctx.shadowBlur  = 0;
  ctx.shadowColor = 'transparent';

  // 4. Upper highlight
  ctx.strokeStyle = `hsl(${spiralHue},100%,${68 + bass * 12}%)`;
  ctx.lineWidth   = lineW * 0.42;
  tracePaths();

  // 5. Bright rim
  ctx.strokeStyle = `hsla(${spiralHue},70%,92%,0.6)`;
  ctx.lineWidth   = lineW * 0.12;
  tracePaths();

  // Fill center — radius must exceed PITCH so arm endpoints (r≤spiralOffset<PITCH)
  // are always hidden; prevents both the S-shape and the loop-wrap pop.
  // Use arm mid-color + glow so it blends as a tight spiral core, not a dark hole.
  ctx.beginPath();
  ctx.arc(cx, cy, PITCH * 1.4, 0, Math.PI * 2);
  ctx.fillStyle   = `hsl(${spiralHue},100%,${50 + bass * 14}%)`;
  ctx.shadowColor = `hsl(${spiralHue},100%,65%)`;
  ctx.shadowBlur  = 18;
  ctx.fill();
  ctx.shadowBlur  = 0;
  ctx.shadowColor = 'transparent';

  // Reset line styles so they don't leak into other render functions
  ctx.lineCap  = 'butt';
  ctx.lineJoin = 'miter';
}

// ─── Three.js — Mode 3: Raymarching Blob ─────────────────────────────────────

let threeRenderer, threeScene, threeCamera, blobMesh;
let threeReady = false;

const VERT_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAG_SHADER = `
  precision highp float;
  uniform float u_time;
  uniform float u_audio;
  uniform vec2  u_resolution;
  varying vec2  vUv;

  float sdSphere(vec3 p, float r) { return length(p) - r; }

  float scene(vec3 p) {
    float wobble =
      sin(p.x * 4.0 + u_time * 1.1) *
      sin(p.y * 3.5 + u_time * 0.75) *
      sin(p.z * 4.5 + u_time * 0.9)  *
      (0.07 + u_audio * 0.38);
    float r = 0.65 + u_audio * 0.28;
    return sdSphere(p, r) + wobble;
  }

  vec3 getNormal(vec3 p) {
    const vec2 e = vec2(0.001, 0.0);
    return normalize(vec3(
      scene(p + e.xyy) - scene(p - e.xyy),
      scene(p + e.yxy) - scene(p - e.yxy),
      scene(p + e.yyx) - scene(p - e.yyx)
    ));
  }

  void main() {
    vec2 uv = (vUv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);

    vec3 ro = vec3(0.0, 0.0, 2.2);
    vec3 rd = normalize(vec3(uv, -1.3));

    float t   = 0.0;
    bool  hit = false;

    for (int i = 0; i < 96; i++) {
      float d = scene(ro + rd * t);
      if (d < 0.0008) { hit = true; break; }
      if (t > 8.0)    break;
      t += d * 0.92;
    }

    vec3 col = vec3(0.0);

    if (hit) {
      vec3 p = ro + rd * t;
      vec3 n = getNormal(p);

      vec3 l1 = normalize(vec3( 1.0,  1.2,  2.0));
      vec3 l2 = normalize(vec3(-1.0,  0.3,  1.0));

      float d1   = max(dot(n, l1), 0.0);
      float d2   = max(dot(n, l2), 0.0) * 0.4;
      float spec = pow(max(dot(reflect(-l1, n), -rd), 0.0), 40.0);

      float hue  = u_time * 0.08 + u_audio * 0.6 + n.y * 0.4 + n.x * 0.3;
      vec3  base = 0.5 + 0.5 * cos(6.28318 * (hue + vec3(0.0, 0.33, 0.67)));

      col  = base * (d1 + d2 + 0.12);
      col += vec3(spec * 0.8);
      col += base * u_audio * 0.45;
    } else {
      // Ambient background glow behind the blob
      float fog  = exp(-length(uv) * 1.8);
      float hue2 = u_time * 0.04;
      vec3  gCol = 0.5 + 0.5 * cos(6.28318 * (hue2 + vec3(0.0, 0.33, 0.67)));
      col = gCol * fog * 0.15 * (0.4 + u_audio);
    }

    col = pow(max(col, 0.0), vec3(0.4545));
    gl_FragColor = vec4(col, 1.0);
  }
`;

function initThree() {
  const container = document.getElementById('webgl-container');

  threeRenderer = new THREE.WebGLRenderer({ antialias: false });
  threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  threeRenderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(threeRenderer.domElement);

  threeScene  = new THREE.Scene();
  threeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const geo = new THREE.PlaneGeometry(2, 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      u_time:       { value: 0.0 },
      u_audio:      { value: 0.0 },
      u_resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) }
    },
    vertexShader:   VERT_SHADER,
    fragmentShader: FRAG_SHADER,
  });

  blobMesh = new THREE.Mesh(geo, mat);
  threeScene.add(blobMesh);
  threeReady = true;
}

function renderBlob(t) {
  if (!threeReady) return;
  blobMesh.material.uniforms.u_time.value  = t;
  blobMesh.material.uniforms.u_audio.value = bass;
  threeRenderer.render(threeScene, threeCamera);
}

// ─── Speed control (shared by Hypno Rings + Spiral) ──────────────────────────

let ringSpeed = 1.0;

// ─── Mode routing ─────────────────────────────────────────────────────────────

let currentMode = 0;

function setMode(mode) {
  currentMode = mode;
  const is3D     = mode === 3;
  const hasSpeed = mode === 4 || mode === 5;
  canvas2d.style.display = is3D ? 'none' : 'block';
  document.getElementById('webgl-container').style.display = is3D ? 'block' : 'none';
  document.getElementById('vortex-controls').classList.toggle('visible', mode === 2);
  document.getElementById('waves-controls').classList.toggle('visible', mode === 1);

  document.getElementById('speed-control').style.display = hasSpeed ? 'flex' : 'none';

  document.querySelectorAll('.mode-btn').forEach((btn, i) => {
    btn.classList.toggle('active', i === mode);
  });

  if (is3D && !threeReady) initThree();
}

// ─── Progress UI ──────────────────────────────────────────────────────────────

function fmt(s) {
  s = Math.max(0, s);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function updateProgressUI() {
  if (!audioBuffer) return;
  const dur = audioBuffer.duration;
  const cur = isPlaying
    ? (audioCtx.currentTime - startTime) % dur
    : pauseOffset % dur;
  const pct = `${(cur / dur) * 100}%`;
  document.getElementById('progress-fill').style.width = pct;
  document.getElementById('track-time').textContent    = `${fmt(cur)} / ${fmt(dur)}`;
  document.getElementById('ipod-np-fill').style.width  = pct;
  document.getElementById('ipod-track-time').textContent = `${fmt(cur)} / ${fmt(dur)}`;
}

// ─── Animation loop ───────────────────────────────────────────────────────────

let startTS = null;

function loop(ts) {
  if (!startTS) startTS = ts;
  const t = (ts - startTS) / 1000;

  updateAudioValues();
  updateProgressUI();

  switch (currentMode) {
    case 0: renderMandala();     break;
    case 1: renderEmojiWaves();  break;
    case 2: renderEmojiVortex(); break;
    case 3: renderBlob(t);       break;
    case 4: renderHypnoRings();  break;
    case 5: renderSpiralRings(); break;
    case 6: renderSubwoofer();   break;
  }

  requestAnimationFrame(loop);
}

// ─── Controls ─────────────────────────────────────────────────────────────────

document.getElementById('audio-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  if (!audioCtx) initAudio();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  loadAudio(file);

  // Show filename as default; try to read ID3 tags for title + album art
  const baseName = file.name.replace(/\.[^/.]+$/, '');
  setTrackDisplayName(baseName);

  if (window.jsmediatags) {
    jsmediatags.read(file, {
      onSuccess(tag) {
        const t = tag.tags;
        const title = t.title ? (t.artist ? `${t.artist} — ${t.title}` : t.title) : null;
        if (title) {
          setTrackDisplayName(title);
          document.getElementById('ipod-track-name').textContent = t.title || title;
        }
        if (t.picture) {
          if (albumArtUrl) URL.revokeObjectURL(albumArtUrl);
          const bytes = new Uint8Array(t.picture.data);
          const blob  = new Blob([bytes], { type: t.picture.format });
          albumArtUrl = URL.createObjectURL(blob);
          const artEl = document.getElementById('album-art');
          artEl.src = albumArtUrl; artEl.style.display = 'block';
          const ipodArt = document.getElementById('ipod-art');
          ipodArt.src = albumArtUrl; ipodArt.style.display = 'block';
        }
        syncIPodView();
      },
      onError() { syncIPodView(); }
    });
  } else {
    syncIPodView();
  }
});

// Seek on progress bar click
const progressWrap = document.getElementById('progress-wrap');
const scrubHead    = document.getElementById('scrub-head');

progressWrap.addEventListener('click', e => {
  if (!audioBuffer) return;
  const rect = e.currentTarget.getBoundingClientRect();
  pauseOffset = ((e.clientX - rect.left) / rect.width) * audioBuffer.duration;
  if (isPlaying) play(); // seekBy not used here — absolute position, not delta
});

progressWrap.addEventListener('mouseenter', () => {
  scrubHead.style.opacity = '1';
});
progressWrap.addEventListener('mouseleave', () => {
  scrubHead.style.opacity = '0';
});
progressWrap.addEventListener('mousemove', e => {
  const rect = progressWrap.getBoundingClientRect();
  const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  scrubHead.style.left = `${pct * 100}%`;
});

function syncPlayBtn() {
  document.getElementById('play-pause').textContent = isPlaying ? '⏸' : '▶';
}

function currentPos() {
  return isPlaying ? audioCtx.currentTime - startTime : pauseOffset;
}

function seekBy(delta) {
  if (!audioBuffer) return;
  pauseOffset = Math.max(0, Math.min(audioBuffer.duration, currentPos() + delta));
  if (isPlaying) play();
}

function togglePlayback() {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  if (isPlaying) { pause(); } else { play(); }
  syncPlayBtn();
}

document.getElementById('play-pause').addEventListener('click', togglePlayback);

document.getElementById('btn-rewind').addEventListener('click', () => seekBy(-10));
document.getElementById('btn-fwd').addEventListener('click',    () => seekBy(+10));

document.querySelectorAll('.mode-btn').forEach((btn, i) => {
  btn.addEventListener('click', () => setMode(i));
});

document.getElementById('speed-slider').addEventListener('input', e => {
  ringSpeed = e.target.value / 50;
});

document.getElementById('rings-slider').addEventListener('input', e => {
  waveRingCount = +e.target.value;
});

document.getElementById('spin-slider').addEventListener('input', e => {
  waveSpinSpeed = e.target.value / 50;
});

document.getElementById('tight-slider').addEventListener('input', e => {
  waveSpacing = e.target.value / 1000;
});

document.getElementById('spread-slider').addEventListener('input', e => {
  phylloSpread = +e.target.value;
});

document.getElementById('zoom-slider').addEventListener('input', e => {
  phylloZoom = e.target.value / 100;
});

document.getElementById('ripple-slider').addEventListener('input', e => {
  rippleAmplitude = +e.target.value;
});

document.getElementById('ripple-speed-slider').addEventListener('input', e => {
  rippleStepSize = +e.target.value;
});

let albumArtUrl = null;  // tracks current object URL so prior one can be revoked

// ─── Playlist (music/ folder) ─────────────────────────────────────────────────

const playlistBtn  = document.getElementById('playlist-btn');
const playlistMenu = document.getElementById('playlist-menu');
let   currentTrackName = null;

function loadTrackFromUrl(url, displayName) {
  if (!audioCtx) initAudio();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  fetch(url)
    .then(r => r.arrayBuffer())
    .then(buf => audioCtx.decodeAudioData(buf, decoded => {
      audioBuffer = decoded;
      setTransportEnabled(true);
      currentTrackName = displayName;
      renderPlaylistMenu(); // update playing highlight
    }));

  setTrackDisplayName(displayName);
  document.getElementById('ipod-track-name').textContent = displayName;

  // Try ID3 tags via jsmediatags using the URL
  if (window.jsmediatags) {
    jsmediatags.read(url, {
      onSuccess(tag) {
        const t = tag.tags;
        const title = t.title ? (t.artist ? `${t.artist} — ${t.title}` : t.title) : null;
        if (title) {
          setTrackDisplayName(title);
          document.getElementById('ipod-track-name').textContent = t.title || title;
        }
        if (t.picture) {
          if (albumArtUrl) URL.revokeObjectURL(albumArtUrl);
          const bytes = new Uint8Array(t.picture.data);
          const blob  = new Blob([bytes], { type: t.picture.format });
          albumArtUrl = URL.createObjectURL(blob);
          const artEl = document.getElementById('album-art');
          artEl.src = albumArtUrl; artEl.style.display = 'block';
          const ipodArt = document.getElementById('ipod-art');
          ipodArt.src = albumArtUrl; ipodArt.style.display = 'block';
        }
        syncIPodView();
      },
      onError() { syncIPodView(); }
    });
  } else {
    syncIPodView();
  }
}

function renderPlaylistMenu(tracks) {
  // Called with a fresh list on open, or without args to refresh highlights only
  const items = tracks !== undefined ? tracks : Array.from(playlistMenu.querySelectorAll('li:not(.playlist-empty)')).map(li => li.dataset.file);

  playlistMenu.innerHTML = '';
  if (!items.length) {
    playlistMenu.innerHTML = '<li class="playlist-empty">No tracks in /music folder</li>';
    return;
  }
  items.forEach(file => {
    const li = document.createElement('li');
    li.textContent = file.replace(/\.[^/.]+$/, ''); // strip extension
    li.dataset.file = file;
    if (file.replace(/\.[^/.]+$/, '') === currentTrackName || file === currentTrackName) {
      li.classList.add('playing');
    }
    li.addEventListener('click', () => {
      loadTrackFromUrl(`/music/${encodeURIComponent(file)}`, file.replace(/\.[^/.]+$/, ''));
      closePlaylist();
    });
    playlistMenu.appendChild(li);
  });
}

function openPlaylist() {
  playlistBtn.classList.add('open');
  playlistMenu.classList.add('open');
  fetch('/api/tracks')
    .then(r => r.json())
    .then(tracks => renderPlaylistMenu(tracks))
    .catch(() => renderPlaylistMenu([]));
}

function closePlaylist() {
  playlistBtn.classList.remove('open');
  playlistMenu.classList.remove('open');
}

playlistBtn.addEventListener('click', e => {
  e.stopPropagation();
  playlistMenu.classList.contains('open') ? closePlaylist() : openPlaylist();
});

// Close when clicking outside
document.addEventListener('click', e => {
  if (!playlistMenu.contains(e.target) && e.target !== playlistBtn) closePlaylist();
});

// ─── iPod overlay ─────────────────────────────────────────────────────────────

const controlsEl  = document.getElementById('controls');
const ipodOverlay = document.getElementById('ipod-overlay');
let ipodVisible   = false;

function syncIPodView() {
  const hasTrack = !!audioBuffer;
  document.getElementById('ipod-view-empty').classList.toggle('hidden', hasTrack);
  document.getElementById('ipod-view-nowplaying').classList.toggle('hidden', !hasTrack);
}

function showIPod() {
  ipodVisible = true;
  syncIPodView();
  controlsEl.classList.add('ipod-mode');
  ipodOverlay.classList.add('visible');
}

function hideIPod() {
  ipodVisible = false;
  controlsEl.classList.remove('ipod-mode');
  ipodOverlay.classList.remove('visible');
}

// iPod toggle — button inside controls bar + utility button
document.getElementById('ipod-toggle').addEventListener('click', showIPod);
document.getElementById('btn-ipod').addEventListener('click', () => {
  ipodVisible ? hideIPod() : showIPod();
});

// iPod MENU → back to controls
document.querySelector('#ipod-wheel .wheel-menu').addEventListener('click', hideIPod);

// iPod center → play / pause
document.getElementById('ipod-center').addEventListener('click', togglePlayback);

// iPod forward/back → seek ±10 s
document.querySelector('#ipod-wheel .wheel-forward').addEventListener('click', () => seekBy(+10));
document.querySelector('#ipod-wheel .wheel-back').addEventListener('click',    () => seekBy(-10));

// ─── Hide controls + fullscreen ───────────────────────────────────────────────

let controlsHidden = false;
const uiButtons    = document.getElementById('ui-buttons');
let hideTimer      = null;

function setControlsHidden(hidden) {
  controlsHidden = hidden;
  controlsEl.classList.toggle('controls-hidden', hidden);
  document.getElementById('btn-hide').title = hidden ? 'Show controls' : 'Hide controls';
}

document.getElementById('btn-hide').addEventListener('click', () => {
  setControlsHidden(!controlsHidden);
});

// Auto-hide ui-buttons after 3s of mouse inactivity (screensaver mode)
function resetHideTimer() {
  uiButtons.style.opacity = '1';
  uiButtons.style.pointerEvents = 'all';
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (controlsHidden) {
      uiButtons.style.opacity = '0';
      uiButtons.style.pointerEvents = 'none';
    }
  }, 3000);
}

document.addEventListener('mousemove', resetHideTimer);

document.getElementById('btn-fullscreen').addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
    document.getElementById('btn-fullscreen').textContent = '⊠';
  } else {
    document.exitFullscreen();
    document.getElementById('btn-fullscreen').textContent = '⛶';
  }
});

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) {
    document.getElementById('btn-fullscreen').textContent = '⛶';
  }
});

window.addEventListener('resize', () => {
  resizeCanvas();
  if (threeReady) {
    threeRenderer.setSize(window.innerWidth, window.innerHeight);
    blobMesh.material.uniforms.u_resolution.value.set(window.innerWidth, window.innerHeight);
  }
  clampPillToViewport();
});

// ─── Draggable controls pill ──────────────────────────────────────────────────

const PILL_POS_KEY = 'musicviz_pill_pos';

// Tags that should initiate their own interaction, not a drag
const NON_DRAG = new Set(['BUTTON', 'INPUT', 'LABEL', 'SELECT', 'A']);

function isInteractive(el) {
  let node = el;
  while (node && node !== controlsEl) {
    if (NON_DRAG.has(node.tagName)) return true;
    node = node.parentElement;
  }
  return false;
}

function clampPillToViewport() {
  const r = controlsEl.getBoundingClientRect();
  const x = Math.max(0, Math.min(window.innerWidth  - r.width,  r.left));
  const y = Math.max(0, Math.min(window.innerHeight - r.height, r.top));
  controlsEl.style.left = `${x}px`;
  controlsEl.style.top  = `${y}px`;
}

function setPillPos(x, y) {
  const r = controlsEl.getBoundingClientRect();
  x = Math.max(0, Math.min(window.innerWidth  - r.width,  x));
  y = Math.max(0, Math.min(window.innerHeight - r.height, y));
  controlsEl.style.left = `${x}px`;
  controlsEl.style.top  = `${y}px`;
}

function savePillPos() {
  const r = controlsEl.getBoundingClientRect();
  try { localStorage.setItem(PILL_POS_KEY, JSON.stringify({ x: r.left, y: r.top })); } catch {}
}

function initPillPos() {
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(PILL_POS_KEY)); } catch { return null; }
  })();

  if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
    controlsEl.style.left = `${saved.x}px`;
    controlsEl.style.top  = `${saved.y}px`;
    clampPillToViewport();  // in case viewport shrank since last session
  } else {
    // Default: bottom-center
    const r = controlsEl.getBoundingClientRect();
    controlsEl.style.left = `${Math.round((window.innerWidth - r.width)  / 2)}px`;
    controlsEl.style.top  = `${Math.round(window.innerHeight - r.height - 28)}px`;
  }
}

let dragState = null;

controlsEl.addEventListener('mousedown', e => {
  if (isInteractive(e.target)) return;
  e.preventDefault();
  const r = controlsEl.getBoundingClientRect();
  dragState = { offX: e.clientX - r.left, offY: e.clientY - r.top };
  controlsEl.classList.add('dragging');
});

document.addEventListener('mousemove', e => {
  if (!dragState) return;
  setPillPos(e.clientX - dragState.offX, e.clientY - dragState.offY);
});

document.addEventListener('mouseup', () => {
  if (!dragState) return;
  dragState = null;
  controlsEl.classList.remove('dragging');
  savePillPos();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

resizeCanvas();
setMode(0);
requestAnimationFrame(loop);
// Position pill after first layout paint so getBoundingClientRect() has real dimensions
requestAnimationFrame(initPillPos);
