import '../src/quiet.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import { checkWatch } from '../src/runner.js';
import { parseConfig } from '../src/config.js';
import { FlightSearchError } from '../src/google-flights.js';

function itinerary(price, stops = 0) {
  return {
    price,
    stops,
    airlines: stops === 0 ? 'Delta' : 'JetBlue',
    durationText: '3 hr 55 min',
    durationMinutes: 235,
    departTime: '7:30 AM',
    arriveTime: '11:25 AM',
    departDay: 'Saturday, August 15',
    arriveDay: 'Saturday, August 15',
    flightNumbers: ['DL1854'],
    layovers: [],
    segments: [],
  };
}

/** A search stub that returns a scripted price sequence. */
function scriptedSearch(sequences) {
  let i = 0;
  return async () => {
    const results = sequences[Math.min(i++, sequences.length - 1)];
    return {
      url: 'https://example.test/flights',
      results,
      priceLevel: 'typical',
      fetchedAt: new Date().toISOString(),
    };
  };
}

function recordingNotifier() {
  const sent = [];
  return {
    name: 'test',
    sent,
    async send(msg) {
      sent.push(msg);
      return { request: 'x' };
    },
  };
}

function setup(watchOverrides = {}, configDefaults = {}) {
  const config = parseConfig({
    defaults: { staggerSeconds: 0, ...configDefaults },
    watches: [{ id: 'w1', from: 'SJU', to: 'JFK', depart: '2026-08-15', ...watchOverrides }],
  });
  config.databasePath = ':memory:';
  return { config, watch: config.watches[0], store: openDb(':memory:') };
}

