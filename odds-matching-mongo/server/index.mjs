import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeMongo, coll } from './lib/mongo.mjs';
import { cached } from './lib/cache.mjs';
import {
  competitionLogos, competitions, dateRange, fixtureById, fixtures,
  leagueDirectory, oddsForFixture, search,
} from './lib/queries.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
/* The page and its badges live at the workspace root, because that is what the
   Vercel `workspace` project deploys. Mounted rather than copied so there is
   one index.html, not a local twin that drifts from the deployed one.

   On the NAS only the API runs — the page is served by Vercel — so neither
   path exists there and every static request 404s, which is correct. */
const PAGE = resolve(ROOT, '..', 'index.html');
const ASSETS = resolve(ROOT, '..', 'assets');
const PORT = Number(process.env.PORT || 5180);

/* Origins allowed to call this API from a browser. Empty allows any, which is
   right for a read-only public archive behind a same-origin rewrite; name the
   app's exact origin when the page calls the tunnel directly. */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',').map(o => o.trim()).filter(Boolean);

/* Optional `?key=` gate, matching the existing odds API. Unset means open,
   which is the honest default: the page is public and unauthenticated, so a key
   here guards nothing a visitor could not already read off the site. `/health`
   is always exempt so the container's healthcheck needs no secret. */
const API_KEY = process.env.API_KEY || '';

/* --------------------------------------------------------------- caching */

/* The archive is written by the scrapers on a scale of minutes, and the page's
   own six-hour localStorage cache already sits in front of the competition
   scan — these TTLs are about the second tab and the back button, not freshness.
   Odds get the shortest because a live board really does move. */
const TTL = {
  meta: 60 * 60_000,      // the league directory and competition badges
  range: 60 * 60_000,     // a sport's date span moves by a day
  scan: 15 * 60_000,      // the whole-archive competition scan
  month: 5 * 60_000,      // a month's competitions and its fixtures
  odds: 15_000,
};

/* ---------------------------------------------------------------- routes */

const json = (res, body, status = 200) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** year+month, or nulls when the caller wants the whole archive. */
function period(url) {
  const year = num(url.searchParams.get('year'));
  const month = num(url.searchParams.get('month'));
  return year && month >= 1 && month <= 12 ? { year, month } : { year: null, month: null };
}

const ROUTES = {
  'GET /api/date-range': (url) => {
    const sport = url.searchParams.get('sport') ?? '';
    if (!sport) return { min: null, max: null };
    return cached(`range:${sport}`, TTL.range, () => dateRange(sport));
  },

  'GET /api/leagues': () => cached('leagues', TTL.meta, leagueDirectory),

  'GET /api/competitions': (url) => {
    const sport = url.searchParams.get('sport') ?? '';
    if (!sport) return { total: 0, rows: [] };
    const { year, month } = period(url);
    const key = `comp:${sport}:${year ?? '*'}-${month ?? '*'}`;
    return cached(key, year ? TTL.month : TTL.scan, () => competitions(sport, year, month));
  },

  'GET /api/fixtures': (url) => {
    const sport = url.searchParams.get('sport') ?? '';
    if (!sport) return [];
    const { year, month } = period(url);
    const leagues = url.searchParams.getAll('league').filter(Boolean);
    const tournament = url.searchParams.get('tournament');
    const key = `fx:${sport}:${year ?? '*'}-${month ?? '*'}:${leagues.join('|')}:${tournament ?? ''}`;
    return cached(key, TTL.month, () => fixtures({ sport, year, month, leagues, tournament }));
  },

  'GET /api/fixture': (url) => {
    const id = url.searchParams.get('id') ?? '';
    return cached(`fx1:${id}`, TTL.month, () => fixtureById(id));
  },

  // Deliberately uncached: it is keyed on whatever was typed.
  'GET /api/search': (url) => search(url.searchParams.get('q') ?? ''),

  'GET /api/odds': (url) => {
    const id = url.searchParams.get('fixture_id') ?? '';
    return cached(`odds:${id}`, TTL.odds, () => oddsForFixture(id));
  },

  'GET /api/competition-logos': () => cached('logos', TTL.meta, competitionLogos),

  /* `/health` as well as `/api/health`: the container's HEALTHCHECK and the
     tunnel both want a bare path, and the page wants it under /api so one
     rewrite covers everything it calls. */
  'GET /health': () => ROUTES['GET /api/health'](),

  'GET /api/health': async () => {
    const t = Date.now();
    const n = await (await coll('fixtures')).estimatedDocumentCount();
    return { ok: true, db: process.env.MONGO_DB || 'gutsys_sport', fixtures: n, ms: Date.now() - t };
  },
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
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function fileOr404(res, file, root, cache) {
  // normalize() collapses `..` before it can escape the root.
  if (!file.startsWith(root)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('Forbidden');
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const buf = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': cache,
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}

async function serveStatic(res, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');

  if (rel.startsWith('/assets/')) {
    return fileOr404(res, join(ASSETS, rel.slice('/assets/'.length)), ASSETS,
      'public, max-age=86400');
  }

  /* The Odds Library is one file that owns its own routing via the hash, so
     every other path is that same file rather than a 404. */
  return fileOr404(res, PAGE, PAGE, 'no-cache');
}

/* ---------------------------------------------------------------- server */

/* Off by default; `LOG_REQUESTS=1 npm run dev` turns it on. One line per API
   call is what tells a slow query apart from a page asking too often. */
const LOG = process.env.LOG_REQUESTS === '1';

/* No cookies and no auth here — this is a read-only archive — so the response
   never needs `Allow-Credentials`, and an origin that is not on the list simply
   gets no CORS header rather than an error. */
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const key = `${req.method} ${url.pathname.replace(/\/$/, '') || '/'}`;
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (LOG && url.pathname.startsWith('/api/')) {
    const at = Date.now();
    res.on('finish', () => console.log(`[api] ${req.url} ${res.statusCode} ${Date.now() - at}ms`));
  }
  if (API_KEY && url.pathname.startsWith('/api/') && url.searchParams.get('key') !== API_KEY) {
    return json(res, { error: 'bad or missing key' }, 401);
  }

  const handler = ROUTES[key];

  if (!handler) {
    if (url.pathname.startsWith('/api/')) return json(res, { error: 'not found' }, 404);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      return res.end('Method not allowed');
    }
    return serveStatic(res, url.pathname);
  }

  try {
    json(res, await handler(url));
  } catch (err) {
    // The library is read-only, so a failure here is always a DB or query
    // problem; log it in full and hand the page a short message to render.
    console.error(`[api] ${key} failed:`, err);
    json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`[odds-matching-mongo] http://localhost:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    closeMongo().finally(() => process.exit(0));
  });
}
