/**
 * Fetches and parses Google Flights search results.
 *
 * Parsing deliberately keys off ARIA labels rather than CSS class names.
 * Google's class names are minified and rotate frequently; the accessibility
 * labels are user-facing contract and change far more slowly. Every result row
 * carries one self-contained label that reads like:
 *
 *   "From 189 US dollars. Nonstop flight with Delta. Leaves Luis Munoz Marin
 *    International Airport at 7:30 AM on Saturday, August 15 and arrives at
 *    John F. Kennedy International Airport at 11:25 AM on Saturday, August 15.
 *    Total duration 3 hr 55 min. 1 carry-on bag included. ..."
 *
 * so a single regex sweep yields the whole itinerary.
 */

import { buildSearchUrl } from './tfs.js';

// Rotated per request. Google serves the lightweight no-JS result list to all
// of these; varying them avoids looking like a single pinned client.
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

const RESULT_LABEL = /aria-label="(From [^"]*?Total duration[^"]*?)"/g;

export class FlightSearchError extends Error {
  constructor(message, { retryable = false, status } = {}) {
    super(message);
    this.name = 'FlightSearchError';
    this.retryable = retryable;
    this.status = status;
  }
}

const decodeEntities = (s) =>
  s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&ndash;/g, '–')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

/** "3 hr 55 min" / "55 min" / "2 hr" -> minutes */
function parseDuration(text) {
  if (!text) return null;
  const hours = /(\d+)\s*hr/.exec(text);
  const mins = /(\d+)\s*min/.exec(text);
  if (!hours && !mins) return null;
  return (hours ? Number(hours[1]) * 60 : 0) + (mins ? Number(mins[1]) : 0);
}

