import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseResults, searchFlights, FlightSearchError } from '../src/google-flights.js';

const here = dirname(fileURLToPath(import.meta.url));
// A real Google Flights response for SJU -> JFK on 2026-08-15, captured live.
const FIXTURE = readFileSync(join(here, 'fixtures/sju-jfk-oneway.html'), 'utf8');

test('extracts every itinerary from a real response', () => {
  const { results } = parseResults(FIXTURE);
  assert.equal(results.length, 30);
  assert.ok(
    results.every((r) => Number.isFinite(r.price) && r.price > 0),
    'every row has a numeric price',
  );
});

test('deduplicates the rows Google renders twice', () => {
  const { results } = parseResults(FIXTURE);
  const keys = results.map((r) => [r.flightNumbers.join('|'), r.departTime, r.price].join('~'));
  assert.equal(new Set(keys).size, keys.length, 'no duplicate itineraries survive parsing');
});

test('results are ordered cheapest first', () => {
  const { results } = parseResults(FIXTURE);
  const prices = results.map((r) => r.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
});

test('parses a nonstop itinerary in full', () => {
  const { results } = parseResults(FIXTURE);
  const cheapest = results[0];

  assert.equal(cheapest.price, 189);
  assert.equal(cheapest.airlines, 'Delta');
  assert.equal(cheapest.stops, 0);
  assert.equal(cheapest.durationText, '3 hr 55 min');
  assert.equal(cheapest.durationMinutes, 235);
  assert.equal(cheapest.departTime, '7:30 AM');
  assert.equal(cheapest.arriveTime, '11:25 AM');
  assert.deepEqual(cheapest.flightNumbers, ['DL1854']);
  assert.equal(cheapest.co2Kg, 173);
  assert.deepEqual(cheapest.layovers, []);
});

test('parses a connecting itinerary with both segments and its layover', () => {
  const { results } = parseResults(FIXTURE);
  const connecting = results.find((r) => r.stops === 1);

  assert.deepEqual(connecting.flightNumbers, ['B6754', 'B62102']);
  assert.deepEqual(
    connecting.segments.map((s) => `${s.from}-${s.to}`),
    ['SJU-FLL', 'FLL-JFK'],
    'segments are kept in flown order',
  );
  assert.equal(connecting.layovers.length, 1);
  assert.equal(connecting.layovers[0].durationMinutes, 110);
  assert.match(connecting.layovers[0].airport, /Fort Lauderdale/);
});

test('detects arrival on the following day', () => {
  const { results } = parseResults(FIXTURE);
  const overnight = results.find((r) => r.departDay !== r.arriveDay);
  assert.ok(overnight, 'fixture contains a red-eye');
  assert.match(overnight.arriveDay, /Sunday, August 16/);
});

test("reads Google's own price-level verdict", () => {
  assert.equal(parseResults(FIXTURE).priceLevel, 'typical');
});

test('every field the alerting path depends on is populated', () => {
  const { results } = parseResults(FIXTURE);
  for (const field of ['price', 'airlines', 'stops', 'durationMinutes', 'departTime', 'arriveTime']) {
    const missing = results.filter((r) => r[field] == null);
    assert.equal(missing.length, 0, `${field} is never null`);
  }
});

test('flags a consent or captcha interstitial rather than reporting zero flights', () => {
  const wall = '<html><body>Before you continue to Google</body></html>';
  const { results, blocked } = parseResults(wall);
  assert.equal(results.length, 0);
  assert.equal(blocked, true);
});

test('a legitimately empty result set is not treated as blocked', () => {
  // Long enough to clear the size heuristic, but with no itineraries.
  const empty = `<html><body>${'x'.repeat(60_000)}</body></html>`;
  assert.equal(parseResults(empty).blocked, false);
});

test('searchFlights retries transient failures and then succeeds', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls < 3) throw new FlightSearchError('boom', { retryable: true });
    return FIXTURE;
  };

  const { results } = await searchFlights(
    { from: 'SJU', to: 'JFK', depart: '2026-08-15' },
    { fetchImpl, retries: 3, backoffBaseMs: 0 },
  );

  assert.equal(calls, 3);
  assert.equal(results.length, 30);
});

test('searchFlights does not retry a non-retryable failure', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    throw new FlightSearchError('bad request', { retryable: false, status: 400 });
  };

  await assert.rejects(
    () => searchFlights({ from: 'SJU', to: 'JFK', depart: '2026-08-15' }, { fetchImpl }),
    /bad request/,
  );
  assert.equal(calls, 1);
});
