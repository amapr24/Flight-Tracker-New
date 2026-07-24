import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, inQuietHours, DEFAULT_ALERT } from '../src/rules.js';

const noAlerts = () => null;

/** Builds the evaluate() argument set with sensible test defaults. */
function ctx({ watch = {}, price, previous = null, stats = null, lastAlert = noAlerts, now, quietHours = null }) {
  return {
    watch: { id: 'w', label: 'Test', from: 'SJU', to: 'JFK', depart: '2026-08-15', ...watch },
    current: { price, currency: 'USD', resultsCount: 10, best: null, priceLevel: null },
    previous,
    stats,
    lastAlert,
    now: now ?? new Date('2026-07-23T15:00:00Z'),
    quietHours,
  };
}

test('the very first observation is reported once, quietly', () => {
  const d = evaluate(ctx({ price: 300 }));
  assert.equal(d.notify, true);
  assert.equal(d.reason, 'first-seen');
  assert.equal(d.priority, -1);
});

test('first-seen can be turned off', () => {
  const d = evaluate(ctx({ price: 300, watch: { alert: { notifyOnFirstSeen: false } } }));
  assert.equal(d.notify, false);
  assert.equal(d.reason, null);
});

test('crossing the target price is the highest-priority alert', () => {
  const d = evaluate(
    ctx({
      price: 250,
      previous: { price: 300 },
      stats: { low: 300, count: 4 },
      watch: { alert: { targetPrice: 260 } },
    }),
  );
  assert.equal(d.reason, 'target-hit');
  assert.equal(d.priority, 1);
  assert.equal(d.underTarget, true);
  assert.equal(d.change, -50);
});

test('staying under the target without improving does not re-alert', () => {
  const d = evaluate(
    ctx({
      price: 250,
      previous: { price: 250 },
      stats: { low: 250, count: 4 },
      watch: { alert: { targetPrice: 260 } },
    }),
  );
  assert.equal(d.notify, false);
});

test('improving further while already under target alerts again', () => {
  const d = evaluate(
    ctx({
      price: 210,
      previous: { price: 250 },
      stats: { low: 250, count: 4 },
      watch: { alert: { targetPrice: 260 } },
    }),
  );
  assert.equal(d.reason, 'target-hit');
});

test('a new all-time low alerts even with no target set', () => {
  const d = evaluate(ctx({ price: 190, previous: { price: 300 }, stats: { low: 200, count: 12 } }));
  assert.equal(d.reason, 'new-low');
  assert.equal(d.isNewLow, true);
  assert.equal(d.priority, 0);
});

test('a record low that also clears the target is reported as a target hit', () => {
  const d = evaluate(
    ctx({
      price: 190,
      previous: { price: 195 },
      stats: { low: 200, count: 12 },
      watch: { alert: { targetPrice: 250 } },
    }),
  );
  // Both conditions hold, but "you can book this now" is the actionable one,
  // and it already carries the high-priority slot.
  assert.equal(d.reason, 'target-hit');
  assert.equal(d.priority, 1);
  assert.equal(d.isNewLow, true, 'the record-low fact is still reported to the formatter');
});

test('matching the previous low is not a new low', () => {
  const d = evaluate(ctx({ price: 200, previous: { price: 220 }, stats: { low: 200, count: 12 } }));
  assert.notEqual(d.reason, 'new-low');
  assert.equal(d.isNewLow, false);
});

test('a drop past the absolute threshold alerts', () => {
  const d = evaluate(
    ctx({ price: 260, previous: { price: 300 }, stats: { low: 250, count: 9 } }),
  );
  assert.equal(d.reason, 'price-drop');
  assert.equal(d.change, -40);
});

test('a drop past the percentage threshold alerts even when small in absolute terms', () => {
  const d = evaluate(
    ctx({
      price: 92,
      previous: { price: 100 },
      stats: { low: 90, count: 9 },
      watch: { alert: { dropAmount: 1000, dropPercent: 8 } },
    }),
  );
  assert.equal(d.reason, 'price-drop');
});

test('noise below both thresholds stays silent', () => {
  const d = evaluate(
    ctx({ price: 297, previous: { price: 300 }, stats: { low: 250, count: 9 } }),
  );
  assert.equal(d.notify, false);
  assert.equal(d.reason, null);
});

test('price rises are ignored unless explicitly requested', () => {
  const rising = { price: 400, previous: { price: 300 }, stats: { low: 250, count: 9 } };
  assert.equal(evaluate(ctx(rising)).notify, false);

  const d = evaluate(ctx({ ...rising, watch: { alert: { notifyOnRise: true, risePercent: 20 } } }));
  assert.equal(d.reason, 'price-rise');
  assert.equal(d.priority, -1);
});

