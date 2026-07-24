import '../src/quiet.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';

const base = { from: 'SJU', to: 'JFK', depart: '2026-08-15' };

/** Boots the real server on an ephemeral port and returns a client for it. */
async function withServer(run, { seed } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ft-srv-'));
  const configPath = join(dir, 'watches.json');
  if (seed) writeFileSync(configPath, JSON.stringify(seed, null, 2));

  const store = openDb(':memory:');
  const sent = [];
  const notifier = { name: 'test', async send(m) { sent.push(m); } };
  const changes = [];

  const server = createServer({
    store,
    configPath,
    notifier,
    onConfigChange: (c) => changes.push(c),
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(`${origin}${path}`, {
      method,
      headers: {
        // A browser attaches this automatically; the CSRF guard requires it.
        ...(method === 'GET' ? {} : { origin, 'content-type': 'application/json' }),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  try {
    await run({ call, origin, configPath, store, sent, changes });
  } finally {
    server.close();
    store.close();
  }
}

test('serves state for a fresh install with no config file', async () => {
  await withServer(async ({ call }) => {
    const { status, body } = await call('/api/state');
    assert.equal(status, 200);
    assert.deepEqual(body.watches, []);
    assert.equal(body.defaults.intervalMinutes, 30);
  });
});

test('rejects a foreign Host header', async () => {
  await withServer(async ({ origin }) => {
    // fetch() treats Host as a forbidden header and will not send it, so this
    // one guard has to be exercised through the raw http client.
    const { port } = new URL(origin);
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: '/api/state', headers: { Host: 'evil.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403, 'DNS rebinding is blocked');
  });
});

test('rejects a cross-origin write', async () => {
  await withServer(async ({ call }) => {
    const { status } = await call('/api/watches', {
      method: 'POST',
      body: base,
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(status, 403);
  });
});

test('rejects a write with no Origin at all', async () => {
  await withServer(async ({ call }) => {
    const { status } = await call('/api/watches', { method: 'POST', body: base, headers: { origin: '' } });
    assert.equal(status, 403);
  });
});

test('does not serve files outside the web root', async () => {
  await withServer(async ({ origin }) => {
    const res = await fetch(`${origin}/../../.env`);
    assert.ok(res.status === 404 || res.status === 403, `got ${res.status}`);
  });
});

test('unknown API paths 404 instead of falling through to static', async () => {
  await withServer(async ({ call }) => {
    assert.equal((await call('/api/nonsense')).status, 404);
  });
});

test('the wrong method on a real route is a 405', async () => {
  await withServer(async ({ call }) => {
    assert.equal((await call('/api/state', { method: 'POST', body: {} })).status, 405);
  });
});

test('airport lookup is exposed to the picker', async () => {
  await withServer(async ({ call }) => {
    const { body } = await call('/api/airports?q=madrid');
    assert.equal(body.results[0].code, 'MAD');

    const empty = await call('/api/airports?q=');
    assert.deepEqual(empty.body.results, []);
  });
});

test('a watch can be created, listed, patched and deleted', async () => {
  await withServer(async ({ call, configPath, changes }) => {
    const created = await call('/api/watches', {
      method: 'POST',
      body: { ...base, intervalMinutes: 20, alert: { targetPrice: 200 } },
    });
    assert.equal(created.status, 200);
    const id = created.body.watch.id;
    assert.equal(created.body.watch.fromLabel, 'San Juan, Puerto Rico');
    assert.match(created.body.watch.searchUrl, /^https:\/\/www\.google\.com\/travel\/flights\?tfs=/);

    const listed = await call('/api/state');
    assert.equal(listed.body.watches.length, 1);
    assert.equal(listed.body.watches[0].latest, null, 'no price until a check runs');

    const patched = await call(`/api/watches/${id}`, { method: 'PATCH', body: { enabled: false } });
    assert.equal(patched.body.watch.enabled, false);
    assert.equal(patched.body.watch.intervalMinutes, 20, 'unrelated fields survive');

    const removed = await call(`/api/watches/${id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.deepEqual((await call('/api/state')).body.watches, []);

    assert.equal(changes.length, 3, 'the poller is told about create, patch and delete');
    assert.ok(readFileSync(configPath, 'utf8').includes('"watches"'));
  });
});

test('an invalid watch is refused with a useful message', async () => {
  await withServer(async ({ call }) => {
    const { status, body } = await call('/api/watches', {
      method: 'POST',
      body: { from: 'NOPE', to: 'JFK', depart: '2026-08-15' },
    });
    assert.equal(status, 400);
    assert.match(body.error, /3-letter airport code/);
  });
});

test('an impossible date is refused', async () => {
  await withServer(async ({ call }) => {
    const { status, body } = await call('/api/watches', {
      method: 'POST',
      body: { ...base, depart: '2026-02-31' },
    });
    assert.equal(status, 400);
    assert.match(body.error, /not a real date/);
  });
});

test('checking an unknown watch is a 404', async () => {
  await withServer(async ({ call }) => {
    assert.equal((await call('/api/watches/ghost/check', { method: 'POST' })).status, 404);
  });
});

test('history is returned for a watch that has some', async () => {
  await withServer(
    async ({ call, store }) => {
      store.recordObservation({
        watchId: 'seeded',
        price: 250,
        currency: 'USD',
        resultsCount: 5,
        best: { price: 250, stops: 0, airlines: 'Delta' },
      });

      const { body } = await call('/api/watches/seeded/history');
      assert.equal(body.history.length, 1);
      assert.equal(body.history[0].price, 250);

      const state = await call('/api/state');
      const w = state.body.watches[0];
      assert.equal(w.latest.price, 250);
      assert.equal(w.stats.low, 250);
      assert.equal(w.series.length, 1);
    },
    { seed: { defaults: {}, watches: [{ id: 'seeded', ...base }] } },
  );
});

test('editing alert settings coerces form strings to numbers', async () => {
  await withServer(
    async ({ call }) => {
      // A browser form sends everything as a string; the numeric validators in
      // config.js would reject those outright without coercion.
      const { status, body } = await call('/api/watches/w1', {
        method: 'PATCH',
        body: { intervalMinutes: '60', alert: { targetPrice: '175', dropPercent: '12' } },
      });

      assert.equal(status, 200);
      assert.equal(body.watch.intervalMinutes, 60);
      assert.equal(body.watch.alert.targetPrice, 175);
      assert.equal(body.watch.alert.dropPercent, 12);
    },
    { seed: { defaults: {}, watches: [{ id: 'w1', ...base }] } },
  );
});

test('an alert edit preserves the fields it does not mention', async () => {
  await withServer(
    async ({ call }) => {
      const { body } = await call('/api/watches/w1', {
        method: 'PATCH',
        body: { alert: { targetPrice: 150 } },
      });
      assert.equal(body.watch.alert.targetPrice, 150);
      assert.equal(body.watch.alert.dropAmount, 40, 'untouched alert fields survive');
      assert.equal(body.watch.intervalMinutes, 45, 'untouched watch fields survive');
    },
    {
      seed: {
        defaults: {},
        watches: [{ id: 'w1', ...base, intervalMinutes: 45, alert: { targetPrice: 300, dropAmount: 40 } }],
      },
    },
  );
});

test('a target price can be cleared', async () => {
  await withServer(
    async ({ call }) => {
      const { body } = await call('/api/watches/w1', {
        method: 'PATCH',
        body: { alert: { targetPrice: null } },
      });
      assert.equal(body.watch.alert.targetPrice, null);
    },
    { seed: { defaults: {}, watches: [{ id: 'w1', ...base, alert: { targetPrice: 300 } }] } },
  );
});

test('route and dates are refused, with an explanation', async () => {
  await withServer(
    async ({ call }) => {
      for (const patch of [{ depart: '2026-09-01' }, { to: 'LAX' }, { from: 'BOS' }, { return: '2026-09-10' }]) {
        const { status, body } = await call('/api/watches/w1', { method: 'PATCH', body: patch });
        assert.equal(status, 400, `${Object.keys(patch)[0]} must be rejected`);
        assert.match(body.error, /cannot be changed|history/i);
      }
      // The watch is untouched after every rejection.
      const state = await call('/api/state');
      assert.equal(state.body.watches[0].depart, '2026-08-15');
      assert.equal(state.body.watches[0].to, 'JFK');
    },
    { seed: { defaults: {}, watches: [{ id: 'w1', ...base }] } },
  );
});

test('an edit with no editable fields is rejected rather than silently doing nothing', async () => {
  await withServer(
    async ({ call }) => {
      const { status, body } = await call('/api/watches/w1', { method: 'PATCH', body: { nonsense: 1 } });
      assert.equal(status, 400);
      assert.match(body.error, /No editable fields/);
    },
    { seed: { defaults: {}, watches: [{ id: 'w1', ...base }] } },
  );
});

test('a non-numeric value for a numeric field is refused', async () => {
  await withServer(
    async ({ call }) => {
      const { status, body } = await call('/api/watches/w1', {
        method: 'PATCH',
        body: { alert: { targetPrice: 'cheap please' } },
      });
      assert.equal(status, 400);
      assert.match(body.error, /must be a number/);
    },
    { seed: { defaults: {}, watches: [{ id: 'w1', ...base }] } },
  );
});

test('pause and resume still work through the same endpoint', async () => {
  await withServer(
    async ({ call }) => {
      assert.equal((await call('/api/watches/w1', { method: 'PATCH', body: { enabled: false } })).body.watch.enabled, false);
      assert.equal((await call('/api/watches/w1', { method: 'PATCH', body: { enabled: true } })).body.watch.enabled, true);
    },
    { seed: { defaults: {}, watches: [{ id: 'w1', ...base }] } },
  );
});
