// HTTP + WebSocket server: serves the static client and hosts multiplayer rooms.
// Usage: `npm start` (honours the PORT environment variable, as Railway sets it).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const srcRoot = join(root, 'src');
const port = Number(process.env.PORT || process.argv[2] || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const log = (...args) => console.log(new Date().toISOString(), ...args);
const rooms = new RoomManager({ log });

/** Map a URL path to a file the client is allowed to load, or null. Only the page, stylesheet and client modules are public. */
function publicFile(pathname) {
  if (pathname === '/' || pathname === '/index.html') return join(root, 'index.html');
  if (pathname === '/styles.css') return join(root, 'styles.css');
  if (pathname.startsWith('/src/') && pathname.endsWith('.js')) {
    const file = normalize(join(root, pathname));
    if (file.startsWith(srcRoot + sep)) return file;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, rooms: rooms.rooms.size }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method not allowed');
    return;
  }
  const file = publicFile(pathname);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

// ---------------------------------------------------------------------------
// WebSockets
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 32 * 1024 });
const MAX_MESSAGES_PER_10S = 120;

wss.on('connection', (ws) => {
  const client = {
    room: null,
    seat: null,
    send(msg) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
  };
  ws.isAlive = true;
  let windowStart = Date.now();
  let count = 0;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data, isBinary) => {
    const now = Date.now();
    if (now - windowStart > 10_000) {
      windowStart = now;
      count = 0;
    }
    if (++count > MAX_MESSAGES_PER_10S) {
      ws.close(1008, 'Too many messages');
      return;
    }
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      client.send({ t: 'error', message: 'Bad message.' });
      return;
    }
    rooms.handle(client, msg);
  });

  ws.on('close', () => rooms.disconnect(client));
  ws.on('error', () => rooms.disconnect(client));
});

// Drop dead connections and keep proxies from idling the socket out.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000);

const sweeper = setInterval(() => rooms.sweep(), 10 * 60 * 1000);

server.listen(port, () => log(`Settlers server listening on http://localhost:${port}`));

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(sweeper);
  for (const ws of wss.clients) ws.close(1012, 'Server restarting');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
