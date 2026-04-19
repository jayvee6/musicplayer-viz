// Apple Music catalog search via MusicKit JS — implements the MusicSource interface.
// Requires window.AppleAuth (apple-auth.js).

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
    hasFullTrack: false, // Phase 3
  };
}

async function search(query) {
  if (!query) return [];
  const mk = await window.AppleAuth.ready();
  // MusicKit's api.music() returns a structured response; path is relative.
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
    artwork:  null, // library artist items rarely carry artwork; listing artist catalog requires extra call
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
  return {
    id:       t.id,
    name:     t.name,
    subtitle: t.artists,
    artwork:  t.albumArt,
    kind:     'song',
    track:    t,
  };
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

const AppleSource = {
  displayName: 'Apple Music',
  connect()    { return window.AppleAuth.beginAuth(); },
  isAuthed()   { return window.AppleAuth.isAuthed(); },
  search,
  getLibrary,
  getChildren,
};

window.AppleSource = AppleSource;
if (window.MusicSources) window.MusicSources.register('apple', AppleSource);
