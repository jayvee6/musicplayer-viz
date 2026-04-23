// Synthesizes a 32-bin mel-like spectrum + beatPulse from Spotify's Audio
// Analysis API, since the Web Playback SDK audio is DRM-protected and
// unreachable by AnalyserNode.
//
// Per frame: given current playback position, find the active segment (binary
// search), interpolate loudness across its rising/falling phases, shape a
// spectrum from timbre coefficients (brightness + flatness), and add a
// decaying beat bump on each beat start. Values land in the same ~0..1 range
// as the real FFT path post-AGC, so downstream bass/mid/treble computation +
// OnsetBPMDetector work without further scaling.

const cache = new Map();

async function loadForTrack(trackId) {
  if (!trackId) return null;
  const cached = cache.get(trackId);
  if (cached !== undefined) return cached; // may be a promise, compact data, or null

  const promise = (async () => {
    const token = await window.SpotifyAuth.getAccessToken();
    if (!token) return null;
    const res = await fetch(`https://api.spotify.com/v1/audio-analysis/${trackId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null; // 404 is common — Spotify doesn't analyze everything
    const data = await res.json();
    return {
      segments: (data.segments || []).map(s => ({
        start: s.start, duration: s.duration,
        loudness_start:    s.loudness_start,
        loudness_max:      s.loudness_max,
        loudness_max_time: s.loudness_max_time,
        timbre: s.timbre || [],
      })),
      beats: (data.beats || []).map(b => ({ start: b.start, duration: b.duration, confidence: b.confidence })),
    };
  })();

  cache.set(trackId, promise);
  // Replace the promise with the resolved value so synchronous fill reads the
  // unwrapped data without awaiting.
  promise.then(v => cache.set(trackId, v), () => cache.set(trackId, null));
  return promise;
}

function hasTrack(trackId) {
  const a = cache.get(trackId);
  return !!(a && typeof a.then !== 'function' && a.segments && a.segments.length);
}

function binarySearch(arr, targetStart) {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const s = arr[m];
    if (targetStart < s.start) hi = m - 1;
    else if (targetStart >= s.start + s.duration) lo = m + 1;
    else return m;
  }
  return Math.max(0, Math.min(arr.length - 1, lo));
}

// Map dB → [0, 1]. Spotify loudness is roughly -60…0 dB; -40 floor is a good
// compromise between "silence suppresses viz" and "everything clips".
function normDb(db) {
  const v = (db - -40) / 40;
  return Math.max(0, Math.min(1, v));
}

function segmentLoudnessAt(seg, posSec, nextSeg) {
  const t = posSec - seg.start;
  if (t <= seg.loudness_max_time) {
    const r = seg.loudness_max_time > 0 ? t / seg.loudness_max_time : 1;
    return seg.loudness_start + (seg.loudness_max - seg.loudness_start) * r;
  }
  const tailDur = Math.max(0.0001, seg.duration - seg.loudness_max_time);
  const endLoud = nextSeg ? nextSeg.loudness_start : seg.loudness_start;
  const r = Math.min(1, (t - seg.loudness_max_time) / tailDur);
  return seg.loudness_max + (endLoud - seg.loudness_max) * r;
}

// Fills `out` (Float32Array of length 32) with a synthesized spectrum for the
// current playback position. Returns true if synthesis succeeded, false if
// analysis data isn't loaded or the track has no segments. On success, values
// are already in the post-AGC 0..1 range.
function fillMagnitudes(out, trackId, posSec) {
  const a = cache.get(trackId);
  if (!a || typeof a.then === 'function' || !a.segments || !a.segments.length) return false;

  const segIdx = binarySearch(a.segments, posSec);
  const seg    = a.segments[segIdx];
  const next   = a.segments[segIdx + 1] || null;
  const loud   = normDb(segmentLoudnessAt(seg, posSec, next));

  // timbre[1] = brightness (higher → more treble tilt)
  // timbre[2] = flatness  (higher → less tilted, more evenly-distributed)
  // Both are roughly [-100, 100]; normalize to [0, 1] with a 0.5-centered floor.
  const brightness = Math.max(0, Math.min(1, ((seg.timbre[1] || 0) + 80) / 160));
  const flatness   = Math.max(0, Math.min(1, ((seg.timbre[2] || 0) + 80) / 160));

  // Beat pulse within the active beat window — bass-weighted so detection
  // downstream reads the same "kick → spike" shape as the real FFT path.
  let beatPulse = 0;
  if (a.beats.length) {
    const beat = a.beats[binarySearch(a.beats, posSec)];
    if (beat && posSec >= beat.start && posSec < beat.start + beat.duration) {
      const phase = (posSec - beat.start) / Math.max(0.08, beat.duration);
      beatPulse = Math.exp(-phase * 5) * (beat.confidence || 0.5);
    }
  }

  const N = out.length;
  const lastIdx = N - 1;
  for (let b = 0; b < N; b++) {
    const t = b / lastIdx; // 0..1 mel-bin fraction
    // Brightness-controlled tilt: 0 → low-shelf, 1 → high-shelf. gamma=1.2 keeps
    // the shape from going too spiky at the endpoints.
    const lowShape  = Math.pow(1 - t, 1.2);
    const highShape = Math.pow(t, 1.2);
    const tilt  = (1 - brightness) * lowShape + brightness * highShape;
    // Flatness blends tilted shape with a uniform mid-level so high-flatness
    // segments (noise, pads) fill the whole bar instead of hugging one end.
    const shape = flatness * 0.45 + (1 - flatness) * tilt;
    // Bass bump on beat — concentrated in the low bins, decays exponentially
    // toward treble. Same shape a kick drum presents in a real FFT.
    const bassBump = beatPulse * Math.exp(-t * 6.0) * 0.55;
    const v = loud * (0.20 + shape * 1.35) + bassBump;
    out[b] = v > 0 ? v : 0;
  }
  return true;
}

window.SpotifyAnalysis = { loadForTrack, hasTrack, fillMagnitudes };
