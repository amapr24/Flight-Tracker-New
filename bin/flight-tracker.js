#!/usr/bin/env node
/**
 * flight-tracker CLI
 *
 * Run `flight-tracker help` for usage.
 */

import '../src/quiet.js'; // must precede any import of node:sqlite

import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';

import { loadConfig, loadEnv, ConfigError, PROJECT_ROOT, parseConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { WatchFile } from '../src/watch-file.js';
import { openDb } from '../src/db.js';
import { createNotifier, NotifyError } from '../src/notify.js';
import { checkAll, checkWatch, summariseLine } from '../src/runner.js';
import { startDaemon } from '../src/daemon.js';
import { searchFlights } from '../src/google-flights.js';
import { buildSearchUrl } from '../src/tfs.js';
import { describe as describeAirport } from '../src/airports.js';
import { c, money, sparkline, formatItinerary, relativeTime } from '../src/format.js';

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'no-notify': { type: 'boolean', default: false },
    limit: { type: 'string' },
    all: { type: 'boolean', default: false },
    port: { type: 'string' },
    'no-open': { type: 'boolean', default: false },
    'no-poll': { type: 'boolean', default: false },
    'keep-days': { type: 'string' },
    orphans: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const command = positionals[0] ?? 'help';

const HELP = `
${c.bold('flight-tracker')} — poll Google Flights on an interval, push price alerts to Pushover.

${c.bold('USAGE')}
  flight-tracker <command> [options]

${c.bold('COMMANDS')}
  ${c.cyan('serve')}                     Open the dashboard and poll in the background (start here)
  ${c.cyan('watch')}                     Run continuously, checking each watch on its interval
  ${c.cyan('check')} [watchId]           Run one poll now (all watches, or just one)
  ${c.cyan('search')} <FROM> <TO> <DATE> [RETURN]
                            One-off search with no config and no history
  ${c.cyan('list')}                      Show configured watches and their latest price
  ${c.cyan('history')} <watchId>         Price history with a sparkline
  ${c.cyan('test-notify')}               Send a test notification to confirm Pushover works
  ${c.cyan('import')} [file]             Load price history from NDJSON (for stateless CI runs)
  ${c.cyan('export')} [file]             Write price history to NDJSON
  ${c.cyan('site-data')} [file]          Write the JSON the published viewer reads
  ${c.cyan('prune')}                     Drop observations older than a year
  ${c.cyan('prune')} --orphans           Drop history for watches no longer in the config
  ${c.cyan('help')}                      This message

${c.bold('OPTIONS')}
  --config <path>           Config file (default: watches.json)
  --dry-run                 Print notifications instead of sending them
  --no-notify               Poll and record history, but never notify
  --all                     history: show every row rather than the last 30
  --limit <n>               history/search: cap rows shown
  --port <n>                serve: dashboard port (default 4127)
  --no-open                 serve: don't open a browser
  --no-poll                 serve: dashboard only, no background checking
  --keep-days <n>           export/prune: drop records older than n days
  --orphans                 prune: drop history for watches not in the config

${c.bold('EXAMPLES')}
  flight-tracker serve
  flight-tracker search SJU JFK 2026-08-15
  flight-tracker check --dry-run
  flight-tracker watch
`;

function resolveConfig() {
  return loadConfig(flags.config ?? process.env.FLIGHT_TRACKER_CONFIG);
}

/**
 * Missing Pushover credentials degrade to console output rather than stopping
 * the tool: history still accrues and the dashboard still works. The warning is
 * loud so nobody assumes pushes are going out when they aren't. `test-notify`
 * passes strict:true, since confirming real delivery is its entire purpose.
 */
function makeNotifier(config, { strict = false } = {}) {
  const options = { dryRun: flags['dry-run'], sounds: config?.defaults?.sounds ?? {} };
  if (strict) return createNotifier(options);

  try {
    return createNotifier(options);
  } catch (err) {
    if (!(err instanceof NotifyError)) throw err;
    console.error(
      c.yellow('\n  ⚠ Pushover is not configured — alerts will print here instead of your phone.\n') +
        c.gray('    Set PUSHOVER_USER_KEY and PUSHOVER_TOKEN in .env, then run `test-notify`.\n'),
    );
    return createNotifier({ ...options, dryRun: true });
  }
}

async function cmdCheck() {
  const config = resolveConfig();
  const store = openDb(config.databasePath);
  const notify = !flags['no-notify'];
  const notifier = notify ? makeNotifier(config) : { name: 'disabled', send: async () => {} };

  try {
    const targetId = positionals[1];
    if (targetId) {
      const watch = config.watches.find((w) => w.id === targetId);
      if (!watch) {
        console.error(c.red(`No watch with id "${targetId}". Known ids: ${config.watches.map((w) => w.id).join(', ')}`));
        process.exitCode = 1;
        return;
      }
      const result = await checkWatch({ watch, store, notifier, config, notify });
      console.log(summariseLine(result, watch));
      if (result.results?.length) printItineraries(result.results, config.defaults.currency, 8);
      if (result.url) console.log(c.gray(`\n  ${result.url}\n`));
      return;
    }

    const results = await checkAll({ config, store, notifier, notify });
    const failed = results.filter((r) => r.status !== 'ok').length;
    const pushed = results.filter((r) => r.notified).length;
    console.log(
      c.gray(`\n  ${results.length} checked · ${pushed} notification${pushed === 1 ? '' : 's'} sent${failed ? ` · ${failed} failed` : ''}\n`),
    );
    if (failed) process.exitCode = 1;
  } finally {
    store.close();
  }
}

async function cmdWatch() {
  const config = resolveConfig();
  const store = openDb(config.databasePath);
  const notify = !flags['no-notify'];
  const notifier = notify ? makeNotifier(config) : { name: 'disabled', send: async () => {} };

  const daemon = startDaemon({ config, store, notifier, notify });

  const shutdown = (signal) => {
    console.log(c.gray(`\n  ${signal} received — stopping after ${daemon.cycles} check(s).`));
    daemon.stop();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function cmdServe() {
  const configPath = flags.config ?? process.env.FLIGHT_TRACKER_CONFIG ?? join(PROJECT_ROOT, 'watches.json');
  const watchFile = new WatchFile(configPath);
  const initial = watchFile.config();

  const store = openDb(resolve(PROJECT_ROOT, initial.defaults.database));
  const notify = !flags['no-notify'];
  const notifier = notify ? makeNotifier(initial) : { name: 'disabled', send: async () => {} };

  // The dashboard and the poller share one process, so a route added in the UI
  // starts being checked immediately rather than after a manual restart.
  let daemon = null;
  const startPolling = (config) => {
    daemon?.stop();
    daemon = null;
    if (flags['no-poll']) return;
    if (!config.watches.some((w) => w.enabled)) return;
    daemon = startDaemon({ config, store, notifier, notify, log: (line) => console.log(line) });
  };

  const server = createServer({
    store,
    configPath,
    notifier,
    notify,
    onConfigChange: (config) => startPolling(config),
  });

  const port = Number(flags.port ?? process.env.FLIGHT_TRACKER_PORT ?? 4127);
  await new Promise((resolvePort, reject) => {
    server.once('error', reject);
    // Loopback only — this server edits config and makes outbound requests.
    server.listen(port, '127.0.0.1', resolvePort);
  });

  const url = `http://localhost:${port}`;
  console.log(c.bold(`\n✈  Flight Tracker dashboard`));
  console.log(`   ${c.cyan(url)}`);
  console.log(c.gray(`   config ${configPath}`));
  console.log(c.gray(`   notifier: ${notifier.name}${notify ? '' : ' (notifications disabled)'}`));
  if (initial.watches.length === 0) console.log(c.yellow('   no watches yet — add one in the dashboard'));
  console.log(c.gray('   Ctrl-C to stop\n'));

  startPolling(initial);

  if (!flags['no-open'] && process.platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  }

  const shutdown = () => {
    daemon?.stop();
    server.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdSearch() {
  const [, from, to, depart, ret] = positionals;
  if (!from || !to || !depart) {
    console.error(c.red('Usage: flight-tracker search <FROM> <TO> <YYYY-MM-DD> [RETURN]'));
    process.exitCode = 1;
    return;
  }

  // Reuse the real validator so an ad-hoc search fails the same way a watch would.
  const { watches, defaults } = parseConfig({
    watches: [{ id: 'adhoc', from, to, depart, return: ret ?? null }],
  });
  const watch = watches[0];

  const limit = Number(flags.limit ?? 15);
  console.log(c.gray(`\n  Searching ${watch.from} → ${watch.to} on ${watch.depart}${watch.return ? ` returning ${watch.return}` : ''}…`));

  const { results, priceLevel, url } = await searchFlights(watch, {
    currency: defaults.currency,
    language: defaults.language,
    region: defaults.region,
  });

  if (results.length === 0) {
    console.log(c.yellow('\n  No flights found for those dates.\n'));
    return;
  }

  console.log(
    c.bold(`\n  ${results.length} options · cheapest ${money(results[0].price, defaults.currency)}`) +
      (priceLevel ? c.gray(` · Google says prices are ${priceLevel}`) : ''),
  );
  printItineraries(results, defaults.currency, limit);
  console.log(c.gray(`\n  ${url}\n`));
}

function printItineraries(results, currency, limit) {
  console.log('');
  for (const r of results.slice(0, limit)) console.log(`  ${formatItinerary(r, currency)}`);
  if (results.length > limit) console.log(c.gray(`  … ${results.length - limit} more`));
}

async function cmdList() {
  const config = resolveConfig();
  const store = openDb(config.databasePath);
  try {
    console.log('');
    for (const w of config.watches) {
      const latest = store.latestObservation(w.id);
      const stats = store.stats(w.id);
      const status = w.enabled ? '' : c.gray(' [disabled]');
      console.log(`  ${c.cyan(w.id.padEnd(18))} ${c.bold(w.label)}${status}`);

      const bits = [`${w.from}→${w.to}`, w.depart];
      if (w.return) bits.push(`ret ${w.return}`);
      bits.push(`every ${w.intervalMinutes}m`);
      if (w.alert.targetPrice != null) bits.push(`target ${money(w.alert.targetPrice, config.defaults.currency)}`);
      console.log(c.gray(`    ${bits.join(' · ')}`));

      if (latest) {
        const trend = stats
          ? ` · low ${money(stats.low, latest.currency)} · avg ${money(stats.avg, latest.currency)} · ${stats.count} check${stats.count === 1 ? '' : 's'}`
          : '';
        console.log(
          `    ${c.bold(money(latest.price, latest.currency))} ${c.gray(relativeTime(latest.observedAt) + trend)}`,
        );
      } else {
        console.log(c.gray('    no data yet — run `flight-tracker check`'));
      }
      console.log('');
    }
  } finally {
    store.close();
  }
}

async function cmdHistory() {
  const config = resolveConfig();
  const store = openDb(config.databasePath);
  try {
    const watchId = positionals[1];
    if (!watchId) {
      console.error(c.red(`Usage: flight-tracker history <watchId>. Known: ${config.watches.map((w) => w.id).join(', ')}`));
      process.exitCode = 1;
      return;
    }

    const limit = flags.all ? 100_000 : Number(flags.limit ?? 30);
    const rows = store.history(watchId, { limit });
    if (rows.length === 0) {
      console.log(c.yellow(`\n  No history for "${watchId}" yet.\n`));
      return;
    }

    const watch = config.watches.find((w) => w.id === watchId);
    const stats = store.stats(watchId);
    // The chart covers the whole history even when the table below is truncated,
    // so the trend line always matches the summary stats beside it.
    const chronological = store.history(watchId, { limit: 500 }).reverse();

    console.log(c.bold(`\n  ${watch?.label ?? watchId}`));
    console.log(
      c.gray(
        `  low ${money(stats.low, rows[0].currency)} · avg ${money(stats.avg, rows[0].currency)} · high ${money(stats.high, rows[0].currency)} · ${stats.count} observations`,
      ),
    );
    console.log(`\n  ${c.cyan(sparkline(chronological.map((r) => r.price)))}\n`);

    for (const row of rows) {
      const isLow = row.price === stats.low;
      const price = money(row.price, row.currency).padStart(7);
      const best = row.best;
      const detail = best
        ? c.gray(`${best.stops === 0 ? 'nonstop' : `${best.stops} stop`} · ${best.airlines ?? ''}`)
        : '';
      console.log(
        `  ${c.gray(new Date(row.observedAt).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }))}  ${
          isLow ? c.green(price) : c.bold(price)
        } ${isLow ? c.green('◄ low') : '     '}  ${detail}`,
      );
    }
    console.log('');
  } finally {
    store.close();
  }
}

async function cmdTestNotify() {
  let config = null;
  try {
    config = resolveConfig();
  } catch {
    // A test push should work before any watches exist.
  }
  const notifier = makeNotifier(config, { strict: true });
  await notifier.send({
    title: '✈️ Flight tracker is connected',
    message:
      'If you can read this, price alerts will reach you.\n<i>Sent by flight-tracker test-notify</i>',
    priority: 0,
    url: 'https://www.google.com/travel/flights',
    urlTitle: 'Open Google Flights',
  });
  console.log(c.green(`\n  ✓ Test notification sent via ${notifier.name}.\n`));
}

const DEFAULT_HISTORY_FILE = 'data/history.ndjson';

/**
 * Rebuilds the database from the NDJSON committed to the repo. CI runners start
 * with an empty disk, so this is what gives a stateless run its memory of past
 * prices — without it every check would look like a brand-new all-time low.
 */
async function cmdImport() {
  const config = resolveConfig();
  const file = resolve(PROJECT_ROOT, positionals[1] ?? DEFAULT_HISTORY_FILE);
  const store = openDb(config.databasePath);

  try {
    if (!existsSync(file)) {
      console.log(c.gray(`\n  No history at ${file} — starting fresh.\n`));
      return;
    }

    const records = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line, i) => {
        try {
          return JSON.parse(line);
        } catch {
          throw new Error(`${file} line ${i + 1} is not valid JSON`);
        }
      });

    const { observations, alerts } = store.importRecords(records);
    console.log(
      c.gray(`\n  Imported ${observations} observation(s) and ${alerts} alert(s) from ${file}.\n`),
    );
  } finally {
    store.close();
  }
}

async function cmdExport() {
  const config = resolveConfig();
  const file = resolve(PROJECT_ROOT, positionals[1] ?? DEFAULT_HISTORY_FILE);
  const store = openDb(config.databasePath);

  try {
    if (flags['keep-days']) store.prune({ keepDays: Number(flags['keep-days']) });

    const records = store.exportRecords();
    mkdirSync(dirname(file), { recursive: true });
    // One record per line, append-ordered, so git stores each run as a small
    // delta rather than rewriting the whole blob.
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
    console.log(c.gray(`\n  Wrote ${records.length} record(s) to ${file}.\n`));
  } finally {
    store.close();
  }
}

/**
 * Emits everything the static viewer needs as one JSON file.
 *
 * The deep links are built here rather than in the browser so the published
 * page stays a pure renderer — no protobuf encoder, no API, nothing to break
 * when it is served from a CDN with no server behind it.
 */
async function cmdSiteData() {
  const config = resolveConfig();
  const file = resolve(PROJECT_ROOT, positionals[1] ?? 'site/data.json');
  const store = openDb(config.databasePath);

  try {
    const watches = config.watches.map((w) => {
      const series = store.history(w.id, { limit: 1000 }).reverse();
      const latest = series.at(-1) ?? null;
      const previous = series.length > 1 ? series.at(-2) : null;

      return {
        id: w.id,
        label: w.label,
        from: w.from,
        to: w.to,
        fromLabel: describeAirport(w.from),
        toLabel: describeAirport(w.to),
        depart: w.depart,
        return: w.return,
        enabled: w.enabled,
        nonstopOnly: w.maxStops === 'nonstop' || w.trackNonstopOnly,
        target: w.alert?.targetPrice ?? null,
        searchUrl: buildSearchUrl(w, { currency: config.defaults.currency }),
        latest: latest
          ? {
              price: latest.price,
              observedAt: latest.observedAt,
              priceLevel: latest.priceLevel,
              change: previous ? latest.price - previous.price : null,
              best: latest.best,
            }
          : null,
        stats: store.stats(w.id),
        series: series.map((s) => ({ t: s.observedAt, p: s.price })),
      };
    });

    const payload = {
      generatedAt: new Date().toISOString(),
      currency: config.defaults.currency,
      watches,
    };

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(payload)}\n`);
    console.log(
      c.gray(`\n  Wrote site data for ${watches.length} watch(es) to ${file}.\n`),
    );
  } finally {
    store.close();
  }
}

async function cmdPrune() {
  const config = resolveConfig();
  const store = openDb(config.databasePath);
  try {
    if (flags.orphans) {
      const ids = config.watches.map((w) => w.id);
      const { watches, observations, alerts } = store.pruneOrphans(ids);
      if (watches.length === 0) {
        console.log(c.gray('\n  No orphaned history — every record belongs to a configured watch.\n'));
      } else {
        console.log(
          c.gray(`\n  Removed ${observations} observation(s) and ${alerts} alert(s) for `) +
            watches.map((w) => c.yellow(w)).join(', ') +
            c.gray(' (no longer in the config).\n'),
        );
      }
      return;
    }

    const keepDays = Number(flags['keep-days'] ?? 365);
    const { observations, failures } = store.prune({ keepDays });
    console.log(
      c.gray(`\n  Removed ${observations} observation(s) and ${failures} failure(s) older than ${keepDays} days.\n`),
    );
  } finally {
    store.close();
  }
}

const COMMANDS = {
  serve: cmdServe,
  ui: cmdServe,
  check: cmdCheck,
  watch: cmdWatch,
  daemon: cmdWatch,
  search: cmdSearch,
  list: cmdList,
  history: cmdHistory,
  'test-notify': cmdTestNotify,
  import: cmdImport,
  export: cmdExport,
  'site-data': cmdSiteData,
  prune: cmdPrune,
  help: async () => console.log(HELP),
};

async function main() {
  loadEnv();

  if (flags.help || !COMMANDS[command]) {
    console.log(HELP);
    if (!COMMANDS[command]) {
      console.error(c.red(`Unknown command "${command}"`));
      process.exitCode = 1;
    }
    return;
  }

  // A first run with no config should say so kindly rather than throw. `serve`
  // is exempt: the dashboard is the nicest way to create that first watch.
  const needsConfig = !['help', 'search', 'test-notify', 'serve', 'ui'].includes(command);
  if (!flags.config && !existsSync(join(PROJECT_ROOT, 'watches.json')) && needsConfig) {
    console.error(
      c.yellow('\n  No watches.json found.\n') +
        c.gray('  Run the dashboard to add your first route:\n\n') +
        '    node bin/flight-tracker.js serve\n\n' +
        c.gray('  Or start from the example config:\n\n') +
        '    cp watches.example.json watches.json\n',
    );
    process.exitCode = 1;
    return;
  }

  await COMMANDS[command]();
}

main().catch((err) => {
  if (err instanceof ConfigError) console.error(c.red(`\n  Config error: ${err.message}\n`));
  else if (err instanceof NotifyError) console.error(c.red(`\n  Notification error: ${err.message}\n`));
  else console.error(c.red(`\n  ${err.stack ?? err.message}\n`));
  process.exitCode = 1;
});
