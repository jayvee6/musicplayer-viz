(() => {
// Spotify Web Playback SDK wrapper.
// Requires the SDK CDN script and window.SpotifyAuth.

const DEVICE_NAME = 'musicplayer-viz';

// The SDK calls window.onSpotifyWebPlaybackSDKReady exactly once when it finishes
// loading. If it's undefined at that moment the SDK throws AnthemError and later
// consumers never get notified. We install a pending-callback stub now; init()
// wires up the real resolver when it's called.
let _sdkReadyResolvers = [];
if (!window.onSpotifyWebPlaybackSDKReady) {
  window.onSpotifyWebPlaybackSDKReady = () => {
    _sdkReadyResolvers.forEach(r => r());
    _sdkReadyResolvers = null; // signal "already fired"
  };
}

let player = null;
let deviceId = null;
let readyPromise = null;

// Latest state snapshot + wall-clock baseline so we can interpolate smoothly
// between the ~500ms state_changed ticks.
let lastState = null;     // { paused, position, duration, trackId }
let lastStateWallMs = 0;

const trackChangeSubs = [];
const fatalSubs       = [];

function emitTrackChange(id) { trackChangeSubs.forEach(cb => { try { cb(id); } catch {} }); }
function emitFatal(msg)      { fatalSubs.forEach(cb => { try { cb(msg); } catch {} }); }

function waitForSDK() {
  return new Promise(resolve => {
    if (window.Spotify && window.Spotify.Player) return resolve();
    if (_sdkReadyResolvers === null) return resolve(); // ready callback already fired
    _sdkReadyResolvers.push(resolve);
  });
}

async function init() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    await waitForSDK();
    player = new window.Spotify.Player({
      name: DEVICE_NAME,
      getOAuthToken: cb => {
        window.SpotifyAuth.getAccessToken()
          .then(t => cb(t || ''))
          .catch(() => cb(''));
      },
      volume: 0.6,
    });

    player.addListener('initialization_error', ({ message }) => emitFatal(`Spotify SDK init failed: ${message}`));
    player.addListener('authentication_error', ({ message }) => emitFatal(`Spotify auth failed: ${message}`));
    player.addListener('account_error',        ({ message }) => emitFatal(`Spotify Premium required: ${message}`));
    player.addListener('playback_error',       ({ message }) => console.error('[spotify-player playback]', message));

    player.addListener('player_state_changed', state => {
      if (!state) { lastState = null; return; }
      const track = state.track_window && state.track_window.current_track;
      const trackId = track && track.id;
      const prevTrackId = lastState && lastState.trackId;
      lastState = {
        paused:   state.paused,
        position: state.position,
        duration: state.duration,
        trackId,
        track, // full metadata for now-playing UI updates on auto-advance
      };
      lastStateWallMs = performance.now();
      if (trackId && trackId !== prevTrackId) emitTrackChange(track);
    });

    const deviceReady = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Spotify SDK: device never ready (check Premium + scopes)')), 15000);
      player.addListener('ready', ({ device_id }) => {
        clearTimeout(t);
        deviceId = device_id;
        resolve();
      });
      player.addListener('not_ready', ({ device_id }) => {
        console.warn('[spotify-player] device went offline', device_id);
      });
    });

    const connected = await player.connect();
    if (!connected) throw new Error('Spotify SDK: player.connect() returned false');
    await deviceReady;
  })();
  return readyPromise;
}

function isReady() { return !!deviceId; }

function getDeviceId() { return deviceId; }

// Extrapolate current position between SDK state ticks using wall-clock,
// clamped to duration so a silent disconnect doesn't drift forever.
function currentPositionMs() {
  if (!lastState) return 0;
  if (lastState.paused) return lastState.position;
  const extrapolated = lastState.position + (performance.now() - lastStateWallMs);
  return lastState.duration ? Math.min(extrapolated, lastState.duration) : extrapolated;
}

function getCurrentTrackId() { return lastState ? lastState.trackId : null; }
function getCurrentTrack()   { return lastState ? lastState.track : null; }
function getDurationMs()     { return lastState ? lastState.duration : 0; }

async function pause()  { if (player) return player.pause(); }
async function resume() { if (player) return player.resume(); }
async function seek(ms) { if (player) return player.seek(Math.max(0, Math.floor(ms))); }
async function togglePlay()    { if (player) return player.togglePlay(); }
async function nextTrack()     { if (player) return player.nextTrack(); }
async function previousTrack() { if (player) return player.previousTrack(); }

function onTrackChange(cb) { trackChangeSubs.push(cb); }
function onFatalError(cb)  { fatalSubs.push(cb); }

window.SpotifyPlayer = {
  init,
  isReady,
  getDeviceId,
  pause,
  resume,
  seek,
  togglePlay,
  nextTrack,
  previousTrack,
  currentPositionMs,
  getCurrentTrackId,
  getCurrentTrack,
  getDurationMs,
  onTrackChange,
  onFatalError,
};

})();
