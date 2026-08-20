import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import httpProxy from 'http-proxy';

const PORT = Number(process.env.PORT || 10000);
const USERNAME = process.env.USERNAME || '';
const PASSWORD = process.env.PASSWORD || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 60 * 60 * 1000);
const TTYD_START_PORT = Number(process.env.TTYD_START_PORT || 18000);

if (!USERNAME || !PASSWORD) {
  console.error('USERNAME and PASSWORD environment variables are required.');
  process.exit(1);
}

const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });
const sessions = new Map();
let nextPort = TTYD_START_PORT;

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function safeEqual(a, b) {
  const aa = Buffer.from(a || '');
  const bb = Buffer.from(b || '');
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function checkBasicAuth(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;

  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return false;
    const user = decoded.slice(0, colon);
    const pass = decoded.slice(colon + 1);
    return safeEqual(user, USERNAME) && safeEqual(pass, PASSWORD);
  } catch {
    return false;
  }
}

function publicBase(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return `${proto}://${req.headers.host}`;
}

function removeSession(token) {
  const session = sessions.get(token);
  if (!session) return;
  clearTimeout(session.timer);
  try { session.process.kill('SIGTERM'); } catch {}
  sessions.delete(token);
}

function spawnSession(req, res) {
  if (!checkBasicAuth(req)) {
    res.writeHead(401, {
      'www-authenticate': 'Basic realm="CPXS Kali Bridge"',
      'cache-control': 'no-store',
    });
    res.end('Unauthorized');
    return;
  }

  const token = crypto.randomBytes(24).toString('hex');
  const localPort = nextPort++;
  const basePath = `/t/${token}`;
  const expiresAt = Date.now() + SESSION_TTL_MS;

  const child = spawn('/bin/ttyd', [
    '-i', '127.0.0.1',
    '-p', String(localPort),
    '-b', basePath,
    '-W',
    '/bin/bash', '-l',
  ], {
    env: { ...process.env, TERM: 'xterm-256color' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', chunk => process.stdout.write(`[ttyd:${localPort}] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[ttyd:${localPort}] ${chunk}`));
  child.on('exit', () => removeSession(token));

  const timer = setTimeout(() => removeSession(token), SESSION_TTL_MS);

  sessions.set(token, {
    token,
    port: localPort,
    basePath,
    process: child,
    timer,
    expiresAt,
  });

  // Give ttyd a moment to bind before returning the URL.
  setTimeout(() => {
    if (!sessions.has(token)) {
      return json(res, 500, { status: 'error', error: 'ttyd failed to start.' });
    }

    json(res, 200, {
      status: 'ok',
      sessionId: token,
      terminalUrl: `${publicBase(req)}${basePath}/`,
      expiresAt,
    });
  }, 250);
}

function getSession(pathname) {
  const match = pathname.match(/^\/t\/([a-f0-9]{48})(?:\/|$)/i);
  if (!match) return null;
  return sessions.get(match[1]) || null;
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) removeSession(token);
  }
}, 60_000).unref();

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      service: 'cpxs-kali-bridge',
      activeSessions: sessions.size,
    });
  }

  if (url.pathname === '/api/session' && req.method === 'POST') {
    return spawnSession(req, res);
  }

  if (url.pathname.startsWith('/api/session/') && req.method === 'DELETE') {
    if (!checkBasicAuth(req)) return json(res, 401, { error: 'Unauthorized' });
    const token = url.pathname.split('/').pop();
    removeSession(token);
    return json(res, 200, { status: 'ended' });
  }

  const session = getSession(url.pathname);
  if (!session) {
    res.writeHead(404, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end('Terminal session not found or expired.');
    return;
  }

  proxy.web(req, res, {
    target: `http://127.0.0.1:${session.port}`,
    changeOrigin: false,
  });
});

server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const session = getSession(url.pathname);
    if (!session) {
      socket.destroy();
      return;
    }

    proxy.ws(req, socket, head, {
      target: `ws://127.0.0.1:${session.port}`,
      changeOrigin: false,
    });
  } catch {
    socket.destroy();
  }
});

proxy.on('error', (err, req, resOrSocket) => {
  console.error('Proxy error:', err.message);
  if (resOrSocket && typeof resOrSocket.writeHead === 'function') {
    resOrSocket.writeHead(502);
    resOrSocket.end('Terminal proxy error.');
  } else if (resOrSocket && typeof resOrSocket.destroy === 'function') {
    resOrSocket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CPXS Kali bridge listening on :${PORT}`);
});