test('a successful check stores history and pushes the first-seen alert', async () => {
  const { config, watch, store } = setup();
  const notifier = recordingNotifier();

  const result = await checkWatch({
    watch,
    store,
    notifier,
    config,
    search: scriptedSearch([[itinerary(189), itinerary(258, 1)]]),
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.price, 189);
  assert.equal(result.notified, true);
  assert.equal(result.decision.reason, 'first-seen');

  assert.equal(store.latestObservation('w1').price, 189);
  assert.equal(store.latestObservation('w1').resultsCount, 2);
  assert.equal(notifier.sent.length, 1);
  assert.match(notifier.sent[0].title, /\$189/);
  assert.equal(notifier.sent[0].url, 'https://example.test/flights');
  store.close();
});

test('the cheapest option is what gets tracked regardless of result order', async () => {
  const { config, watch, store } = setup();
  const result = await checkWatch({
    watch,
    store,
    notifier: recordingNotifier(),
    config,
    search: scriptedSearch([[itinerary(400), itinerary(150), itinerary(275)]]),
  });
  assert.equal(result.price, 150);
  store.close();
});

test('trackNonstopOnly ignores cheaper connecting fares', async () => {
  const { config, watch, store } = setup({ trackNonstopOnly: true });
  const result = await checkWatch({
    watch,
    store,
    notifier: recordingNotifier(),
    config,
    search: scriptedSearch([[itinerary(120, 1), itinerary(310, 0)]]),
  });

  assert.equal(result.price, 310, 'the $120 one-stop is not eligible');
  assert.equal(store.latestObservation('w1').nonstopPrice, 310);
  store.close();
});

test('a price drop across two checks produces a drop alert with the delta', async () => {
  const { config, watch, store } = setup({ alert: { notifyOnFirstSeen: false } });
  const notifier = recordingNotifier();
  // A cheap first reading establishes the floor, so the later fall to $240 is a
  // plain drop rather than a record low — which is what this test is about.
  const search = scriptedSearch([[itinerary(200)], [itinerary(300)], [itinerary(240)]]);

  const first = await checkWatch({ watch, store, notifier, config, search });
  assert.equal(first.notified, false, 'first-seen is disabled for this watch');
  await checkWatch({ watch, store, notifier, config, search });

  const third = await checkWatch({ watch, store, notifier, config, search });
  assert.equal(third.decision.reason, 'price-drop');
  assert.equal(third.decision.change, -60);
  assert.equal(third.notified, true);
  assert.match(notifier.sent.at(-1).message, /was \$300/);
  store.close();
});

test('an unchanged price is recorded but never notified', async () => {
  const { config, watch, store } = setup({ alert: { notifyOnFirstSeen: false } });
  const notifier = recordingNotifier();
  const search = scriptedSearch([[itinerary(300)]]);

  await checkWatch({ watch, store, notifier, config, search });
  await checkWatch({ watch, store, notifier, config, search });
  await checkWatch({ watch, store, notifier, config, search });

  assert.equal(notifier.sent.length, 0, 'a flat price is silent');
  assert.equal(store.stats('w1').count, 3, 'but every check is still recorded');
  store.close();
});

test('the current observation cannot become its own all-time low', async () => {
  const { config, watch, store } = setup({ alert: { notifyOnFirstSeen: false } });
  const notifier = recordingNotifier();

  // Rising prices: no check should ever be reported as a record low.
  const search = scriptedSearch([[itinerary(200)], [itinerary(250)], [itinerary(300)]]);
  for (let i = 0; i < 3; i++) {
    const r = await checkWatch({ watch, store, notifier, config, search });
    assert.notEqual(r.decision.reason, 'new-low');
  }
  store.close();
});

test('a genuine record low is detected against stored history', async () => {
  const { config, watch, store } = setup({ alert: { notifyOnFirstSeen: false } });
  const notifier = recordingNotifier();
  const search = scriptedSearch([[itinerary(300)], [itinerary(280)], [itinerary(150)]]);

  await checkWatch({ watch, store, notifier, config, search });
  await checkWatch({ watch, store, notifier, config, search });
  const third = await checkWatch({ watch, store, notifier, config, search });

  assert.equal(third.decision.isNewLow, true);
  assert.equal(third.decision.allTimeLow, 280, 'compared against the previous best');
  store.close();
});

test('a search failure is recorded and reported without throwing', async () => {
  const { config, watch, store } = setup();
  const notifier = recordingNotifier();

  const result = await checkWatch({
    watch,
    store,
    notifier,
    config,
    search: async () => {
      throw new FlightSearchError('Google returned HTTP 429', { retryable: true });
    },
  });

  assert.equal(result.status, 'error');
  assert.match(result.error, /429/);
  assert.equal(store.consecutiveFailures('w1'), 1);
  assert.equal(notifier.sent.length, 0, 'one failure is not worth a push');
  store.close();
});

test('repeated failures eventually warn that the tracker has gone blind', async () => {
  const { config, watch, store } = setup();
  const notifier = recordingNotifier();
  const search = async () => {
    throw new FlightSearchError('blocked', { retryable: true });
  };

  for (let i = 0; i < 4; i++) await checkWatch({ watch, store, notifier, config, search });

  assert.equal(notifier.sent.length, 1, 'warns once, not on every failure');
  assert.match(notifier.sent[0].title, /Checks failing/);
  assert.equal(notifier.sent[0].priority, -1);
  store.close();
});

test('an empty result set is treated as a failure rather than a free price', async () => {
  const { config, watch, store } = setup();
  const result = await checkWatch({
    watch,
    store,
    notifier: recordingNotifier(),
    config,
    search: scriptedSearch([[]]),
  });

  assert.equal(result.status, 'no-results');
  assert.equal(store.latestObservation('w1'), null, 'nothing is written to history');
  store.close();
});

test('notify:false records history but sends nothing', async () => {
  const { config, watch, store } = setup();
  const notifier = recordingNotifier();

  const result = await checkWatch({
    watch,
    store,
    notifier,
    config,
    notify: false,
    search: scriptedSearch([[itinerary(189)]]),
  });

  assert.equal(result.notified, false);
  assert.equal(notifier.sent.length, 0);
  assert.equal(store.latestObservation('w1').price, 189);
  store.close();
});

test('a notifier outage does not lose the observation and is surfaced', async () => {
  const { config, watch, store } = setup();
  const broken = {
    name: 'broken',
    async send() {
      throw new Error('pushover down');
    },
  };

  const result = await checkWatch({
    watch,
    store,
    notifier: broken,
    config,
    search: scriptedSearch([[itinerary(189)]]),
  });

  assert.equal(result.notified, false);
  assert.match(result.notifyError, /pushover down/);
  assert.equal(store.latestObservation('w1').price, 189, 'history is still written');
  assert.equal(store.lastAlert('w1'), null, 'a failed send is not recorded as sent');
  store.close();
});

test('an alert that fails to send is retried on the next check', async () => {
  const { config, watch, store } = setup({ alert: { targetPrice: 250 } });
  let fail = true;
  const flaky = {
    name: 'flaky',
    sent: [],
    async send(msg) {
      if (fail) throw new Error('temporary outage');
      this.sent.push(msg);
    },
  };
  const search = scriptedSearch([[itinerary(200)], [itinerary(190)]]);

  await checkWatch({ watch, store, notifier: flaky, config, search });
  fail = false;
  const second = await checkWatch({ watch, store, notifier: flaky, config, search });

  assert.equal(second.notified, true);
  assert.equal(flaky.sent.length, 1);
  store.close();
});

test('quiet hours downgrade an ordinary alert to a silent push', async () => {
  const { config, watch, store } = setup(
    { alert: { notifyOnFirstSeen: false } },
    { quietHours: { start: '00:00', end: '23:59', timezone: 'UTC' } },
  );
  const notifier = recordingNotifier();
  const search = scriptedSearch([[itinerary(300)], [itinerary(240)]]);

  await checkWatch({ watch, store, notifier, config, search });
  await checkWatch({ watch, store, notifier, config, search });

  assert.equal(notifier.sent.length, 1);
  assert.equal(notifier.sent[0].priority, -1, 'delivered, but silently');
  store.close();
});
