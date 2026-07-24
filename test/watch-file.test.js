import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WatchFile } from '../src/watch-file.js';
import { ConfigError } from '../src/config.js';

const base = { from: 'SJU', to: 'JFK', depart: '2026-08-15' };

function tempFile(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'ft-'));
  const path = join(dir, 'watches.json');
  if (contents) writeFileSync(path, JSON.stringify(contents, null, 2));
  return path;
}

test('a missing file reads as an empty config rather than throwing', () => {
  const file = new WatchFile(tempFile());
  assert.deepEqual(file.read(), { defaults: {}, watches: [] });
  assert.deepEqual(file.config().watches, []);
});

test('adding to a missing file creates it', () => {
  const path = tempFile();
  const file = new WatchFile(path);
  const { watch } = file.add(base);

  assert.ok(existsSync(path));
  assert.equal(watch.from, 'SJU');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).watches.length, 1);
});

test('ids are derived from the route and stay unique', () => {
  const file = new WatchFile(tempFile());
  assert.equal(file.add(base).watch.id, 'sju-jfk-2026-08-15');
  assert.equal(file.add(base).watch.id, 'sju-jfk-2026-08-15-2');
  assert.equal(file.add(base).watch.id, 'sju-jfk-2026-08-15-3');
});

test('an explicit duplicate id is rejected', () => {
  const file = new WatchFile(tempFile());
  file.add({ ...base, id: 'mine' });
  assert.throws(() => file.add({ ...base, id: 'mine' }), /already exists/);
});

test('an invalid watch is rejected and never reaches disk', () => {
  const path = tempFile({ defaults: {}, watches: [{ id: 'keep', ...base }] });
  const file = new WatchFile(path);
  const before = readFileSync(path, 'utf8');

  assert.throws(() => file.add({ from: 'NOPE', to: 'JFK', depart: '2026-08-15' }), ConfigError);
  assert.equal(readFileSync(path, 'utf8'), before, 'the file is byte-identical after a rejected add');
});

test('a failed write leaves no temp file behind', () => {
  const path = tempFile();
  const file = new WatchFile(path);
  assert.throws(() => file.add({ ...base, depart: '2026-02-31' }), ConfigError);

  const strays = readdirSync(join(path, '..')).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(strays, []);
});

test('update patches a single field without disturbing the rest', () => {
  const file = new WatchFile(tempFile());
  const { watch } = file.add({ ...base, intervalMinutes: 30, alert: { targetPrice: 200 } });

  const updated = file.update(watch.id, { enabled: false }).watch;
  assert.equal(updated.enabled, false);
  assert.equal(updated.intervalMinutes, 30, 'other fields survive');
  assert.equal(updated.alert.targetPrice, 200);
});

test('an alert patch merges rather than replacing the block', () => {
  const file = new WatchFile(tempFile());
  const { watch } = file.add({ ...base, alert: { targetPrice: 200, dropAmount: 40 } });

  const updated = file.update(watch.id, { alert: { targetPrice: 150 } }).watch;
  assert.equal(updated.alert.targetPrice, 150);
  assert.equal(updated.alert.dropAmount, 40, 'untouched alert fields are preserved');
});

test('the id cannot be changed by an update', () => {
  const file = new WatchFile(tempFile());
  const { watch } = file.add(base);
  const updated = file.update(watch.id, { id: 'something-else' }).watch;
  assert.equal(updated.id, watch.id, 'history is keyed to the id, so it is immutable here');
});

test('updating or removing an unknown id fails cleanly', () => {
  const file = new WatchFile(tempFile());
  file.add(base);
  assert.throws(() => file.update('ghost', { enabled: false }), /no watch with id/);
  assert.throws(() => file.remove('ghost'), /no watch with id/);
});

test('remove deletes only the named watch', () => {
  const file = new WatchFile(tempFile());
  const a = file.add(base).watch;
  file.add({ ...base, depart: '2026-09-01' });

  const { config } = file.remove(a.id);
  assert.equal(config.watches.length, 1);
  assert.equal(config.watches[0].depart, '2026-09-01');
});

test('removing the final watch is allowed and leaves a valid empty config', () => {
  const file = new WatchFile(tempFile());
  const { watch } = file.add(base);
  const { config } = file.remove(watch.id);
  assert.deepEqual(config.watches, []);
  assert.deepEqual(file.config().watches, []);
});

test('user-set defaults survive an edit', () => {
  const path = tempFile({
    defaults: { intervalMinutes: 45, currency: 'EUR' },
    watches: [{ id: 'a', ...base }],
  });
  const file = new WatchFile(path);
  file.add({ ...base, depart: '2026-09-09' });

  const raw = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(raw.defaults.intervalMinutes, 45);
  assert.equal(raw.defaults.currency, 'EUR');
});

test('malformed JSON is reported, not swallowed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ft-'));
  const path = join(dir, 'watches.json');
  writeFileSync(path, '{ not json');
  assert.throws(() => new WatchFile(path).read(), /not valid JSON/);
});

test('empty values are pruned so the saved file stays readable', () => {
  const path = tempFile();
  new WatchFile(path).add({ ...base, label: '', return: null, alert: { targetPrice: 200 } });

  const saved = JSON.parse(readFileSync(path, 'utf8')).watches[0];
  assert.ok(!('label' in saved), 'blank label is not written');
  assert.ok(!('return' in saved), 'null return is not written');
  assert.equal(saved.alert.targetPrice, 200);
});
