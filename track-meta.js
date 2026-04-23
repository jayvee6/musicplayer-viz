// window.TrackMeta — source-agnostic facade for the mood uniforms read by
// every viz via AudioEngine.currentFrame(). Populated when the current
// remote source (Spotify, Apple) changes track.
//
// Spotify tracks resolve to real audio-features from the API. Apple tracks
// stay at neutral defaults since MusicKit JS doesn't expose ISRC in the
// browser — we have no bridge to translate an Apple track ID to something
// Spotify can query.

(() => {
  const DEFAULTS = Object.freeze({
    valence:      0.5,
    energy:       0.5,
    danceability: 0.5,
    tempoBPM:     120,
  });

  let currentKey = null;          // "spotify:<id>" or "apple:<id>" or null
  let currentFeatures = null;     // resolved features or null

  // AudioEngine reads this every frame — return a stable reference when
  // nothing has resolved so the engine's `?? 0.5` fallbacks take over.
  function current() {
    return currentFeatures;
  }

  // Called whenever the active remote source swaps tracks. See
  // onRemoteTrackChange in app.js for the wiring.
  // opts = { source: 'spotify' | 'apple', id, title?, artist? }
  async function set(opts) {
    if (!opts || !opts.id) {
      currentKey = null;
      currentFeatures = null;
      return;
    }
    const key = `${opts.source}:${opts.id}`;
    if (key === currentKey && currentFeatures) return;   // already resolved
    currentKey = key;
    currentFeatures = null;  // clear while fetching so the viz defaults in

    if (opts.source === 'spotify' && window.SpotifyFeatures) {
      try {
        const features = await window.SpotifyFeatures.fetch(opts.id);
        // Only commit if the current track hasn't changed under us — guards
        // against stale async resolves when the user skips quickly.
        if (currentKey === key && features) {
          currentFeatures = features;
        }
      } catch (err) {
        console.warn('[track-meta] spotify fetch failed', err);
      }
    }
    // Apple tracks: try ISRC bridge → Spotify audio-features. Catalog song IDs
    // (numeric) can be resolved via Apple Music API → ISRC → Spotify search.
    // Library IDs ("i.*") are silently skipped; engine falls back to neutral mood.
    if (opts.source === 'apple' && window.AppleISRC) {
      try {
        const features = await window.AppleISRC.fetchFeaturesForAppleTrack(opts.id);
        if (currentKey === key && features) {
          currentFeatures = features;
        }
      } catch (err) {
        console.warn('[track-meta] apple isrc bridge failed', err);
      }
    }
  }

  window.TrackMeta = { current, set, DEFAULTS };
})();
