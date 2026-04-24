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

// getLibrary / getChildren both support opaque cursor-based pagination. Pass
// `{ cursor }` on subsequent calls to continue where the previous call left
// off; a null `nextCursor` in the response means end-of-list. Cursors are
// adapter-private — most Spotify endpoints encode an integer offset, except:
//   - artists: Spotify's /me/following uses a cursor-paginated model keyed by
//     the last artist's id (`after=<id>`), so the cursor IS that id string.
//   - album children: we preserve the album artwork across pages so pagination
//     doesn't refetch /albums/{id} each page. Cursor is { offset, artwork }.
// All shapes are opaque to the UI.

async function getLibrary(category, opts = {}) {
  const cursor = opts.cursor;
  const limit  = opts.limit || 50;

  switch (category) {
    case 'playlists': {
      const offset = cursor || 0;
      const data = await apiFetch(`/me/playlists?limit=${limit}&offset=${offset}`);
      const items = (data.items || []).map(mapPlaylist);
      return { items, nextCursor: data.next ? offset + items.length : null };
    }
    case 'artists': {
      // Cursor-paginated (not offset). The cursor IS a Spotify artist id;
      // first-page requests pass no `after` param.
      const q = cursor ? `&after=${encodeURIComponent(cursor)}` : '';
      const data = await apiFetch(`/me/following?type=artist&limit=${limit}${q}`);
      const followers = data.artists || {};
      const items = (followers.items || []).map(mapArtist);
      const nextCursor = followers.next
        ? (followers.cursors && followers.cursors.after) || null
        : null;
      return { items, nextCursor };
    }
    case 'albums': {
      const offset = cursor || 0;
      const data = await apiFetch(`/me/albums?limit=${limit}&offset=${offset}`);
      const items = (data.items || []).map(w => mapAlbum(w.album));
      return { items, nextCursor: data.next ? offset + items.length : null };
    }
    case 'songs': {
      const offset = cursor || 0;
      const data = await apiFetch(`/me/tracks?limit=${limit}&offset=${offset}`);
      const items = (data.items || []).map(w => toSongItem(mapTrack(w.track)));
      return { items, nextCursor: data.next ? offset + items.length : null };
    }
    default: return { items: [], nextCursor: null };
  }
}

async function getChildren(parentKind, parentId, opts = {}) {
  const cursor = opts.cursor;
  const limit  = opts.limit || 50;

  switch (parentKind) {
    case 'playlist': {
      const offset = cursor || 0;
      const data = await apiFetch(`/playlists/${parentId}/tracks?limit=${limit}&offset=${offset}`);
      const items = (data.items || [])
        .filter(w => w.track && w.track.id)
        .map(w => toSongItem(mapTrack(w.track)));
      return { items, nextCursor: data.next ? offset + items.length : null };
    }
    case 'artist': {
      // /artists/{id}/albums rejects an explicit `limit` param with
      // 400 "Invalid limit" — use Spotify's default page size (~20) and
      // only pass offset. `data.next` remains the authoritative signal.
      const offset = cursor || 0;
      const data = await apiFetch(`/artists/${parentId}/albums?include_groups=album,single&offset=${offset}`);
      const items = (data.items || []).map(mapAlbum);
      return { items, nextCursor: data.next ? offset + items.length : null };
    }
    case 'album': {
      // Compound cursor { offset, artwork } — the album art lookup only
      // needs to happen once per album, not once per page.
      const offset  = (cursor && cursor.offset) || 0;
      let   artwork = cursor && cursor.artwork;
      if (artwork === undefined) {
        const album = await apiFetch(`/albums/${parentId}`);
        artwork = pickAlbumArt(album.images);
      }
      const data = await apiFetch(`/albums/${parentId}/tracks?limit=${limit}&offset=${offset}`);
      const items = (data.items || []).map(t => toSongItem(mapTrack(t, { albumArtOverride: artwork })));
      const nextCursor = data.next ? { offset: offset + items.length, artwork } : null;
      return { items, nextCursor };
    }
    default: return { items: [], nextCursor: null };
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
