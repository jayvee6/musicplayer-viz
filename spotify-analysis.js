// Synthesizes bass / mid / treble from Spotify's Audio Analysis API, since the
// Web Playback SDK audio is DRM-protected and unreachable by AnalyserNode.
//
// For each frame, given current playback position, we find the active segment
// (binary search), interpolate loudness across its rising/falling phases, and
// add a decaying beat pulse on each beat start — the combination gives a
// loudness-envelope-plus-kick feel that matches tracks' energy without real FFT.

// Cached shape:   { segments: [...], beats: [...] }
// In-flight shape: Promise resolving to the above (or null on failure).
// We store the promise so concurrent callers during the initial fetch share
// one network request instead of racing two.
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
  // Replace the promise with the resolved value so synchronous synthesize()
  // reads the unwrapped data without awaiting.
  promise.then(v => cache.set(trackId, v), () => cache.set(trackId, null));
  return promise;
}

// Returns the index of the segment containing targetStart, clamped to valid range.
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

function synthesize(trackId, posSec) {
  const a = cache.get(trackId);
  // Ignore pending-promise entries — they're unresolved, treat as "no data yet".
  if (!a || typeof a.then === 'function' || !a.segments || !a.segments.length) {
    return { bass: 0, mid: 0, treble: 0 };
  }

  const idx  = binarySearch(a.segments, posSec);
  const seg  = a.segments[idx];
  const next = a.segments[idx + 1] || null;
  const loud = normDb(segmentLoudnessAt(seg, posSec, next));

  let beatPulse = 0;
  if (a.beats.length) {
    const beat = a.beats[binarySearch(a.beats, posSec)];
    // Only fire within the actual beat window — past the last beat's end,
    // pos stays >= beat.start forever so we'd pulse every frame.
    if (beat && posSec >= beat.start && posSec < beat.start + beat.duration) {
      const phase = (posSec - beat.start) / Math.max(0.08, beat.duration);
      beatPulse = Math.exp(-phase * 5) * (beat.confidence || 0.5);
    }
  }

  // timbre[1] is a brightness coefficient, roughly [-100, 100].
  const brightness = Math.max(0, Math.min(1, ((seg.timbre[1] || 0) + 80) / 160));

  const bass   = Math.min(1, loud * 0.55 + beatPulse * 0.75);
  const treble = Math.min(1, 0.2 + brightness * 0.55 + loud * 0.25);
  const mid    = Math.min(1, (bass + treble) * 0.5);
  return { bass, mid, treble };
}

window.SpotifyAnalysis = { loadForTrack, synthesize };
