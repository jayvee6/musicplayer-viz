(() => {
// Apple Music catalog/library + MusicKit full-track playback.
// Implements the MusicSource interface + the "remote playback" sub-interface
// (playTrack/pause/resume/seek/getPositionMs/getDurationMs/getCurrentTrackId/onTrackChange).

const STOREFRONT = 'us';

function artworkUrl(artwork, size = 300) {
  if (!artwork || !artwork.url) return null;
  return artwork.url.replace('{w}', size).replace('{h}', size);
}

function mapSong(song) {
  const a = song.attributes || {};
  const preview = a.previews && a.previews[0] ? a.previews[0].url : null;
  return {
    id:           song.id,
    name:         a.name,
    artists:      a.artistName || '',
    albumArt:     artworkUrl(a.artwork, 300),
    previewUrl:   preview,
    durationMs:   a.durationInMillis || 0,
    hasFullTrack: true, // MusicKit can play full tracks for authed subscribers
  };
}

async function search(query) {
  if (!query) return [];
  const mk = await window.AppleAuth.ready();
  const res = await mk.api.music(`/v1/catalog/${STOREFRONT}/search`, {
    term:  query,
    types: 'songs',
    limit: 20,
  });
  const songs = (res.data && res.data.results && res.data.results.songs && res.data.results.songs.data) || [];
  return songs.map(mapSong);
}

// ─── Library browsing (for iPod overlay) ─────────────────────────────────────

function mapLibPlaylist(p) {
  const a = p.attributes || {};
  return {
    id:       p.id,
    name:     a.name || 'Untitled playlist',
    subtitle: a.trackCount ? `${a.trackCount} tracks` : (a.curatorName || ''),
    artwork:  artworkUrl(a.artwork, 300),
    kind:     'playlist',
  };
}

function mapLibArtist(ar) {
  const a = ar.attributes || {};
  return {
    id:       ar.id,
    name:     a.name,
    subtitle: null,
    artwork:  null,
    kind:     'artist',
  };
}

function mapLibAlbum(al) {
  const a = al.attributes || {};
  return {
    id:       al.id,
    name:     a.name,
    subtitle: a.artistName || '',
    artwork:  artworkUrl(a.artwork, 300),
    kind:     'album',
  };
}

function toSongItemApple(song) {
  const t = mapSong(song);
  return { id: t.id, name: t.name, subtitle: t.artists, artwork: t.albumArt, kind: 'song', track: t };
}

// Fetch one page of an Apple Music library endpoint. Pagination uses the
// `data.next` URL that Apple returns — an opaque path string we pass back on
// the next call. Cursor shape: null (first page) or a string like
// '/v1/me/library/artists?offset=50'. On the first page we add `limit=50`;
// subsequent pages inherit whatever Apple put in `next`.
//
// Two-strategy fallback:
//   1. MusicKit JS SDK — mk.api.music(path) passes through to Apple's REST.
//      Works for both first-page paths with opts and arbitrary `next` strings.
//   2. Raw fetch — if the SDK rejects the path (implementations vary across
//      MusicKit JS versions), use the instance's developerToken +
//      musicUserToken to call the Apple REST endpoint directly.
async function fetchApplePage(path, cursor) {
  const mk = await window.AppleAuth.ready();
  const reqPath = cursor || path;
  const opts    = cursor ? undefined : { limit: 50 };
  try {
    const res  = await mk.api.music(reqPath, opts);
    const body = res.data || {};
    return { items: body.data || [], nextCursor: body.next || null };
  } catch (sdkErr) {
    // Strategy 2: raw HTTP with the instance's tokens. MusicKit exposes them
    // on the instance; we rebuild the request against api.music.apple.com.
    const devToken  = mk.developerToken || (mk._developerToken);
    const userToken = mk.musicUserToken || (mk._musicUserToken);
    if (!devToken || !userToken) throw sdkErr;
    const qs  = cursor ? '' : '?limit=50';
    const url = `https://api.music.apple.com${reqPath}${qs}`;
    const res = await fetch(url, {
      headers: {
        Authorization:       `Bearer ${devToken}`,
        'Music-User-Token':  userToken,
      },
    });
    if (!res.ok) throw sdkErr; // surface the original SDK error, it's usually clearer
    const body = await res.json();
    return { items: body.data || [], nextCursor: body.next || null };
  }
}

async function getLibrary(category, opts = {}) {
  const cursor = opts.cursor;
  switch (category) {
    case 'playlists': {
      const { items, nextCursor } = await fetchApplePage('/v1/me/library/playlists', cursor);
      return { items: items.map(mapLibPlaylist), nextCursor };
    }
    case 'artists': {
      const { items, nextCursor } = await fetchApplePage('/v1/me/library/artists', cursor);
      return { items: items.map(mapLibArtist), nextCursor };
    }
    case 'albums': {
      const { items, nextCursor } = await fetchApplePage('/v1/me/library/albums', cursor);
      return { items: items.map(mapLibAlbum), nextCursor };
    }
    case 'songs': {
      const { items, nextCursor } = await fetchApplePage('/v1/me/library/songs', cursor);
      return { items: items.map(toSongItemApple), nextCursor };
    }
    default: return { items: [], nextCursor: null };
  }
}

async function getChildren(parentKind, parentId, opts = {}) {
  const cursor = opts.cursor;
  switch (parentKind) {
    case 'playlist': {
      const { items, nextCursor } = await fetchApplePage(`/v1/me/library/playlists/${parentId}/tracks`, cursor);
      return { items: items.map(toSongItemApple), nextCursor };
    }
    case 'artist': {
      const { items, nextCursor } = await fetchApplePage(`/v1/me/library/artists/${parentId}/albums`, cursor);
      return { items: items.map(mapLibAlbum), nextCursor };
    }
    case 'album': {
      const { items, nextCursor } = await fetchApplePage(`/v1/me/library/albums/${parentId}/tracks`, cursor);
      return { items: items.map(toSongItemApple), nextCursor };
    }
    default: return { items: [], nextCursor: null };
  }
}

// ─── Remote-playback interface via MusicKit ──────────────────────────────────

// Cache the MusicKit instance across per-frame accessor calls. First call
// hits getInstance(); subsequent calls read the cached ref. Invalidate if the
// singleton ever changes (MusicKit doesn't reassign in practice).
let _mkInstance = null;
function mk() {
  if (_mkInstance) return _mkInstance;
  if (!window.MusicKit || !window.MusicKit.getInstance) return null;
  _mkInstance = window.MusicKit.getInstance();
  return _mkInstance;
}

// Library IDs start with "i.", catalog IDs are numeric. MusicKit's shortcut
// forms (song/songs/album/playlist) handle both, but library-only items
// sometimes need the explicit library-* container — fall back progressively.
async function playTrack(trackId, { contextKind, contextId, trackIds } = {}) {
  const instance = await window.AppleAuth.ready();
  // If the user hasn't completed `authorize()` yet, playback of full tracks
  // will fail with 401. Surface that clearly.
  if (!instance.isAuthorized) throw new Error('Apple Music sign-in required for full-track playback. Click Connect.');

  const attempts = [];
  if (contextKind === 'playlist' && contextId) {
    attempts.push({ playlist: contextId, startWith: trackId });
  } else if (contextKind === 'album' && contextId) {
    attempts.push({ album: contextId, startWith: trackId });
  } else if (trackIds && trackIds.length) {
    attempts.push({ songs: trackIds, startWith: trackId });
  }
  // Always fall back to single-track play if the richer queue fails.
  attempts.push({ song: trackId });

  let lastErr;
  for (const a of attempts) {
    try { await instance.setQueue(a); lastErr = null; break; }
    catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  await instance.play();
}

async function pause()    { const i = mk(); if (i) return i.pause(); }
async function resume()   { const i = mk(); if (i) return i.play(); }
async function seekToMs(ms) { const i = mk(); if (i) return i.seekToTime(Math.max(0, ms / 1000)); }
async function nextTrack()     { const i = mk(); if (i && i.skipToNextItem)     return i.skipToNextItem(); }
async function previousTrack() { const i = mk(); if (i && i.skipToPreviousItem) return i.skipToPreviousItem(); }

// MusicKit shuffleMode: 0 = off, 1 = songs. repeatMode: 0 = none, 1 = one, 2 = all.
async function setShuffle(on) {
  const i = mk(); if (!i) return;
  try { i.shuffleMode = on ? 1 : 0; } catch {}
}
// Normalize the mode string coming from app.js to MusicKit's numeric enum.
async function setRepeat(mode) {
  const i = mk(); if (!i) return;
  const code = mode === 'track' ? 1 : mode === 'context' ? 2 : 0;
  try { i.repeatMode = code; } catch {}
}

function getPositionMs()  { const i = mk(); return i ? Math.round((i.currentPlaybackTime || 0) * 1000) : 0; }
function getDurationMs()  { const i = mk(); return i ? Math.round((i.currentPlaybackDuration || 0) * 1000) : 0; }
function getCurrentTrackId() { const i = mk(); return (i && i.nowPlayingItem && i.nowPlayingItem.id) || null; }

const appleTrackChangeSubs = [];
function onTrackChange(cb) { appleTrackChangeSubs.push(cb); }
function wireNowPlayingListenerOnce() {
  const i = mk(); if (!i || wireNowPlayingListenerOnce._done) return;
  wireNowPlayingListenerOnce._done = true;
  const emit = () => {
    const item = i.nowPlayingItem;
    if (!item) return;
    const track = {
      id: item.id,
      name: item.attributes && item.attributes.name || item.title,
      artists: [{ name: (item.attributes && item.attributes.artistName) || item.artistName || '' }],
      album: {
        name: (item.attributes && item.attributes.albumName) || item.albumName || '',
        images: (item.attributes && item.attributes.artwork) ? [{ url: artworkUrl(item.attributes.artwork, 300) }] : [],
      },
    };
    appleTrackChangeSubs.forEach(cb => { try { cb(track); } catch {} });
  };
  if (typeof i.addEventListener === 'function') {
    i.addEventListener('nowPlayingItemDidChange', emit);
  }
}

// Hook listener as soon as MusicKit is configured.
if (window.AppleAuth && window.AppleAuth.ready) {
  window.AppleAuth.ready().then(() => wireNowPlayingListenerOnce()).catch(() => {});
}

const AppleSource = {
  displayName: 'Apple Music',
  connect()    { return window.AppleAuth.beginAuth(); },
  isAuthed()   { return window.AppleAuth.isAuthed(); },
  search,
  getLibrary,
  getChildren,
  // Remote-playback interface
  playTrack,
  pause,
  resume,
  seekToMs,
  nextTrack,
  previousTrack,
  setShuffle,
  setRepeat,
  getPositionMs,
  getDurationMs,
  getCurrentTrackId,
  onTrackChange,
};

window.AppleSource = AppleSource;
if (window.MusicSources) window.MusicSources.register('apple', AppleSource);

})();
