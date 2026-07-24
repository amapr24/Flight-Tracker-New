/* Flight Tracker dashboard — no framework, no build step. */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const { dataset, style, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  // `dataset` and `style` are read-only accessors — assigning to them throws in
  // strict mode, so their keys have to be copied across individually.
  if (dataset) Object.assign(node.dataset, dataset);
  if (style) Object.assign(node.style, style);
  for (const kid of kids.flat()) if (kid != null) node.append(kid);
  return node;
};

const state = { watches: [], defaults: {}, open: new Set(), preview: null, busy: false };

/* ── API ──────────────────────────────────────────────────────── */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error ?? `Request failed (${res.status})`);
  return payload;
}

/* ── Formatting ───────────────────────────────────────────────── */

const money = (n, currency = 'USD') =>
  n == null
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        maximumFractionDigits: 0,
      }).format(n);

function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });
}

function ago(iso) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

const stopsLabel = (n) => (n === 0 ? 'Nonstop' : n === 1 ? '1 stop' : `${n} stops`);

/* ── Toast ────────────────────────────────────────────────────── */

let toastTimer;
function toast(message, kind = 'info') {
  const node = $('#toast');
  node.textContent = message;
  node.dataset.kind = kind;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 5200);
}

function setStatus(text, stateName) {
  const node = $('#status');
  node.dataset.state = stateName;
  $('.status__text', node).textContent = text;
}

/* ── Charts ───────────────────────────────────────────────────── */

