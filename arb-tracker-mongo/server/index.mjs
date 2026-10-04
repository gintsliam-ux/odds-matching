import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeMongo } from './lib/mongo.mjs';
import { closeBets } from './lib/betsMongo.mjs';
import { describeSource } from './lib/source.mjs';
import { handleApi, warmCaches } from './lib/routes.mjs';

/**
 * The local / on-NAS host. Serves the same route table a Vercel function does
 * (see server/lib/routes.mjs) plus the built frontend, so one process is the
 * whole app when it runs on the tailnet.
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 5174);

const json = (res, body, status = 200) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

/* ----------------------------------------------------------- static files */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Serve the built SPA in production (`npm start`). In dev, Vite serves the app
 * and proxies /api here, so this never runs. Unknown paths fall through to
 * index.html — the client router owns /event/:slug/:id.
 */
async function serveStatic(req, res, pathname) {
  if (!existsSync(DIST)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('No build found. Run `npm run build`, or use `npm run dev` for the dev server.');
    return;
  }
  // normalize() collapses `..` before it can escape DIST.
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, rel);
  if (!file.startsWith(DIST) || !existsSync(file) || rel === '/' || rel === '\\') {
    file = join(DIST, 'index.html');
  }
  try {
    const buf = await readFile(file);
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    // Hashed asset filenames are immutable; index.html must never be cached.
    const cache = file.endsWith('index.html')
      ? 'no-cache'
      : 'public, max-age=31536000, immutable';
    res.writeHead(200, { 'content-type': type, 'cache-control': cache });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // The only POST is a list of fixture ids; anything larger is not ours.
      if (size > 1_000_000) {
        fail(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return ok(null);
      try {
        ok(JSON.parse(raw));
      } catch {
        fail(new Error('invalid JSON body'));
      }
    });
    req.on('error', fail);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

  try {
    const body = req.method === 'POST' ? await readBody(req) : null;
    const out = await handleApi({
      method: req.method ?? 'GET',
      pathname: url.pathname,
      searchParams: url.searchParams,
      body,
    });
    json(res, out.body, out.status);
  } catch (err) {
    // The board is read-only, so a failure here is always a data or query
    // problem; log it in full and hand the client something short to render.
    console.error(`[api] ${req.method} ${url.pathname} failed:`, err);
    json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`[sports-odds-desk] API on http://localhost:${PORT}`);
  console.log(`[sports-odds-desk] source: ${describeSource()}`);
  warmCaches();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await Promise.all([closeMongo(), closeBets()]);
    process.removeAllListeners(sig);
    process.kill(process.pid, sig);
  });
}
