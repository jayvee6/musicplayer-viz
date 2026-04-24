(() => {
// Local Library source — a MusicSource adapter backed by files the user picks
// from their own machine via a browser folder picker. Chunks 4+5 ship the
// picker + filename-based song index; chunks 6/7 add ID3 parsing and
// playback:
//
//   4/7  Adapter stub + Local button in the sources picker.
//   5/7  webkitdirectory picker — captures a FileList the user selects,
//        filters to audio extensions, builds filename-based song entries.
//   6/7  Client-side ID3 parsing via music-metadata (browser build) inside
//        a Web Worker; upgrades entries to proper metadata + builds
//        artist/album indexes.
//   7/7  Playback + queue — playTrack resolves the chosen file to an
//        ObjectURL and delegates to the existing buffer-mode engine in app.js.

// Module-scope state — populated by chunks 5+. Kept here so chunks can be
// reviewed / reverted in isolation without shuffling the registration code.
let _library = {
  songs:          [],   // Array<LibraryItem>  — all songs, alphabetical by title
  artists:        [],   // Array<LibraryItem>
  albums:         [],   // Array<LibraryItem>
  playlists:      [],   // future: saved selections (not in scope yet)
  byArtistId:     new Map(), // artistId → Array<albumId>
  bySongId:       new Map(), // songId   → { file: File, meta: {...} }
  byAlbumId:      new Map(), // albumId  → Array<songId>
  ingestedCount:  0,    // number of files processed by the parser worker
};

function isAuthed() {
  // "Authed" for the local source means the user has picked a folder and the
  // ingestion has produced at least one song entry. Until that happens, the
  // iPod overlay's auth-gated "Connect a music account to browse your
  // library" empty view shows.
  return _library.ingestedCount > 0;
}

// Audio extensions we accept from the folder pick. Mirrors serve.js's server-
// side AUDIO_EXTS so the client + server agree on what counts as music.
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.aac']);

function fileExt(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

// FNV-1a 32-bit hash → short base36 id. Used to derive stable ids from the
// file's webkitRelativePath so the same file has the same id across page
// reloads (assuming the user picks the same folder). Chunks 6+ will layer
// artist/album ids from parsed metadata on top; song ids stay file-hash.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Strip extension + collapse underscores/dashes to spaces for a reasonable
// fallback title before ID3 parsing lands in chunk 6. "03 - Song Title.mp3"
// becomes "03  Song Title"; good enough to read while the worker chews.
function titleFromName(name) {
  const base = name.replace(/\.[^.]+$/, '');
  return base.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function ingestFileList(fileList) {
  const files = Array.from(fileList).filter(f => AUDIO_EXTS.has(fileExt(f.name)));
  if (!files.length) {
    console.warn('[local-source] picker returned no audio files');
    return;
  }

  // Sort alphabetically by relative path so Songs reads A→Z out of the gate.
  files.sort((a, b) => {
    const pa = a.webkitRelativePath || a.name;
    const pb = b.webkitRelativePath || b.name;
    return pa.localeCompare(pb);
  });

  // Release any art ObjectURLs from a previous pick so we don't leak.
  revokeArtUrls(_library);

  const songs = [];
  const bySongId = new Map();
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    const id   = 'loc_' + fnv1a(path);
    const title = titleFromName(file.name);
    // Chunk-5 filename-based shape. Chunk 6 upgrades each entry's track
    // fields + the item-level artwork as ID3 results stream in from the
    // worker, and builds the artists/albums indexes in parallel.
    const item = {
      id,
      name:     title,
      subtitle: null,
      artwork:  null,
      kind:     'song',
      track: {
        id,
        name:         title,
        artists:      '',
        albumArt:     null,
        previewUrl:   null,
        durationMs:   0,
        hasFullTrack: true,
      },
    };
    songs.push(item);
    bySongId.set(id, { file, meta: { title }, path });
  }

  _library = {
    songs,
    artists:       [],      // populated progressively by the worker
    albums:        [],      // populated progressively by the worker
    playlists:     [],
    byArtistId:    new Map(),
    byAlbumId:     new Map(),
    bySongId,
    ingestedCount: songs.length,
    _artistByKey:  new Map(),  // lower-cased artist name → artistId
    _albumByKey:   new Map(),  // artistId + '::' + lower album → albumId
    _artUrls:      [],          // Object URLs to revoke on re-pick
  };

  // First notify — Songs list is immediately browsable with filename titles.
  // Subsequent dispatches happen as the worker streams metadata back.
  window.dispatchEvent(new CustomEvent('localsourcechanged', {
    detail: { ingestedCount: _library.ingestedCount, phase: 'initial' },
  }));

  // Kick off ID3 parsing in the worker.
  parseLibraryWithWorker(_library);
}

function revokeArtUrls(lib) {
  if (!lib || !lib._artUrls) return;
  for (const url of lib._artUrls) {
    try { URL.revokeObjectURL(url); } catch {}
  }
  lib._artUrls = [];
}

// Build the worker once per page session; terminate on re-pick so there's no
// stale parse storm from the previous library competing for CPU.
let _worker = null;
function getWorker() {
  if (_worker) { try { _worker.terminate(); } catch {} }
  _worker = new Worker('local-parse-worker.js', { type: 'module' });
  return _worker;
}

// FNV-1a-keyed deduplication for artist + album. Artist id is hashed off the
// lowercased artist name; album id folds the artist in so "Thriller" by two
// different artists stays distinct. Both prefixed so iPod item IDs don't
// collide with song IDs.
function keyArtist(name) {
  return 'art_' + fnv1a(name.toLowerCase().trim());
}
function keyAlbum(artistName, albumName) {
  return 'alb_' + fnv1a(artistName.toLowerCase().trim() + '::' + albumName.toLowerCase().trim());
}

// Update cadence: rebuild the artists/albums arrays + fire a progress event
// every N parses so the iPod doesn't stutter on huge libraries but the user
// still sees populate live.
const UPDATE_EVERY = 20;

function parseLibraryWithWorker(lib) {
  const worker = getWorker();
  const pending = new Set(lib.bySongId.keys());
  let sinceLastRefresh = 0;

  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg || msg.type !== 'parsed') return;

    const rec = lib.bySongId.get(msg.id);
    if (!rec) return; // library swapped while parse was in flight

    if (msg.ok && msg.meta) {
      applyParsedMeta(lib, msg.id, rec, msg.meta);
    }
    pending.delete(msg.id);
    sinceLastRefresh++;

    if (sinceLastRefresh >= UPDATE_EVERY || pending.size === 0) {
      rebuildArtistAlbumArrays(lib);
      window.dispatchEvent(new CustomEvent('localsourcechanged', {
        detail: {
          ingestedCount: lib.ingestedCount,
          parsedCount:   lib.songs.length - pending.size,
          phase:         pending.size === 0 ? 'complete' : 'progress',
        },
      }));
      sinceLastRefresh = 0;
    }
  };

  // Dispatch all parses up front — worker handles them sequentially. For
  // huge libraries we could throttle here to avoid copying every File into
  // the worker at once, but structured-cloning File objects is cheap (the
  // underlying blob ref transfers, not the bytes).
  for (const [id, rec] of lib.bySongId) {
    worker.postMessage({ type: 'parse', id, file: rec.file });
  }
}

function applyParsedMeta(lib, songId, rec, meta) {
  const song = lib.songs.find(s => s.id === songId);
  if (!song) return;

  // Title / artist / album fall back to what we already had (filename title
  // for missing ID3 title; empty string elsewhere).
  if (meta.title)  song.name = meta.title;
  song.track.name = song.name;

  const artistName = (meta.albumartist || meta.artist || '').trim();
  const albumName  = (meta.album || '').trim();

  // Build album art ObjectURL once per track. music-metadata hands us raw
  // bytes + mime; we wrap it as a Blob and mint an ObjectURL. Revocation
  // happens at next re-pick.
  let artUrl = null;
  if (meta.picture && meta.picture.bytes && meta.picture.bytes.byteLength) {
    try {
      const blob = new Blob([meta.picture.bytes], { type: meta.picture.format || 'image/jpeg' });
      artUrl = URL.createObjectURL(blob);
      lib._artUrls.push(artUrl);
    } catch {}
  }

  song.track.artists    = artistName;
  song.subtitle         = artistName || null;
  song.track.durationMs = Math.round((meta.durationSec || 0) * 1000);
  song.artwork          = artUrl || song.artwork;
  song.track.albumArt   = artUrl || song.track.albumArt;

  // Artist + album dedup. An empty artist name means "Unknown" — still
  // bucket so every song is reachable via Artists drill-down.
  const artistKey = artistName || 'Unknown Artist';
  const albumKey  = albumName  || null;

  let artistId = lib._artistByKey.get(artistKey.toLowerCase());
  if (!artistId) {
    artistId = keyArtist(artistKey);
    lib._artistByKey.set(artistKey.toLowerCase(), artistId);
    lib.byArtistId.set(artistId, { name: artistKey, albumIds: new Set() });
  }

  if (albumKey) {
    const albKeyLc = artistKey.toLowerCase() + '::' + albumKey.toLowerCase();
    let albumId = lib._albumByKey.get(albKeyLc);
    if (!albumId) {
      albumId = keyAlbum(artistKey, albumKey);
      lib._albumByKey.set(albKeyLc, albumId);
      lib.byAlbumId.set(albumId, {
        id: albumId,
        name: albumKey,
        artistName: artistKey,
        artistId,
        artwork: artUrl || null,
        songIds: [],
      });
      lib.byArtistId.get(artistId).albumIds.add(albumId);
    }
    const album = lib.byAlbumId.get(albumId);
    if (!album.songIds.includes(songId)) album.songIds.push(songId);
    // First-album-art wins for the album tile; songs can differ.
    if (!album.artwork && artUrl) album.artwork = artUrl;
    rec.albumId  = albumId;
  }
  rec.artistId = artistId;
  rec.meta     = {
    title:       song.name,
    artist:      artistName,
    album:       albumName,
    durationSec: meta.durationSec || 0,
  };
}

function rebuildArtistAlbumArrays(lib) {
  // Sort artists by name, albums by artistName + name.
  const artists = Array.from(lib.byArtistId.entries()).map(([id, rec]) => ({
    id,
    name:     rec.name,
    subtitle: null,
    artwork:  null,
    kind:     'artist',
  }));
  artists.sort((a, b) => a.name.localeCompare(b.name));

  const albums = Array.from(lib.byAlbumId.values()).map(alb => ({
    id:       alb.id,
    name:     alb.name,
    subtitle: alb.artistName,
    artwork:  alb.artwork,
    kind:     'album',
  }));
  albums.sort((a, b) => {
    const artistCmp = (a.subtitle || '').localeCompare(b.subtitle || '');
    return artistCmp !== 0 ? artistCmp : a.name.localeCompare(b.name);
  });

  lib.artists = artists;
  lib.albums  = albums;
}

// Wire the hidden folder picker once the DOM is ready. We attach listeners
// here (not in app.js) so local-source.js owns its full lifecycle.
function bindPicker() {
  const input = document.getElementById('local-folder-picker');
  if (!input) return null;
  input.addEventListener('change', ev => {
    const files = ev.target.files;
    if (files && files.length) ingestFileList(files);
    // Clear the input so picking the same folder again still fires change.
    ev.target.value = '';
  });
  return input;
}
let _pickerInput = null;
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { _pickerInput = bindPicker(); });
} else {
  _pickerInput = bindPicker();
}

