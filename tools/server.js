// Tiny static file server (no dependencies). `npm run dev` → http://127.0.0.1:8000

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEV_BOOTSTRAP = '<script>window.__NMS_DEV_SERVER__=true;</script>';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function startServer(port = 0) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (p === '/') p = '/index.html';
        const file = normalize(join(ROOT, p));
        if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
        let data = await readFile(file);
        // The runtime uses this explicit marker instead of guessing from the
        // hostname, so a production build served on a LAN never grows dev UI.
        if (extname(file).toLowerCase() === '.html') {
          data = Buffer.from(data.toString('utf8').replace('</head>', `  ${DEV_BOOTSTRAP}\n</head>`));
        }
        res.writeHead(200, {
          'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'no-store',
        });
        res.end(data);
      } catch {
        res.writeHead(404); res.end('not found');
      }
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// The dev server is often left running in another terminal while a second
// session is opened. Keep that harmless: only the CLI/dev path walks upward
// to a free port; tests that request port 0 and callers that need an exact
// port can continue using startServer directly.
export async function startDevServer(preferredPort = 8000, maxFallbacks = 10) {
  const firstPort = Number.isInteger(preferredPort) && preferredPort > 0
    ? preferredPort
    : 8000;
  let lastError = null;
  for (let offset = 0; offset <= maxFallbacks; offset++) {
    const candidate = firstPort + offset;
    if (candidate > 65535) break;
    try {
      const result = await startServer(candidate);
      return { ...result, preferredPort: firstPort, usedFallback: offset > 0 };
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw lastError || new Error(`No free development port near ${firstPort}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8000);
  startDevServer(port).then(({ port: p, preferredPort, usedFallback }) => {
    if (usedFallback) {
      console.warn(`Port ${preferredPort} is already in use; using ${p} instead.`);
    }
    console.log(`No Man's Sky three.js → http://127.0.0.1:${p}`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
