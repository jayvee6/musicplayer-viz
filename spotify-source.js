(() => {
// Spotify Web API adapter — implements the MusicSource interface.
// Requires window.SpotifyAuth (spotify-auth.js).

async function apiFetch(path, { method = 'GET', body } = {}) {
  const token = await window.SpotifyAuth.getAccessToken();
  if (!token) throw new Error('Not authenticated with Spotify');

  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    window.SpotifyAuth.clearToken();
    throw new Error('Spotify token rejected — please reconnect.');
  }
  if (res.status === 403 && method === 'PUT' && path.startsWith('/me/player')) {
    // 403 on player-control endpoints is almost always a non-Premium account.
    throw new Error('Spotify Premium is required for full-track playback.');
  }
  if (!res.ok && res.status !== 204) {
    let detail = '';
    try {
      const b = await res.json();
      detail = (b && b.error && b.error.message) ? `: ${b.error.message}` : '';
    } catch {}
    throw new Error(`Spotify ${res.status}${detail}`);
  }
  return res.status === 204 ? null : res.json();
}

function pickAlbumArt(images) {
  if (!images || !images.length) return null;
  // Prefer ~300px thumbnail for UI; fall back to first image.
  const mid = images.find(i => i.width >= 200 && i.width <= 400);
  return (mid || images[0]).url;
}

// If the caller has album art from a separate lookup (e.g. /albums/{id}/tracks
// items don't embed album images), pass it via albumArtOverride.
function mapTrack(item, { albumArtOverride } = {}) {
  return {
    id:           item.id,
    name:         item.name,
    artists:      (item.artists || []).map(a => a.name).join(', '),
    albumArt:     albumArtOverride !== undefined ? albumArtOverride : pickAlbumArt(item.album && item.album.images),
    previewUrl:   item.preview_url || null,
    durationMs:   item.duration_ms || 0,
    hasFullTrack: true,
  };
}

async function search(query) {
  if (!query) return [];
  const params = new URLSearchParams({ q: query, type: 'track', limit: '20' });
  const data = await apiFetch(`/search?${params}`);
  const items = (data.tracks && data.tracks.items) || [];
  return items.map(t => mapTrack(t));
}

// ─── Library browsing (for iPod overlay) ─────────────────────────────────────

function mapPlaylist(p) {
  return {
    id:       p.id,
    name:     p.name,
    subtitle: p.tracks ? `${p.tracks.total} tracks` : (p.owner && p.owner.display_name) || '',
    artwork:  pickAlbumArt(p.images),
    kind:     'playlist',
  };
}

function mapArtist(a) {
  return {
    id:       a.id,
    name:     a.name,
    subtitle: null,
    artwork:  pickAlbumArt(a.images),
    kind:     'artist',
  };
}

function mapAlbum(al) {
  return {
    id:       al.id,
    name:     al.name,
    subtitle: (al.artists || []).map(a => a.name).join(', '),
    artwork:  pickAlbumArt(al.images),
    kind:     'album',
  };
}

function toSongItem(track) {
  return {
    id:       track.id,
    name:     track.name,
    subtitle: track.artists,
    artwork:  track.albumArt,
    kind:     'song',
    track,
  };
}

async function getLibrary(category) {
  switch (category) {
    case 'playlists': {
      const data = await apiFetch('/me/playlists?limit=50');
      return (data.items || []).map(mapPlaylist);
    }
    case 'artists': {
      const data = await apiFetch('/me/following?type=artist&limit=50');
      const items = (data.artists && data.artists.items) || [];
      return items.map(mapArtist);
    }
    case 'albums': {
      const data = await apiFetch('/me/albums?limit=50');
      return (data.items || []).map(w => mapAlbum(w.album));
    }
    case 'songs': {
      const data = await apiFetch('/me/tracks?limit=50');
      return (data.items || []).map(w => toSongItem(mapTrack(w.track)));
    }
    default: return [];
  }
}

async function getChildren(parentKind, parentId) {
  switch (parentKind) {
    case 'playlist': {
      const data = await apiFetch(`/playlists/${parentId}/tracks?limit=50`);
      return (data.items || [])
        .filter(w => w.track && w.track.id)
        .map(w => toSongItem(mapTrack(w.track)));
    }
    case 'artist': {
      // Use Spotify's default limit; overriding it triggered a 400 "Invalid limit" on this endpoint.
      const data = await apiFetch(`/artists/${parentId}/albums?include_groups=album,single`);
      return (data.items || []).map(mapAlbum);
    }
    case 'album': {
      // /albums/{id}/tracks items don't carry album art, so fetch the album once and inject.
      const album = await apiFetch(`/albums/${parentId}`);
      const artwork = pickAlbumArt(album.images);
      const data = await apiFetch(`/albums/${parentId}/tracks?limit=50`);
      return (data.items || []).map(t => toSongItem(mapTrack(t, { albumArtOverride: artwork })));
    }
    default: return [];
  }
}

// ─── Full-track playback via Web Playback SDK ────────────────────────────────

// Play a track on the SDK device. When `contextKind` + `contextId` are given,
// the server-side queue auto-advances (e.g. pick song 3 of an album, continue
// to 4, 5, ...). `trackIds` provides an explicit ad-hoc queue. Otherwise the
// track plays alone.
async function playTrack(trackId, { contextKind, contextId, trackIds } = {}) {
  await window.SpotifyPlayer.init();
  const deviceId = window.SpotifyPlayer.getDeviceId();
  if (!deviceId) throw new Error('Spotify SDK device not ready');

  const trackUri = `spotify:track:${trackId}`;
  let body;
  if (contextKind && contextId) {
    body = { context_uri: `spotify:${contextKind}:${contextId}`, offset: { uri: trackUri }, position_ms: 0 };
  } else if (trackIds && trackIds.length) {
    body = { uris: trackIds.map(id => `spotify:track:${id}`), offset: { uri: trackUri }, position_ms: 0 };
  } else {
    body = { uris: [trackUri] };
  }

  await apiFetch(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
    method: 'PUT',
    body,
  });
}

