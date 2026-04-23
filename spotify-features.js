// Fetches Spotify /v1/audio-features/{id} — the "mood" numbers used to tint
// the viz palette: valence (happy/sad), energy, danceability, tempo.
// Responses are cached through window.MetaCache so flipping between tracks
// or reloading never re-queries the endpoint for an already-seen ID.
//
// Promise-dedup: concurrent calls for the same track share one network
// request (same pattern as spotify-analysis.js).

(() => {
  const inflight = new Map();  // trackId → Promise

  function cacheKey(trackId) { return `spotify-features:${trackId}`; }

  async function fetchFeatures(trackId) {
    if (!trackId) return null;

    const cached = await window.MetaCache.get(cacheKey(trackId));
    if (cached) return cached;

    if (inflight.has(trackId)) return inflight.get(trackId);

    const promise = (async () => {
      const token = window.SpotifyAuth && await window.SpotifyAuth.getAccessToken();
      if (!token) return null;
      const res = await fetch(`https://api.spotify.com/v1/audio-features/${trackId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;  // 404 for tracks Spotify hasn't analyzed
      const raw = await res.json();
      // Stash only the fields the viz pipeline actually reads. Keeps cache
      // entries small and future-proofs us against API shape drift.
      const features = {
        valence:      raw.valence      ?? 0.5,
        energy:       raw.energy       ?? 0.5,
        danceability: raw.danceability ?? 0.5,
        tempoBPM:     raw.tempo        ?? 120,
      };
      await window.MetaCache.set(cacheKey(trackId), features);
      return features;
    })().finally(() => inflight.delete(trackId));

    inflight.set(trackId, promise);
    return promise;
  }

  window.SpotifyFeatures = { fetch: fetchFeatures };
})();
