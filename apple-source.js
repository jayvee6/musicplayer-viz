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

async function getLibrary(category) {
  const mk = await window.AppleAuth.ready();
  switch (category) {
    case 'playlists': {
      const res = await mk.api.music('/v1/me/library/playlists', { limit: 50 });
      return (res.data && res.data.data || []).map(mapLibPlaylist);
    }
    case 'artists': {
      const res = await mk.api.music('/v1/me/library/artists', { limit: 50 });
      return (res.data && res.data.data || []).map(mapLibArtist);
    }
    case 'albums': {
      const res = await mk.api.music('/v1/me/library/albums', { limit: 50 });
      return (res.data && res.data.data || []).map(mapLibAlbum);
    }
    case 'songs': {
      const res = await mk.api.music('/v1/me/library/songs', { limit: 50 });
      return (res.data && res.data.data || []).map(toSongItemApple);
    }
    default: return [];
  }
}

async function getChildren(parentKind, parentId) {
  const mk = await window.AppleAuth.ready();
  switch (parentKind) {
    case 'playlist': {
      const res = await mk.api.music(`/v1/me/library/playlists/${parentId}/tracks`, { limit: 50 });
      return (res.data && res.data.data || []).map(toSongItemApple);
    }
    case 'artist': {
      const res = await mk.api.music(`/v1/me/library/artists/${parentId}/albums`, { limit: 50 });
      return (res.data && res.data.data || []).map(mapLibAlbum);
    }
    case 'album': {
      const res = await mk.api.music(`/v1/me/library/albums/${parentId}/tracks`, { limit: 50 });
      return (res.data && res.data.data || []).map(toSongItemApple);
    }
    default: return [];
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
