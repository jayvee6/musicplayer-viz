// Apple MusicKit JS v3 configure + authorize wrapper.
// Requires the MusicKit script tag in index.html:
//   <script src="https://js-cdn.music.apple.com/musickit/v3/musickit.js" data-web-components async></script>
//
// The developer JWT is signed by serve.js (endpoint: GET /api/apple-token) using
// the .p8 private key on disk. Nothing secret ever lives in this file.
//
// The user token (per-listener, from authorize()) is managed internally by MusicKit
// in localStorage — we don't need to persist it ourselves.

const APP_NAME  = 'musicplayer-viz';
const APP_BUILD = '1.0.0';

let configured = false;
let configuring = null;

function waitForMusicKit() {
  return new Promise(resolve => {
    if (window.MusicKit) return resolve();
    document.addEventListener('musickitloaded', () => resolve(), { once: true });
  });
}

async function fetchDeveloperToken() {
  const res = await fetch('/api/apple-token');
  if (res.status === 503) {
    throw new Error('Apple MusicKit is not configured on the server. Set APPLE_TEAM_ID, APPLE_KEY_ID, and APPLE_PRIVATE_KEY_PATH in .env, then restart serve.js.');
  }
  if (!res.ok) throw new Error(`Apple token fetch failed (${res.status})`);
  const json = await res.json();
  if (!json.token) throw new Error('Server returned no Apple token');
  return json.token;
}

async function configure() {
  if (configured) return;
  if (configuring) return configuring;
  configuring = (async () => {
    await waitForMusicKit();
    const token = await fetchDeveloperToken();
    await window.MusicKit.configure({
      developerToken: token,
      app: { name: APP_NAME, build: APP_BUILD },
    });
    configured = true;
  })();
  return configuring;
}

async function beginAuth() {
  try {
    await configure();
  } catch (e) {
    alert(e.message);
    return;
  }
  const mk = window.MusicKit.getInstance();
  try { await mk.authorize(); } catch (e) { console.error('[apple-auth]', e); }
}

function isAuthed() {
  if (!configured || !window.MusicKit) return false;
  const mk = window.MusicKit.getInstance();
  return !!(mk && mk.isAuthorized);
}

async function ready() {
  await configure();
  return window.MusicKit.getInstance();
}

window.AppleAuth = {
  configure,
  beginAuth,
  isAuthed,
  ready,
};
