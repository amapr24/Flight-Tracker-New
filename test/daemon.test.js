import '../src/quiet.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { openDb } from '../src/db.js';
import { startDaemon } from '../src/daemon.js';

const itinerary = (price) => ({
  price,
  stops: 0,
  airlines: 'Delta',
  durationText: '3 hr 55 min',
  departTime: '7:30 AM',
  arriveTime: '11:25 AM',
  flightNumbers: ['DL1854'],
  layovers: [],
  segments: [],
});

/** Builds a config directly so tests can use sub-second intervals. */
function testConfig(watches, defaults = {}) {
  return {
    defaults: {
      currency: 'USD',
      language: 'en',
      region: 'US',
      staggerSeconds: 0,
      jitterSeconds: 0,
      quietHours: null,
      ...defaults,
    },
    watches: watches.map((w) => ({
      adults: 1,
      seat: 'economy',
      maxStops: null,
      enabled: true,
      trackNonstopOnly: false,
      alert: {},
      ...w,
    })),
  };
}

const silentNotifier = { name: 'test', async send() {} };
const noop = () => {};

test('every enabled watch is polled on start', async () => {
  const store = openDb(':memory:');
  const seen = [];
  const config = testConfig([
    { id: 'a', label: 'A', from: 'SJU', to: 'JFK', depart: '2026-08-15', intervalMinutes: 60 },
    { id: 'b', label: 'B', from: 'SJU', to: 'MAD', depart: '2026-10-03', intervalMinutes: 60 },
  ]);

  const daemon = startDaemon({
    config,
    store,
    notifier: silentNotifier,
    log: noop,
    search: async (watch) => {
      seen.push(watch.id);
      return { url: 'https://example.test', results: [itinerary(200)], priceLevel: null };
    },
  });

  await delay(120);
  daemon.stop();

  assert.deepEqual(seen.sort(), ['a', 'b']);
  assert.equal(store.latestObservation('a').price, 200);
  assert.equal(store.latestObservation('b').price, 200);
  store.close();
});

test('disabled watches are never polled', async () => {
  const store = openDb(':memory:');
  const seen = [];
  const config = testConfig([
    { id: 'on', label: 'On', from: 'SJU', to: 'JFK', depart: '2026-08-15', intervalMinutes: 60 },
    { id: 'off', label: 'Off', from: 'SJU', to: 'MAD', depart: '2026-10-03', intervalMinutes: 60, enabled: false },
  ]);

  const daemon = startDaemon({
    config,
    store,
    notifier: silentNotifier,
    log: noop,
    search: async (watch) => {
      seen.push(watch.id);
      return { url: 'https://example.test', results: [itinerary(200)], priceLevel: null };
    },
  });

  await delay(120);
  daemon.stop();

  assert.deepEqual(seen, ['on']);
  store.close();
});

test('a watch reschedules itself and keeps polling', async () => {
  const store = openDb(':memory:');
  let calls = 0;
  const config = testConfig([
    // 0.001 minutes = 60ms, fast enough to observe several cycles.
    { id: 'a', label: 'A', from: 'SJU', to: 'JFK', depart: '2026-08-15', intervalMinutes: 0.001 },
  ]);

  const daemon = startDaemon({
    config,
    store,
    notifier: silentNotifier,
    log: noop,
    search: async () => {
      calls++;
      return { url: 'https://example.test', results: [itinerary(200)], priceLevel: null };
    },
  });

  await delay(300);
  daemon.stop();

  assert.ok(calls >= 3, `expected repeated polling, saw ${calls}`);
  assert.equal(daemon.cycles, calls);
  store.close();
});

test('stop() halts all further polling', async () => {
  const store = openDb(':memory:');
  let calls = 0;
  const config = testConfig([
    { id: 'a', label: 'A', from: 'SJU', to: 'JFK', depart: '2026-08-15', intervalMinutes: 0.001 },
  ]);

  const daemon = startDaemon({
    config,
    store,
    notifier: silentNotifier,
    log: noop,
    search: async () => {
      calls++;
      return { url: 'https://example.test', results: [itinerary(200)], priceLevel: null };
    },
  });

  await delay(150);
  daemon.stop();
  const afterStop = calls;

  await delay(200);
  assert.equal(calls, afterStop, 'no polls happen after stop()');
  store.close();
});

test('a failing watch does not take the scheduler down', async () => {
  const store = openDb(':memory:');
  let calls = 0;
  const config = testConfig([
    { id: 'bad', label: 'Bad', from: 'SJU', to: 'JFK', depart: '2026-08-15', intervalMinutes: 0.001 },
  ]);

  const daemon = startDaemon({
    config,
    store,
    notifier: silentNotifier,
    log: noop,
    search: async () => {
      calls++;
      throw new Error('network on fire');
    },
  });

  await delay(300);
  daemon.stop();

  assert.ok(calls >= 3, `scheduler kept retrying after errors, saw ${calls}`);
  assert.ok(store.consecutiveFailures('bad') >= 3);
  store.close();
});

test('refuses to start with nothing enabled', () => {
  const store = openDb(':memory:');
  const config = testConfig([
    { id: 'a', label: 'A', from: 'SJU', to: 'JFK', depart: '2026-08-15', intervalMinutes: 60, enabled: false },
  ]);

  assert.throws(
    () => startDaemon({ config, store, notifier: silentNotifier, log: noop }),
    /No enabled watches/,
  );
  store.close();
});
