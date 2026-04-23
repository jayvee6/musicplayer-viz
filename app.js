// ─── Constants ────────────────────────────────────────────────────────────────

const EMOJIS = ['🐻','🦊','🦁','🐱','🐶','🐼','🤖','🐲','🦄','🐷','🐰','🐵'];

// ─── Audio engine ─────────────────────────────────────────────────────────────
// Three playback modes behind a shared interface:
//   'buffer'  — decoded AudioBuffer (local file). Real FFT.
//   'element' — <audio> + MediaElementSource (e.g. Apple/Spotify preview URL). Real FFT.
//   'remote'  — source-owned player (Spotify Web Playback SDK, Apple MusicKit).
//               DRM blocks FFT; visuals come from tab capture or ambient mode.

let audioCtx, analyser, sourceNode, audioBuffer;
let frequencyData;
// activeAnalyser is whichever analyser updateAudioValues reads from this frame.
// Defaults to `analyser` (inline path for buffer/element modes); capture module
// switches it to a dead-end analyser fed by getDisplayMedia/getUserMedia.
let activeAnalyser = null;
let isPlaying = false;
let startTime = 0;
let pauseOffset = 0;

// Element-mode state — one shared <audio> + MediaElementSource created lazily.
// createMediaElementSource() can only be called once per element, so we reuse
// this single element for all streaming-source track swaps.
let streamAudio = null;
let streamMediaSource = null;

let sourceMode = null;

let bass = 0, mid = 0, treble = 0;
const BASS_HISTORY_LEN = 16;
const bassHistory = new Array(BASS_HISTORY_LEN).fill(0);

function initAudio() {
  audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
  analyser   = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.8;
  frequencyData = new Uint8Array(analyser.frequencyBinCount);
  analyser.connect(audioCtx.destination);
  activeAnalyser = analyser;

  // Expose a minimal handle for audio-capture.js to plug into our graph.
  window.vizAudio = {
    get ctx() { return audioCtx; },
    get analyser() { return analyser; },
    // AudioEngine reads the currently-routed analyser every tick so it
    // transparently picks up capture/mic/primary without extra plumbing.
    getActiveAnalyser() { return activeAnalyser; },
    setActiveAnalyser(node) {
      activeAnalyser = node || analyser;
      // frequencyData sized for primary analyser; reuse if capture analyser
      // matches fftSize (it does — we set it the same in audio-capture).
    },
  };
}

function ensureStreamAudio() {
  if (streamAudio) return;
  if (!audioCtx) initAudio();
  streamAudio = new Audio();
  streamAudio.crossOrigin = 'anonymous';
  streamAudio.preload     = 'auto';
  streamAudio.addEventListener('ended', () => { isPlaying = false; syncPlayBtn(); });
  streamMediaSource = audioCtx.createMediaElementSource(streamAudio);
  streamMediaSource.connect(analyser);
}

// Unified queries used by progress UI, seek handlers, and has-track checks.
function remoteSrc() {
  if (sourceMode !== 'remote') return null;
  const s = currentStreamingSource && currentStreamingSource();
  return (s && typeof s.playTrack === 'function') ? s : null;
}

function hasTrack() {
  if (sourceMode === 'buffer')  return !!audioBuffer;
  if (sourceMode === 'element') return !!(streamAudio && streamAudio.src);
  if (sourceMode === 'remote')  return true; // set synchronously before first state arrives
  return false;
}

function trackDuration() {
  if (sourceMode === 'buffer')  return audioBuffer ? audioBuffer.duration : 0;
  if (sourceMode === 'element') return (streamAudio && isFinite(streamAudio.duration)) ? streamAudio.duration : 0;
  const r = remoteSrc();
  if (r) { const ms = r.getDurationMs(); return ms ? ms / 1000 : 0; }
  return 0;
}

function currentPosSec() {
  if (sourceMode === 'buffer')  return isPlaying ? audioCtx.currentTime - startTime : pauseOffset;
  if (sourceMode === 'element' && streamAudio) return streamAudio.currentTime;
  const r = remoteSrc();
  if (r) return r.getPositionMs() / 1000;
  return 0;
}

function setTransportEnabled(on) {
  ['btn-rewind','play-pause','btn-fwd','btn-prev','btn-next'].forEach(id => {
    document.getElementById(id).disabled = !on;
  });
}

