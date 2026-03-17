import http from 'http';
import { readFile } from 'node:fs/promises';
import httpProxy from 'http-proxy';

const FRONTEND_ORIGIN = 'http://localhost:3000';
const GATEWAY_PORT = 8080;
const MAPPING_PATH = new URL('../vm_mapping.json', import.meta.url);

// Create a proxy configured for WebSocket tunneling.
const proxy = httpProxy.createProxyServer({
  ws: true,
  changeOrigin: true,
  secure: false,
});

// Basic error handling for both HTTP and WS proxying.
proxy.on('error', (err, req, socket) => {
  console.error('Proxy error:', err.message);
  if (socket && socket.writable) {
    socket.end();
  }
});

function trim(value) {
  const v = value?.toString().trim();
  return v || undefined;
}

function normalizeWsTarget(vmUrl) {
  if (!vmUrl) return null;
  return /^wss?:\/\//i.test(vmUrl) ? vmUrl : `ws://${vmUrl}`;
}

async function loadVmMapping() {
  const raw = await readFile(MAPPING_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('vm_mapping.json must be an object of { userId: vmUrl }');
  }
  return parsed;
}

async function resolveTargetForUser(userId) {
  const mapping = await loadVmMapping();
  const vmUrl = mapping[userId];
  const target = normalizeWsTarget(vmUrl);
  if (!target) {
    throw new Error(`vm_url not found for userId=${userId}`);
  }
  return target;
}

function rejectUpgrade(socket, code, message) {
  if (!socket.writable) return;
  const body = message ?? 'upgrade rejected';
  socket.write(
    `HTTP/1.1 ${code} ${http.STATUS_CODES[code] ?? 'Error'}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  socket.destroy();
}

// HTTP server to host the upgrade hook and optional CORS-friendly responses.
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', FRONTEND_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Minimal health/info response.
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WebSocket proxy is running. Connect via ws://localhost:8080');
});

// Wire WebSocket upgrades directly to the backend target.
server.on('upgrade', (req, socket, head) => {
  (async () => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
    const userId = trim(url.searchParams.get('userId'));
    if (!userId) {
      rejectUpgrade(socket, 400, 'missing userId');
      return;
    }

    let target;
    try {
      target = await resolveTargetForUser(userId);
    } catch (err) {
      console.error('user lookup failed:', err);
      rejectUpgrade(socket, 404, err.message);
      return;
    }

    console.log(`Proxying WS ${req.socket.remoteAddress || ''} userId=${userId} -> ${target}`);
    proxy.ws(req, socket, head, { target });
  })().catch((err) => {
    console.error('upgrade handler error:', err);
    rejectUpgrade(socket, 500, 'internal error');
  });
});

server.listen(GATEWAY_PORT, () => {
  console.log(`WebSocket gateway listening on ws://localhost:${GATEWAY_PORT}`);
  console.log(`Using VM mapping: ${MAPPING_PATH.pathname}`);
});