// Remote-playback interface — thin wrappers around SpotifyPlayer so the app
// engine can talk to Spotify and Apple through the same surface.
async function pause()    { return window.SpotifyPlayer.pause(); }
async function resume()   { return window.SpotifyPlayer.resume(); }
async function seekToMs(ms) { return window.SpotifyPlayer.seek(ms); }
async function nextTrack()     { return window.SpotifyPlayer.nextTrack(); }
async function previousTrack() { return window.SpotifyPlayer.previousTrack(); }

// Shuffle + repeat hit the /me/player/* endpoints directly since the Web
// Playback SDK doesn't expose toggles. Requires the user-modify-playback-
// state scope, which SpotifyAuth already requests.
async function setShuffle(on) {
  const token = await window.SpotifyAuth.getAccessToken();
  if (!token) return;
  await fetch(`https://api.spotify.com/v1/me/player/shuffle?state=${on ? 'true' : 'false'}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
  });
}
// Repeat modes: 'track' | 'context' (album/playlist) | 'off'
async function setRepeat(mode) {
  const token = await window.SpotifyAuth.getAccessToken();
  if (!token) return;
  await fetch(`https://api.spotify.com/v1/me/player/repeat?state=${mode}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
  });
}

function getPositionMs()  { return window.SpotifyPlayer.currentPositionMs(); }
function getDurationMs()  { return window.SpotifyPlayer.getDurationMs(); }
function getCurrentTrackId() { return window.SpotifyPlayer.getCurrentTrackId(); }
function onTrackChange(cb) { return window.SpotifyPlayer.onTrackChange(cb); }

const SpotifySource = {
  displayName: 'Spotify',
  connect()    { return window.SpotifyAuth.beginAuth(); },
  isAuthed()   { return window.SpotifyAuth.isAuthed(); },
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

window.SpotifySource = SpotifySource;
if (window.MusicSources) window.MusicSources.register('spotify', SpotifySource);

})();
