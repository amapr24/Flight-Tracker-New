/**
 * Builds the `tfs` query parameter that Google Flights uses to encode a search.
 *
 * `tfs` is a base64url-encoded protobuf message. Rather than pull in a protobuf
 * runtime for four field types, we hand-encode the handful of wire types the
 * message actually uses (varint + length-delimited).
 *
 * Message shape, reverse-engineered from the Google Flights web client:
 *
 *   Airport    { string code = 2; }
 *   FlightData { string date = 2; MaxStops maxStops = 5;
 *                Airport from = 13; Airport to = 14; }
 *   Info       { repeated FlightData legs = 3; repeated Passenger pax = 8;
 *                Seat seat = 9; Trip trip = 19; }
 */

const WIRE_VARINT = 0;
const WIRE_LEN = 2;

export const SEAT = {
  economy: 1,
  'premium-economy': 2,
  business: 3,
  first: 4,
};

export const TRIP = {
  'round-trip': 1,
  'one-way': 2,
  'multi-city': 3,
};

/**
 * Field 5 is a literal maximum stop count, not an offset enum — verified
 * against live results: 0 returns nonstop only, 1 returns nonstop + one-stop,
 * 2 adds two-stop. `null` omits the field entirely, meaning "any".
 */
export const MAX_STOPS = {
  nonstop: 0,
  '0': 0,
  '1': 1,
  '2': 2,
  '3': 3,
};

export const PASSENGER = {
  adult: 1,
  child: 2,
  'infant-in-seat': 3,
  'infant-on-lap': 4,
};

function varint(value) {
  const bytes = [];
  let n = value;
  while (n > 127) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return Buffer.from(bytes);
}

const tag = (field, wire) => varint((field << 3) | wire);

const encodeVarintField = (field, value) =>
  Buffer.concat([tag(field, WIRE_VARINT), varint(value)]);

function encodeBytesField(field, payload) {
  return Buffer.concat([tag(field, WIRE_LEN), varint(payload.length), payload]);
}

const encodeStringField = (field, value) =>
  encodeBytesField(field, Buffer.from(value, 'utf8'));

function encodeLeg({ from, to, date, maxStops }) {
  const parts = [encodeStringField(2, date)];
  // Omitted entirely when unset, which Google reads as "any number of stops".
  if (maxStops != null) parts.push(encodeVarintField(5, maxStops));
  parts.push(encodeBytesField(13, encodeStringField(2, from)));
  parts.push(encodeBytesField(14, encodeStringField(2, to)));
  return Buffer.concat(parts);
}

/**
 * @param {object} query
 * @param {Array<{from:string,to:string,date:string,maxStops?:number|null}>} query.legs
 * @param {number} [query.adults]
 * @param {number} [query.children]
 * @param {number} [query.infantsInSeat]
 * @param {number} [query.infantsOnLap]
 * @param {number} [query.seat] one of SEAT
 * @param {number} [query.trip] one of TRIP
 * @returns {string} base64url `tfs` value
 */
export function encodeTfs({
  legs,
  adults = 1,
  children = 0,
  infantsInSeat = 0,
  infantsOnLap = 0,
  seat = SEAT.economy,
  trip = TRIP['one-way'],
}) {
  if (!legs?.length) throw new Error('encodeTfs: at least one leg is required');

  const parts = legs.map((leg) => encodeBytesField(3, encodeLeg(leg)));

  // Passengers are a repeated enum: one entry per traveller, not a count.
  const pax = [
    [PASSENGER.adult, adults],
    [PASSENGER.child, children],
    [PASSENGER['infant-in-seat'], infantsInSeat],
    [PASSENGER['infant-on-lap'], infantsOnLap],
  ];
  for (const [type, count] of pax) {
    for (let i = 0; i < count; i++) parts.push(encodeVarintField(8, type));
  }

  parts.push(encodeVarintField(9, seat));
  parts.push(encodeVarintField(19, trip));

  return Buffer.concat(parts)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Turns a normalised watch into the Google Flights URL a human would land on.
 * The same URL is used for scraping and as the deep link in notifications, so
 * tapping the alert always opens the exact search that produced the price.
 */
export function buildSearchUrl(watch, { currency = 'USD', language = 'en', region = 'US' } = {}) {
  const legs = [
    {
      from: watch.from,
      to: watch.to,
      date: watch.depart,
      maxStops: watch.maxStops == null ? null : MAX_STOPS[String(watch.maxStops)] ?? null,
    },
  ];

  if (watch.return) {
    legs.push({
      from: watch.to,
      to: watch.from,
      date: watch.return,
      maxStops: watch.maxStops == null ? null : MAX_STOPS[String(watch.maxStops)] ?? null,
    });
  }

  const tfs = encodeTfs({
    legs,
    adults: watch.adults ?? 1,
    children: watch.children ?? 0,
    infantsInSeat: watch.infantsInSeat ?? 0,
    infantsOnLap: watch.infantsOnLap ?? 0,
    seat: SEAT[watch.seat ?? 'economy'] ?? SEAT.economy,
    trip: watch.return ? TRIP['round-trip'] : TRIP['one-way'],
  });

  const params = new URLSearchParams({
    tfs,
    hl: language,
    gl: region,
    curr: currency,
    // Asks for the "cheapest/best" result set rather than a saved sort order.
    tfu: 'EgQIABABIgA',
  });

  return `https://www.google.com/travel/flights?${params}`;
}
