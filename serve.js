#!/usr/bin/env node
// Static file server with two credential-handling endpoints:
//   GET /api/config     → { spotifyClientId }  (client_id is not secret under PKCE)
//   GET /api/apple-token → { token, expiresAt } (ES256 JWT signed server-side)
//
// Secrets live in .env (gitignored) + a .p8 private key outside the repo.
// Nothing secret ever ships to the browser. Apple tokens are short-lived and
// re-minted on demand, so the .p8 stays server-side.

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const root = path.dirname(__filename);

// ─── .env loader (no dep) ────────────────────────────────────────────────────
function loadEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val   = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv(path.join(root, '.env'));

const SPOTIFY_CLIENT_ID      = process.env.SPOTIFY_CLIENT_ID      || '';
const APPLE_TEAM_ID          = process.env.APPLE_TEAM_ID          || '';
const APPLE_KEY_ID           = process.env.APPLE_KEY_ID           || '';
const APPLE_PRIVATE_KEY_PATH = process.env.APPLE_PRIVATE_KEY_PATH || '';
const APPLE_TOKEN_TTL_SEC    = Math.min(parseInt(process.env.APPLE_TOKEN_TTL_SEC, 10) || 7200, 60 * 60 * 24 * 180);

// Lazily load + cache the parsed Apple private key so we don't re-parse PEM
// on every request. Throws if the file is unreadable or malformed.
let _applePrivateKey = null;
function getApplePrivateKey() {
  if (_applePrivateKey) return _applePrivateKey;
  if (!APPLE_PRIVATE_KEY_PATH) throw new Error('APPLE_PRIVATE_KEY_PATH is not set');
  // Relative paths resolve against serve.js's directory, not the process cwd,
  // so `./secrets/...` works regardless of where the user launched node from.
  const resolved = path.isAbsolute(APPLE_PRIVATE_KEY_PATH)
    ? APPLE_PRIVATE_KEY_PATH
    : path.resolve(root, APPLE_PRIVATE_KEY_PATH);
  const pem = fs.readFileSync(resolved, 'utf8');
  _applePrivateKey = crypto.createPrivateKey({ key: pem, format: 'pem' });
  return _applePrivateKey;
}

function b64url(buf) {
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signAppleDeveloperToken() {
  if (!APPLE_TEAM_ID || !APPLE_KEY_ID) {
    throw new Error('APPLE_TEAM_ID and APPLE_KEY_ID must be set');
  }
  const key = getApplePrivateKey();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + APPLE_TOKEN_TTL_SEC;

  const header  = b64url(JSON.stringify({ alg: 'ES256', kid: APPLE_KEY_ID, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: APPLE_TEAM_ID, iat: now, exp }));
  const signingInput = `${header}.${payload}`;

  // JWT ES256 requires raw r||s, not ASN.1 DER — dsaEncoding: 'ieee-p1363' gives us that.
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  const token = `${signingInput}.${b64url(sig)}`;
  return { token, expiresAt: exp * 1000 };
}

// ─── Static + API ────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.aac': 'audio/aac',
};

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.aac']);
const MUSIC_DIR  = path.join(root, 'music');
const PORT       = process.env.PORT       || 3001;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

// ─── TLS (self-signed dev cert) ──────────────────────────────────────────────
// When secrets/dev-{cert,key}.pem both exist, start HTTPS alongside HTTP so
// LAN clients can access getUserMedia / getDisplayMedia — those APIs require
// a secure context, and LAN IPs like 192.168.x.x are NOT considered secure
// over plain HTTP (only localhost is). Certs are gitignored; regenerate via:
//   openssl req -x509 -newkey rsa:2048 -nodes \
//     -keyout secrets/dev-key.pem -out secrets/dev-cert.pem -days 365 \
//     -subj "/CN=musicplayer-viz-dev" \
//     -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:<LAN>,IP:::1"
function loadTLSCredentials() {
  const certPath = path.join(root, 'secrets', 'dev-cert.pem');
  const keyPath  = path.join(root, 'secrets', 'dev-key.pem');
  try {
    return {
      cert: fs.readFileSync(certPath),
      key:  fs.readFileSync(keyPath),
    };
  } catch { return null; }
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type':  'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function handleRequest(req, res) {
  let url = req.url.split('?')[0];

  if (url === '/api/tracks') {
    fs.readdir(MUSIC_DIR, (err, files) => {
      const tracks = err ? [] : files.filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()));
      sendJSON(res, 200, tracks);
    });
    return;
  }

  if (url === '/api/config') {
    // Only non-secret values belong here. client_id is public under PKCE.
    sendJSON(res, 200, { spotifyClientId: SPOTIFY_CLIENT_ID });
    return;
  }

  if (url === '/api/apple-token') {
    if (!APPLE_TEAM_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY_PATH) {
      sendJSON(res, 503, { error: 'Apple MusicKit not configured on server' });
      return;
    }
    try {
      sendJSON(res, 200, signAppleDeveloperToken());
    } catch (e) {
      console.error('[apple-token]', e.message);
      sendJSON(res, 500, { error: 'Failed to sign Apple developer token' });
    }
    return;
  }

  if (url === '/' || url === '') url = '/index.html';
  const file = path.join(root, decodeURIComponent(url));

  if (!file.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not found');
    } else {
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    }
  });
}

// HTTP — always on. localhost is already a secure context per the Fetch
// spec, so getUserMedia / getDisplayMedia work here. LAN clients need HTTPS.
http.createServer(handleRequest).listen(PORT, () => {
  console.log(`musicplayer-viz serving on http://localhost:${PORT}`);
  console.log(`  Spotify: ${SPOTIFY_CLIENT_ID ? 'configured' : 'NOT configured (set SPOTIFY_CLIENT_ID)'}`);
  console.log(`  Apple:   ${(APPLE_TEAM_ID && APPLE_KEY_ID && APPLE_PRIVATE_KEY_PATH) ? 'configured' : 'NOT configured (set APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY_PATH)'}`);
});

// HTTPS — only if a self-signed cert was generated. Required for LAN clients
// that want to use the capture-tab-audio / microphone reactive-visual paths;
// those APIs are gated on a secure context and refuse plain HTTP LAN IPs.
const tls = loadTLSCredentials();
if (tls) {
  https.createServer(tls, handleRequest).listen(HTTPS_PORT, () => {
    console.log(`  HTTPS:   https://localhost:${HTTPS_PORT}  (self-signed — trust in Keychain or click-through)`);
  });
} else {
  console.log(`  HTTPS:   disabled (secrets/dev-{cert,key}.pem missing — run openssl to enable LAN capture APIs)`);
}