async function connect() {
  if (!_pickerInput) _pickerInput = bindPicker();
  if (!_pickerInput) {
    console.error('[local-source] no #local-folder-picker element found');
    return;
  }
  _pickerInput.click(); // triggers the OS folder picker
}

async function search(/* query */) {
  // Chunk 6 will index song/artist/album names for search.
  return [];
}

async function getLibrary(category, opts = {}) {
  // Until chunks 5+6 populate _library, return empty pages.
  // Shape matches Spotify/Apple's { items, nextCursor } contract.
  void opts;
  switch (category) {
    case 'playlists': return { items: _library.playlists.slice(), nextCursor: null };
    case 'artists':   return { items: _library.artists.slice(),   nextCursor: null };
    case 'albums':    return { items: _library.albums.slice(),    nextCursor: null };
    case 'songs':     return { items: _library.songs.slice(),     nextCursor: null };
    default:          return { items: [], nextCursor: null };
  }
}

async function getChildren(parentKind, parentId, opts = {}) {
  void opts;
  if (parentKind === 'artist') {
    const rec = _library.byArtistId.get(parentId);
    if (!rec) return { items: [], nextCursor: null };
    const items = Array.from(rec.albumIds)
      .map(aid => _library.byAlbumId.get(aid))
      .filter(Boolean)
      .map(alb => ({
        id:       alb.id,
        name:     alb.name,
        subtitle: alb.artistName,
        artwork:  alb.artwork,
        kind:     'album',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { items, nextCursor: null };
  }
  if (parentKind === 'album') {
    const alb = _library.byAlbumId.get(parentId);
    if (!alb) return { items: [], nextCursor: null };
    const items = alb.songIds
      .map(sid => _library.songs.find(s => s.id === sid))
      .filter(Boolean);
    return { items, nextCursor: null };
  }
  return { items: [], nextCursor: null };
}

// ─── Remote-playback interface ───────────────────────────────────────────
// Local source uses the buffer-mode audio engine already in app.js. Chunk 7
// wires playTrack → loadTrackFromUrl (via an ObjectURL for the File), and
// routes next/prev through an in-memory queue derived from the current
// context (album / playlist / flat songs-list).

async function playTrack(/* trackId, queue */) {
  throw new Error('Local playback ships in chunk 7');
}
async function pause()         { return; }
async function resume()        { return; }
async function seekToMs(/*ms*/) { return; }
async function nextTrack()     { return; }
async function previousTrack() { return; }

async function setShuffle(/* on */)  { return; }
async function setRepeat(/* mode */) { return; }

function getPositionMs()     { return 0; }
function getDurationMs()     { return 0; }
function getCurrentTrackId() { return null; }

const trackChangeSubs = [];
function onTrackChange(cb) { trackChangeSubs.push(cb); }

const LocalSource = {
  displayName: 'Local Library',
  connect,
  isAuthed,
  search,
  getLibrary,
  getChildren,
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

window.LocalSource = LocalSource;
if (window.MusicSources) window.MusicSources.register('local', LocalSource);

// Internal — chunks 5+6 call into this to replace the module-scope library
// object after ingestion. Exposed here (not on window) so only bundled JS
// in this module's chunks can swap it.
LocalSource._setLibrary = function (next) { _library = next; };
LocalSource._getLibrary = function () { return _library; };

})();
