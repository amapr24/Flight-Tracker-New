import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeTfs, buildSearchUrl, SEAT, TRIP, MAX_STOPS } from '../src/tfs.js';

/** Decodes just enough protobuf to assert on what we encoded. */
function decode(buf) {
  const fields = [];
  let i = 0;
  const varint = () => {
    let result = 0;
    let shift = 0;
    while (buf[i] & 0x80) {
      result |= (buf[i++] & 0x7f) << shift;
      shift += 7;
    }
    result |= buf[i++] << shift;
    return result;
  };
  while (i < buf.length) {
    const key = varint();
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 0) fields.push({ field, value: varint() });
    else if (wire === 2) {
      const len = varint();
      fields.push({ field, bytes: buf.subarray(i, i + len) });
      i += len;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
  return fields;
}

const fromBase64Url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

test('encodes a one-way search with the expected field numbers', () => {
  const tfs = encodeTfs({
    legs: [{ from: 'SJU', to: 'JFK', date: '2026-08-15' }],
    adults: 1,
    seat: SEAT.economy,
    trip: TRIP['one-way'],
  });

  const fields = decode(fromBase64Url(tfs));

  assert.equal(fields.filter((f) => f.field === 3).length, 1, 'one leg');
  assert.deepEqual(
    fields.filter((f) => f.field === 8).map((f) => f.value),
    [1],
    'one adult passenger',
  );
  assert.equal(fields.find((f) => f.field === 9).value, SEAT.economy);
  assert.equal(fields.find((f) => f.field === 19).value, TRIP['one-way']);

  const leg = decode(fields.find((f) => f.field === 3).bytes);
  assert.equal(leg.find((f) => f.field === 2).bytes.toString(), '2026-08-15');
  assert.equal(decode(leg.find((f) => f.field === 13).bytes)[0].bytes.toString(), 'SJU');
  assert.equal(decode(leg.find((f) => f.field === 14).bytes)[0].bytes.toString(), 'JFK');
});

test('a round trip encodes two legs in opposite directions', () => {
  const tfs = encodeTfs({
    legs: [
      { from: 'SJU', to: 'MAD', date: '2026-10-03' },
      { from: 'MAD', to: 'SJU', date: '2026-10-17' },
    ],
    trip: TRIP['round-trip'],
  });

  const legs = decode(fromBase64Url(tfs)).filter((f) => f.field === 3);
  assert.equal(legs.length, 2);

  const routes = legs.map((l) => {
    const parts = decode(l.bytes);
    return [
      decode(parts.find((f) => f.field === 13).bytes)[0].bytes.toString(),
      decode(parts.find((f) => f.field === 14).bytes)[0].bytes.toString(),
    ].join('-');
  });
  assert.deepEqual(routes, ['SJU-MAD', 'MAD-SJU']);
});

test('passengers are repeated entries, not a count', () => {
  const tfs = encodeTfs({
    legs: [{ from: 'SJU', to: 'JFK', date: '2026-08-15' }],
    adults: 3,
    children: 1,
  });
  const pax = decode(fromBase64Url(tfs)).filter((f) => f.field === 8);
  assert.deepEqual(pax.map((p) => p.value), [1, 1, 1, 2]);
});

test('maxStops is a literal stop count and is omitted when unset', () => {
  // Verified against live Google results: 0 => nonstop only, 1 => one stop or fewer.
  assert.equal(MAX_STOPS.nonstop, 0);
  assert.equal(MAX_STOPS['1'], 1);

  const withStops = decode(
    decode(fromBase64Url(encodeTfs({ legs: [{ from: 'A', to: 'B', date: '2026-01-01', maxStops: 0 }] })))
      .find((f) => f.field === 3).bytes,
  );
  assert.equal(withStops.find((f) => f.field === 5).value, 0, 'explicit 0 must still be written');

  const without = decode(
    decode(fromBase64Url(encodeTfs({ legs: [{ from: 'A', to: 'B', date: '2026-01-01', maxStops: null }] })))
      .find((f) => f.field === 3).bytes,
  );
  assert.equal(without.find((f) => f.field === 5), undefined, 'unset means the field is absent');
});

test('buildSearchUrl produces a base64url-safe tfs and the expected query params', () => {
  const url = new URL(
    buildSearchUrl({ from: 'SJU', to: 'MAD', depart: '2026-10-03', return: '2026-10-17', adults: 2 }),
  );

  assert.equal(url.origin + url.pathname, 'https://www.google.com/travel/flights');
  assert.equal(url.searchParams.get('curr'), 'USD');
  assert.equal(url.searchParams.get('hl'), 'en');

  const tfs = url.searchParams.get('tfs');
  assert.doesNotMatch(tfs, /[+/=]/, 'tfs must be base64url with no padding');

  const fields = decode(fromBase64Url(tfs));
  assert.equal(fields.find((f) => f.field === 19).value, TRIP['round-trip']);
  assert.equal(fields.filter((f) => f.field === 8).length, 2, 'two adults');
});

test('a one-way watch is encoded as one-way', () => {
  const url = new URL(buildSearchUrl({ from: 'SJU', to: 'JFK', depart: '2026-08-15' }));
  const fields = decode(fromBase64Url(url.searchParams.get('tfs')));
  assert.equal(fields.find((f) => f.field === 19).value, TRIP['one-way']);
  assert.equal(fields.filter((f) => f.field === 3).length, 1);
});

test('rejects an empty itinerary', () => {
  assert.throws(() => encodeTfs({ legs: [] }), /at least one leg/);
});
