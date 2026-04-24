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

  const songs = [];
  const bySongId = new Map();
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    const id   = 'loc_' + fnv1a(path);
    const title = titleFromName(file.name);
    // Chunk-5 shape: id/name/kind only, with a track stub for the iPod's
    // song-playback path. Chunk 6 enriches these with real artist/album/
    // durationMs/albumArt after the worker parses ID3.
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
    bySongId.set(id, { file, meta: { title } });
  }

  _library = {
    songs,
    artists:       [],      // chunk 6 will populate via ID3
    albums:        [],      // chunk 6 will populate via ID3
    playlists:     [],
    byArtistId:    new Map(),
    byAlbumId:     new Map(),
    bySongId,
    ingestedCount: songs.length,
  };

  // Broadcast so the sign-in UI updates (auth state flipped) and any open
  // iPod frame can re-sync. app.js listens via the same event name.
  window.dispatchEvent(new CustomEvent('localsourcechanged', {
    detail: { ingestedCount: _library.ingestedCount },
  }));
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

async function getChildren(/* parentKind, parentId, opts */) {
  // Chunk 6 will look up via byArtistId / byAlbumId indexes.
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