test('a repeat alert inside the cooldown window is suppressed', () => {
  const now = new Date('2026-07-23T15:00:00Z');
  const recent = { sent_at: new Date(now.getTime() - 30 * 60_000).toISOString(), price: 260 };

  const d = evaluate(
    ctx({
      price: 255,
      previous: { price: 300 },
      stats: { low: 250, count: 9 },
      lastAlert: (reason) => (reason === 'price-drop' ? recent : null),
      now,
    }),
  );

  assert.equal(d.notify, false);
  assert.match(d.suppressedBy, /cooldown/);
});

test('a materially better price breaks through the cooldown', () => {
  const now = new Date('2026-07-23T15:00:00Z');
  const recent = { sent_at: new Date(now.getTime() - 30 * 60_000).toISOString(), price: 260 };

  const d = evaluate(
    ctx({
      price: 230, // 260 - 30 clears the default $25 dropAmount
      previous: { price: 300 },
      stats: { low: 220, count: 9 }, // not a record, so 'price-drop' is the reason

      lastAlert: (reason) => (reason === 'price-drop' ? recent : null),
      now,
    }),
  );

  assert.equal(d.notify, true);
  assert.equal(d.reason, 'price-drop');
});

test('an expired cooldown no longer suppresses', () => {
  const now = new Date('2026-07-23T15:00:00Z');
  const old = {
    sent_at: new Date(now.getTime() - (DEFAULT_ALERT.cooldownMinutes + 10) * 60_000).toISOString(),
    price: 260,
  };

  const d = evaluate(
    ctx({
      price: 255,
      previous: { price: 300 },
      stats: { low: 250, count: 9 },
      lastAlert: () => old,
      now,
    }),
  );
  assert.equal(d.notify, true);
});

test('quiet hours mute ordinary alerts but let urgent ones through', () => {
  const quietHours = { start: '23:00', end: '07:00', timezone: 'UTC', allowUrgent: true };
  const night = new Date('2026-07-23T02:00:00Z');

  const ordinary = evaluate(
    ctx({ price: 260, previous: { price: 300 }, stats: { low: 250, count: 9 }, now: night, quietHours }),
  );
  assert.equal(ordinary.reason, 'price-drop');
  assert.equal(ordinary.priority, -1, 'a normal drop is silenced overnight');
  assert.equal(ordinary.quiet, true);

  const urgent = evaluate(
    ctx({
      price: 190,
      previous: { price: 300 },
      stats: { low: 250, count: 9 },
      watch: { alert: { targetPrice: 200 } },
      now: night,
      quietHours,
    }),
  );
  assert.equal(urgent.reason, 'target-hit');
  assert.equal(urgent.priority, 1, 'hitting the target still wakes you');
});

test('quiet hours can mute everything', () => {
  const quietHours = { start: '23:00', end: '07:00', timezone: 'UTC', allowUrgent: false };
  const d = evaluate(
    ctx({
      price: 190,
      previous: { price: 300 },
      watch: { alert: { targetPrice: 200 } },
      now: new Date('2026-07-23T02:00:00Z'),
      quietHours,
    }),
  );
  assert.equal(d.priority, -1);
});

test('inQuietHours handles a window that wraps past midnight', () => {
  const q = { start: '23:00', end: '07:00', timezone: 'UTC' };
  assert.equal(inQuietHours(new Date('2026-07-23T23:30:00Z'), q), true);
  assert.equal(inQuietHours(new Date('2026-07-23T03:00:00Z'), q), true);
  assert.equal(inQuietHours(new Date('2026-07-23T06:59:00Z'), q), true);
  assert.equal(inQuietHours(new Date('2026-07-23T07:00:00Z'), q), false);
  assert.equal(inQuietHours(new Date('2026-07-23T15:00:00Z'), q), false);
});

test('inQuietHours handles a same-day window and respects the time zone', () => {
  const sameDay = { start: '01:00', end: '05:00', timezone: 'UTC' };
  assert.equal(inQuietHours(new Date('2026-07-23T03:00:00Z'), sameDay), true);
  assert.equal(inQuietHours(new Date('2026-07-23T06:00:00Z'), sameDay), false);

  // 03:00 UTC is 23:00 the previous day in Puerto Rico (UTC-4).
  const pr = { start: '23:00', end: '07:00', timezone: 'America/Puerto_Rico' };
  assert.equal(inQuietHours(new Date('2026-07-24T03:00:00Z'), pr), true);
  assert.equal(inQuietHours(new Date('2026-07-23T20:00:00Z'), pr), false);
});

test('no quiet-hours config means never quiet', () => {
  assert.equal(inQuietHours(new Date(), null), false);
  assert.equal(inQuietHours(new Date(), {}), false);
});
