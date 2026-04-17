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
  pauseOffset = audioCtx.currentTime - startTime;
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

function resizeCanvas() {
  canvas2d.width  = window.innerWidth;
  canvas2d.height = window.innerHeight;
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
  const W = canvas2d.width, H = canvas2d.height;
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
  const W = canvas2d.width, H = canvas2d.height;
  ctx.clearRect(0, 0, W, H);

  const cx = W / 2, cy = H / 2;
  waveSpin += 0.008 * waveSpinSpeed;

  // When spin is near zero the rings pulse like a subwoofer.
  // Only boost emoji SIZE — never touch ring radius so tightness is unaffected.
  const spinFactor = Math.min(1, waveSpinSpeed);    // 0 = stopped, 1 = full spin
  const sizeAmp    = 18 + (1 - spinFactor) * 46;   // 18 normal → 64 when stopped

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
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    for (let j = 0; j < count; j++) {
      const angle   = (j / count) * Math.PI * 2 + waveSpin * dir;
      const x       = cx + r * Math.cos(angle);
      const y       = cy + r * Math.sin(angle);
      const emoji   = EMOJIS[(ring * 4 + j) % EMOJIS.length];
      ctx.fillText(emoji, x, y);
    }
  }
}

// ── Mode 2: Emoji Tunnel Vortex ───────────────────────────────────────────

const GOLDEN_ANGLE  = 2.39996323;
const TUNNEL_COUNT  = 160;        // reduced for smooth perf
const FOCAL         = 320;
const Z_FAR         = 650;
const Z_NEAR        = 28;
let coneSlope = 0.068;
// Pre-render each emoji once at CACHE_SIZE px → reuse with drawImage (fast)
const CACHE_SIZE    = 80;

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

// Phyllotaxis: place PHYLLO_COUNT emojis at golden-angle increments.
// r = phylloSpread * sqrt(i) naturally produces Fibonacci spiral arms.

let tunnelRot    = 0;
let phylloSpread = 18;   // controls tightness; higher = more spread out
let phylloZoom   = 1.0;  // zoom multiplier; >1 zooms in, <1 zooms out
const PHYLLO_COUNT = 280;

function renderEmojiVortex() {
  ctx.clearRect(0, 0, canvas2d.width, canvas2d.height);
  const W  = canvas2d.width,  H = canvas2d.height;
  const cx = W / 2,           cy = H / 2;
  const scl = (Math.min(W, H) / 600) * phylloZoom;

  tunnelRot += 0.003 + mid * 0.012;

  // Render outer → inner so small center emojis layer on top
  for (let i = PHYLLO_COUNT - 1; i >= 0; i--) {
    const angle = i * GOLDEN_ANGLE + tunnelRot;
    const r     = phylloSpread * Math.sqrt(i) * scl;
    const x     = cx + r * Math.cos(angle);
    const y     = cy + r * Math.sin(angle);

    const size  = (5 + Math.sqrt(i) * 6.5) * scl * (1 + bass * 0.5);

    // Soft fade at screen edge
    const edge  = Math.min(W, H) * 0.52;
    const alpha = Math.min(1, Math.max(0, 1 - (r - edge * 0.8) / (edge * 0.2)));

    if (size < 2 || alpha < 0.02) continue;

    const img  = emojiCache[EMOJIS[i % EMOJIS.length]];
    const half = size / 2;
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, x - half, y - half, size, size);
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
  const W = canvas2d.width, H = canvas2d.height;
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

  // Draw filled discs largest → smallest; parity uses ringColorShift offset
  for (let i = numRings; i >= 1; i--) {
    const r = i * SPACING - ringOffset;
    if (r <= 0) continue;

    const isLight = (i + ringColorShift) % 2 === 0;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = isLight
      ? `hsl(0,0%,${82 + bass * 18}%)`
      : colorPop;
    ctx.fill();
  }
}

// ── Mode 5: Spiral Rings ──────────────────────────────────────────────────────

let spiralOffset     = 0;
let spiralHue        = 0;

function renderSpiralRings() {
  const W  = canvas2d.width, H = canvas2d.height;
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

  // Precompute paths — reused across all draw passes so arms stay visually equal
  const armPts = [];
  for (let arm = 0; arm < ARMS; arm++) {
    const armOff = arm * Math.PI;
    const pts = [];
    for (let s = 0; s <= STEPS; s++) {
      const theta = (s / STEPS) * thetaMax;
      const r     = spiralOffset + (theta / (Math.PI * 2)) * PITCH;
      if (r > maxR) break;
      pts.push(cx + r * Math.cos(theta + armOff), cy + r * Math.sin(theta + armOff));
    }
    armPts.push(pts);
  }

  function tracePaths() {
    for (const pts of armPts) {
      if (pts.length < 4) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.stroke();
    }
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
  const hasExtra = mode === 1 || mode === 2;

  canvas2d.style.display = is3D ? 'none' : 'block';
  document.getElementById('webgl-container').style.display = is3D ? 'block' : 'none';
  document.getElementById('vortex-controls').classList.toggle('visible', mode === 2);
  document.getElementById('waves-controls').classList.toggle('visible', mode === 1);

  const speedCtrl  = document.getElementById('speed-control');
  const slidersRow = document.getElementById('sliders-row');
  speedCtrl.style.display  = hasSpeed ? 'flex' : 'none';
  slidersRow.style.display = (hasSpeed || hasExtra) ? 'flex' : 'none';
  slidersRow.classList.toggle('speed-only', hasSpeed && !hasExtra);

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
          const bytes = new Uint8Array(t.picture.data);
          const blob  = new Blob([bytes], { type: t.picture.format });
          const src   = URL.createObjectURL(blob);
          const artEl = document.getElementById('album-art');
          artEl.src = src; artEl.style.display = 'block';
          const ipodArt = document.getElementById('ipod-art');
          ipodArt.src = src; ipodArt.style.display = 'block';
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
  if (isPlaying) play();
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

document.getElementById('play-pause').addEventListener('click', () => {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  if (isPlaying) { pause(); } else { play(); }
  syncPlayBtn();
});

document.getElementById('btn-rewind').addEventListener('click', () => {
  if (!audioBuffer) return;
  const cur = isPlaying ? audioCtx.currentTime - startTime : pauseOffset;
  pauseOffset = Math.max(0, cur - 10);
  if (isPlaying) play();
});

document.getElementById('btn-fwd').addEventListener('click', () => {
  if (!audioBuffer) return;
  const cur = isPlaying ? audioCtx.currentTime - startTime : pauseOffset;
  pauseOffset = Math.min(audioBuffer.duration, cur + 10);
  if (isPlaying) play();
});

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
document.getElementById('ipod-center').addEventListener('click', () => {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  if (isPlaying) { pause(); } else { play(); }
  syncPlayBtn();
});

// iPod forward/back → seek ±10 s
document.querySelector('#ipod-wheel .wheel-forward').addEventListener('click', () => {
  if (!audioBuffer) return;
  pauseOffset = Math.min(audioBuffer.duration, (isPlaying ? audioCtx.currentTime - startTime : pauseOffset) + 10);
  if (isPlaying) play();
});
document.querySelector('#ipod-wheel .wheel-back').addEventListener('click', () => {
  if (!audioBuffer) return;
  pauseOffset = Math.max(0, (isPlaying ? audioCtx.currentTime - startTime : pauseOffset) - 10);
  if (isPlaying) play();
});

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
});

// ─── Init ─────────────────────────────────────────────────────────────────────

resizeCanvas();
setMode(0);
requestAnimationFrame(loop);
