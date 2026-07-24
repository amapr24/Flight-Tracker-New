import test from 'node:test';
import assert from 'node:assert/strict';

import { parseConfig, ConfigError, loadEnv } from '../src/config.js';

const base = { from: 'SJU', to: 'JFK', depart: '2026-08-15' };
const one = (watch) => parseConfig({ watches: [{ id: 'w', ...base, ...watch }] }).watches[0];

test('applies defaults and derives a readable label', () => {
  const w = one({});
  assert.equal(w.adults, 1);
  assert.equal(w.seat, 'economy');
  assert.equal(w.enabled, true);
  assert.equal(w.intervalMinutes, 30);
  assert.equal(w.maxStops, null);
  assert.equal(w.label, 'SJU → JFK 2026-08-15');
  assert.equal(w.alert.dropPercent, 8, 'alert defaults are merged in');
});

test('a partial alert block keeps the remaining defaults', () => {
  const w = one({ alert: { targetPrice: 250 } });
  assert.equal(w.alert.targetPrice, 250);
  assert.equal(w.alert.dropAmount, 25);
  assert.equal(w.alert.notifyOnNewLow, true);
});

test('airport codes are upper-cased', () => {
  assert.equal(one({ from: 'sju' }).from, 'SJU');
});

test('rejects malformed airport codes', () => {
  assert.throws(() => one({ from: 'SANJUAN' }), ConfigError);
  assert.throws(() => one({ to: 'J' }), ConfigError);
  assert.throws(() => one({ from: 'SJU', to: 'SJU' }), /must differ/);
});

test('rejects malformed and impossible dates', () => {
  assert.throws(() => one({ depart: '08/15/2026' }), /YYYY-MM-DD/);
  assert.throws(() => one({ depart: '2026-02-31' }), /not a real date/);
  assert.throws(() => one({ depart: undefined }), /depart is required/);
});

test('rejects a return date before departure', () => {
  assert.throws(() => one({ return: '2026-08-01' }), /return date is before depart/);
  assert.doesNotThrow(() => one({ return: '2026-08-20' }));
});

test('accepts every documented maxStops value and rejects the rest', () => {
  for (const v of ['nonstop', 0, 1, 2, 3, null]) assert.doesNotThrow(() => one({ maxStops: v }));
  assert.throws(() => one({ maxStops: 'direct' }), ConfigError);
  assert.throws(() => one({ maxStops: 9 }), ConfigError);
});

test('validates seat class, passenger count and interval', () => {
  assert.throws(() => one({ seat: 'coach' }), /seat must be one of/);
  assert.throws(() => one({ adults: 0 }), /between 1 and 9/);
  assert.throws(() => one({ adults: 2.5 }), /between 1 and 9/);
  assert.throws(() => one({ intervalMinutes: 1 }), /at least 5/);
  assert.doesNotThrow(() => one({ intervalMinutes: 5 }));
});

test('rejects nonsensical alert thresholds', () => {
  assert.throws(() => one({ alert: { targetPrice: -5 } }), /non-negative/);
  assert.throws(() => one({ alert: { dropPercent: 'lots' } }), /non-negative/);
});

test('rejects duplicate watch ids', () => {
  assert.throws(
    () => parseConfig({ watches: [{ id: 'x', ...base }, { id: 'x', ...base }] }),
    /duplicate watch id/,
  );
});

test('requires at least one watch', () => {
  assert.throws(() => parseConfig({ watches: [] }), /non-empty/);
  assert.throws(() => parseConfig({}), /non-empty/);
});

test('validates quiet hours and time zones', () => {
  assert.throws(
    () => parseConfig({ defaults: { quietHours: { start: '11pm', end: '07:00' } }, watches: [{ ...base }] }),
    /HH:MM/,
  );
  assert.throws(
    () =>
      parseConfig({
        defaults: { quietHours: { start: '23:00', end: '07:00', timezone: 'Mars/Olympus' } },
        watches: [{ ...base }],
      }),
    /not a valid IANA time zone/,
  );

  const ok = parseConfig({
    defaults: { quietHours: { start: '23:00', end: '07:00', timezone: 'America/Puerto_Rico' } },
    watches: [{ ...base }],
  });
  assert.equal(ok.defaults.quietHours.allowUrgent, true, 'urgent alerts pass through by default');
});

test('per-watch interval overrides the default', () => {
  const config = parseConfig({
    defaults: { intervalMinutes: 60 },
    watches: [{ id: 'a', ...base }, { id: 'b', ...base, intervalMinutes: 15 }],
  });
  assert.equal(config.watches[0].intervalMinutes, 60);
  assert.equal(config.watches[1].intervalMinutes, 15);
});

test('loadEnv never overwrites a real environment variable', () => {
  const env = { PUSHOVER_TOKEN: 'from-shell' };
  loadEnv('/definitely/not/a/path/.env', env);
  assert.equal(env.PUSHOVER_TOKEN, 'from-shell');
});
