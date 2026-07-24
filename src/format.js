/**
 * Presentation: notification copy and terminal output.
 *
 * Notification bodies are built for a lock screen — the price, the delta, and
 * enough of the itinerary to judge it without opening anything.
 */

const SUPPORTS_COLOR =
  process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';

const wrap = (code) => (s) => (SUPPORTS_COLOR ? `[${code}m${s}[0m` : String(s));

export const c = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
  gray: wrap(90),
};

const CURRENCY_SYMBOL = { USD: '$', EUR: '€', GBP: '£', CAD: 'C$', AUD: 'A$', MXN: 'MX$', JPY: '¥' };

export function money(amount, currency = 'USD') {
  const symbol = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  return `${symbol}${Math.round(amount).toLocaleString('en-US')}`;
}

const REASON_STYLE = {
  'target-hit': { icon: '🎯', label: 'Target price hit' },
  'new-low': { icon: '📉', label: 'New all-time low' },
  'price-drop': { icon: '⬇️', label: 'Price drop' },
  'price-rise': { icon: '⬆️', label: 'Price increase' },
  'first-seen': { icon: '👀', label: 'Now tracking' },
};

export function alertTitle({ watch, decision, current }) {
  const style = REASON_STYLE[decision.reason] ?? { icon: '✈️' };
  const price = money(current.price, current.currency);

  if (decision.reason === 'price-drop' || decision.reason === 'price-rise') {
    const delta = `${decision.change > 0 ? '+' : '−'}${money(Math.abs(decision.change), current.currency)}`;
    return `${style.icon} ${price} (${delta}) · ${watch.label}`;
  }
  if (decision.reason === 'new-low') return `${style.icon} New low ${price} · ${watch.label}`;
  if (decision.reason === 'target-hit') return `${style.icon} ${price} · ${watch.label}`;
  return `${style.icon} ${price} · ${watch.label}`;
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Pushover supports a small HTML subset: <b> <i> <u> <font> <a>. */
export function alertBody({ watch, decision, current }) {
  const lines = [];
  const cur = current.currency;
  const best = current.best;

  const headline = [`<b>${escapeHtml(money(current.price, cur))}</b>`];
  if (decision.previousPrice != null && decision.change !== 0) {
    const dir = decision.change < 0 ? 'was' : 'up from';
    headline.push(
      `${dir} ${escapeHtml(money(decision.previousPrice, cur))} (${decision.change < 0 ? '−' : '+'}${escapeHtml(
        money(Math.abs(decision.change), cur),
      )}, ${decision.changePercent < 0 ? '−' : '+'}${Math.abs(decision.changePercent).toFixed(0)}%)`,
    );
  }
  lines.push(headline.join(' '));

  if (best) {
    const stops = best.stops === 0 ? 'nonstop' : `${best.stops} stop${best.stops === 1 ? '' : 's'}`;
    lines.push(escapeHtml([best.airlines, stops, best.durationText].filter(Boolean).join(' · ')));
    if (best.departTime && best.arriveTime) {
      const times = `${best.departTime} → ${best.arriveTime}`;
      const overnight = best.arriveDay && best.departDay && best.arriveDay !== best.departDay ? ' (+1)' : '';
      lines.push(
        escapeHtml([`${times}${overnight}`, best.flightNumbers?.join(', ')].filter(Boolean).join(' · ')),
      );
    }
  }

  const context = [];
  if (decision.allTimeLow != null) {
    context.push(
      decision.isNewLow
        ? `previous low ${money(decision.allTimeLow, cur)}`
        : `all-time low ${money(decision.allTimeLow, cur)}`,
    );
  }
  if (watch.alert?.targetPrice != null) {
    context.push(`target ${money(watch.alert.targetPrice, cur)}`);
  }
  if (current.priceLevel) context.push(`Google: prices ${current.priceLevel}`);
  if (context.length) lines.push(`<i>${escapeHtml(context.join(' · '))}</i>`);

  const route = `${watch.from} → ${watch.to} · ${watch.depart}${watch.return ? ` – ${watch.return}` : ''}`;
  lines.push(
    `<font color="#888888">${escapeHtml(route)} · ${current.resultsCount} option${
      current.resultsCount === 1 ? '' : 's'
    }</font>`,
  );

  return lines.join('\n');
}

const BLOCKS = '▁▂▃▄▅▆▇█';

export function sparkline(values) {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return BLOCKS[3].repeat(values.length);
  return values
    .map((v) => BLOCKS[Math.round(((v - min) / (max - min)) * (BLOCKS.length - 1))])
    .join('');
}

export function formatItinerary(r, currency = 'USD') {
  const stops = r.stops === 0 ? 'nonstop' : `${r.stops} stop${r.stops === 1 ? '' : 's'}`;
  const overnight = r.arriveDay && r.departDay && r.arriveDay !== r.departDay ? '+1' : '  ';
  return [
    c.bold(money(r.price, currency).padStart(7)),
    (r.departTime ?? '').padStart(8),
    '→',
    `${(r.arriveTime ?? '').padEnd(8)}${c.dim(overnight)}`,
    c.dim((r.durationText ?? '').padEnd(11)),
    stops === 'nonstop' ? c.green(stops.padEnd(7)) : c.yellow(stops.padEnd(7)),
    (r.airlines ?? '').slice(0, 22).padEnd(22),
    c.gray(r.flightNumbers?.join(', ') ?? ''),
  ].join(' ');
}

export function relativeTime(iso) {
  const diff = Date.now() - Date.parse(iso);
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function formatClock(date = new Date()) {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}
