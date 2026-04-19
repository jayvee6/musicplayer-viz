(() => {
// Ambient mode: synthesize a believable frequency spectrum in the absence of
// real audio analysis. Used when tab capture isn't available and Spotify's
// audio-analysis API is 403'd (new-app deprecation).
//
// Instead of just pulsing bass on every beat, we fill the full frequencyData
// buffer with a shaped pseudo-spectrum:
//   - Low bins: kick-drum envelope on the tempo grid (sharp attack, fast decay)
//   - Mid bins: slowly-modulated sinusoid bed
//   - High bins: faster sinusoid "fizz" with per-bin phase offsets
// This gives every visualizer mode — including Ferro, which reads raw FFT bins
// directly — something alive to animate against. Tap-tempo sets the beat rate.

let active = false;
let bpm = 120;
let lastTapMs = 0;
const tapIntervals = [];
const MAX_TAPS = 4;

function intervalMs() { return 60_000 / bpm; }

function tap() {
  const now = performance.now();
  if (lastTapMs) {
    const dt = now - lastTapMs;
    if (dt >= 200 && dt <= 2000) {
      tapIntervals.push(dt);
      while (tapIntervals.length > MAX_TAPS) tapIntervals.shift();
      const avg = tapIntervals.reduce((a, b) => a + b, 0) / tapIntervals.length;
      const next = Math.round(60_000 / avg);
      if (next >= 35 && next <= 220) bpm = next;
    }
  }
  lastTapMs = now;
}

function start() { active = true;  tapIntervals.length = 0; lastTapMs = 0; }
function stop()  { active = false; }
function isActive() { return active; }
function getBpm()   { return bpm; }

// Fill a Uint8Array with a synthesized spectrum for the given time (seconds).
// Bin values mirror Web Audio's AnalyserNode: 0..255 (dB-normalized).
function fillSpectrum(buffer, tSec) {
  if (!active) { buffer.fill(0); return; }

  const len     = buffer.length;
  const bassEnd = Math.floor(len * 0.10);
  const midEnd  = Math.floor(len * 0.45);

  // Beat envelope: 1.0 at each beat start, decays to ~0 before next beat.
  const beatDur   = intervalMs() / 1000;
  const beatPhase = (tSec % beatDur) / beatDur;
  const beat      = Math.exp(-beatPhase * 4.5);

  // Slow modulator that adds rise-and-fall across 2 bars.
  const slow = 0.35 + 0.25 * (0.5 + 0.5 * Math.sin(tSec * 0.45));

  // Bass bins: driven by kick envelope, peak near the lowest bin and fall off.
  for (let i = 0; i < bassEnd; i++) {
    const t   = i / Math.max(1, bassEnd - 1);
    const fall = Math.exp(-t * 2.2);               // low bins strongest
    const v   = beat * fall * (0.65 + slow * 0.35) * 255;
    buffer[i] = Math.min(255, Math.max(0, v + (Math.random() - 0.5) * 8));
  }

  // Mid bins: slowly modulated bed + light kick coupling.
  for (let i = bassEnd; i < midEnd; i++) {
    const t     = (i - bassEnd) / Math.max(1, midEnd - bassEnd - 1);
    const carrier = 0.55 + 0.45 * Math.sin(tSec * 1.7 + i * 0.09);
    const shape   = 1 - Math.abs(t - 0.5) * 1.2;   // peak in the middle of the band
    const v       = (slow * 180 + beat * 60) * carrier * Math.max(0.25, shape);
    buffer[i] = Math.min(255, Math.max(0, v + (Math.random() - 0.5) * 10));
  }

  // Treble bins: high-freq fizz with per-bin phase offsets — looks like a
  // mid-brightness cymbal wash. Not beat-locked so it feels "between" kicks.
  for (let i = midEnd; i < len; i++) {
    const t      = (i - midEnd) / Math.max(1, len - midEnd - 1);
    const fizz   = 0.3 + 0.5 * Math.abs(Math.sin(tSec * 5.3 + i * 0.23));
    const rolloff = Math.exp(-t * 0.9);            // taper toward nyquist
    const v      = slow * fizz * rolloff * 170 + beat * 25;
    buffer[i] = Math.min(255, Math.max(0, v + (Math.random() - 0.5) * 14));
  }
}

window.AmbientMode = { start, stop, isActive, tap, getBpm, fillSpectrum };

})();
