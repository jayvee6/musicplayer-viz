// Spotify Authorization Code + PKCE flow (client-side only).
// Client ID is fetched from GET /api/config so it never lives in git.
// Register REDIRECT_URI on the dashboard — must exactly match what we send.

const REDIRECT_URI = `${location.origin}/`;
const TOKEN_KEY    = 'spotify_token_v1';
const VERIFIER_KEY = 'spotify_pkce_verifier';
// Scopes needed by the iPod library browser + Web Playback SDK:
//   user-library-read            — /me/tracks, /me/albums
//   playlist-read-private        — /me/playlists (private + owned)
//   playlist-read-collaborative  — collaborative playlists
//   user-follow-read             — /me/following?type=artist
//   streaming                    — Web Playback SDK (Premium-only)
//   user-modify-playback-state   — PUT /me/player/play to start SDK playback
//   user-read-playback-state     — GET /me/player for device state
const SCOPES = [
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-follow-read',
  'streaming',
  'user-modify-playback-state',
  'user-read-playback-state',
].join(' ');

let _clientIdPromise = null;
function getClientId() {
  if (!_clientIdPromise) {
    _clientIdPromise = fetch('/api/config')
      .then(r => r.ok ? r.json() : {})
      .then(c => c.spotifyClientId || '')
      .catch(() => '');
  }
  return _clientIdPromise;
}

function randomString(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => ('0' + b.toString(16)).slice(-2)).join('').slice(0, len);
}

async function sha256(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readToken() {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY)); } catch { return null; }
}

function writeToken(t) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function tokenExpired(t) {
  return !t || !t.expires_at || Date.now() >= t.expires_at - 10_000;
}

async function beginAuth() {
  const clientId = await getClientId();
  if (!clientId) {
    alert('Spotify is not configured on this server. Set SPOTIFY_CLIENT_ID in .env and restart serve.js.');
    return;
  }
  const verifier  = randomString(96);
  const challenge = await sha256(verifier);
  sessionStorage.setItem(VERIFIER_KEY, verifier);

  const params = new URLSearchParams({
    client_id:             clientId,
    response_type:         'code',
    redirect_uri:          REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge:        challenge,
    scope:                 SCOPES,
  });
  location.href = `https://accounts.spotify.com/authorize?${params}`;
}

async function exchangeCode(code) {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error('Missing PKCE verifier — start auth again.');
  const clientId = await getClientId();

  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    redirect_uri:  REDIRECT_URI,
    client_id:     clientId,
    code_verifier: verifier,
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const json = await res.json();
  writeToken({
    access_token:  json.access_token,
    refresh_token: json.refresh_token,
    expires_at:    Date.now() + json.expires_in * 1000,
  });
  sessionStorage.removeItem(VERIFIER_KEY);
}

async function refreshToken() {
  const t = readToken();
  if (!t || !t.refresh_token) throw new Error('No refresh token');
  const clientId = await getClientId();

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: t.refresh_token,
    client_id:     clientId,
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) { clearToken(); throw new Error(`Refresh failed: ${res.status}`); }
  const json = await res.json();
  writeToken({
    access_token:  json.access_token,
    refresh_token: json.refresh_token || t.refresh_token,
    expires_at:    Date.now() + json.expires_in * 1000,
  });
}

async function handleRedirectIfPresent() {
  const params = new URLSearchParams(location.search);
  const code   = params.get('code');
  if (!code) return false;
  try {
    await exchangeCode(code);
  } catch (e) {
    console.error('[spotify-auth]', e);
  } finally {
    // Strip the code from the URL so a refresh doesn't re-exchange it.
    history.replaceState({}, '', location.pathname);
  }
  return true;
}

async function getAccessToken() {
  let t = readToken();
  if (tokenExpired(t)) {
    if (t && t.refresh_token) {
      try { await refreshToken(); t = readToken(); } catch { return null; }
    } else {
      return null;
    }
  }
  return t ? t.access_token : null;
}

function isAuthed() {
  const t = readToken();
  return !!t && !!t.access_token;
}

window.SpotifyAuth = {
  beginAuth,
  handleRedirectIfPresent,
  getAccessToken,
  isAuthed,
  clearToken,
};
