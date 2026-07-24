import '../src/quiet.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import { checkWatch } from '../src/runner.js';
import { parseConfig } from '../src/config.js';

/**
 * These cover the CI story: a stateless runner rebuilds the database from the
 * NDJSON in the repo, and must behave exactly as if it had been running all
 * along. Getting this wrong would make every run report a fresh all-time low.
 */

const obs = (watchId, price, observedAt, extra = {}) => ({
  watchId,
  price,
  currency: 'USD',
  resultsCount: 12,
  observedAt,
  best: { price, airlines: 'Delta', stops: 0, durationText: '3 hr 55 min' },
  ...extra,
});

function roundTrip(source) {
  const target = openDb(':memory:');
  target.importRecords(source.exportRecords());
  return target;
}

test('observations survive a round trip', () => {
  const source = openDb(':memory:');
  source.recordObservation(obs('w1', 300, '2026-07-01T10:00:00Z'));
  source.recordObservation(obs('w1', 250, '2026-07-02T10:00:00Z'));
  source.recordObservation(obs('w2', 900, '2026-07-02T11:00:00Z'));

  const copy = roundTrip(source);

  assert.equal(copy.stats('w1').low, 250);
  assert.equal(copy.stats('w1').count, 2);
  assert.equal(copy.stats('w2').low, 900);
  assert.equal(copy.latestObservation('w1').price, 250);
  source.close();
  copy.close();
});

test('the newest observation keeps its itinerary detail', () => {
  const source = openDb(':memory:');
  source.recordObservation(obs('w1', 300, '2026-07-01T10:00:00Z'));
  source.recordObservation(obs('w1', 250, '2026-07-02T10:00:00Z'));

  const copy = roundTrip(source);
  // Only the latest row's `best` is carried, since that is the only one read.
  assert.equal(copy.latestObservation('w1').best.airlines, 'Delta');
  assert.equal(copy.history('w1')[1].best, null, 'older rows drop the detail to save space');
  source.close();
  copy.close();
});

test('alert state survives, so cooldowns still apply after a restart', () => {
  const source = openDb(':memory:');
  source.recordAlert({ watchId: 'w1', reason: 'price-drop', price: 250, prevPrice: 300 });

  const copy = roundTrip(source);
  const alert = copy.lastAlert('w1', 'price-drop');
  assert.ok(alert, 'the alert came across');
  assert.equal(alert.price, 250);
  assert.equal(alert.prev_price, 300);
  source.close();
  copy.close();
});

test('importing twice is idempotent', () => {
  const source = openDb(':memory:');
  source.recordObservation(obs('w1', 300, '2026-07-01T10:00:00Z'));
  source.recordAlert({ watchId: 'w1', reason: 'new-low', price: 300 });

  const records = source.exportRecords();
  const copy = openDb(':memory:');

  const first = copy.importRecords(records);
  const second = copy.importRecords(records);

  assert.equal(first.observations, 1);
  assert.equal(first.alerts, 1);
  assert.equal(second.observations, 0, 're-importing inserts nothing');
  assert.equal(second.alerts, 0);
  assert.equal(copy.stats('w1').count, 1);
  source.close();
  copy.close();
});

test('an empty database exports nothing and imports cleanly', () => {
  const source = openDb(':memory:');
  assert.deepEqual(source.exportRecords(), []);

  const copy = openDb(':memory:');
  assert.deepEqual(copy.importRecords([]), { observations: 0, alerts: 0 });
  source.close();
  copy.close();
});

test('every record serialises to a single NDJSON line', () => {
  const source = openDb(':memory:');
  source.recordObservation(obs('w1', 300, '2026-07-01T10:00:00Z'));
  source.recordAlert({ watchId: 'w1', reason: 'new-low', price: 300, message: 'multi\nline' });

  for (const rec of source.exportRecords()) {
    const line = JSON.stringify(rec);
    assert.ok(!line.includes('\n'), 'a literal newline would corrupt the file');
    assert.deepEqual(JSON.parse(line), rec);
  }
  source.close();
});

test('a restored run does not mistake the current price for a record low', async () => {
  // The failure this guards against: a stateless runner with no history treats
  // every price as an all-time low and pushes an alert on every single run.
  const config = parseConfig({
    defaults: { staggerSeconds: 0 },
    watches: [{ id: 'w1', from: 'SJU', to: 'JFK', depart: '2026-08-15', alert: { notifyOnFirstSeen: false } }],
  });
  const watch = config.watches[0];

  const original = openDb(':memory:');
  original.recordObservation(obs('w1', 200, '2026-07-01T10:00:00Z'));
  original.recordObservation(obs('w1', 210, '2026-07-02T10:00:00Z'));

  const restored = roundTrip(original);
  const sent = [];
  const notifier = { name: 'test', async send(m) { sent.push(m); } };

  const result = await checkWatch({
    watch,
    store: restored,
    notifier,
    config,
    search: async () => ({
      url: 'https://example.test',
      priceLevel: null,
      results: [{ price: 260, stops: 0, airlines: 'Delta', durationText: '3 hr', flightNumbers: [], layovers: [], segments: [] }],
    }),
  });

  assert.equal(result.decision.isNewLow, false, '260 is not below the restored low of 200');
  assert.equal(result.decision.allTimeLow, 200, 'history came back intact');
  assert.equal(sent.length, 0, 'a routine price change stays silent after a restart');

  original.close();
  restored.close();
});
