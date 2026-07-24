/**
 * Price history storage, backed by node's built-in SQLite (no dependencies).
 *
 * Every poll writes one row to `observations`. Alert decisions read from that
 * history — an all-time low is only meaningful against a real record of past
 * prices, which is precisely what Google's emails never give you.
 */

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * `node:sqlite` is loaded lazily rather than with a static import. ES modules
 * are linked before any module body executes, so a static import would emit
 * node's experimental-SQLite warning before src/quiet.js could suppress it.
 */
const require = createRequire(import.meta.url);
let DatabaseSync;
function sqlite() {
  if (!DatabaseSync) ({ DatabaseSync } = require('node:sqlite'));
  return DatabaseSync;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id      TEXT    NOT NULL,
  observed_at   TEXT    NOT NULL,
  price         INTEGER NOT NULL,
  currency      TEXT    NOT NULL,
  nonstop_price INTEGER,
  price_level   TEXT,
  results_count INTEGER NOT NULL,
  best_json     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_watch ON observations(watch_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id   TEXT    NOT NULL,
  sent_at    TEXT    NOT NULL,
  reason     TEXT    NOT NULL,
  price      INTEGER NOT NULL,
  prev_price INTEGER,
  message    TEXT
);
CREATE INDEX IF NOT EXISTS idx_alert_watch ON alerts(watch_id, sent_at DESC);

-- The resolved flag is flipped by the next successful observation. Counting
-- unresolved rows is exact, whereas comparing failure timestamps against the
-- last success loses the streak when both land in the same millisecond.
CREATE TABLE IF NOT EXISTS failures (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id   TEXT    NOT NULL,
  failed_at  TEXT    NOT NULL,
  message    TEXT    NOT NULL,
  resolved   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fail_watch ON failures(watch_id, resolved, failed_at DESC);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const Database = sqlite();
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  return new PriceStore(db);
}

export class PriceStore {
  #db;

  constructor(db) {
    this.#db = db;
  }

  close() {
    this.#db.close();
  }

  recordObservation({
    watchId,
    observedAt = new Date().toISOString(),
    price,
    currency,
    nonstopPrice = null,
    priceLevel = null,
    resultsCount,
    best,
  }) {
    this.#db
      .prepare(
        `INSERT INTO observations
           (watch_id, observed_at, price, currency, nonstop_price, price_level, results_count, best_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        watchId,
        observedAt,
        price,
        currency,
        nonstopPrice,
        priceLevel,
        resultsCount,
        JSON.stringify(best ?? null),
      );

    // A successful read ends any current failure streak.
    this.#db
      .prepare('UPDATE failures SET resolved = 1 WHERE watch_id = ? AND resolved = 0')
      .run(watchId);
  }

  /** Most recent observation strictly before the one just written. */
  previousObservation(watchId, { excludeId = null } = {}) {
    const row = this.#db
      .prepare(
        `SELECT * FROM observations
          WHERE watch_id = ? ${excludeId ? 'AND id != ?' : ''}
          ORDER BY observed_at DESC, id DESC LIMIT 1`,
      )
      .get(...(excludeId ? [watchId, excludeId] : [watchId]));
    return row ? hydrate(row) : null;
  }

  latestObservation(watchId) {
    return this.previousObservation(watchId);
  }

  /**
   * @returns {{low:number, lowAt:string, high:number, avg:number, count:number}|null}
   */
  stats(watchId, { sinceDays = null } = {}) {
    const params = [watchId];
    let where = 'watch_id = ?';
    if (sinceDays != null) {
      where += ' AND observed_at >= ?';
      params.push(new Date(Date.now() - sinceDays * 86_400_000).toISOString());
    }
    const row = this.#db
      .prepare(
        `SELECT MIN(price) AS low, MAX(price) AS high, AVG(price) AS avg, COUNT(*) AS count
           FROM observations WHERE ${where}`,
      )
      .get(...params);

    if (!row || row.count === 0) return null;

    const lowAt = this.#db
      .prepare(
        `SELECT observed_at FROM observations
          WHERE ${where} AND price = ? ORDER BY observed_at DESC LIMIT 1`,
      )
      .get(...params, row.low)?.observed_at;

    return {
      low: row.low,
      lowAt,
      high: row.high,
      avg: Math.round(row.avg),
      count: row.count,
    };
  }

  history(watchId, { limit = 50 } = {}) {
    return this.#db
      .prepare(
        `SELECT * FROM observations WHERE watch_id = ?
          ORDER BY observed_at DESC, id DESC LIMIT ?`,
      )
      .all(watchId, limit)
      .map(hydrate);
  }

  /** Used for alert de-duplication. */
  lastAlert(watchId, reason = null) {
    const row = this.#db
      .prepare(
        `SELECT * FROM alerts WHERE watch_id = ? ${reason ? 'AND reason = ?' : ''}
          ORDER BY sent_at DESC, id DESC LIMIT 1`,
      )
      .get(...(reason ? [watchId, reason] : [watchId]));
    return row ?? null;
  }

  recordAlert({ watchId, reason, price, prevPrice = null, message = null }) {
    this.#db
      .prepare(
        `INSERT INTO alerts (watch_id, sent_at, reason, price, prev_price, message)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(watchId, new Date().toISOString(), reason, price, prevPrice, message);
  }

  recordFailure(watchId, message) {
    this.#db
      .prepare('INSERT INTO failures (watch_id, failed_at, message) VALUES (?, ?, ?)')
      .run(watchId, new Date().toISOString(), String(message).slice(0, 500));
  }

  /** Consecutive failures since the last successful observation. */
  consecutiveFailures(watchId) {
    return this.#db
      .prepare('SELECT COUNT(*) AS n FROM failures WHERE watch_id = ? AND resolved = 0')
      .get(watchId).n;
  }

  /**
   * Serialises the database to plain records for round-tripping through git.
   *
   * CI runners are stateless, so history has to live in the repo. Keys are
   * short and the itinerary detail (`b`) is kept only on the newest row per
   * watch — that is the only one anything reads it from, and carrying it on
   * every row would multiply the committed file several times over.
   */
  exportRecords() {
    const observations = this.#db
      .prepare('SELECT * FROM observations ORDER BY observed_at ASC, id ASC')
      .all();

    const newestId = new Map();
    for (const o of observations) newestId.set(o.watch_id, o.id);

    const records = observations.map((o) => {
      const rec = { k: 'p', w: o.watch_id, t: o.observed_at, p: o.price, c: o.currency };
      if (o.nonstop_price != null) rec.n = o.nonstop_price;
      if (o.price_level) rec.l = o.price_level;
      if (o.results_count != null) rec.r = o.results_count;
      if (newestId.get(o.watch_id) === o.id && o.best_json && o.best_json !== 'null') {
        rec.b = compactItinerary(JSON.parse(o.best_json));
      }
      return rec;
    });

    for (const a of this.#db.prepare('SELECT * FROM alerts ORDER BY sent_at ASC, id ASC').all()) {
      const rec = { k: 'a', w: a.watch_id, t: a.sent_at, r: a.reason, p: a.price };
      if (a.prev_price != null) rec.pp = a.prev_price;
      if (a.message) rec.m = a.message;
      records.push(rec);
    }

    return records;
  }

  /** Inverse of exportRecords. Idempotent, so re-importing changes nothing. */
  importRecords(records) {
    const insertObservation = this.#db.prepare(
      `INSERT INTO observations
         (watch_id, observed_at, price, currency, nonstop_price, price_level, results_count, best_json)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM observations WHERE watch_id = ? AND observed_at = ?)`,
    );
    const insertAlert = this.#db.prepare(
      `INSERT INTO alerts (watch_id, sent_at, reason, price, prev_price, message)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS
         (SELECT 1 FROM alerts WHERE watch_id = ? AND sent_at = ? AND reason = ?)`,
    );

    let observations = 0;
    let alerts = 0;

    for (const rec of records) {
      if (rec.k === 'p') {
        observations += insertObservation.run(
          rec.w,
          rec.t,
          rec.p,
          rec.c ?? 'USD',
          rec.n ?? null,
          rec.l ?? null,
          rec.r ?? 0,
          JSON.stringify(rec.b ?? null),
          rec.w,
          rec.t,
        ).changes;
      } else if (rec.k === 'a') {
        alerts += insertAlert.run(
          rec.w,
          rec.t,
          rec.r,
          rec.p,
          rec.pp ?? null,
          rec.m ?? null,
          rec.w,
          rec.t,
          rec.r,
        ).changes;
      }
    }

    return { observations, alerts };
  }

  watchIds() {
    return this.#db
      .prepare('SELECT DISTINCT watch_id FROM observations ORDER BY watch_id')
      .all()
      .map((r) => r.watch_id);
  }

  /**
   * Drops all history for watches that no longer exist in the config.
   *
   * Deleting a watch deliberately keeps its history, so you can re-add the same
   * route later and still have the record. That means orphans accumulate, and
   * clearing them has to be an explicit choice rather than a side effect of
   * any routine export.
   *
   * @param {string[]} knownWatchIds ids currently present in the config
   */
  pruneOrphans(knownWatchIds) {
    const known = new Set(knownWatchIds);
    // Union both tables: a watch could have alert rows but no observations.
    const present = this.#db
      .prepare(
        `SELECT watch_id FROM observations
         UNION SELECT watch_id FROM alerts
         ORDER BY watch_id`,
      )
      .all()
      .map((r) => r.watch_id);
    const orphans = present.filter((id) => !known.has(id));
    if (orphans.length === 0) return { watches: [], observations: 0, alerts: 0 };

    const placeholders = orphans.map(() => '?').join(', ');
    const observations = this.#db
      .prepare(`DELETE FROM observations WHERE watch_id IN (${placeholders})`)
      .run(...orphans).changes;
    const alerts = this.#db
      .prepare(`DELETE FROM alerts WHERE watch_id IN (${placeholders})`)
      .run(...orphans).changes;
    this.#db.prepare(`DELETE FROM failures WHERE watch_id IN (${placeholders})`).run(...orphans);

    return { watches: orphans, observations, alerts };
  }

  /** Keeps the database from growing without bound on a long-running daemon. */
  prune({ keepDays = 365 } = {}) {
    const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
    const obs = this.#db.prepare('DELETE FROM observations WHERE observed_at < ?').run(cutoff);
    const fail = this.#db.prepare('DELETE FROM failures WHERE failed_at < ?').run(cutoff);
    return { observations: obs.changes, failures: fail.changes };
  }
}

/**
 * Trims a parsed itinerary to the fields the UI and notifications actually
 * read. The full object carries the raw ARIA label and per-segment routing,
 * which is useful for debugging a parse but would triple the size of a file
 * that gets committed dozens of times a day.
 */
function compactItinerary(best) {
  if (!best) return null;
  const keep = [
    'price',
    'airlines',
    'stops',
    'durationText',
    'departTime',
    'departDay',
    'arriveTime',
    'arriveDay',
    'flightNumbers',
    'co2Kg',
  ];
  const out = {};
  for (const key of keep) if (best[key] != null) out[key] = best[key];
  return out;
}

function hydrate(row) {
  return {
    id: row.id,
    watchId: row.watch_id,
    observedAt: row.observed_at,
    price: row.price,
    currency: row.currency,
    nonstopPrice: row.nonstop_price,
    priceLevel: row.price_level,
    resultsCount: row.results_count,
    best: row.best_json ? JSON.parse(row.best_json) : null,
  };
}
