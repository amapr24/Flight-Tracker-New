/**
 * The long-running scheduler.
 *
 * Each watch keeps its own timer so a route you care about can poll every 15
 * minutes while a speculative one checks hourly. Jitter is applied to every
 * interval: perfectly periodic requests are the easiest thing in the world for
 * a rate limiter to spot, and a few seconds of drift costs nothing.
 */

import { checkWatch, summariseLine } from './runner.js';
import { c, formatClock } from './format.js';

export function startDaemon({
  config,
  store,
  notifier,
  notify = true,
  log = console.log,
  runImmediately = true,
  search, // injectable for tests; defaults to the real Google Flights fetch
}) {
  const timers = new Map();
  let stopped = false;
  let cycles = 0;

  const watches = config.watches.filter((w) => w.enabled);
  if (watches.length === 0) throw new Error('No enabled watches to run');

  const jitterMs = () => Math.round((Math.random() * 2 - 1) * (config.defaults.jitterSeconds ?? 0) * 1000);

  async function runOne(watch) {
    if (stopped) return;
    try {
      const result = await checkWatch({ watch, store, notifier, config, notify, ...(search ? { search } : {}) });
      cycles++;
      log(summariseLine(result, watch));
    } catch (err) {
      // A scheduler that dies on an unexpected error is worse than a noisy one.
      log(`${c.gray(formatClock())} ${c.red('✗')} ${watch.id}: ${err.message}`);
    } finally {
      if (!stopped) schedule(watch, watch.intervalMinutes * 60_000 + jitterMs());
    }
  }

  function schedule(watch, delayMs) {
    // Deliberately not unref'd: these timers are what keep the daemon alive.
    timers.set(watch.id, setTimeout(() => runOne(watch), Math.max(0, delayMs)));
  }

  log(
    c.bold(`\n✈  Flight tracker running · ${watches.length} watch${watches.length === 1 ? '' : 'es'}`),
  );
  for (const w of watches) {
    log(`   ${c.cyan(w.id.padEnd(18))} ${w.label} ${c.gray(`every ${w.intervalMinutes}m`)}`);
  }
  if (config.defaults.quietHours) {
    const q = config.defaults.quietHours;
    log(c.gray(`   quiet hours ${q.start}–${q.end} ${q.timezone}${q.allowUrgent ? ' (urgent still alerts)' : ''}`));
  }
  log(c.gray(`   notifier: ${notifier.name}${notify ? '' : ' (notifications disabled)'}`));
  log(c.gray('   Ctrl-C to stop\n'));

  // Stagger the first run so we do not fire every watch in the same instant.
  watches.forEach((watch, i) => {
    const initial = runImmediately ? i * (config.defaults.staggerSeconds ?? 8) * 1000 : watch.intervalMinutes * 60_000;
    schedule(watch, Math.max(0, initial) + 1);
  });

  const pruneTimer = setInterval(() => store.prune({ keepDays: 365 }), 24 * 60 * 60 * 1000);
  pruneTimer.unref?.();

  return {
    get cycles() {
      return cycles;
    },
    stop() {
      stopped = true;
      for (const t of timers.values()) clearTimeout(t);
      clearInterval(pruneTimer);
      timers.clear();
    },
  };
}
