// Apple Music → Spotify ISRC bridge. For catalog songs (numeric IDs), fetches
// the ISRC from the Apple Music API, then searches Spotify by that ISRC to find
// a matching track ID, then fetches audio-features from Spotify.
//
// Only catalog song IDs (pure numeric strings) are bridgeable. Library song IDs
// (prefixed "i.") are skipped — the catalog lookup would fail or return the
// wrong track.
//
// Both the ISRC itself and the resolved audio-features are cached through
// window.MetaCache (IndexedDB-backed) so subsequent track-changes for an
// already-seen Apple song never hit the network.
//
// Requires: window.AppleAuth, window.SpotifyAuth, window.SpotifyFeatures,
//            window.MetaCache

(() => {
  const STOREFRONT = 'us';

  function isCatalogId(id) {
    // Library IDs start with "i." — catalog IDs are purely numeric.
    return typeof id === 'string' && /^\d+$/.test(id);
  }

  async function fetchIsrc(catalogId) {
    const cacheKey = `apple-isrc:${catalogId}`;
    const cached = await window.MetaCache.get(cacheKey);
    if (cached) return cached;

    try {
      const mk  = await window.AppleAuth.ready();
      const res = await mk.api.music(`/v1/catalog/${STOREFRONT}/songs/${catalogId}`);
      const song = res.data && res.data.data && res.data.data[0];
      const isrc = song && song.attributes && song.attributes.isrc;
      if (isrc) await window.MetaCache.set(cacheKey, isrc);
      return isrc || null;
    } catch (err) {
      console.warn('[apple-isrc] ISRC fetch failed', err);
      return null;
    }
  }

  // Promise-dedup: concurrent calls for the same Apple track ID share one
  // network round-trip (same pattern as spotify-features.js).
  const inflight = new Map();

  async function fetchFeaturesForAppleTrack(appleId) {
    if (!isCatalogId(appleId)) return null;

    const featuresCacheKey = `apple-via-isrc:${appleId}`;
    const cached = await window.MetaCache.get(featuresCacheKey);
    if (cached) return cached;

    if (inflight.has(appleId)) return inflight.get(appleId);

    const promise = (async () => {
      const isrc = await fetchIsrc(appleId);
      if (!isrc) return null;

      if (!window.SpotifyAuth) return null;
      const token = await window.SpotifyAuth.getAccessToken();
      if (!token) return null;

      // Search Spotify for the ISRC — returns the matching Spotify track ID.
      const searchRes = await fetch(
        `https://api.spotify.com/v1/search?q=isrc:${encodeURIComponent(isrc)}&type=track&limit=1`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!searchRes.ok) return null;
      const searchData = await searchRes.json();
      const spotifyId  = searchData.tracks
                      && searchData.tracks.items
                      && searchData.tracks.items[0]
                      && searchData.tracks.items[0].id;
      if (!spotifyId) return null;

      if (!window.SpotifyFeatures) return null;
      const features = await window.SpotifyFeatures.fetch(spotifyId);
      if (features) await window.MetaCache.set(featuresCacheKey, features);
      return features || null;
    })().finally(() => inflight.delete(appleId));

    inflight.set(appleId, promise);
    return promise;
  }

  window.AppleISRC = { fetchFeaturesForAppleTrack };
})();
