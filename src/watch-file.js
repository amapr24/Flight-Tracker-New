/**
 * Read/write access to watches.json for the web UI.
 *
 * Every mutation validates the *whole* document through parseConfig before it
 * touches disk, and writes via a temp file + rename. A half-written or invalid
 * config would take the daemon down on its next restart, so the file on disk is
 * only ever replaced by something already proven to load.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';

import { parseConfig, ConfigError } from './config.js';

export class WatchFile {
  #path;

  constructor(path) {
    this.#path = path;
  }

  get path() {
    return this.#path;
  }

  /** The raw document, preserving any keys the UI does not manage. */
  read() {
    // A missing file is the fresh-install case, not an error: the UI renders an
    // empty board and writes the file when the first watch is saved.
    if (!existsSync(this.#path)) return { defaults: {}, watches: [] };
    try {
      return JSON.parse(readFileSync(this.#path, 'utf8'));
    } catch (err) {
      throw new ConfigError(`${this.#path} is not valid JSON: ${err.message}`);
    }
  }

  /** The validated, normalised config. */
  config() {
    const config = parseConfig(this.read(), { allowEmpty: true });
    config.path = this.#path;
    return config;
  }

  #commit(raw) {
    // Throws before anything is written if the edit produced an invalid config.
    const config = parseConfig(raw, { allowEmpty: true });

    const tmp = `${this.#path}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
      renameSync(tmp, this.#path);
    } catch (err) {
      if (existsSync(tmp)) unlinkSync(tmp);
      throw err;
    }
    return config;
  }

  add(input) {
    const raw = this.read();
    raw.watches ??= [];

    const id = input.id?.trim() || uniqueId(input, raw.watches.map((w) => w.id));
    if (raw.watches.some((w) => w.id === id)) {
      throw new ConfigError(`a watch with id "${id}" already exists`);
    }

    raw.watches.push(pruneEmpty({ ...input, id }));
    const config = this.#commit(raw);
    return { config, watch: config.watches.find((w) => w.id === id) };
  }

  update(id, patch) {
    const raw = this.read();
    const index = (raw.watches ?? []).findIndex((w) => w.id === id);
    if (index === -1) throw new ConfigError(`no watch with id "${id}"`);

    // `alert` merges rather than replaces so the UI can send a single field.
    const existing = raw.watches[index];
    const merged = {
      ...existing,
      ...patch,
      ...(patch.alert ? { alert: { ...(existing.alert ?? {}), ...patch.alert } } : {}),
      id: existing.id,
    };

    raw.watches[index] = pruneEmpty(merged);
    const config = this.#commit(raw);
    return { config, watch: config.watches.find((w) => w.id === id) };
  }

  remove(id) {
    const raw = this.read();
    const before = (raw.watches ?? []).length;
    raw.watches = (raw.watches ?? []).filter((w) => w.id !== id);
    if (raw.watches.length === before) throw new ConfigError(`no watch with id "${id}"`);
    return { config: this.#commit(raw) };
  }
}

/** Drops nulls and empty strings so the saved file stays readable by hand. */
function pruneEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    if (k === 'alert' && typeof v === 'object') {
      const alert = pruneEmpty(v);
      if (Object.keys(alert).length) out.alert = alert;
      continue;
    }
    out[k] = v;
  }
  return out;
}

function uniqueId({ from, to, depart }, taken) {
  const base = `${from}-${to}-${depart}`.toLowerCase();
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
