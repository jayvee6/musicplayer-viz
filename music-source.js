// Shared MusicSource interface used by Spotify + Apple adapters.
// app.js talks to whichever source is currently selected; each adapter maps
// service-specific responses into this common track shape.
//
//   Track = {
//     id:          string,
//     name:        string,      // track title
//     artists:     string,      // comma-separated artist names
//     albumArt:    string|null, // https URL, or null
//     previewUrl:  string|null, // direct audio URL (~30s), or null
//     durationMs:  number,
//     hasFullTrack: boolean     // whether the source *could* play the full track
//                               // (Phase 2 only — currently always false)
//   }
//
// Library browsing (used by the iPod overlay):
//
//   source.getLibrary(category) → Promise<LibraryItem[]>
//     category is one of 'playlists' | 'artists' | 'albums' | 'songs'
//
//   source.getChildren(parentKind, parentId) → Promise<LibraryItem[]>
//     playlists/<id> → songs
//     artists/<id>   → albums
//     albums/<id>    → songs
//
//   LibraryItem = {
//     id:       string,
//     name:     string,
//     subtitle: string?,         // artist name, track count, etc.
//     artwork:  string|null,
//     kind:     'playlist'|'artist'|'album'|'song',
//     track?:   Track             // present when kind === 'song'
//   }

window.MusicSources = {
  _registry: {},
  _currentKey: null,

  register(key, source) { this._registry[key] = source; },
  get(key)              { return this._registry[key] || null; },
  setCurrent(key)       { this._currentKey = this._registry[key] ? key : null; },
  current()             { return this._currentKey ? this._registry[this._currentKey] : null; },
  list()                { return Object.entries(this._registry).map(([k, s]) => ({ key: k, name: s.displayName })); },
};
