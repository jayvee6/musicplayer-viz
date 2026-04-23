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

// Cache entry shape: { state: 'loading' | 'ready' | 'failed', data, promise, ts }
//   - 'loading': fetch in flight. `promise` resolves to the final `data` (or null).
//     `data` is null until resolution.
//   - 'ready':   fetch succeeded and data has segments. `data` holds the compact
//                analysis object. Stays cached for the life of the page — audio
//                analysis is immutable per trackId.
//   - 'failed':  fetch returned no usable data (404, network error, empty body,
//                token refresh miss, etc.). `data` is null. After
//                FAILED_RETRY_MS we will refetch on the next loadForTrack call,
//                so a transient token-refresh miss eventually recovers rather
//                than permanently blocking synth playback.
const cache = new Map();

// How long a 'failed' entry sits before loadForTrack will refetch. 30s is long
// enough that we don't hammer the API on a genuine 404, short enough that a
// user who refreshes their Spotify token or reconnects a flaky network sees
// the synth spectrum come back without a full reload.
const FAILED_RETRY_MS = 30_000;

function _doFetch(trackId) {
  const entry = { state: 'loading', data: null, promise: null, ts: Date.now() };
  entry.promise = (async () => {
    try {
      const token = await window.SpotifyAuth.getAccessToken();
      if (!token) {
        cache.set(trackId, { state: 'failed', data: null, promise: null, ts: Date.now() });
        return null;
      }
      const res = await fetch(`https://api.spotify.com/v1/audio-analysis/${trackId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        // 404 is common — Spotify doesn't analyze everything. 401 means the
        // access token expired mid-flight; a future call after refresh should
        // retry, which the FAILED_RETRY_MS window enables.
        cache.set(trackId, { state: 'failed', data: null, promise: null, ts: Date.now() });
        return null;
      }
      const raw = await res.json();
      const data = {
        segments: (raw.segments || []).map(s => ({
          start: s.start, duration: s.duration,
          loudness_start:    s.loudness_start,
          loudness_max:      s.loudness_max,
          loudness_max_time: s.loudness_max_time,
          timbre: s.timbre || [],
        })),
        beats: (raw.beats || []).map(b => ({ start: b.start, duration: b.duration, confidence: b.confidence })),
      };
      cache.set(trackId, { state: 'ready', data, promise: null, ts: Date.now() });
      return data;
    } catch (e) {
      // Network error, JSON parse error, token refresh throw — all retryable
      // after the window expires.
      cache.set(trackId, { state: 'failed', data: null, promise: null, ts: Date.now() });
      return null;
    }
  })();
  cache.set(trackId, entry);
  return entry.promise;
}

async function loadForTrack(trackId) {
  if (!trackId) return null;
  const cached = cache.get(trackId);
  if (cached) {
    if (cached.state === 'ready')   return cached.data;
    if (cached.state === 'loading') return cached.promise;
    if (cached.state === 'failed') {
      // Retry only after the cooldown window — a burst of callers (e.g. the
      // DRM path polling every frame) should not spin up N parallel fetches
      // for the same 404.
      if (Date.now() - cached.ts < FAILED_RETRY_MS) return null;
      // Fall through — stale failure, refetch below.
    }
  }
  return _doFetch(trackId);
}

function hasTrack(trackId) {
  const e = cache.get(trackId);
  return !!(e && e.state === 'ready' && e.data && e.data.segments && e.data.segments.length);
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
  const e = cache.get(trackId);
  if (!e || e.state !== 'ready' || !e.data || !e.data.segments || !e.data.segments.length) return false;
  const a = e.data;

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
