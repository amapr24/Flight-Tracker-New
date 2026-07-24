/**
 * Silences node's "SQLite is an experimental feature" notice.
 *
 * Must be imported before anything that pulls in `node:sqlite` — ES modules are
 * evaluated in source order, so this import belongs first in the entry point.
 * Every other warning is left alone.
 */

const original = process.emitWarning;

process.emitWarning = function emitWarning(warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning' && /SQLite/i.test(String(warning))) return;
  return original.call(process, warning, ...rest);
};