const svg = (name, attrs = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

/** Compact trend line for a board row. */
function sparkline(series) {
  const node = svg('svg', { class: 'spark', viewBox: '0 0 100 34', preserveAspectRatio: 'none' });
  if (series.length < 2) {
    node.append(svg('line', { x1: 0, y1: 17, x2: 100, y2: 17, stroke: 'var(--muted-2)', 'stroke-dasharray': '2 3' }));
    return node;
  }

  const prices = series.map((s) => s.p);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  const x = (i) => (i / (prices.length - 1)) * 100;
  const y = (p) => 30 - ((p - min) / span) * 26;

  const d = prices.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)} ${y(p).toFixed(2)}`).join(' ');
  const falling = prices.at(-1) <= prices[0];

  node.append(
    svg('path', { d: `${d} L100 34 L0 34 Z`, fill: falling ? 'var(--green-soft)' : 'var(--red-soft)' }),
    svg('path', { d, stroke: falling ? 'var(--green)' : 'var(--red)', 'stroke-width': 1.5, fill: 'none' }),
    svg('circle', { cx: x(prices.length - 1), cy: y(prices.at(-1)), r: 2, fill: falling ? 'var(--green)' : 'var(--red)' }),
  );
  return node;
}

/** Full price history chart for the expanded detail view. */
function priceChart(series, currency) {
  const W = 520;
  const H = 170;
  const pad = { l: 46, r: 12, t: 14, b: 24 };
  // Uniform scaling only — stretching this viewBox would distort the labels.
  const node = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}` });

  if (series.length < 2) {
    node.append(
      svg('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'lbl' }),
    );
    node.lastChild.textContent = 'Not enough history yet — check back after a few polls.';
    return node;
  }

  const prices = series.map((s) => s.p);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || Math.max(1, max * 0.1);
  const lo = min - span * 0.12;
  const hi = max + span * 0.12;

  const x = (i) => pad.l + (i / (prices.length - 1)) * (W - pad.l - pad.r);
  const y = (p) => pad.t + (1 - (p - lo) / (hi - lo)) * (H - pad.t - pad.b);

  const defs = svg('defs');
  const grad = svg('linearGradient', { id: 'fade', x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(
    svg('stop', { offset: '0%', 'stop-color': 'var(--amber)', 'stop-opacity': 0.24 }),
    svg('stop', { offset: '100%', 'stop-color': 'var(--amber)', 'stop-opacity': 0 }),
  );
  defs.append(grad);
  node.append(defs);

  // Horizontal guides at min / mid / max.
  for (const p of [min, (min + max) / 2, max]) {
    node.append(svg('line', { class: 'axis', x1: pad.l, y1: y(p), x2: W - pad.r, y2: y(p) }));
    const label = svg('text', { class: 'lbl', x: pad.l - 8, y: y(p) + 3, 'text-anchor': 'end' });
    label.textContent = money(Math.round(p), currency);
    node.append(label);
  }

  const d = prices.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p).toFixed(1)}`).join(' ');
  node.append(
    svg('path', { class: 'area', d: `${d} L${x(prices.length - 1)} ${H - pad.b} L${pad.l} ${H - pad.b} Z` }),
    svg('path', { class: 'line', d }),
  );

  const lowIndex = prices.indexOf(min);
  node.append(svg('circle', { class: 'lowdot', cx: x(lowIndex), cy: y(min), r: 3.4 }));

  for (const [i, anchor] of [[0, 'start'], [prices.length - 1, 'end']]) {
    const t = svg('text', { class: 'lbl', x: x(i), y: H - 7, 'text-anchor': anchor });
    t.textContent = new Date(series[i].t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    node.append(t);
  }
  return node;
}

/* ── Board ────────────────────────────────────────────────────── */

const lastPrice = new Map();

function render() {
  const body = $('#board-body');
  body.replaceChildren();

  if (state.watches.length === 0) {
    body.append(
      el('div', { className: 'empty' },
        el('strong', {}, 'No routes tracked yet'),
        el('p', {}, 'Add one above and it will be checked on your chosen interval.'),
      ),
    );
    $('#footnote').textContent = '';
    return;
  }

  state.watches.forEach((w, i) => body.append(row(w, i)));

  const total = state.watches.filter((w) => w.enabled).length;
  $('#footnote').textContent = `${total} active · config at ${state.configPath}`;
}

function row(w, index) {
  const wrap = el('div', { className: `row${w.enabled ? '' : ' is-paused'}` });
  wrap.style.animationDelay = `${Math.min(index * 45, 340)}ms`;

  const price = w.latest?.price ?? null;
  const currency = w.latest?.currency ?? 'USD';
  const change = w.latest?.change ?? null;

  const priceNode = price == null
    ? el('div', { className: 'price price--none' }, 'awaiting first check')
    : el('div', { className: 'price' }, money(price, currency));

  // Flip only when the number actually moved since the last render.
  if (price != null && lastPrice.has(w.id) && lastPrice.get(w.id) !== price) {
    priceNode.classList.add('is-flipping');
  }
  if (price != null) lastPrice.set(w.id, price);

  const dir = change == null ? 'flat' : change < 0 ? 'down' : change > 0 ? 'up' : 'flat';
  const deltaText =
    change == null || change === 0
      ? w.latest ? `updated ${ago(w.latest.observedAt)}` : ''
      : `${change < 0 ? '▼' : '▲'} ${money(Math.abs(change), currency)}`;

  const main = el('div', { className: 'row__main' },
    el('div', {},
      el('div', { className: 'route-codes' }, w.from, el('i', {}, '——✈——'), w.to),
      el('div', { className: 'route-sub' }, `${w.fromLabel} → ${w.toLabel}`),
    ),
    el('div', { className: 'dates' },
      shortDate(w.depart),
      el('small', {}, w.return ? `returns ${shortDate(w.return)}` : 'one way'),
    ),
    el('div', { className: 'price-cell' },
      priceNode,
      el('div', { className: 'delta', dataset: { dir } }, deltaText),
    ),
    el('div', { className: 'spark-cell' }, sparkline(w.series)),
    actions(w),
  );

  // Clicks on the action buttons must not also toggle the drawer.
  main.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    state.open.has(w.id) ? state.open.delete(w.id) : state.open.add(w.id);
    render();
  });

  wrap.append(main);
  if (state.open.has(w.id)) wrap.append(detail(w));
  return wrap;
}

function actions(w) {
  const check = el('button', { className: 'btn btn--icon', type: 'button', title: 'Check this route now' }, 'CHECK');
  check.addEventListener('click', async () => {
    check.disabled = true;
    check.textContent = '…';
    setStatus('Checking', 'busy');
    try {
      const res = await api(`/api/watches/${encodeURIComponent(w.id)}/check`, { method: 'POST' });
      if (res.status === 'ok') {
        toast(
          `${w.from} → ${w.to}: ${money(res.watch.latest.price, res.watch.latest.currency)}${
            res.notified ? ` · pushed (${res.reason})` : ''
          }`,
          'good',
        );
      } else {
        toast(`${w.from} → ${w.to}: ${res.error}`, 'error');
      }
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      check.disabled = false;
      check.textContent = 'CHECK';
      setStatus('Live', 'ok');
    }
  });

  const pause = el('button', { className: 'btn btn--icon', type: 'button' }, w.enabled ? 'PAUSE' : 'RESUME');
  pause.addEventListener('click', async () => {
    try {
      await api(`/api/watches/${encodeURIComponent(w.id)}`, {
        method: 'PATCH',
        body: { enabled: !w.enabled },
      });
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  const remove = el('button', { className: 'btn btn--icon btn--danger', type: 'button' }, 'DELETE');
  remove.addEventListener('click', async () => {
    if (!confirm(`Stop tracking ${w.from} → ${w.to} on ${w.depart}?\n\nIts price history will be kept.`)) return;
    try {
      await api(`/api/watches/${encodeURIComponent(w.id)}`, { method: 'DELETE' });
      state.open.delete(w.id);
      toast('Watch removed', 'info');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  return el('div', { className: 'row__actions' }, check, pause, remove);
}

function detail(w) {
  const currency = w.latest?.currency ?? 'USD';
  const best = w.latest?.best;

  const stats = el('dl', { className: 'stats' },
    el('div', { className: 'stat' }, el('dt', {}, 'All-time low'),
      el('dd', { className: 'is-low' }, money(w.stats?.low, currency))),
    el('div', { className: 'stat' }, el('dt', {}, 'Average'), el('dd', {}, money(w.stats?.avg, currency))),
    el('div', { className: 'stat' }, el('dt', {}, 'Checks'), el('dd', {}, String(w.stats?.count ?? 0))),
  );

  const facts = el('ul', { className: 'kv' },
    row2('Target price', w.alert?.targetPrice != null ? money(w.alert.targetPrice, currency) : 'not set'),
    row2('Alert on drop', `${w.alert?.dropPercent ?? 8}% or ${money(w.alert?.dropAmount ?? 25, currency)}`),
    row2('Interval', `every ${w.intervalMinutes} min`),
    row2('Cabin', `${w.seat.replace('-', ' ')} · ${w.adults} adult${w.adults === 1 ? '' : 's'}`),
    row2('Stops', w.maxStops == null ? 'any' : w.maxStops === 'nonstop' ? 'nonstop only' : `${w.maxStops} or fewer`),
    best ? row2('Current best', `${best.airlines} · ${stopsLabel(best.stops)} · ${best.durationText}`) : null,
    best?.departTime ? row2('Departs', `${best.departTime} → ${best.arriveTime}`) : null,
    w.latest?.priceLevel ? row2('Google says', `prices are ${w.latest.priceLevel}`) : null,
    w.latest ? row2('Last checked', ago(w.latest.observedAt)) : null,
  );

  const link = el('a', { className: 'btn btn--icon', href: w.searchUrl, target: '_blank', rel: 'noopener noreferrer' },
    'OPEN IN GOOGLE FLIGHTS ↗');
  link.style.display = 'inline-block';
  link.style.marginTop = '14px';
  link.style.textDecoration = 'none';

  const left = el('div', {}, el('h3', { className: 'panel-title' }, 'Price history'), priceChart(w.series, currency));
  const right = el('div', {}, el('h3', { className: 'panel-title' }, 'Settings & latest'), stats, facts, link);

  const wrap = el('div', { className: 'row__detail' }, el('div', { className: 'detail__grid' }, left, right));
  if (w.failing >= 3) {
    wrap.append(el('p', { className: 'warn' }, `${w.failing} checks in a row have failed for this route.`));
  }
  return wrap;
}

const row2 = (k, v) => el('li', {}, el('span', {}, k), el('span', {}, v));

/* ── Airport autocomplete ─────────────────────────────────────── */

function wireAutocomplete(inputId, listId, hintId) {
  const input = $(`#${inputId}`);
  const list = $(`#${listId}`);
  const hint = $(`#${hintId}`);
  let items = [];
  let active = -1;
  let seq = 0;

  const close = () => {
    list.hidden = true;
    list.replaceChildren();
    active = -1;
  };

  const choose = (airport) => {
    input.value = airport.code;
    hint.textContent = `${airport.city}, ${airport.country}`;
    hint.dataset.bad = '0';
    close();
  };

  const draw = () => {
    list.replaceChildren();
    items.forEach((a, i) => {
      const li = el('li', { role: 'option' },
        el('span', { className: 'ac__code' }, a.code),
        el('span', { className: 'ac__city' }, `${a.city}, ${a.country}`),
        el('span', { className: 'ac__name' }, a.name),
      );
      li.setAttribute('aria-selected', String(i === active));
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(a); });
      list.append(li);
    });
    list.hidden = items.length === 0;
  };

  input.addEventListener('input', async () => {
    const q = input.value.trim();
    hint.dataset.bad = '0';

    if (q.length < 2) {
      hint.innerHTML = '&nbsp;';
      return close();
    }

    const mine = ++seq;
    try {
      const { results } = await api(`/api/airports?q=${encodeURIComponent(q)}`);
      if (mine !== seq) return; // a newer keystroke already won
      items = results;
      active = -1;
      draw();

      if (results.length === 0) {
        hint.textContent = /^[A-Za-z]{3}$/.test(q)
          ? 'Not in the list — the code will still be tried.'
          : 'No match';
        hint.dataset.bad = /^[A-Za-z]{3}$/.test(q) ? '0' : '1';
      } else {
        hint.innerHTML = '&nbsp;';
      }
    } catch {
      /* autocomplete is a convenience; typing a code still works */
    }
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      draw();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      choose(items[active]);
    } else if (e.key === 'Escape') {
      close();
    }
  });

  input.addEventListener('blur', () => setTimeout(close, 120));
}

