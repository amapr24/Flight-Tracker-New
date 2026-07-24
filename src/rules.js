/**
 * Alert decision engine.
 *
 * The point of this project is to beat Google's price emails, which arrive late
 * and fire on opaque criteria. Here every alert has a named, inspectable reason
 * and a de-duplication rule, so a route that oscillates by $3 all afternoon
 * stays silent while a genuine drop reaches the phone within one poll interval.
 */

/** Highest-value reason wins; the first match short-circuits. */
export const REASONS = ['target-hit', 'new-low', 'price-drop', 'price-rise', 'first-seen'];

export const DEFAULT_ALERT = {
  targetPrice: null,
  dropPercent: 8,
  dropAmount: 25,
  notifyOnNewLow: true,
  notifyOnRise: false,
  risePercent: 20,
  notifyOnFirstSeen: true,
  cooldownMinutes: 180,
};

/**
 * Pushover priorities: -2 silent, -1 quiet (no sound), 0 normal, 1 high
 * (bypasses the user's quiet hours), 2 emergency (requires acknowledgement).
 * Nothing here ever emits 2 — a cheap flight is not an emergency.
 */
const BASE_PRIORITY = {
  'target-hit': 1,
  'new-low': 0,
  'price-drop': 0,
  'price-rise': -1,
  'first-seen': -1,
};

export function inQuietHours(now, quietHours) {
  if (!quietHours?.start || !quietHours?.end) return false;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: quietHours.timezone ?? 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);

  const hour = Number(parts.find((p) => p.type === 'hour').value);
  const minute = Number(parts.find((p) => p.type === 'minute').value);
  const nowMins = hour * 60 + minute;

  const toMins = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const start = toMins(quietHours.start);
  const end = toMins(quietHours.end);

  // A window like 23:00–07:00 wraps past midnight, so the test inverts.
  return start <= end ? nowMins >= start && nowMins < end : nowMins >= start || nowMins < end;
}

const pct = (from, to) => (from === 0 ? 0 : ((to - from) / from) * 100);

function materiallyBetter(price, reference, { dropAmount, dropPercent }) {
  if (reference == null) return true;
  return price <= reference - dropAmount || price <= reference * (1 - dropPercent / 100);
}

/**
 * Decides whether a freshly observed price is worth a push.
 *
 * @param {object} args
 * @param {object} args.watch          normalised watch config
 * @param {object} args.current        {price, nonstopPrice, priceLevel, best, currency}
 * @param {object|null} args.previous  the prior observation, if any
 * @param {object|null} args.stats     history stats EXCLUDING `current`
 * @param {(reason:string)=>object|null} args.lastAlert lookup of prior alerts
 * @param {Date} [args.now]
 * @param {object|null} [args.quietHours]
 * @returns {{notify:boolean, reason:string|null, priority:number, suppressedBy?:string,
 *            change:number|null, changePercent:number|null, isNewLow:boolean,
 *            underTarget:boolean, quiet:boolean}}
 */
export function evaluate({ watch, current, previous, stats, lastAlert, now = new Date(), quietHours = null }) {
  const alert = { ...DEFAULT_ALERT, ...(watch.alert ?? {}) };
  const price = current.price;

  const change = previous ? price - previous.price : null;
  const changePercent = previous ? pct(previous.price, price) : null;
  const isNewLow = Boolean(stats && stats.count > 0 && price < stats.low);
  const underTarget = alert.targetPrice != null && price <= alert.targetPrice;

  const base = {
    change,
    changePercent,
    isNewLow,
    underTarget,
    previousPrice: previous?.price ?? null,
    allTimeLow: stats?.low ?? null,
    alertConfig: alert,
  };

  const reason = pickReason({ alert, price, previous, isNewLow, underTarget, change, changePercent });
  if (!reason) {
    return { ...base, notify: false, reason: null, priority: 0, quiet: false };
  }

  // De-duplication: within the cooldown window, only a materially better price
  // for the same reason is allowed through.
  const prior = lastAlert(reason);
  if (prior) {
    const elapsedMs = now.getTime() - Date.parse(prior.sent_at);
    const inCooldown = elapsedMs < alert.cooldownMinutes * 60_000;
    if (inCooldown && !materiallyBetter(price, prior.price, alert)) {
      return {
        ...base,
        notify: false,
        reason,
        priority: 0,
        quiet: false,
        suppressedBy: `cooldown (${Math.round(elapsedMs / 60_000)}m of ${alert.cooldownMinutes}m)`,
      };
    }
  }

  // A record low that also clears the target needs no special case here: it is
  // reported as 'target-hit', which already carries the high-priority slot.
  let priority = BASE_PRIORITY[reason];

  const quiet = inQuietHours(now, quietHours);
  if (quiet) {
    const allowUrgent = quietHours?.allowUrgent ?? true;
    priority = allowUrgent && priority >= 1 ? priority : Math.min(priority, -1);
  }

  return { ...base, notify: true, reason, priority, quiet };
}

function pickReason({ alert, price, previous, isNewLow, underTarget, change, changePercent }) {
  if (underTarget) {
    // Only fire on the crossing, or on a further improvement while under.
    if (!previous || previous.price > alert.targetPrice || price < previous.price) return 'target-hit';
  }
  if (alert.notifyOnNewLow && isNewLow) return 'new-low';

  if (previous && change < 0) {
    const dropped =
      Math.abs(change) >= alert.dropAmount || Math.abs(changePercent) >= alert.dropPercent;
    if (dropped) return 'price-drop';
  }
  if (alert.notifyOnRise && previous && changePercent >= alert.risePercent) return 'price-rise';

  if (!previous && alert.notifyOnFirstSeen) return 'first-seen';

  return null;
}
