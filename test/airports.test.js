import test from 'node:test';
import assert from 'node:assert/strict';

import { AIRPORTS, search, lookup, describe as describeAirport } from '../src/airports.js';

test('the dataset is well formed', () => {
  assert.ok(AIRPORTS.length > 300, `expected a substantial list, got ${AIRPORTS.length}`);
  for (const a of AIRPORTS) {
    assert.match(a.code, /^[A-Z]{3}$/, `${a.code} is not a 3-letter code`);
    assert.ok(a.city && a.country && a.name, `${a.code} is missing a field`);
  }
});

test('codes are unique', () => {
  const codes = AIRPORTS.map((a) => a.code);
  assert.equal(new Set(codes).size, codes.length);
});

test('an exact code match always ranks first', () => {
  // "SAN" is also a prefix of San Antonio, San Francisco, San Juan…
  assert.equal(search('SAN')[0].code, 'SAN');
  assert.equal(search('lax')[0].code, 'LAX');
});

test('searches by city and by airport name', () => {
  assert.ok(search('new york').some((a) => a.code === 'JFK'));
  assert.ok(search('heathrow').some((a) => a.code === 'LHR'));
  assert.ok(search('kennedy').some((a) => a.code === 'JFK'));
});

test('accents are folded so plain ASCII finds them', () => {
  assert.equal(search('malaga')[0].code, 'AGP');
  assert.ok(search('zurich').some((a) => a.code === 'ZRH'));
});

test('empty and unmatched queries return nothing', () => {
  assert.deepEqual(search(''), []);
  assert.deepEqual(search('   '), []);
  assert.deepEqual(search('zzzzzz'), []);
  assert.deepEqual(search(null), []);
});

test('results are capped at the requested limit', () => {
  assert.ok(search('san', 3).length <= 3);
  assert.ok(search('a', 5).length <= 5);
});

test('lookup and describe handle unknown codes gracefully', () => {
  assert.equal(lookup('SJU').city, 'San Juan');
  assert.equal(lookup('sju').code, 'SJU', 'lookup is case-insensitive');
  assert.equal(lookup('ZZZ'), null);
  assert.equal(describeAirport('SJU'), 'San Juan, Puerto Rico');
  assert.equal(describeAirport('ZZZ'), 'ZZZ', 'unknown codes fall back to the code itself');
});