/* ── Composer ─────────────────────────────────────────────────── */

function draft() {
  const trip = $('input[name="trip"]:checked').value;
  return {
    from: $('#from').value.trim().toUpperCase(),
    to: $('#to').value.trim().toUpperCase(),
    depart: $('#depart').value,
    return: trip === 'round-trip' ? $('#return').value : null,
    adults: Number($('#adults').value || 1),
    seat: $('#seat').value,
    maxStops: $('#maxStops').value || null,
    intervalMinutes: Number($('#intervalMinutes').value),
  };
}

function openComposer(open) {
  $('#composer').hidden = !open;
  if (open) {
    $('#from').focus();
    $('#composer').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    $('#preview').hidden = true;
    state.preview = null;
  }
}

async function runPreview(e) {
  e.preventDefault();
  const d = draft();

  if (d.return && d.return < d.depart) {
    return toast('The return date is before the departure date.', 'error');
  }

  const btn = $('#preview-btn');
  btn.disabled = true;
  btn.replaceChildren(el('span', { className: 'spinner' }), 'Searching Google Flights…');
  setStatus('Searching', 'busy');

  try {
    const result = await api('/api/search', { method: 'POST', body: d });
    state.preview = { draft: d, result };
    renderPreview(d, result);
  } catch (err) {
    toast(err.message, 'error');
    $('#preview').hidden = true;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check prices now';
    setStatus('Live', 'ok');
  }
}

