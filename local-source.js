(() => {
// Local Library source — a MusicSource adapter backed by files the user picks
// from their own machine via a browser folder picker. This file is the stub
// scaffolding (chunk 4 of 7). The actual file ingestion + ID3 parsing +
// playback land in chunks 5–7:
//
//   5/7  webkitdirectory picker — captures a FileList the user selects.
//   6/7  Client-side ID3 parsing via music-metadata (browser build) inside
//        a Web Worker; builds an in-memory artist/album/song index.
//   7/7  Playback + queue — playTrack resolves the chosen file to an
//        ObjectURL and delegates to the existing buffer-mode engine in app.js.
//
// Until those land, this adapter registers itself so the UI has a third
// source option alongside Spotify + Apple, but every data method returns
// empty and every playback method is a no-op.

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
  // parse worker has produced at least one indexed song. Until chunk 5 ships
  // the picker, this is always false so the iPod overlay's auth-gated views
  // still work correctly (the "Connect a music account to browse your
  // library" empty view shows until ingestion completes).
  return _library.ingestedCount > 0;
}

async function connect() {
  // Chunk 5 will replace this with the folder-picker trigger.
  console.warn('[local-source] connect() — folder picker ships in chunk 5');
  return;
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
