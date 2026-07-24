/**
 * Local web dashboard.
 *
 * Binds to the loopback interface only. Because this server writes to
 * watches.json and triggers outbound requests, it is not treated as trusted
 * just for being local: the Host header is checked to defeat DNS rebinding,
 * and state-changing requests must carry a same-origin Origin header, which
 * stops any random web page you have open from driving it.
 */

import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';

import { PROJECT_ROOT, ConfigError } from './config.js';
import { WatchFile } from './watch-file.js';
import { search as searchAirports, describe } from './airports.js';
import { searchFlights } from './google-flights.js';
import { checkWatch } from './runner.js';
import { buildSearchUrl } from './tfs.js';

const WEB_ROOT = join(PROJECT_ROOT, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const hostname = (value = '') => value.trim().replace(/:\d+$/, '').toLowerCase();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    // The UI never renders remote content; lock the page down anyway.
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'",
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

async function readJsonBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}

/**
 * @param {object} deps
 * @param {import('./db.js').PriceStore} deps.store
 * @param {string} deps.configPath
 * @param {object} deps.notifier
 * @param {(config:object)=>void} [deps.onConfigChange] called after any edit
 */
export function createServer({ store, configPath, notifier, onConfigChange, notify = true }) {
  const watchFile = new WatchFile(configPath);

  /** Summary of a watch plus whatever history we have for it. */
  const decorate = (watch) => {
    const latest = store.latestObservation(watch.id);
    const stats = store.stats(watch.id);
    const history = store.history(watch.id, { limit: 200 }).reverse();
    const previous = history.length > 1 ? history[history.length - 2] : null;

    return {
      ...watch,
      fromLabel: describe(watch.from),
      toLabel: describe(watch.to),
      searchUrl: buildSearchUrl(watch, { currency: 'USD' }),
      latest: latest
        ? {
            price: latest.price,
            currency: latest.currency,
            observedAt: latest.observedAt,
            priceLevel: latest.priceLevel,
            resultsCount: latest.resultsCount,
            nonstopPrice: latest.nonstopPrice,
            best: latest.best,
            change: previous ? latest.price - previous.price : null,
          }
        : null,
      stats,
      series: history.map((h) => ({ t: h.observedAt, p: h.price })),
      failing: store.consecutiveFailures(watch.id),
    };
  };

  const state = () => {
    const config = watchFile.config();
    return {
      defaults: config.defaults,
      configPath: watchFile.path,
      watches: config.watches.map(decorate),
    };
  };

  const publish = (config) => {
    if (onConfigChange) onConfigChange(config);
  };

  const routes = [
    ['GET', /^\/api\/state$/, async () => state()],

    ['GET', /^\/api\/airports$/, async (_req, _m, url) => ({
      results: searchAirports(url.searchParams.get('q') ?? '', 8),
    })],

    // A live lookup used by the composer before a watch is ever saved, so the
    // route and dates are confirmed against Google rather than trusted.
    ['POST', /^\/api\/search$/, async (req) => {
      const body = await readJsonBody(req);
      const draft = normaliseDraft(body);
      const { results, priceLevel, url } = await searchFlights(draft, { currency: 'USD' });
      return {
        url,
        priceLevel,
        count: results.length,
        cheapest: results[0] ?? null,
        cheapestNonstop: results.find((r) => r.stops === 0) ?? null,
        results: results.slice(0, 20),
      };
    }],

    ['POST', /^\/api\/watches$/, async (req) => {
      const body = await readJsonBody(req);
      const { config, watch } = watchFile.add(normaliseDraft(body, { keepAlert: true }));
      publish(config);
      return { watch: decorate(watch) };
    }],

    ['PATCH', /^\/api\/watches\/([^/]+)$/, async (req, m) => {
      const body = await readJsonBody(req);
      const { config, watch } = watchFile.update(decodeURIComponent(m[1]), normalisePatch(body));
      publish(config);
      return { watch: decorate(watch) };
    }],

    ['DELETE', /^\/api\/watches\/([^/]+)$/, async (_req, m) => {
      const { config } = watchFile.remove(decodeURIComponent(m[1]));
      publish(config);
      return { ok: true };
    }],

    ['POST', /^\/api\/watches\/([^/]+)\/check$/, async (_req, m) => {
      const id = decodeURIComponent(m[1]);
      const config = watchFile.config();
      const watch = config.watches.find((w) => w.id === id);
      if (!watch) throw new HttpError(404, `no watch with id "${id}"`);

      const result = await checkWatch({ watch, store, notifier, config, notify });
      return {
        status: result.status,
        error: result.error ?? null,
        reason: result.decision?.reason ?? null,
        notified: result.notified ?? false,
        watch: decorate(watch),
      };
    }],

    ['GET', /^\/api\/watches\/([^/]+)\/history$/, async (_req, m) => ({
      history: store.history(decodeURIComponent(m[1]), { limit: 500 }),
    })],
  ];

  const server = createHttpServer(async (req, res) => {
    try {
      // DNS-rebinding guard: a hostile domain resolving to 127.0.0.1 would
      // still send its own name in Host.
      if (!ALLOWED_HOSTS.has(hostname(req.headers.host))) {
        throw new HttpError(403, 'Invalid Host header');
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const isMutation = req.method !== 'GET' && req.method !== 'HEAD';

      // CSRF guard: browsers always attach Origin to cross-origin writes.
      if (isMutation) {
        const origin = req.headers.origin;
        if (!origin || !ALLOWED_HOSTS.has(hostname(new URL(origin).hostname))) {
          throw new HttpError(403, 'Cross-origin request refused');
        }
      }

      // PATCH and DELETE share a path pattern, so every route has to be
      // considered before concluding the method is wrong.
      let pathMatched = false;
      for (const [method, pattern, handler] of routes) {
        const match = pattern.exec(url.pathname);
        if (!match) continue;
        pathMatched = true;
        if (req.method !== method) continue;
        return json(res, 200, await handler(req, match, url));
      }
      if (pathMatched) throw new HttpError(405, `${req.method} not allowed here`);

      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'Unknown endpoint');
      return await serveStatic(url.pathname, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof ConfigError ? 400 : 500;
      if (status === 500) console.error(err);
      json(res, status, { error: err.message });
    }
  });

  return server;
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  // normalize() collapses any ../ before it can escape the web root.
  const target = join(WEB_ROOT, normalize(rel));
  if (!target.startsWith(WEB_ROOT)) {
    return json(res, 403, { error: 'Forbidden' });
  }

  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
}

/**
 * Route and dates are deliberately not editable.
 *
 * Price history is keyed to the watch id and represents one specific trip.
 * Repointing a watch at a different date would silently attach the old prices
 * to a journey they were never quotes for — the all-time low, the averages and
 * the charts would all become quietly wrong. Changing a trip means a new watch.
 */
const IMMUTABLE_FIELDS = ['from', 'to', 'depart', 'return', 'id'];

const EDITABLE_FIELDS = ['label', 'intervalMinutes', 'maxStops', 'trackNonstopOnly', 'enabled', 'seat', 'adults'];

const EDITABLE_ALERT_FIELDS = [
  'targetPrice',
  'dropPercent',
  'dropAmount',
  'cooldownMinutes',
  'notifyOnNewLow',
  'notifyOnRise',
  'notifyOnFirstSeen',
];

const NUMERIC = new Set([
  'intervalMinutes',
  'adults',
  'targetPrice',
  'dropPercent',
  'dropAmount',
  'cooldownMinutes',
]);

/**
 * Allowlists and type-coerces an edit. Form fields arrive as strings, which the
 * numeric validators in config.js would otherwise reject.
 */
function normalisePatch(body) {
  const attempted = IMMUTABLE_FIELDS.filter((f) => f in body);
  if (attempted.length) {
    throw new HttpError(
      400,
      `${attempted.join(' and ')} cannot be changed on an existing watch — the recorded price ` +
        `history belongs to this exact trip. Create a new watch instead.`,
    );
  }

  const coerce = (key, value) => {
    if (!NUMERIC.has(key)) return value;
    if (value === '' || value === null) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new HttpError(400, `${key} must be a number, got "${value}"`);
    return n;
  };

  const patch = {};
  for (const key of EDITABLE_FIELDS) {
    if (key in body) patch[key] = coerce(key, body[key]);
  }

  if (body.alert && typeof body.alert === 'object') {
    patch.alert = {};
    for (const key of EDITABLE_ALERT_FIELDS) {
      if (key in body.alert) patch.alert[key] = coerce(key, body.alert[key]);
    }
  }

  if (Object.keys(patch).length === 0) throw new HttpError(400, 'No editable fields in the request');
  return patch;
}

/** Maps the UI's form payload onto the shape config.js expects. */
function normaliseDraft(body, { keepAlert = false } = {}) {
  const num = (v) => (v === '' || v == null ? null : Number(v));

  const draft = {
    id: body.id,
    label: body.label,
    from: String(body.from ?? '').trim().toUpperCase(),
    to: String(body.to ?? '').trim().toUpperCase(),
    depart: body.depart,
    return: body.return || null,
    adults: num(body.adults) ?? 1,
    seat: body.seat || 'economy',
    maxStops: body.maxStops === '' || body.maxStops == null ? null : body.maxStops,
    intervalMinutes: num(body.intervalMinutes) ?? 30,
  };

  // Only record the non-default toggles, so the saved file stays readable.
  if (num(body.children)) draft.children = num(body.children);
  if (body.trackNonstopOnly) draft.trackNonstopOnly = true;

  if (keepAlert) {
    draft.alert = {
      targetPrice: num(body.alert?.targetPrice),
      dropPercent: num(body.alert?.dropPercent),
      dropAmount: num(body.alert?.dropAmount),
      cooldownMinutes: num(body.alert?.cooldownMinutes),
      notifyOnNewLow: body.alert?.notifyOnNewLow ?? true,
      notifyOnRise: body.alert?.notifyOnRise ?? false,
    };
  }
  return draft;
}