function renderPreview(d, result) {
  const panel = $('#preview');

  if (result.count === 0) {
    $('#preview-summary').replaceChildren(
      el('span', {}, 'No flights found for those dates. Try a different date or fewer stop restrictions.'),
    );
    $('#preview-list').replaceChildren();
    $('#save-form').hidden = true;
    panel.hidden = false;
    return;
  }

  $('#save-form').hidden = false;
  const cheapest = result.cheapest;

  $('#preview-summary').replaceChildren(
    el('strong', {}, money(cheapest.price)),
    el('span', {}, `cheapest of ${result.count} options`),
    result.cheapestNonstop
      ? el('span', {}, `nonstop from ${money(result.cheapestNonstop.price)}`)
      : el('span', {}, 'no nonstop service'),
    result.priceLevel ? el('span', {}, `Google: prices ${result.priceLevel}`) : null,
  );

  $('#preview-list').replaceChildren(
    ...result.results.map((r) =>
      el('li', {},
        el('span', { className: 'itin__price' }, money(r.price)),
        el('span', { className: 'itin__times' }, `${r.departTime ?? ''} → ${r.arriveTime ?? ''}`),
        el('span', { className: 'itin__meta' }, `${r.durationText ?? ''} · ${r.airlines ?? ''}`),
        el('span', { className: 'itin__stops', dataset: { nonstop: r.stops === 0 ? '1' : '0' } }, stopsLabel(r.stops)),
      ),
    ),
  );

  // Suggest a target ~8% under today's fare: low enough to mean something,
  // close enough to be reachable.
  const suggested = Math.max(1, Math.round((cheapest.price * 0.92) / 5) * 5);
  $('#targetPrice').value = suggested;
  $('#target-hint').textContent = `about 8% below today's ${money(cheapest.price)}`;

  panel.hidden = false;
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function saveWatch(e) {
  e.preventDefault();
  if (!state.preview) return;

  const btn = $('#save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const target = $('#targetPrice').value;
  try {
    const { watch } = await api('/api/watches', {
      method: 'POST',
      body: { ...state.preview.draft, alert: { targetPrice: target === '' ? null : Number(target) } },
    });
    toast(`Now tracking ${watch.from} → ${watch.to}, checking every ${watch.intervalMinutes} minutes.`, 'good');

    // Populate the row's first data point right away rather than leaving it
    // blank until the first scheduled poll. Deliberately not awaited — the
    // board should appear immediately.
    api(`/api/watches/${encodeURIComponent(watch.id)}/check`, { method: 'POST' })
      .then(refresh)
      .catch(() => {});

    openComposer(false);
    $('#composer-form').reset();
    $('#return-field').hidden = true;
    for (const id of ['from-hint', 'to-hint']) $(`#${id}`).innerHTML = '&nbsp;';
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Start tracking';
  }
}

/* ── Boot ─────────────────────────────────────────────────────── */

async function refresh() {
  try {
    const data = await api('/api/state');
    Object.assign(state, data);
    render();
    setStatus('Live', 'ok');
  } catch (err) {
    setStatus('Offline', 'error');
    toast(err.message, 'error');
  }
}

function init() {
  wireAutocomplete('from', 'from-ac', 'from-hint');
  wireAutocomplete('to', 'to-ac', 'to-hint');

  $('#new-watch-btn').addEventListener('click', () => openComposer($('#composer').hidden));
  $('#composer-close').addEventListener('click', () => openComposer(false));
  $('#composer-form').addEventListener('submit', runPreview);
  $('#save-form').addEventListener('submit', saveWatch);

  for (const radio of document.querySelectorAll('input[name="trip"]')) {
    radio.addEventListener('change', () => {
      const round = $('input[name="trip"]:checked').value === 'round-trip';
      $('#return-field').hidden = !round;
      $('#return').required = round;
    });
  }

  $('#swap').addEventListener('click', (e) => {
    const from = $('#from');
    const to = $('#to');
    [from.value, to.value] = [to.value, from.value];
    const fh = $('#from-hint');
    const th = $('#to-hint');
    [fh.textContent, th.textContent] = [th.textContent, fh.textContent];
    e.currentTarget.classList.toggle('is-spun');
  });

  // Departure defaults to a month out — a realistic booking horizon.
  const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  for (const id of ['depart', 'return']) $(`#${id}`).min = today;
  $('#depart').value = soon;

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#composer').hidden) openComposer(false);
  });

  refresh();
  setInterval(refresh, 30000);
}

init();
