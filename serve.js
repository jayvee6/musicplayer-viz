#!/usr/bin/env node
// Minimal static file server — no cwd dependency
const http = require('http');
const fs   = require('fs');
const path = require('path');
const root = path.dirname(__filename); // always resolves to script location

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

http.createServer((req, res) => {
  let url = req.url.split('?')[0];

  // API: list tracks in /music
  if (url === '/api/tracks') {
    fs.readdir(MUSIC_DIR, (err, files) => {
      const tracks = err ? [] : files.filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tracks));
    });
    return;
  }

  if (url === '/' || url === '') url = '/index.html';
  const file = path.join(root, url);

  // Prevent directory traversal outside project root
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
}).listen(3001, () => console.log('musicplayer-viz serving on http://localhost:3001'));
