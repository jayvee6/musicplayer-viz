// Local Library ID3 parser — runs in a Web Worker so parsing hundreds of
// files doesn't block the UI. Uses music-metadata's browser build via esm.sh.
//
// Protocol (main thread ↔ worker):
//   main → worker: { type: 'parse', id: <string>, file: File }
//   worker → main: { type: 'parsed', id, ok: true,  meta }    on success
//                  { type: 'parsed', id, ok: false, error }    on failure
//
// `meta` shape (subset of music-metadata's output we actually use):
//   { title, artist, album, albumartist, year, trackNo, durationSec,
//     picture: { bytes: Uint8Array, format: string } | null }
//
// esm.sh pins the version for reproducibility. If esm.sh is unreachable the
// worker reports every file as failed with 'module load failed' — the main
// thread keeps the filename-based fallback entries from chunk 5, so the
// library stays usable, just without real metadata.

let _mm = null;
async function loadModule() {
  if (_mm) return _mm;
  try {
    _mm = await import('https://esm.sh/music-metadata@10.5.7');
  } catch (e) {
    _mm = { _err: e };
  }
  return _mm;
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'parse') return;
  const { id, file } = msg;

  const mm = await loadModule();
  if (mm._err) {
    self.postMessage({ type: 'parsed', id, ok: false, error: 'music-metadata load failed' });
    return;
  }

  try {
    const result = await mm.parseBlob(file, { duration: true, skipCovers: false });
    const common = result.common || {};
    const format = result.format || {};
    const pic = (common.picture && common.picture[0]) || null;
    self.postMessage({
      type: 'parsed',
      id,
      ok: true,
      meta: {
        title:       common.title       || null,
        artist:      common.artist      || null,
        album:       common.album       || null,
        albumartist: common.albumartist || null,
        year:        common.year        || null,
        trackNo:     (common.track && common.track.no) || null,
        durationSec: format.duration    || 0,
        picture:     pic ? { bytes: pic.data, format: pic.format } : null,
      },
    });
  } catch (err) {
    self.postMessage({
      type: 'parsed',
      id,
      ok: false,
      error: (err && err.message) ? err.message : String(err),
    });
  }
};