function parseStops(text) {
  if (/nonstop/i.test(text)) return 0;
  const m = /(\d+)\s+stops?\s+flight/i.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * Pulls carrier + flight number and the routing out of the Travel Impact Model
 * links Google embeds next to each row, e.g.
 * `...?itinerary=SJU-JFK-DL-1854-20260815`. Segments appear in flown order.
 */
function parseSegments(html) {
  const out = [];
  // Multi-segment itineraries are comma-separated, so the value must be read up
  // to the URL/attribute boundary rather than to the first non-alphanumeric.
  for (const m of html.matchAll(/itinerary=([^"&\s]+)/g)) {
    for (const seg of m[1].split(',')) {
      const p = seg.split('-');
      if (p.length < 5) continue;
      const [from, to, carrier, number] = p;
      const key = `${carrier}${number}`;
      if (!out.some((s) => s.flight === key && s.from === from)) {
        out.push({ from, to, carrier, flight: key });
      }
    }
  }
  return out;
}

/** Parses one result row's label + the HTML window that follows it. */
function parseResult(label, windowHtml) {
  const text = decodeEntities(label).replace(/\s+/g, ' ').trim();

  const priceMatch = /^From\s+([\d.,]+)\s+(.+?)\.\s/.exec(text);
  if (!priceMatch) return null;

  const price = Number(priceMatch[1].replace(/,/g, ''));
  if (!Number.isFinite(price)) return null;

  const airlines = /flight with ([^.]+)\./.exec(text)?.[1]?.trim() ?? null;
  const legs =
    /Leaves (.+?) at (\d{1,2}:\d{2}\s*[AP]M) on (.+?) and arrives at (.+?) at (\d{1,2}:\d{2}\s*[AP]M) on ([^.]+)\./.exec(
      text,
    );
  const durationText = /Total duration ([^.]+)\./.exec(text)?.[1]?.trim() ?? null;
  const layovers = [...text.matchAll(/is a ([\d\s a-z]+?) layover at ([^.]+?)(?:\.|$)/g)].map(
    (m) => ({ duration: m[1].trim(), durationMinutes: parseDuration(m[1]), airport: m[2].trim() }),
  );

  const segments = parseSegments(windowHtml);
  const co2 = /data-co2currentflight="(\d+)"/.exec(windowHtml)?.[1];

  return {
    price,
    // "US dollars" / "US dollars round trip" — keep the qualifier for display.
    priceUnit: priceMatch[2].trim(),
    roundTrip: /round trip/i.test(priceMatch[2]),
    airlines,
    stops: parseStops(text),
    durationText,
    durationMinutes: parseDuration(durationText),
    departTime: legs?.[2]?.replace(/\s+/g, ' ') ?? null,
    departDay: legs?.[3]?.trim() ?? null,
    departAirport: legs?.[1]?.trim() ?? null,
    arriveTime: legs?.[5]?.replace(/\s+/g, ' ') ?? null,
    arriveDay: legs?.[6]?.trim() ?? null,
    arriveAirport: legs?.[4]?.trim() ?? null,
    layovers,
    segments,
    flightNumbers: segments.map((s) => s.flight),
    co2Kg: co2 ? Math.round(Number(co2) / 1000) : null,
    label: text,
  };
}

/**
 * @param {string} html raw Google Flights response body
 * @returns {{results: object[], priceLevel: string|null, blocked: boolean}}
 */
export function parseResults(html) {
  const matches = [...html.matchAll(RESULT_LABEL)];

  const results = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    // Bound the lookahead window by the next row so segment/CO2 data from the
    // following itinerary can never leak into this one.
    const end = i + 1 < matches.length ? matches[i + 1].index : Math.min(start + 8000, html.length);
    const parsed = parseResult(matches[i][1], html.slice(start, end));
    if (parsed) results.push(parsed);
  }

  // Google renders the same itinerary twice — once under "Best departing
  // flights" and again in the full list — so identical rows must be collapsed.
  const seen = new Set();
  const unique = results.filter((r) => {
    const key = [r.flightNumbers.join('|'), r.departTime, r.arriveTime, r.price].join('~');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => a.price - b.price);

  // Google's own verdict on the current price, shown as "Prices are currently
  // low / typical / high". The value sits inside a nested span.
  const priceLevel =
    /Prices are currently\s*(?:<[^>]*>\s*)*(\w+)/.exec(html)?.[1]?.toLowerCase() ?? null;

  const blocked =
    unique.length === 0 &&
    (/consent\.google\.com|Before you continue|unusual traffic|captcha/i.test(html) ||
      html.length < 50_000);

  return { results: unique, priceLevel, blocked };
}

async function fetchOnce(url, { timeoutMs, language }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': `${language}-US,${language};q=0.9`,
        'cache-control': 'no-cache',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'upgrade-insecure-requests': '1',
      },
    });

    if (res.status === 429 || res.status >= 500) {
      throw new FlightSearchError(`Google returned HTTP ${res.status}`, {
        retryable: true,
        status: res.status,
      });
    }
    if (!res.ok) {
      throw new FlightSearchError(`Google returned HTTP ${res.status}`, { status: res.status });
    }
    return await res.text();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new FlightSearchError(`Request timed out after ${timeoutMs}ms`, { retryable: true });
    }
    if (err instanceof FlightSearchError) throw err;
    // Network-level failures (DNS, reset, offline) are worth another try.
    throw new FlightSearchError(err.message, { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs one search, with bounded retry on transient failures.
 *
 * @returns {Promise<{url:string, results:object[], priceLevel:string|null, fetchedAt:string}>}
 */
export async function searchFlights(watch, options = {}) {
  const {
    currency = 'USD',
    language = 'en',
    region = 'US',
    timeoutMs = 30_000,
    retries = 3,
    fetchImpl = fetchOnce,
    backoffBaseMs = 1000,
  } = options;

  const url = buildSearchUrl(watch, { currency, language, region });

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff with jitter: 2s, 4s, 8s (+0-1s).
      await sleep(2 ** attempt * backoffBaseMs + Math.random() * backoffBaseMs);
    }
    try {
      const html = await fetchImpl(url, { timeoutMs, language });
      const { results, priceLevel, blocked } = parseResults(html);

      if (blocked) {
        throw new FlightSearchError('Google served a consent/captcha page instead of results', {
          retryable: true,
        });
      }
      if (results.length === 0) {
        // A genuinely empty route (no flights on that date) is not an error.
        return { url, results: [], priceLevel, fetchedAt: new Date().toISOString() };
      }
      return { url, results, priceLevel, fetchedAt: new Date().toISOString() };
    } catch (err) {
      lastError = err;
      if (!(err instanceof FlightSearchError) || !err.retryable) throw err;
    }
  }
  throw lastError;
}