function setTrackDisplayName(text) {
  const el = document.getElementById('track-name');
  if (el.textContent === text) return; // skip reflow when unchanged
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

// When switching sources, stop the other path so we don't have two streams
// feeding the analyser simultaneously.
function stopOtherMode(nextMode) {
  if (nextMode !== 'buffer' && sourceNode) {
    try { sourceNode.stop(); } catch {}
    sourceNode = null;
    audioBuffer = null;
  }
  if (nextMode !== 'element' && streamAudio && !streamAudio.paused) {
    streamAudio.pause();
  }
  if (nextMode !== 'remote' && sourceMode === 'remote') {
    const s = currentStreamingSource && currentStreamingSource();
    if (s && s.pause) { try { s.pause(); } catch {} }
  }
  isPlaying = false;
}

function loadAudio(file) {
  stopOtherMode('buffer');
  const reader = new FileReader();
  reader.onload = e => {
    audioCtx.decodeAudioData(e.target.result, buf => {
      audioBuffer = buf;
      sourceMode  = 'buffer';
      pauseOffset = 0;
      if (typeof ipodMode !== 'undefined') ipodMode = 'now';
      setTransportEnabled(true);
    });
  };
  reader.readAsArrayBuffer(file);
}

// Full-track playback via the current source's own player (Spotify SDK, Apple
// MusicKit). `meta` matches loadStreamUrl: { displayName, albumArt }. DRM
// blocks FFT so reactive visuals need tab capture or ambient mode.
async function loadRemoteTrack(trackId, meta, queueOptions) {
  if (!audioCtx) initAudio();
  stopOtherMode('remote');
  sourceMode = 'remote';
  pauseOffset = 0;
  if (typeof ipodMode !== 'undefined') ipodMode = 'now';

  if (meta) updateNowPlayingUI(meta);
  setTransportEnabled(true);
  syncIPodView();

  const src = currentStreamingSource();
  if (!src || !src.playTrack) throw new Error('Current source does not support full-track playback');

  await src.playTrack(trackId, queueOptions);
  isPlaying = true;
  syncPlayBtn();
}

// Central now-playing UI updater. meta = { title, artist, album?, albumArt?, displayName? }.
// displayName is derived from "artist — title" if not supplied; used for the pill ticker.
function updateNowPlayingUI(meta) {
  const { title = '', artist = '', album, albumArt } = meta || {};
  const displayName = meta.displayName || (artist ? `${artist} — ${title}` : title);

  setTrackDisplayName(displayName);
  document.getElementById('ipod-track-name').textContent = displayName;
  const artEl   = document.getElementById('album-art');
  const ipodArt = document.getElementById('ipod-art');
  if (albumArt) {
    artEl.src = albumArt;   artEl.style.display = 'block';
    ipodArt.src = albumArt; ipodArt.style.display = 'block';
  } else {
    artEl.style.display = 'none';
    ipodArt.style.display = 'none';
  }
  if (typeof setMediaSessionMetadata === 'function') {
    setMediaSessionMetadata({ title, artist, album, artworkUrl: albumArt });
  }
}

function loadStreamUrl(url, meta) {
  if (!audioCtx) initAudio();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  stopOtherMode('element');
  ensureStreamAudio();
  streamAudio.src = url;
  streamAudio.load();
  sourceMode  = 'element';
  pauseOffset = 0;
  if (typeof ipodMode !== 'undefined') ipodMode = 'now';
  setTransportEnabled(true);
  if (meta) updateNowPlayingUI(meta);
  syncIPodView();
}

function play() {
  if (!hasTrack()) return;
  if (sourceMode === 'buffer') {
    if (sourceNode) { try { sourceNode.disconnect(); } catch {} }
    sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(analyser);
    sourceNode.loop = true;
    sourceNode.start(0, pauseOffset % audioBuffer.duration);
    startTime = audioCtx.currentTime - pauseOffset;
    isPlaying = true;
  } else if (sourceMode === 'element') {
    streamAudio.play().then(() => { isPlaying = true; syncPlayBtn(); }).catch(e => {
      console.error('[stream play]', e);
    });
    isPlaying = true;
  } else if (sourceMode === 'remote') {
    const r = remoteSrc(); if (r) { r.resume(); isPlaying = true; }
  }
}

function pause() {
  if (sourceMode === 'buffer') {
    if (!sourceNode) return;
    pauseOffset = (audioCtx.currentTime - startTime) % audioBuffer.duration;
    try { sourceNode.stop(); } catch {}
    isPlaying = false;
  } else if (sourceMode === 'element') {
    if (!streamAudio) return;
    streamAudio.pause();
    isPlaying = false;
  } else if (sourceMode === 'remote') {
    const r = remoteSrc(); if (r) { r.pause(); isPlaying = false; }
  }
}

// Cache module refs outside the 60fps loop — each `window.*` property access
// is cheap but adds up at ~4×/frame across lookups. These modules are set
// once at load and never reassigned, so caching is safe.
const _Capture = window.AudioCapture;
const _Ambient = window.AmbientMode;

function updateAudioValues() {
  // Data-source priority, highest first: ambient synth > captured audio >
  // silent fallback (remote mode w/o capture has no FFT access). Once
  // frequencyData is populated, the band-sum pass computes bass/mid/treble
  // for every path — including Ferro, which reads the array directly.
  if (_Ambient && _Ambient.isActive()) {
    _Ambient.fillSpectrum(frequencyData, performance.now() / 1000);
  } else if (_Capture && _Capture.isActive() && activeAnalyser) {
    activeAnalyser.getByteFrequencyData(frequencyData);
  } else if (sourceMode === 'remote') {
    frequencyData.fill(0);
    bass = mid = treble = 0;
    bassHistory.unshift(0); bassHistory.pop();
    return;
  } else if (activeAnalyser) {
    activeAnalyser.getByteFrequencyData(frequencyData);
  } else {
    return;
  }

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
// Shared 2D context for viz/*.js files so they can draw into the same
// DPR-scaled canvas without re-acquiring the context.
window.ctx      = ctx;
window.canvas2d = canvas2d;

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

  // Shared renderer + camera — each viz can build its own scene + mesh on top.
  // A1 (Kaleidoscope) onwards uses this to avoid a per-viz WebGLRenderer.
  window.vizGL = { renderer: threeRenderer, camera: threeCamera };
}

// Expose initThree so a non-Blob WebGL viz (Kaleidoscope, CosmicWave, Lunar)
// can force WebGL setup if it's the first webgl-kind mode ever activated.
window.initThree = initThree;

function renderBlob(t) {
  if (!threeReady) return;
  blobMesh.material.uniforms.u_time.value  = t;
  blobMesh.material.uniforms.u_audio.value = bass;
  threeRenderer.render(threeScene, threeCamera);
}

// ─── Speed control (shared by Hypno Rings + Spiral) ──────────────────────────

let ringSpeed = 1.0;

// ── Mode 7: Ferrofluid ───────────────────────────────────────────────────────
// Discrete spindle spikes rising from a dark glossy pool, lit from upper-left.
// Left = sub-bass (log-scale), right = high treble.  One connected fluid mass.

const FLUID_N      = 48;
const fluidSpikes  = new Float32Array(FLUID_N);
const fluidTargets = new Float32Array(FLUID_N);
const fluidVels    = new Float32Array(FLUID_N);

let fluidSpikeHeight = 0.55;
let fluidStiffness   = 0.18;
let fluidBlobSize    = 1.0;   // specular highlight brightness (0 = matte)
let fluidHue         = 280;   // current hue — drifts + snaps on bass hits

function updateFluidTargets() {
  // Hue: slow ambient drift + hard bass-kick → Daft Punk light-show feel
  fluidHue = (fluidHue + 0.06 + bass * 1.8) % 360;

  const maxH  = H * fluidSpikeHeight;
  const idleH = H * 0.06;
  const now   = performance.now() / 1000;
  for (let i = 0; i < FLUID_N; i++) {
    // Log-scale left→right: spike 0 ≈ 21Hz (bin 1), spike 47 ≈ 10.7kHz (bin 500)
    const bin    = Math.round(Math.pow(500, i / (FLUID_N - 1)));
    const energy = frequencyData
      ? (frequencyData[Math.min(bin, frequencyData.length - 1)] / 255) * maxH
      : 0;
    const idle   = idleH * (0.4 + 0.6 * Math.sin(now * 0.7 + i * 0.52));
    fluidTargets[i] = Math.max(idle, energy);
  }
}

function updateFluidSprings() {
  const k    = fluidStiffness * (0.12 + bass * 2.8);
  const damp = 0.60 - bass * 0.46;
  for (let i = 0; i < FLUID_N; i++) {
    fluidVels[i]   += (fluidTargets[i] - fluidSpikes[i]) * k;
    fluidVels[i]   *= (1 - Math.max(0.04, damp));
    fluidSpikes[i]  = Math.max(0, fluidSpikes[i] + fluidVels[i]);
  }
}

// Spindle/lozenge shape: narrow at base, bulges in middle, sharp tip.
// Horizontal gradient gives cylindrical metallic sheen (lit from upper-left).
function drawFerroSpike(cx, spikeH, poolY, spaceW) {
  if (spikeH < 3) return;
  const tipY = poolY - spikeH;
  const mw   = Math.min(spaceW * 0.40, spikeH * 0.30);   // max half-width
  const bw   = mw * 0.18;                                   // base half-width
  const bulY = tipY + spikeH * 0.42;                        // widest point

  ctx.beginPath();
  ctx.moveTo(cx, tipY);
  ctx.bezierCurveTo(cx + mw * 0.16, tipY + spikeH * 0.13,  cx + mw, bulY,  cx + bw, poolY);
  ctx.lineTo(cx - bw, poolY);
  ctx.bezierCurveTo(cx - mw, bulY,  cx - mw * 0.16, tipY + spikeH * 0.13,  cx, tipY);
  ctx.closePath();

  const hi   = Math.min(255, Math.round(220 * fluidBlobSize));
  const lo   = Math.min(180, Math.round(70  * fluidBlobSize));
  const grad = ctx.createLinearGradient(cx - mw, 0, cx + mw, 0);
  grad.addColorStop(0.00, `rgba(${lo},${lo},${lo},1)`);   // medium grey left
  grad.addColorStop(0.20, `rgba(${hi},${hi},${hi},1)`);   // bright specular peak
  grad.addColorStop(0.46, `rgba(${Math.round(lo*0.3)},${Math.round(lo*0.3)},${Math.round(lo*0.3)},1)`);
  grad.addColorStop(1.00, 'rgba(8,3,14,1)');              // dark right
  ctx.fillStyle = grad;
  ctx.fill();
}

function renderFluid() {
  ctx.globalAlpha = 1; ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
  const fH = fluidHue;  // snapshot hue for this frame
  ctx.fillStyle = `hsl(${fH}, 40%, 3%)`;  // deep tinted black
  ctx.fillRect(0, 0, W, H);

  const poolY  = H * 0.80;
  const spaceW = W / FLUID_N;

  updateFluidTargets();
  updateFluidSprings();

  // ── Single connected fluid body ───────────────────────────────────────────
  // Valleys between spikes rise proportionally to neighbours so the mass stays
  // connected — no harsh gaps. hw close to 0.5*spaceW = bases nearly merge.
  const _vY = new Float32Array(FLUID_N + 1);
  for (let v = 0; v <= FLUID_N; v++) {
    const hL = v > 0       ? fluidSpikes[v - 1] : 0;
    const hR = v < FLUID_N ? fluidSpikes[v]     : 0;
    // Raised saddle: surface stays elevated between spikes → one connected mass
    _vY[v] = poolY - (hL + hR) * 0.30;
  }

  ctx.beginPath();
  ctx.moveTo(0, H);
  ctx.lineTo(0, _vY[0]);

  for (let i = 0; i < FLUID_N; i++) {
    const cx   = (i + 0.5) * spaceW;
    const h    = fluidSpikes[i];
    const tipY = poolY - h;
    const hw   = spaceW * 0.49;              // wide base — nearly merging
    const sp   = Math.max(1.5, h * 0.038);   // small = sharp tip
    const vY_L = _vY[i];
    const vY_R = _vY[i + 1];

    ctx.bezierCurveTo(cx - hw, vY_L, cx - sp, tipY + sp, cx, tipY);
    ctx.bezierCurveTo(cx + sp, tipY + sp, cx + hw, vY_R,
      Math.min(W, (i + 1) * spaceW), vY_R);
  }

  ctx.lineTo(W, H);
  ctx.closePath();

  // Oily body: dark with subtle hue tint so spikes catch the colored light
  const bodyGrad = ctx.createLinearGradient(0, 0, 0, poolY);
  bodyGrad.addColorStop(0,   `hsl(${fH}, 25%, 10%)`);
  bodyGrad.addColorStop(0.5, `hsl(${fH}, 20%, 6%)`);
  bodyGrad.addColorStop(1,   `hsl(${fH}, 15%, 3%)`);
  ctx.fillStyle = bodyGrad;
  ctx.fill();

  // ── Surface glow (pool region only) — full saturation, hue-driven ────────
  const pulse    = 0.40 + bass * 0.55;
  const glowH    = H * 0.22;
  const poolGlow = ctx.createLinearGradient(0, poolY - glowH, 0, poolY + glowH * 0.5);
  poolGlow.addColorStop(0,    'rgba(0,0,0,0)');
  poolGlow.addColorStop(0.50, `hsla(${fH}, 100%, 36%, ${pulse * 0.50})`);
  poolGlow.addColorStop(0.82, `hsla(${fH}, 100%, 22%, ${pulse * 0.65})`);
  poolGlow.addColorStop(1,    `hsl(${fH}, 40%, 3%)`);
  ctx.fillStyle = poolGlow;
  ctx.fillRect(0, poolY - glowH, W, glowH * 1.5);

  // Pool surface shimmer
  ctx.globalAlpha = 0.60 + bass * 0.38;
  ctx.strokeStyle = `hsl(${fH}, 100%, ${30 + bass * 38}%)`;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(0, poolY); ctx.lineTo(W, poolY); ctx.stroke();
  ctx.globalAlpha = 1;

  // ── Specular highlights — colored gloss streak on left face of each spike ──
  // Tip = near-white tinted by hue (like light reflecting off a colored surface)
  const hiL = Math.round(88 * fluidBlobSize);   // tip lightness %
  ctx.lineCap = 'round';
  for (let i = 0; i < FLUID_N; i++) {
    const h = fluidSpikes[i];
    if (h < 8) continue;
    const cx   = (i + 0.5) * spaceW;
    const tipY = poolY - h;
    const hLen = h * 0.65;
    const hx   = cx - Math.min(spaceW * 0.12, h * 0.065);

    const hlGrad = ctx.createLinearGradient(0, tipY, 0, tipY + hLen);
    hlGrad.addColorStop(0,    `hsla(${fH}, 60%, ${hiL}%, 0.97)`);
    hlGrad.addColorStop(0.35, `hsla(${fH}, 80%, ${Math.round(hiL * 0.55)}%, 0.42)`);
    hlGrad.addColorStop(1,    'rgba(0,0,0,0)');
    ctx.strokeStyle = hlGrad;
    ctx.lineWidth   = Math.max(1.5, Math.min(h * 0.026, 6));
    ctx.beginPath();
    ctx.moveTo(cx, tipY + 1);
    ctx.bezierCurveTo(hx, tipY + h * 0.20, hx - 2, tipY + h * 0.42, hx - 3, tipY + hLen);
    ctx.stroke();
  }

  // Oily pool reflection — tinted inverted gloss in the flat area below spikes
  ctx.globalAlpha = 0.22 + bass * 0.14;
  for (let i = 0; i < FLUID_N; i++) {
    const h = fluidSpikes[i];
    if (h < 12) continue;
    const cx    = (i + 0.5) * spaceW;
    const rLen  = Math.min(h * 0.25, H * 0.06);
    const refGr = ctx.createLinearGradient(0, poolY, 0, poolY + rLen);
    refGr.addColorStop(0,   `hsla(${fH}, 80%, 75%, 0.5)`);
    refGr.addColorStop(1,   'rgba(0,0,0,0)');
    const hx = cx - Math.min(spaceW * 0.12, h * 0.065);
    ctx.strokeStyle = refGr;
    ctx.lineWidth   = Math.max(1, Math.min(h * 0.018, 4));
    ctx.beginPath();
    ctx.moveTo(cx, poolY - 1);
    ctx.bezierCurveTo(hx, poolY + rLen * 0.4, hx - 1, poolY + rLen * 0.8, hx - 2, poolY + rLen);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // ── Smooth envelope curve through all spike tips (EQ response line) ─────
  {
    const T = 0.38; // Catmull-Rom tension
    const tX = j => (j + 0.5) * spaceW;
    const tY = j => poolY - fluidSpikes[Math.max(0, Math.min(FLUID_N - 1, j))];

    ctx.beginPath();
    ctx.moveTo(tX(0), tY(0));
    for (let i = 0; i < FLUID_N - 1; i++) {
      const p0x = tX(i - 1), p0y = tY(i - 1);
      const p1x = tX(i),     p1y = tY(i);
      const p2x = tX(i + 1), p2y = tY(i + 1);
      const p3x = tX(i + 2), p3y = tY(i + 2);
      const cp1x = p1x + (p2x - p0x) * T / 3;
      const cp1y = p1y + (p2y - p0y) * T / 3;
      const cp2x = p2x - (p3x - p1x) * T / 3;
      const cp2y = p2y - (p3y - p1y) * T / 3;
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2x, p2y);
    }
    const envAlpha = 0.35 + bass * 0.55;
    ctx.shadowColor = `hsla(${fH}, 100%, 50%, ${bass * 0.9})`;
    ctx.shadowBlur  = 3 + bass * 12;
    ctx.strokeStyle = `hsla(${fH}, 100%, 70%, ${envAlpha})`;
    ctx.lineWidth   = 1.5;
    ctx.stroke();
    ctx.shadowBlur  = 0; ctx.shadowColor = 'transparent';
  }

  // ── Color bloom behind tallest spikes on bass hits ────────────────────────
  if (bass > 0.07) {
    ctx.shadowColor = `hsla(${fH}, 100%, 50%, ${bass * 0.85})`;
    ctx.shadowBlur  = bass * 28;
    ctx.strokeStyle = `hsla(${fH}, 100%, 55%, ${bass * 0.70})`;
    ctx.lineWidth   = 2;
    for (let i = 0; i < FLUID_N; i++) {
      const h = fluidSpikes[i];
      if (h < 15) continue;
      const cx = (i + 0.5) * spaceW;
      ctx.beginPath();
      ctx.moveTo(cx, poolY - h);
      ctx.lineTo(cx, poolY - h * 0.5);
      ctx.stroke();
    }
    ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
  }
}

// ─── Mode routing ─────────────────────────────────────────────────────────────

let currentMode = 0;

function setMode(mode) {
  currentMode = mode;
  // Delegate canvas visibility + init/teardown + active-button styling to the
  // viz registry. Legacy control-div toggles stay here since they're tied to
  // the legacy mode indices (Wave 2+ viz will manage their own controls via
  // initFn/teardownFn).
  if (window.Viz) window.Viz.setMode(mode);

  const hasSpeed = mode === 4 || mode === 5;
  document.getElementById('vortex-controls').classList.toggle('visible', mode === 2);
  document.getElementById('waves-controls').classList.toggle('visible', mode === 1);
  document.getElementById('fluid-controls').classList.toggle('visible', mode === 7);
  document.getElementById('speed-control').style.display = hasSpeed ? 'flex' : 'none';
}

// ─── Progress UI ──────────────────────────────────────────────────────────────

function fmt(s) {
  s = Math.max(0, s);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function updateProgressUI() {
  if (!hasTrack()) return;
  const dur = trackDuration();
  if (!dur) return;
  const raw = currentPosSec();
  const cur = sourceMode === 'buffer' ? raw % dur : Math.min(raw, dur);
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

  // Legacy globals (bass/mid/treble/bassHistory) — read by mode 0-7 renderFns.
  updateAudioValues();
  // Unified AudioFrame (mel mags, AGC, onset/BPM, mood) — read by new viz.
  if (window.AudioEngine) window.AudioEngine.tick(t);
  updateProgressUI();

  try {
    // Registry routes to the active viz's renderFn. Legacy renderFns ignore
    // the frame arg and continue reading the back-compat globals.
    if (window.Viz) window.Viz.renderCurrent(t, window.AudioEngine && window.AudioEngine.currentFrame());
  } catch (e) {
    console.error('[loop] render error:', e);
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
  if (!hasTrack()) return;
  const dur  = trackDuration();
  if (!dur) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const t    = ((e.clientX - rect.left) / rect.width) * dur;
  if (sourceMode === 'buffer') {
    pauseOffset = t;
    if (isPlaying) play();
  } else if (sourceMode === 'element') {
    streamAudio.currentTime = t;
  } else if (sourceMode === 'remote') {
    const r = remoteSrc(); if (r) r.seekToMs(t * 1000);
  }
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
  return currentPosSec();
}

function seekBy(delta) {
  if (!hasTrack()) return;
  const dur = trackDuration();
  if (!dur) return;
  const next = Math.max(0, Math.min(dur, currentPosSec() + delta));
  if (sourceMode === 'buffer') {
    pauseOffset = next;
    if (isPlaying) play();
  } else if (sourceMode === 'element') {
    streamAudio.currentTime = next;
  } else if (sourceMode === 'remote') {
    const r = remoteSrc(); if (r) r.seekToMs(next * 1000);
  }
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

// Shuffle / repeat are source-level toggles (Spotify: PUT /me/player/shuffle +
// /me/player/repeat; Apple: MusicKit shuffleMode/repeatMode). They apply to
// remote streaming sources only — local buffer/element playback has no queue.
// The buttons still toggle their UI state even when no source is active so
// the preference persists once a source connects.
let shuffleOn = false;
const REPEAT_MODES = ['off', 'context', 'track'];
let repeatIdx = 0;

const btnShuffle = document.getElementById('btn-shuffle');
const btnRepeat  = document.getElementById('btn-repeat');

function syncShuffleUI() {
  btnShuffle.classList.toggle('active', shuffleOn);
  btnShuffle.title = shuffleOn ? 'Shuffle: On' : 'Shuffle: Off';
}

function syncRepeatUI() {
  const mode = REPEAT_MODES[repeatIdx];
  btnRepeat.classList.toggle('active', mode !== 'off');
  btnRepeat.textContent = mode === 'track' ? '🔂' : '🔁';
  btnRepeat.title = mode === 'off'     ? 'Repeat: Off'
                  : mode === 'context' ? 'Repeat: Queue'
                  :                      'Repeat: One';
}

btnShuffle.addEventListener('click', async () => {
  shuffleOn = !shuffleOn;
  syncShuffleUI();
  const src = currentStreamingSource();
  if (src && src.setShuffle) { try { await src.setShuffle(shuffleOn); } catch {} }
});

btnRepeat.addEventListener('click', async () => {
  repeatIdx = (repeatIdx + 1) % REPEAT_MODES.length;
  syncRepeatUI();
  const src = currentStreamingSource();
  if (src && src.setRepeat) { try { await src.setRepeat(REPEAT_MODES[repeatIdx]); } catch {} }
});

document.getElementById('btn-prev').addEventListener('click', async () => {
  const src = currentStreamingSource();
  if (src && src.previousTrack) { try { await src.previousTrack(); } catch {} }
});
document.getElementById('btn-next').addEventListener('click', async () => {
  const src = currentStreamingSource();
  if (src && src.nextTrack) { try { await src.nextTrack(); } catch {} }
});

syncShuffleUI();
syncRepeatUI();

document.querySelectorAll('.mode-btn').forEach((btn, i) => {
  btn.addEventListener('click', () => setMode(i));
});

// Edge cycle buttons — mirror of the iOS swipe-left/right gesture. Wraps
// around at either end so there's always a next/previous.
function cycleViz(delta) {
  if (!window.Viz) return;
  const entries = window.Viz.entries;
  if (!entries.length) return;
  const cur = window.Viz.currentIndex;
  const n   = entries.length;
  const next = ((cur < 0 ? 0 : cur) + delta + n) % n;
  setMode(next);
}
document.getElementById('viz-cycle-prev')?.addEventListener('click', () => cycleViz(-1));
document.getElementById('viz-cycle-next')?.addEventListener('click', () => cycleViz(+1));

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

document.getElementById('fluid-height-slider').addEventListener('input', e => {
  fluidSpikeHeight = e.target.value / 100;
});
document.getElementById('fluid-stiff-slider').addEventListener('input', e => {
  fluidStiffness = e.target.value / 100;
});
document.getElementById('fluid-blob-slider').addEventListener('input', e => {
  fluidBlobSize = e.target.value / 10;
});

let albumArtUrl = null;  // tracks current object URL so prior one can be revoked

// ─── Playlist (music/ folder) ─────────────────────────────────────────────────

const playlistBtn  = document.getElementById('playlist-btn');
const playlistMenu = document.getElementById('playlist-menu');
let   currentTrackName = null;

function loadTrackFromUrl(url, displayName) {
  if (!audioCtx) initAudio();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  stopOtherMode('buffer');

  fetch(url)
    .then(r => r.arrayBuffer())
    .then(buf => audioCtx.decodeAudioData(buf, decoded => {
      audioBuffer = decoded;
      sourceMode  = 'buffer';
      pauseOffset = 0;
      if (typeof ipodMode !== 'undefined') ipodMode = 'now';
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
// Three views (exactly one visible):
//   empty  — no streaming account connected
//   menu   — library navigator (Playlists / Artists / Albums / Songs, drill-down)
//   now    — current track + progress
// A connected streaming source shows the menu; the Now Playing view is pushed
// onto the nav stack when a song is selected. MENU pops the stack, eventually
// back to the root menu.

const controlsEl  = document.getElementById('controls');
const ipodOverlay = document.getElementById('ipod-overlay');
const ipodViewEmpty      = document.getElementById('ipod-view-empty');
const ipodViewMenu       = document.getElementById('ipod-view-menu');
const ipodViewNowPlaying = document.getElementById('ipod-view-nowplaying');
const ipodMenuList       = document.getElementById('ipod-menu-list');
const ipodMenuTitle      = document.getElementById('ipod-menu-title');
let ipodVisible = false;

// Nav stack: each frame = { title, items, selectedIdx, loading, error }.
// Last frame is the visible menu level. An empty stack means "show root menu",
// which is lazy-initialized on open.
const ROOT_MENU = [
  { id: 'playlists', name: 'Playlists', kind: 'category' },
  { id: 'artists',   name: 'Artists',   kind: 'category' },
  { id: 'albums',    name: 'Albums',    kind: 'category' },
  { id: 'songs',     name: 'Songs',     kind: 'category' },
];

let ipodStack    = [];  // [{title, items, selectedIdx, loading, error}]
let ipodMode     = 'menu';  // 'menu' | 'now'

function currentFrame() { return ipodStack[ipodStack.length - 1] || null; }

function setIPodView(which) {
  ipodViewEmpty.classList.toggle('hidden',      which !== 'empty');
  ipodViewMenu.classList.toggle('hidden',       which !== 'menu');
  ipodViewNowPlaying.classList.toggle('hidden', which !== 'now');
}

function syncIPodView() {
  const src    = currentStreamingSource();
  const authed = src && src.isAuthed();

  if (ipodMode === 'now' && hasTrack()) { setIPodView('now'); return; }
  if (authed) {
    if (ipodStack.length === 0) {
      ipodStack.push({ title: src.displayName, items: ROOT_MENU, selectedIdx: 0 });
    }
    ipodMode = 'menu';
    renderIPodMenu();
    setIPodView('menu');
    return;
  }
  if (hasTrack()) { ipodMode = 'now'; setIPodView('now'); return; }
  setIPodView('empty');
}

function renderIPodMenu() {
  const frame = currentFrame();
  if (!frame) { ipodMenuList.innerHTML = ''; return; }
  ipodMenuTitle.textContent = frame.title;
  ipodMenuList.innerHTML = '';

  if (frame.loading) {
    const li = document.createElement('li');
    li.className = 'ipod-menu-note';
    li.textContent = 'Loading…';
    ipodMenuList.appendChild(li);
    return;
  }
  if (frame.error) {
    const li = document.createElement('li');
    li.className = 'ipod-menu-note error';
    li.textContent = frame.error;
    ipodMenuList.appendChild(li);
    return;
  }
  if (!frame.items.length) {
    const li = document.createElement('li');
    li.className = 'ipod-menu-note';
    li.textContent = 'Empty';
    ipodMenuList.appendChild(li);
    return;
  }

  frame.items.forEach((it, idx) => {
    const li = document.createElement('li');
    li.className = 'ipod-menu-item' + (idx === frame.selectedIdx ? ' selected' : '');
    const chev = (it.kind === 'category' || it.kind === 'playlist' || it.kind === 'artist' || it.kind === 'album') ? '›' : '';
    li.innerHTML = `
      <span class="ipod-item-name">${(it.name || '').replace(/</g, '&lt;')}</span>
      <span class="ipod-item-chev">${chev}</span>
    `;
    li.addEventListener('click', () => {
      frame.selectedIdx = idx;
      renderIPodMenu();
      ipodActivate();
    });
    ipodMenuList.appendChild(li);
  });

  // Scroll selected into view.
  const sel = ipodMenuList.querySelector('.ipod-menu-item.selected');
  if (sel && typeof sel.scrollIntoView === 'function') {
    sel.scrollIntoView({ block: 'nearest' });
  }
}

async function loadFrame(frame, loader) {
  frame.loading = true;
  frame.error = null;
  frame.items = [];
  renderIPodMenu();
  try {
    frame.items = await loader();
  } catch (e) {
    console.error('[ipod load]', e);
    frame.error = e.message || 'Failed to load';
  } finally {
    frame.loading = false;
    frame.selectedIdx = 0;
    renderIPodMenu();
  }
}

function ipodActivate() {
  const frame = currentFrame();
  if (!frame || !frame.items.length) return;
  const it = frame.items[frame.selectedIdx];
  const src = currentStreamingSource();

  if (it.kind === 'category') {
    // `category.id` is also the library category name (songs/playlists/...).
    // Tag only the Songs category with a flat-queue context so picking a song
    // plays all visible songs in order.
    const child = {
      title: it.name,
      items: [],
      selectedIdx: 0,
      queueKind: it.id === 'songs' ? 'flat' : null,
    };
    ipodStack.push(child);
    loadFrame(child, () => src.getLibrary(it.id));
  } else if (it.kind === 'playlist' || it.kind === 'artist' || it.kind === 'album') {
    // Tag the drilled-in frame with source-neutral context so that picking a
    // song inside it queues the whole playlist/album. Each source's playTrack
    // translates contextKind+contextId into its native queue format (Spotify
    // URIs, Apple MusicKit setQueue shape).
    const usesAsContext = it.kind === 'playlist' || it.kind === 'album';
    const child = {
      title: it.name,
      items: [], selectedIdx: 0,
      contextKind: usesAsContext ? it.kind : null,
      contextId:   usesAsContext ? it.id   : null,
    };
    ipodStack.push(child);
    loadFrame(child, () => src.getChildren(it.kind, it.id));
  } else if (it.kind === 'song') {
    const track = it.track;
    if (!track) return;
    const meta = { title: track.name, artist: track.artists, albumArt: track.albumArt };

    // Full-track remote path. Preview fallback stays for any track that
    // exposes a preview_url (rare now on both Spotify and Apple library).
    if (track.hasFullTrack && src && src.playTrack) {
      const queue = {};
      if (frame.contextKind && frame.contextId) {
        queue.contextKind = frame.contextKind;
        queue.contextId   = frame.contextId;
      } else if (frame.queueKind === 'flat') {
        queue.trackIds = frame.items.filter(i => i.kind === 'song' && i.id).map(i => i.id);
      }

      frame.error = null;
      frame.loading = true;
      renderIPodMenu();
      loadRemoteTrack(track.id, meta, queue)
        .then(() => { frame.loading = false; renderIPodMenu(); })
        .catch(e => {
          console.error('[ipod remote play]', e);
          frame.loading = false;
          frame.error = e.message || 'Playback failed';
          renderIPodMenu();
        });
      return;
    }

    if (!track.previewUrl) {
      frame.error = 'No preview available for this song.';
      renderIPodMenu();
      return;
    }
    loadStreamUrl(track.previewUrl, meta);
    play();
    syncPlayBtn();
    ipodMode = 'now';
    setIPodView('now');
  }
}

function ipodBack() {
  if (ipodMode === 'now') {
    ipodMode = 'menu';
    syncIPodView();
    return;
  }
  if (ipodStack.length > 1) {
    ipodStack.pop();
    renderIPodMenu();
    return;
  }
  // At root — hide the overlay
  hideIPod();
}

function ipodMoveSelection(delta) {
  if (ipodMode === 'now') {
    // Wheel scrolling during playback scrubs the track.
    seekBy(delta > 0 ? +5 : -5);
    return;
  }
  const frame = currentFrame();
  if (!frame || !frame.items.length) return;
  frame.selectedIdx = Math.max(0, Math.min(frame.items.length - 1, frame.selectedIdx + delta));
  renderIPodMenu();
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

// MENU: back one frame (or hide if at root)
document.querySelector('#ipod-wheel .wheel-menu').addEventListener('click', ipodBack);

// Center: select (menu) or play/pause (now playing)
document.getElementById('ipod-center').addEventListener('click', () => {
  if (ipodMode === 'now') togglePlayback();
  else                     ipodActivate();
});

// ⏮ / ⏭: scroll list (menu) or seek ±10s (now playing)
document.querySelector('#ipod-wheel .wheel-forward').addEventListener('click', () => {
  if (ipodMode === 'now') seekBy(+10);
  else                     ipodMoveSelection(+1);
});
document.querySelector('#ipod-wheel .wheel-back').addEventListener('click', () => {
  if (ipodMode === 'now') seekBy(-10);
  else                     ipodMoveSelection(-1);
});

// ▶︎: play/pause regardless of menu/now-playing mode
document.querySelector('#ipod-wheel .wheel-play').addEventListener('click', togglePlayback);

// Circular wheel drag → scroll selection. Accumulate angle deltas; every STEP_DEG
// degrees of sweep = 1 step. Larger = slower scroll, less overshoot.
(() => {
  const wheel = document.getElementById('ipod-wheel');
  let lastAngle = 0;
  let accum = 0;
  const STEP_DEG = 40;

  function angleFromEvent(e) {
    const r  = wheel.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top  + r.height / 2;
    return Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;
  }

  // Attach mousemove/mouseup only while dragging — avoids firing the handler
  // on every mouse move across the page during normal use.
  function onMove(e) {
    const a = angleFromEvent(e);
    let d = a - lastAngle;
    if (d >  180) d -= 360;
    if (d < -180) d += 360;
    accum += d;
    lastAngle = a;
    while (accum >=  STEP_DEG) { ipodMoveSelection(+1); accum -= STEP_DEG; }
    while (accum <= -STEP_DEG) { ipodMoveSelection(-1); accum += STEP_DEG; }
  }
  function onUp() {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup',   onUp);
  }
  wheel.addEventListener('mousedown', e => {
    // Wheel labels and center button handle their own clicks.
    if (e.target.closest('.wheel-label') || e.target.id === 'ipod-center') return;
    e.preventDefault();
    lastAngle = angleFromEvent(e);
    accum = 0;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  });
})();

// Mouse wheel / trackpad scroll over the iPod also scrolls the selection.
// Accumulate deltaY so one physical scroll gesture = a few steps, not dozens
// of events per second (which caused overshoot with a trackpad).
(() => {
  const STEP_PX = 50;
  let wheelAccum = 0;
  let resetTimer = null;
  ipodOverlay.addEventListener('wheel', e => {
    if (!ipodVisible) return;
    e.preventDefault();
    wheelAccum += e.deltaY;
    while (wheelAccum >=  STEP_PX) { ipodMoveSelection(+1); wheelAccum -= STEP_PX; }
    while (wheelAccum <= -STEP_PX) { ipodMoveSelection(-1); wheelAccum += STEP_PX; }
    // Drop residual accumulation after a brief idle so a new gesture starts fresh.
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { wheelAccum = 0; }, 180);
  }, { passive: false });
})();

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

// Auto-hide utility clusters after 3s of mouse inactivity (screensaver mode)
const signInButtons = document.getElementById('sign-in-buttons');
function resetHideTimer() {
  uiButtons.style.opacity = '1';
  uiButtons.style.pointerEvents = 'all';
  if (signInButtons) {
    signInButtons.style.opacity = '1';
    signInButtons.style.pointerEvents = 'all';
  }
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (controlsHidden) {
      uiButtons.style.opacity = '0';
      uiButtons.style.pointerEvents = 'none';
      if (signInButtons) {
        signInButtons.style.opacity = '0';
        signInButtons.style.pointerEvents = 'none';
      }
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

// ─── Streaming accounts (auth only; library browsing lives in the iPod) ──────

const streamingBtn     = document.getElementById('signin-btn');
const streamingMenu    = document.getElementById('streaming-menu');
const streamingConnect = document.getElementById('streaming-connect');
const streamingStatus  = document.getElementById('streaming-auth-status');

function currentStreamingSource() {
  return window.MusicSources && window.MusicSources.current();
}

function anySourceAuthed() {
  if (!window.MusicSources) return false;
  return window.MusicSources.list().some(s => {
    const src = window.MusicSources.get(s.key);
    return src && src.isAuthed();
  });
}

function refreshStreamingAuthUI() {
  const src = currentStreamingSource();
  if (!src) {
    streamingStatus.textContent = 'Select a service';
  } else {
    const authed = src.isAuthed();
    streamingStatus.textContent  = authed ? `Connected to ${src.displayName}` : 'Not connected';
    streamingConnect.textContent = authed ? 'Reconnect' : `Connect ${src.displayName}`;
  }
  streamingBtn.classList.toggle('authed', anySourceAuthed());
  syncIPodView();
}

function openStreaming() {
  streamingBtn.classList.add('open');
  streamingMenu.classList.add('open');
  refreshStreamingAuthUI();
}

function closeStreaming() {
  streamingBtn.classList.remove('open');
  streamingMenu.classList.remove('open');
}

streamingBtn.addEventListener('click', e => {
  e.stopPropagation();
  streamingMenu.classList.contains('open') ? closeStreaming() : openStreaming();
});

document.addEventListener('click', e => {
  if (!streamingMenu.contains(e.target) && e.target !== streamingBtn) closeStreaming();
});

document.querySelectorAll('.stream-src-btn').forEach(btn => {
  btn.addEventListener('click', e => {
    e.stopPropagation();
    document.querySelectorAll('.stream-src-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    window.MusicSources.setCurrent(btn.dataset.src);
    refreshStreamingAuthUI();
  });
});

streamingConnect.addEventListener('click', e => {
  e.stopPropagation();
  const src = currentStreamingSource();
  if (src) src.connect();
});

// Initialize default source + restore any persisted auth. Both services
// already store tokens in localStorage; this block makes that persistence
// actually visible at page load:
//   1. Consume Spotify OAuth redirect if we landed here with ?code=…
//   2. Proactively refresh a near-expired Spotify token so the user stays
//      signed in across long sessions without having to re-auth.
//   3. Eagerly configure MusicKit so isAuthed() can consult MusicKit's
//      own cached user-token before the user clicks anything.
(async () => {
  if (window.MusicSources) window.MusicSources.setCurrent('spotify');
  if (window.SpotifyAuth) {
    await window.SpotifyAuth.handleRedirectIfPresent();
    // getAccessToken() internally refreshes if expired. Any failure path
    // clears the stale token so the UI correctly shows "Not connected".
    try { await window.SpotifyAuth.getAccessToken(); } catch {}
  }
  if (window.AppleAuth) {
    try { await window.AppleAuth.configure(); } catch {}
  }
  refreshStreamingAuthUI();
})();

// ─── Spotify Web Playback SDK hooks ──────────────────────────────────────────

if (window.SpotifyPlayer) {
  // Fatal errors from the SDK (init/auth/Premium). Surface into the current
  // iPod frame if one is open so the user sees *why* playback failed.
  window.SpotifyPlayer.onFatalError(msg => {
    console.error('[spotify-player]', msg);
    const frame = typeof currentFrame === 'function' ? currentFrame() : null;
    if (frame) { frame.error = msg; frame.loading = false; renderIPodMenu(); }
  });
}

// Track-change subscription is source-agnostic. Both SpotifySource and
// AppleSource call their callback with { id, name, artists: [{name}], album:
// { name, images: [{url}] } }. The handler updates the now-playing UI and,
// when the current source is Spotify, kicks off an analysis pre-fetch.
function onRemoteTrackChange(source, track) {
  if (sourceMode !== 'remote' || currentStreamingSource() !== source || !track) return;
  const artist = (track.artists || []).map(a => a.name).join(', ');
  const albumArt = track.album && track.album.images && track.album.images[0] && track.album.images[0].url;
  updateNowPlayingUI({
    title: track.name,
    artist,
    album:   track.album && track.album.name,
    albumArt,
  });
  // Kick off a Spotify audio-features fetch for mood-aware viz. Apple
  // Music tracks fall through to neutral defaults — MusicKit JS doesn't
  // expose ISRC in the browser, so we can't bridge to Spotify's dataset.
  if (window.TrackMeta && track.id) {
    const providerId = source === window.SpotifySource ? 'spotify'
                     : source === window.AppleSource   ? 'apple'
                     : null;
    if (providerId) window.TrackMeta.set({ source: providerId, id: track.id });
  }
}
if (window.SpotifySource && window.SpotifySource.onTrackChange) {
  window.SpotifySource.onTrackChange(t => onRemoteTrackChange(window.SpotifySource, t));
}
if (window.AppleSource && window.AppleSource.onTrackChange) {
  window.AppleSource.onTrackChange(t => onRemoteTrackChange(window.AppleSource, t));
}

// ─── Reactive-visuals source (tab capture OR ambient pulse) ──────────────────

const vizCaptureBtn = document.getElementById('viz-capture-btn');
const vizMicBtn     = document.getElementById('viz-mic-btn');
const vizAmbientBtn = document.getElementById('viz-ambient-btn');
const vizOffBtn     = document.getElementById('viz-off-btn');
const vizStatusEl   = document.getElementById('viz-source-status');

// Capture-module `kind` field is set in attach(); we distinguish mic from
// tab-share by checking the audio track's label — browsers label tab-share
// streams with something like "Tab audio" and mic streams with the mic name.
function activeCaptureKind() {
  if (!(window.AudioCapture && window.AudioCapture.isActive())) return null;
  // Heuristic: we flagged it via emitStatus('active', {kind}). We don't store
  // it long-term, so fall back to "capture" if unknown — the UI still shows
  // the Stop button, which is what matters.
  return window._captureKind || 'capture';
}

function vizRefreshUI() {
  const cap = window.AudioCapture && window.AudioCapture.isActive();
  const amb = window.AmbientMode && window.AmbientMode.isActive();
  const kind = cap ? activeCaptureKind() : null;
  const isMic = cap && kind === 'mic';
  const isTab = cap && kind !== 'mic';

  vizCaptureBtn.classList.toggle('active', isTab);
  vizMicBtn    .classList.toggle('active', isMic);
  vizAmbientBtn.classList.toggle('active', amb);

  // Hide the inactive choices while a source is active; only the matching
  // button stays visible (as the "currently on" indicator).
  vizCaptureBtn.hidden = cap && !isTab || amb;
  vizMicBtn    .hidden = cap && !isMic || amb;
  vizAmbientBtn.hidden = cap || amb && false; // keep ambient visible unless a capture is active
  vizAmbientBtn.hidden = cap || amb;
  vizOffBtn.hidden     = !(cap || amb);

  if (isMic)      vizStatusEl.textContent = 'Listening to mic — point it at speakers for reactive visuals.';
  else if (isTab) vizStatusEl.textContent = 'Capturing tab audio — real FFT active.';
  else if (amb)   vizStatusEl.textContent = `Ambient mode — ${window.AmbientMode.getBpm()} BPM. Press T to tap tempo.`;
  else            vizStatusEl.textContent = 'Pick a source to drive the visualizer.';
}

vizCaptureBtn.addEventListener('click', async e => {
  e.stopPropagation();
  if (!audioCtx) initAudio();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  if (window.AmbientMode && window.AmbientMode.isActive()) window.AmbientMode.stop();
  try {
    await window.AudioCapture.startTabCapture();
    window._captureKind = 'tab';
    vizStatusEl.textContent = 'Capturing tab audio — real FFT active.';
  } catch (err) {
    console.error('[viz capture]', err);
    vizStatusEl.textContent = err.message || 'Capture failed';
  }
  vizRefreshUI();
});

vizMicBtn.addEventListener('click', async e => {
  e.stopPropagation();
  if (!audioCtx) initAudio();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  if (window.AmbientMode && window.AmbientMode.isActive()) window.AmbientMode.stop();
  // If tab-capture is running, stop it first — only one capture at a time.
  if (window.AudioCapture && window.AudioCapture.isActive()) window.AudioCapture.stop();
  try {
    await window.AudioCapture.startMicCapture();
    window._captureKind = 'mic';
    vizStatusEl.textContent = 'Listening to mic — point it at speakers for reactive visuals.';
  } catch (err) {
    console.error('[viz mic]', err);
    vizStatusEl.textContent = err.message || 'Mic capture failed';
  }
  vizRefreshUI();
});

vizAmbientBtn.addEventListener('click', e => {
  e.stopPropagation();
  if (window.AudioCapture && window.AudioCapture.isActive()) window.AudioCapture.stop();
  window.AmbientMode.start();
  vizRefreshUI();
});

vizOffBtn.addEventListener('click', e => {
  e.stopPropagation();
  if (window.AudioCapture) window.AudioCapture.stop();
  if (window.AmbientMode)  window.AmbientMode.stop();
  window._captureKind = null;
  vizRefreshUI();
});

if (window.AudioCapture) window.AudioCapture.onStatusChange(vizRefreshUI);
vizRefreshUI();

// ─── Keyboard navigation ─────────────────────────────────────────────────────
// Arrow keys + Space + Enter + Escape, context-aware between menu / now-playing
// / no-iPod. Ignores events while typing in an input. `T` taps ambient tempo.

document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, [contenteditable]')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const k = e.key;

  if (k === 't' || k === 'T') {
    if (window.AmbientMode && window.AmbientMode.isActive()) {
      window.AmbientMode.tap();
      vizRefreshUI();
      e.preventDefault();
    }
    return;
  }

  if (ipodVisible && ipodMode === 'menu') {
    switch (k) {
      case 'ArrowUp':    ipodMoveSelection(-1); e.preventDefault(); break;
      case 'ArrowDown':  ipodMoveSelection(+1); e.preventDefault(); break;
      case 'Enter':
      case 'ArrowRight': ipodActivate();        e.preventDefault(); break;
      case 'Escape':
      case 'ArrowLeft':  ipodBack();            e.preventDefault(); break;
    }
    return;
  }

  if (ipodVisible && ipodMode === 'now') {
    switch (k) {
      case ' ':          togglePlayback(); e.preventDefault(); break;
      case 'ArrowLeft':  seekBy(-5);       e.preventDefault(); break;
      case 'ArrowRight': seekBy(+5);       e.preventDefault(); break;
      case 'Escape':     ipodBack();       e.preventDefault(); break;
    }
    return;
  }

  // iPod closed — global shortcuts only
  switch (k) {
    case ' ':          if (hasTrack()) { togglePlayback(); e.preventDefault(); } break;
    case 'ArrowLeft':  if (hasTrack()) { seekBy(-5);       e.preventDefault(); } break;
    case 'ArrowRight': if (hasTrack()) { seekBy(+5);       e.preventDefault(); } break;
  }
});

// ─── macOS media keys via MediaSession ───────────────────────────────────────
// The OS play/pause/next/prev keys drive playback; metadata feeds Control Center.

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play',  () => { if (!isPlaying) togglePlayback(); });
  navigator.mediaSession.setActionHandler('pause', () => { if ( isPlaying) togglePlayback(); });
  navigator.mediaSession.setActionHandler('seekbackward', () => seekBy(-10));
  navigator.mediaSession.setActionHandler('seekforward',  () => seekBy(+10));
  navigator.mediaSession.setActionHandler('nexttrack',     () => { remoteSrc()?.nextTrack?.(); });
  navigator.mediaSession.setActionHandler('previoustrack', () => { remoteSrc()?.previousTrack?.(); });
}

function setMediaSessionMetadata({ title, artist, album, artworkUrl }) {
  if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
  navigator.mediaSession.metadata = new window.MediaMetadata({
    title:  title  || '',
    artist: artist || '',
    album:  album  || '',
    artwork: artworkUrl ? [{ src: artworkUrl, sizes: '300x300' }] : [],
  });
}

// ─── Debug helper (call window.vizDebug() in DevTools) ───────────────────────
window.vizDebug = async function () {
  const r = remoteSrc();
  const trackId = r ? r.getCurrentTrackId() : null;
  const posMs   = r ? r.getPositionMs()   : null;
  return {
    sourceMode, trackId, posMs,
    live: { bass, mid, treble },
    captureActive: !!(window.AudioCapture && window.AudioCapture.isActive()),
    ambientActive: !!(window.AmbientMode && window.AmbientMode.isActive()),
  };
};

// ─── Visualizer registry ─────────────────────────────────────────────────────
// Legacy renderX() functions read the back-compat globals bass/mid/treble
// /bassHistory that updateAudioValues() continues to populate. New viz
// (Wave 2+) ignore the globals and read the AudioFrame passed as the 2nd arg.
// `ignored` markers below are just a reminder that legacy renderFns take no
// args — they're invoked as renderFn(t, frame) but only t matters for Blob.

if (window.Viz) {
  window.Viz.register({ id:'mandala',      label:'Mandala',      kind:'2d',    renderFn: () => renderMandala() });
  window.Viz.register({ id:'emoji-waves',  label:'Emoji Waves',  kind:'2d',    renderFn: () => renderEmojiWaves() });
  window.Viz.register({ id:'emoji-vortex', label:'Emoji Vortex', kind:'2d',    renderFn: () => renderEmojiVortex() });
  window.Viz.register({ id:'blob',         label:'3D Blob',      kind:'webgl',
                        initFn:   () => { if (!threeReady) initThree(); },
                        renderFn: (t) => renderBlob(t) });
  window.Viz.register({ id:'hypno-rings',  label:'Hypno Rings',  kind:'2d',    renderFn: () => renderHypnoRings() });
  window.Viz.register({ id:'spiral',       label:'Spiral',       kind:'2d',    renderFn: () => renderSpiralRings() });
  window.Viz.register({ id:'subwoofer',    label:'Subwoofer',    kind:'2d',    renderFn: () => renderSubwoofer() });
  window.Viz.register({ id:'ferro',        label:'Ferro',        kind:'2d',    renderFn: () => renderFluid() });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

resizeCanvas();
setMode(0);
requestAnimationFrame(loop);
// Position pill after first layout paint so getBoundingClientRect() has real dimensions
requestAnimationFrame(initPillPos);
