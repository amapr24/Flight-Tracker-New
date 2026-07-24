/**
 * Config loading and validation.
 *
 * A typo in an airport code or a date produces a search that quietly returns
 * nothing, so every watch is validated up front and the process refuses to
 * start on a bad config rather than silently tracking the wrong thing.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SEAT } from './tfs.js';
import { DEFAULT_ALERT } from './rules.js';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const IATA = /^[A-Z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const DEFAULTS = {
  intervalMinutes: 30,
  currency: 'USD',
  language: 'en',
  region: 'US',
  database: 'data/prices.db',
  quietHours: null,
  jitterSeconds: 90,
  staggerSeconds: 8,
  sounds: {},
};

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Minimal .env reader — avoids a dependency for six lines of parsing. */
export function loadEnv(envPath = join(PROJECT_ROOT, '.env'), env = process.env) {
  if (!existsSync(envPath)) return env;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    // Real environment variables always win over the file.
    if (key in env) continue;
    env[key] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

function fail(watchId, message) {
  throw new ConfigError(`watch "${watchId}": ${message}`);
}

function validateDate(watchId, field, value) {
  if (!ISO_DATE.test(value)) fail(watchId, `${field} must be YYYY-MM-DD, got "${value}"`);
  const d = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) fail(watchId, `${field} "${value}" is not a real date`);
  // Guard against 2026-02-31 style values that Date silently rolls over.
  if (d.toISOString().slice(0, 10) !== value) fail(watchId, `${field} "${value}" is not a real date`);
  return d;
}

function normaliseWatch(raw, index, defaults) {
  const id = raw.id ?? `watch-${index + 1}`;
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    fail(id, 'id may only contain letters, numbers, dot, dash and underscore');
  }

  const from = String(raw.from ?? '').toUpperCase();
  const to = String(raw.to ?? '').toUpperCase();
  if (!IATA.test(from)) fail(id, `from must be a 3-letter airport code, got "${raw.from}"`);
  if (!IATA.test(to)) fail(id, `to must be a 3-letter airport code, got "${raw.to}"`);
  if (from === to) fail(id, 'from and to must differ');

  if (!raw.depart) fail(id, 'depart is required (YYYY-MM-DD)');
  const departDate = validateDate(id, 'depart', raw.depart);

  if (raw.return) {
    const returnDate = validateDate(id, 'return', raw.return);
    if (returnDate < departDate) fail(id, 'return date is before depart date');
  }

  const seat = raw.seat ?? 'economy';
  if (!(seat in SEAT)) {
    fail(id, `seat must be one of ${Object.keys(SEAT).join(', ')}, got "${seat}"`);
  }

  const maxStops = raw.maxStops ?? null;
  if (maxStops != null && !['nonstop', 0, 1, 2, 3, '0', '1', '2', '3'].includes(maxStops)) {
    fail(id, 'maxStops must be "nonstop", 0, 1, 2, 3, or null (omit for "any")');
  }

  const adults = raw.adults ?? 1;
  if (!Number.isInteger(adults) || adults < 1 || adults > 9) {
    fail(id, 'adults must be an integer between 1 and 9');
  }

  const alert = { ...DEFAULT_ALERT, ...(raw.alert ?? {}) };
  for (const key of ['targetPrice', 'dropPercent', 'dropAmount', 'risePercent', 'cooldownMinutes']) {
    const v = alert[key];
    if (v != null && (typeof v !== 'number' || Number.isNaN(v) || v < 0)) {
      fail(id, `alert.${key} must be a non-negative number`);
    }
  }

  const interval = raw.intervalMinutes ?? defaults.intervalMinutes;
  if (!Number.isFinite(interval) || interval < 5) {
    fail(id, 'intervalMinutes must be at least 5 (polling faster invites rate limiting)');
  }

  return {
    id,
    label: raw.label ?? `${from} → ${to} ${raw.depart}${raw.return ? ` – ${raw.return}` : ''}`,
    from,
    to,
    depart: raw.depart,
    return: raw.return ?? null,
    adults,
    children: raw.children ?? 0,
    infantsInSeat: raw.infantsInSeat ?? 0,
    infantsOnLap: raw.infantsOnLap ?? 0,
    seat,
    maxStops,
    intervalMinutes: interval,
    /** When true, alerting tracks the cheapest nonstop instead of the cheapest overall. */
    trackNonstopOnly: raw.trackNonstopOnly ?? false,
    enabled: raw.enabled ?? true,
    alert,
  };
}

function validateQuietHours(q) {
  if (!q) return null;
  if (!HHMM.test(q.start ?? '') || !HHMM.test(q.end ?? '')) {
    throw new ConfigError('quietHours.start and quietHours.end must be "HH:MM" (24-hour)');
  }
  if (q.timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: q.timezone });
    } catch {
      throw new ConfigError(`quietHours.timezone "${q.timezone}" is not a valid IANA time zone`);
    }
  }
  return { allowUrgent: true, timezone: 'UTC', ...q };
}

/**
 * @param {object} rawConfig
 * @param {object} [options]
 * @param {boolean} [options.allowEmpty] permit zero watches. The web UI needs
 *   this so a brand-new install can render before the first route is added;
 *   the CLI keeps the strict check so the daemon never starts with nothing.
 */
export function parseConfig(rawConfig, { allowEmpty = false } = {}) {
  const defaults = { ...DEFAULTS, ...(rawConfig.defaults ?? {}) };
  defaults.quietHours = validateQuietHours(defaults.quietHours);

  if (!Array.isArray(rawConfig.watches) || (rawConfig.watches.length === 0 && !allowEmpty)) {
    throw new ConfigError('config must define a non-empty "watches" array');
  }

  const watches = rawConfig.watches.map((w, i) => normaliseWatch(w, i, defaults));

  const seen = new Set();
  for (const w of watches) {
    if (seen.has(w.id)) throw new ConfigError(`duplicate watch id "${w.id}"`);
    seen.add(w.id);
  }

  return { defaults, watches };
}

export function loadConfig(configPath) {
  const path = resolve(configPath ?? join(PROJECT_ROOT, 'watches.json'));
  if (!existsSync(path)) {
    throw new ConfigError(
      `No config at ${path}. Copy watches.example.json to watches.json and edit it.`,
    );
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${path} is not valid JSON: ${err.message}`);
  }

  const config = parseConfig(raw);
  config.path = path;
  config.databasePath = resolve(PROJECT_ROOT, config.defaults.database);
  return config;
}
