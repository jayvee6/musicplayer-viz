// Spotify Web API adapter — implements the MusicSource interface.
// Requires window.SpotifyAuth (spotify-auth.js).

async function apiGet(path) {
  const token = await window.SpotifyAuth.getAccessToken();
  if (!token) throw new Error('Not authenticated with Spotify');
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    window.SpotifyAuth.clearToken();
    throw new Error('Spotify token rejected — please reconnect.');
  }
  if (!res.ok) throw new Error(`Spotify API ${res.status}`);
  return res.json();
}

function pickAlbumArt(images) {
  if (!images || !images.length) return null;
  // Prefer ~300px thumbnail for UI; fall back to first image.
  const mid = images.find(i => i.width >= 200 && i.width <= 400);
  return (mid || images[0]).url;
}

function mapTrack(item) {
  return {
    id:           item.id,
    name:         item.name,
    artists:      (item.artists || []).map(a => a.name).join(', '),
    albumArt:     pickAlbumArt(item.album && item.album.images),
    previewUrl:   item.preview_url || null,
    durationMs:   item.duration_ms || 0,
    hasFullTrack: false, // Phase 2
  };
}

async function search(query) {
  if (!query) return [];
  const params = new URLSearchParams({ q: query, type: 'track', limit: '20' });
  const data = await apiGet(`/search?${params}`);
  const items = (data.tracks && data.tracks.items) || [];
  return items.map(mapTrack);
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
      const data = await apiGet('/me/playlists?limit=50');
      return (data.items || []).map(mapPlaylist);
    }
    case 'artists': {
      const data = await apiGet('/me/following?type=artist&limit=50');
      const items = (data.artists && data.artists.items) || [];
      return items.map(mapArtist);
    }
    case 'albums': {
      const data = await apiGet('/me/albums?limit=50');
      return (data.items || []).map(w => mapAlbum(w.album));
    }
    case 'songs': {
      const data = await apiGet('/me/tracks?limit=50');
      return (data.items || []).map(w => toSongItem(mapTrack(w.track)));
    }
    default: return [];
  }
}

async function getChildren(parentKind, parentId) {
  switch (parentKind) {
    case 'playlist': {
      const data = await apiGet(`/playlists/${parentId}/tracks?limit=50`);
      return (data.items || [])
        .filter(w => w.track && w.track.id)
        .map(w => toSongItem(mapTrack(w.track)));
    }
    case 'artist': {
      const data = await apiGet(`/artists/${parentId}/albums?limit=50&include_groups=album,single`);
      return (data.items || []).map(mapAlbum);
    }
    case 'album': {
      // Album track items lack full album data; fetch album once for artwork.
      const album = await apiGet(`/albums/${parentId}`);
      const artwork = pickAlbumArt(album.images);
      const data = await apiGet(`/albums/${parentId}/tracks?limit=50`);
      return (data.items || []).map(t => toSongItem({
        id:           t.id,
        name:         t.name,
        artists:      (t.artists || []).map(a => a.name).join(', '),
        albumArt:     artwork,
        previewUrl:   t.preview_url || null,
        durationMs:   t.duration_ms || 0,
        hasFullTrack: false,
      }));
    }
    default: return [];
  }
}

const SpotifySource = {
  displayName: 'Spotify',
  connect()    { return window.SpotifyAuth.beginAuth(); },
  isAuthed()   { return window.SpotifyAuth.isAuthed(); },
  search,
  getLibrary,
  getChildren,
};

window.SpotifySource = SpotifySource;
if (window.MusicSources) window.MusicSources.register('spotify', SpotifySource);
