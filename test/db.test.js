import '../src/quiet.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';

const sample = (price, extra = {}) => ({
  watchId: 'w1',
  price,
  currency: 'USD',
  resultsCount: 12,
  best: { price, airlines: 'Delta', stops: 0 },
  ...extra,
});

test('records observations and reads back the most recent one', () => {
  const store = openDb(':memory:');
  store.recordObservation(sample(300, { observedAt: '2026-07-01T10:00:00Z' }));
  store.recordObservation(sample(250, { observedAt: '2026-07-02T10:00:00Z' }));

  const latest = store.latestObservation('w1');
  assert.equal(latest.price, 250);
  assert.equal(latest.currency, 'USD');
  assert.deepEqual(latest.best, { price: 250, airlines: 'Delta', stops: 0 });
  store.close();
});

test('an unseen watch has no observation and no stats', () => {
  const store = openDb(':memory:');
  assert.equal(store.latestObservation('nobody'), null);
  assert.equal(store.stats('nobody'), null);
  store.close();
});

test('stats summarise the full history', () => {
  const store = openDb(':memory:');
  for (const [i, p] of [300, 250, 400, 275].entries()) {
    store.recordObservation(sample(p, { observedAt: `2026-07-0${i + 1}T10:00:00Z` }));
  }

  const stats = store.stats('w1');
  assert.equal(stats.low, 250);
  assert.equal(stats.high, 400);
  assert.equal(stats.avg, 306); // (300+250+400+275)/4 = 306.25
  assert.equal(stats.count, 4);
  assert.equal(stats.lowAt, '2026-07-02T10:00:00Z');
  store.close();
});

test('stats can be restricted to a recent window', () => {
  const store = openDb(':memory:');
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
  store.recordObservation(sample(150, { observedAt: old }));
  store.recordObservation(sample(400, { observedAt: recent }));

  assert.equal(store.stats('w1').low, 150);
  assert.equal(store.stats('w1', { sinceDays: 7 }).low, 400, 'the old bargain is out of the window');
  store.close();
});

test('watches are isolated from one another', () => {
  const store = openDb(':memory:');
  store.recordObservation(sample(100));
  store.recordObservation({ ...sample(900), watchId: 'w2' });

  assert.equal(store.stats('w1').low, 100);
  assert.equal(store.stats('w2').low, 900);
  assert.deepEqual(store.watchIds(), ['w1', 'w2']);
  store.close();
});

test('alerts are recorded and retrievable by reason', () => {
  const store = openDb(':memory:');
  store.recordAlert({ watchId: 'w1', reason: 'price-drop', price: 250, prevPrice: 300 });
  store.recordAlert({ watchId: 'w1', reason: 'new-low', price: 200 });

  assert.equal(store.lastAlert('w1', 'price-drop').price, 250);
  assert.equal(store.lastAlert('w1', 'new-low').price, 200);
  assert.equal(store.lastAlert('w1', 'target-hit'), null);
  assert.equal(store.lastAlert('w1').reason, 'new-low', 'no reason filter returns the newest');
  store.close();
});

test('consecutive failures reset once a check succeeds', () => {
  const store = openDb(':memory:');
  store.recordFailure('w1', 'timeout');
  store.recordFailure('w1', 'timeout');
  assert.equal(store.consecutiveFailures('w1'), 2);

  store.recordObservation(sample(300));
  assert.equal(store.consecutiveFailures('w1'), 0, 'a success clears the streak');

  store.recordFailure('w1', 'timeout again');
  assert.equal(store.consecutiveFailures('w1'), 1);
  store.close();
});

test('history returns newest first and honours the limit', () => {
  const store = openDb(':memory:');
  for (const [i, p] of [300, 250, 400].entries()) {
    store.recordObservation(sample(p, { observedAt: `2026-07-0${i + 1}T10:00:00Z` }));
  }
  assert.deepEqual(store.history('w1').map((r) => r.price), [400, 250, 300]);
  assert.deepEqual(store.history('w1', { limit: 2 }).map((r) => r.price), [400, 250]);
  store.close();
});

test('prune drops rows past the retention window and keeps the rest', () => {
  const store = openDb(':memory:');
  store.recordObservation(sample(300, { observedAt: new Date(Date.now() - 400 * 86_400_000).toISOString() }));
  store.recordObservation(sample(250));

  const removed = store.prune({ keepDays: 365 });
  assert.equal(removed.observations, 1);
  assert.equal(store.stats('w1').count, 1);
  store.close();
});

test('pruneOrphans removes history only for watches that no longer exist', () => {
  const store = openDb(':memory:');
  store.recordObservation(sample(300));
  store.recordObservation({ ...sample(900), watchId: 'gone' });
  store.recordAlert({ watchId: 'gone', reason: 'new-low', price: 900 });
  store.recordAlert({ watchId: 'w1', reason: 'new-low', price: 300 });

  const result = store.pruneOrphans(['w1']);

  assert.deepEqual(result.watches, ['gone']);
  assert.equal(result.observations, 1);
  assert.equal(result.alerts, 1);
  assert.equal(store.stats('gone'), null, 'the orphan is gone');
  assert.equal(store.stats('w1').count, 1, 'the live watch is untouched');
  assert.equal(store.lastAlert('w1').price, 300);
  store.close();
});

test('pruneOrphans finds a watch that has alerts but no observations', () => {
  const store = openDb(':memory:');
  store.recordAlert({ watchId: 'alerts-only', reason: 'new-low', price: 100 });

  const result = store.pruneOrphans([]);
  assert.deepEqual(result.watches, ['alerts-only']);
  assert.equal(result.alerts, 1);
  store.close();
});

test('pruneOrphans is a no-op when every watch is configured', () => {
  const store = openDb(':memory:');
  store.recordObservation(sample(300));

  const result = store.pruneOrphans(['w1']);
  assert.deepEqual(result, { watches: [], observations: 0, alerts: 0 });
  assert.equal(store.stats('w1').count, 1);
  store.close();
});
