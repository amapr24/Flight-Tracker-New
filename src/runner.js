/**
 * One poll cycle: search → store → decide → notify.
 */

import { searchFlights } from './google-flights.js';
import { evaluate } from './rules.js';
import { alertTitle, alertBody, money, c, formatClock } from './format.js';

/** After this many consecutive failures a watch reports itself as broken. */
const FAILURE_ALERT_THRESHOLD = 3;
const FAILURE_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * @returns {Promise<{watchId:string, status:string, price?:number, decision?:object,
 *                    notified?:boolean, error?:string, url?:string, results?:object[]}>}
 */
export async function checkWatch({
  watch,
  store,
  notifier,
  config,
  notify = true,
  now = () => new Date(),
  search = searchFlights,
}) {
  const { currency, language, region } = config.defaults;

  let found;
  try {
    found = await search(watch, { currency, language, region });
  } catch (err) {
    store.recordFailure(watch.id, err.message);
    await maybeReportBreakage({ watch, store, notifier, notify, error: err.message });
    return { watchId: watch.id, status: 'error', error: err.message };
  }

  const { results, priceLevel, url } = found;

  // Do not rely on the search layer having sorted: pick the minimum outright.
  const cheapest = (rows) => rows.reduce((a, b) => (b.price < a.price ? b : a), rows[0]);

  const nonstopRows = results.filter((r) => r.stops === 0);
  const cheapestNonstop = nonstopRows.length ? cheapest(nonstopRows) : null;
  const tracked = watch.trackNonstopOnly ? cheapestNonstop : results.length ? cheapest(results) : null;

  if (!tracked) {
    const why = watch.trackNonstopOnly
      ? 'no nonstop flights returned'
      : 'no flights returned for these dates';
    store.recordFailure(watch.id, why);
    await maybeReportBreakage({ watch, store, notifier, notify, error: why });
    return { watchId: watch.id, status: 'no-results', error: why, url, results };
  }

  // Stats must be read before the new row lands, otherwise the current price
  // becomes its own all-time low and every poll looks like a record.
  const previous = store.previousObservation(watch.id);
  const stats = store.stats(watch.id);

  const current = {
    price: tracked.price,
    currency,
    nonstopPrice: cheapestNonstop?.price ?? null,
    priceLevel,
    resultsCount: results.length,
    best: tracked,
  };

  const decision = evaluate({
    watch,
    current,
    previous,
    stats,
    lastAlert: (reason) => store.lastAlert(watch.id, reason),
    now: now(),
    quietHours: config.defaults.quietHours,
  });

  store.recordObservation({
    watchId: watch.id,
    price: current.price,
    currency,
    nonstopPrice: current.nonstopPrice,
    priceLevel,
    resultsCount: results.length,
    best: tracked,
  });

  let notified = false;
  let notifyError = null;

  if (decision.notify && notify) {
    const title = alertTitle({ watch, decision, current });
    const message = alertBody({ watch, decision, current });
    try {
      await notifier.send({
        title,
        message,
        priority: decision.priority,
        url,
        urlTitle: 'Open in Google Flights',
        reason: decision.reason,
        timestamp: Date.now(),
      });
      store.recordAlert({
        watchId: watch.id,
        reason: decision.reason,
        price: current.price,
        prevPrice: decision.previousPrice,
        message: title,
      });
      notified = true;
    } catch (err) {
      notifyError = err.message;
    }
  }

  return {
    watchId: watch.id,
    status: 'ok',
    price: current.price,
    currency,
    decision,
    notified,
    notifyError,
    url,
    results,
    current,
  };
}

/**
 * Silence is the worst failure mode for a price tracker: a broken scraper looks
 * exactly like "no price changes". After a few consecutive failures we push a
 * low-priority heads-up so the silence is never ambiguous.
 */
async function maybeReportBreakage({ watch, store, notifier, notify, error }) {
  if (!notify) return;
  if (store.consecutiveFailures(watch.id) < FAILURE_ALERT_THRESHOLD) return;

  const last = store.lastAlert(watch.id, 'check-failing');
  if (last && Date.now() - Date.parse(last.sent_at) < FAILURE_ALERT_COOLDOWN_MS) return;

  try {
    await notifier.send({
      title: `⚠️ Checks failing · ${watch.label}`,
      message: `Flight tracker could not read prices for this route.\n<i>${error}</i>`,
      priority: -1,
      reason: 'check-failing',
    });
    store.recordAlert({ watchId: watch.id, reason: 'check-failing', price: 0, message: error });
  } catch {
    // If the notifier itself is down there is nothing useful left to do.
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs every enabled watch once, spacing requests out to stay polite. */
export async function checkAll({ config, store, notifier, notify = true, log = console.log, onResult }) {
  const watches = config.watches.filter((w) => w.enabled);
  const results = [];

  for (const [i, watch] of watches.entries()) {
    if (i > 0 && config.defaults.staggerSeconds) {
      await sleep(config.defaults.staggerSeconds * 1000);
    }
    const result = await checkWatch({ watch, store, notifier, config, notify });
    results.push(result);
    if (onResult) onResult(result, watch);
    else log(summariseLine(result, watch));
  }

  return results;
}

export function summariseLine(result, watch) {
  const time = c.gray(formatClock());
  const label = watch.label.slice(0, 34).padEnd(34);

  if (result.status !== 'ok') {
    return `${time} ${label} ${c.red('✗')} ${result.error}`;
  }

  const { decision } = result;
  const price = c.bold(money(result.price, result.currency).padStart(7));

  let delta = c.gray('  no change');
  if (decision.change != null && decision.change !== 0) {
    const sign = decision.change < 0 ? '▼' : '▲';
    const text = `${sign} ${money(Math.abs(decision.change), result.currency)}`;
    delta = decision.change < 0 ? c.green(text.padStart(11)) : c.red(text.padStart(11));
  } else if (decision.previousPrice == null) {
    delta = c.cyan('      first');
  }

  let tag = '';
  if (result.notified) tag = c.magenta(` → pushed (${decision.reason})`);
  else if (decision.notify && result.notifyError) tag = c.red(` → push failed: ${result.notifyError}`);
  else if (decision.suppressedBy) tag = c.gray(` → held: ${decision.suppressedBy}`);

  const best = result.current.best;
  const detail = c.gray(
    ` ${best.stops === 0 ? 'nonstop' : `${best.stops} stop`} · ${best.durationText} · ${best.airlines}`,
  );

  return `${time} ${label} ${price} ${delta}${detail}${tag}`;
}
