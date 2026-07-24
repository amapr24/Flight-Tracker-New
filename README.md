# flight-tracker

Polls Google Flights on an interval you choose and pushes price alerts to your phone through [Pushover](https://pushover.net) — typically within one polling cycle of the price actually moving.

Google's own price-tracking emails are batched and delayed, they don't tell you what the price *was*, and you can't set a target. This does:

|                        | Google Flights emails | flight-tracker              |
| ---------------------- | --------------------- | --------------------------- |
| Notification delay     | Hours to a day        | Your interval (min. 5 min)  |
| Delivery               | Email                 | Push notification           |
| Target price alerts    | No                    | Yes, high priority          |
| "New all-time low"     | No                    | Yes, against your own record|
| Full price history     | No                    | SQLite, queryable + charted |
| Noise control          | No                    | Thresholds, cooldown, quiet hours |

No API keys, no paid scraping service, and no dependencies — it reads the same public Google Flights page a browser gets, and stores history in Node's built-in SQLite.

---

## Requirements

- **Node.js 24+**. Uses the built-in `node:sqlite`, so there are no dependencies
  to install. Check with `node --version`.
- A free **Pushover** account, plus the app on your phone (one-time ~$5 per platform).

## Setup

Create your credentials file:

```bash
cp .env.example .env
```

> Copy each command on its own. zsh — the default macOS shell — does not treat
> `#` as a comment interactively, so pasting a line with a trailing `# note`
> passes those words to the command as arguments and it fails.

Put your Pushover credentials in `.env`:

- `PUSHOVER_USER_KEY` — the 30-character user key on your [Pushover dashboard](https://pushover.net).
- `PUSHOVER_TOKEN` — an API token from an app you register at [pushover.net/apps/build](https://pushover.net/apps/build). Name it anything.

Confirm delivery works:

```bash
node bin/flight-tracker.js test-notify
```

Then start it. This opens the dashboard and begins polling in the background:

```bash
node bin/flight-tracker.js serve
```

## The dashboard

`serve` runs the web UI and the poller in one process on `http://localhost:4127`.
A route added in the dashboard starts being checked immediately — no restart.

Adding a route is deliberately search-first: you pick airports and dates, and it
**runs a real Google Flights search before saving anything**. You see the actual
fares for those exact dates, and only then commit to tracking them. That also
means a mistyped airport code fails in front of you instead of silently tracking
nothing — the failure mode a hand-edited config makes far too easy.

- **Airport autocomplete** over ~370 major airports, searchable by city, code or
  airport name ("madrid", "MAD", "heathrow"). Any valid 3-letter code works even
  if it isn't in the list; the live search is what confirms it.
- **Suggested target price**, pre-filled about 8% under the current fare.
- **Price history charts** per route, with the all-time low marked.
- **Check now / pause / delete**, and a link back to the exact Google search.

The dashboard edits `watches.json` in place, so the file stays hand-editable and
the CLI keeps working exactly as before. Everything the UI does is also available
as a command, and neither is privileged over the other.

Serving is loopback-only (`127.0.0.1`), with Host and Origin checks so no other
page in your browser can drive it. There is no authentication beyond that — it is
meant for your own machine, not a shared host.

```bash
node bin/flight-tracker.js serve --port 8080 --no-open
```

## Commands

```bash
node bin/flight-tracker.js <command>
```

| Command | What it does |
| --- | --- |
| `serve` | Dashboard + background polling in one process. Start here. |
| `watch` | Poll continuously with no UI — what the LaunchAgent runs. |
| `check [watchId]` | Poll once now — all watches, or just one. Good for testing config. |
| `search <FROM> <TO> <DATE> [RETURN]` | One-off lookup. No config, no history, no notifications. |
| `list` | Configured watches with their latest price and running stats. |
| `history <watchId>` | Price history with a sparkline trend. |
| `test-notify` | Send a test push to verify Pushover is wired up. |
| `import [file]` | Rebuild history from NDJSON. Used by CI; also moves data between machines. |
| `export [file]` | Write history to NDJSON. |
| `site-data [file]` | Write the JSON the published viewer reads. Used by the Pages build. |
| `prune` | Drop observations older than a year. `--orphans` drops history for routes no longer in the config. |

Useful flags: `--dry-run` prints notifications instead of sending them, `--no-notify` records history silently, `--config <path>` points at a different config file. For `serve`: `--port`, `--no-open`, `--no-poll`.

If Pushover isn't configured yet, every command still runs — alerts print to the
terminal with a warning rather than failing, so you can set up routes first.

Try it without any setup at all:

```bash
node bin/flight-tracker.js search SJU JFK 2026-08-15
```

```
  30 options · cheapest $189 · Google says prices are typical

     $189  7:30 AM → 11:25 AM   3 hr 55 min nonstop Delta      DL1854
     $229  5:50 PM → 10:04 PM   4 hr 14 min nonstop Delta      DL1961
     $248  5:05 AM → 12:29 PM   7 hr 24 min 1 stop  JetBlue     B6754, B62102
```

## Configuring watches by hand

The dashboard writes this file for you, but it stays plain JSON you can edit
directly — useful for bulk changes or version control.

```jsonc
{
  "defaults": {
    "intervalMinutes": 30,
    "currency": "USD",
    "quietHours": {
      "start": "23:00",
      "end": "07:00",
      "timezone": "America/Puerto_Rico",
      "allowUrgent": true
    }
  },
  "watches": [
    {
      "id": "sju-jfk-august",
      "label": "San Juan → New York (Aug 15)",
      "from": "SJU",
      "to": "JFK",
      "depart": "2026-08-15",
      "intervalMinutes": 20,
      "alert": {
        "targetPrice": 200,
        "dropPercent": 8,
        "dropAmount": 25
      }
    }
  ]
}
```

### Watch fields

| Field | Default | Notes |
| --- | --- | --- |
| `id` | required | Stable identifier; price history is keyed to it, so don't rename casually. |
| `label` | derived | Shown in notifications. |
| `from`, `to` | required | 3-letter IATA airport codes. |
| `depart` | required | `YYYY-MM-DD`. |
| `return` | none | Omit for one-way. |
| `adults` | `1` | Also `children`, `infantsInSeat`, `infantsOnLap`. |
| `seat` | `economy` | `economy`, `premium-economy`, `business`, `first`. |
| `maxStops` | any | `"nonstop"`, `0`, `1`, `2`, `3`. Filters at the source. |
| `trackNonstopOnly` | `false` | Alert on the cheapest *nonstop* rather than the cheapest fare overall. |
| `intervalMinutes` | `30` | Minimum 5. |
| `enabled` | `true` | Set `false` to keep a watch on file without polling it. |

Deleting a route keeps its price history, so you can re-add the same trip later
and still have the record. That history becomes orphaned, and clearing it is a
deliberate step rather than something any routine command does behind your back:

```bash
node bin/flight-tracker.js prune --orphans
```

### Alert fields

| Field | Default | Notes |
| --- | --- | --- |
| `targetPrice` | none | Your buy price. Crossing it is the only high-priority alert. |
| `dropPercent` | `8` | Percentage fall that counts as a real drop. |
| `dropAmount` | `25` | Absolute fall that counts as a real drop. Either threshold triggers. |
| `notifyOnNewLow` | `true` | Alert when the price beats everything you've recorded. |
| `notifyOnRise` | `false` | Alert on increases too, if you want to know you missed it. |
| `risePercent` | `20` | Rise threshold, when enabled. |
| `notifyOnFirstSeen` | `true` | One quiet alert the first time a watch reports. |
| `cooldownMinutes` | `180` | Minimum gap between repeats of the same alert reason. |

## How alerting decides

On each poll the cheapest eligible fare is compared against the previous observation and against the full recorded history. The first matching reason wins:

1. **`target-hit`** — at or below `targetPrice`, either newly crossed or improved further. *High priority; breaks through quiet hours.*
2. **`new-low`** — cheaper than anything recorded for this watch.
3. **`price-drop`** — fell by at least `dropAmount` **or** `dropPercent`.
4. **`price-rise`** — rose past `risePercent`, only if `notifyOnRise` is on.
5. **`first-seen`** — the first successful reading. *Quiet.*

Anything else is recorded but stays silent, so a fare that jitters a few dollars all day never reaches your phone.

Two things keep it from getting noisy:

- **Cooldown** — the same reason won't repeat within `cooldownMinutes` unless the price improved materially since that alert.
- **Quiet hours** — ordinary alerts are delivered silently overnight. `allowUrgent: true` still lets a target hit wake you.

If checks fail three times running, you get one low-priority warning. A price tracker that has silently broken looks exactly like one reporting no changes, and that's the failure worth knowing about.

## Running it in the background (macOS)

```bash
./scripts/install-launchd.sh
```

Installs a LaunchAgent that starts at login and restarts on crash. It validates your config first and refuses to install a job that would crash-loop.

The agent runs `serve`, so it polls *and* keeps the dashboard at
`http://localhost:4127` available. **Once it's installed, don't also run `serve`
or `watch` by hand** — two pollers means every route gets checked twice.

Watch it work:

```bash
tail -f logs/flight-tracker.log
```

Stop and remove it:

```bash
./scripts/install-launchd.sh --uninstall
```

## Running it without leaving a machine on

A local install only polls while the machine is awake. macOS sleeps within
minutes of going idle, and Power Nap won't run this — so an overnight price
swing is simply missing from your history.

The repo includes a GitHub Actions workflow that runs the check on GitHub's
infrastructure instead. It is **deliberately not triggered by GitHub's own
`schedule:` cron**, which queues on a shared pool and commonly fires 10–30
minutes late — the very delay this project exists to avoid. Instead it listens
for `repository_dispatch`, which an external scheduler triggers on time.

### Read this first

GitHub's runners use Azure datacenter IPs. Those ranges are bot-flagged far more
aggressively than a home connection, so Google is more likely to answer a runner
with a consent or captcha page than it is to answer your laptop. **This may not
work reliably, and that isn't something the code can fix.**

The workflow is built to tell you rather than fail quietly: it detects a
consent/captcha response, fails the job with an explanatory annotation, and
Pushover sends a "checks failing" alert after three consecutive failures. If you
see that consistently, run the tracker from your own network instead — a
Raspberry Pi or any always-on machine at home keeps the residential IP that
works today.

### Setup

**1. Push to GitHub.** Make the repo **public** — Actions minutes are unlimited
on public repos. On a private repo you get 2,000 minutes/month, and checking one
route every 20 minutes burns roughly 2,000 minutes/month on job overhead alone.

Nothing secret is committed: `.env` is ignored, and credentials live in repo
secrets. `watches.json` *is* committed, since CI has to read it.

**2. Add repository secrets** under Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `PUSHOVER_TOKEN` | your Pushover application token |
| `PUSHOVER_USER_KEY` | your Pushover user key |
| `PUSHOVER_DEVICE` | optional, a single device name |

**3. Create a token for the scheduler.** Settings → Developer settings →
Personal access tokens → Fine-grained. Scope it to this one repository and grant
**Contents: Read and write** (that is what `repository_dispatch` requires).

**4. Confirm it works** before wiring up a scheduler. A `204` means the run
started:

```bash
curl -i -X POST -H "Authorization: Bearer YOUR_TOKEN" -H "Accept: application/vnd.github+json" https://api.github.com/repos/OWNER/REPO/dispatches -d '{"event_type":"check-flights"}'
```

**5. Point a scheduler at it.** On [cron-job.org](https://cron-job.org) create a
job with:

- **URL** — `https://api.github.com/repos/OWNER/REPO/dispatches`
- **Method** — `POST`
- **Schedule** — whatever interval you want; every 20 minutes is reasonable
- **Headers** — `Authorization: Bearer YOUR_TOKEN`,
  `Accept: application/vnd.github+json`, `Content-Type: application/json`
- **Body** — `{"event_type":"check-flights"}`

Any scheduler that can send an authenticated POST works — EasyCron, a Cloudflare
Worker cron trigger, or a cron line on a machine that *is* always on.

### How state survives

CI runners start with an empty disk, but alerting is meaningless without
history: with no past prices, every run looks like a fresh all-time low and
pushes an alert. So the workflow round-trips the database through the repo:

```
import data/history.ndjson  →  check  →  export  →  commit
```

`data/history.ndjson` is append-only, one record per line, so git delta-
compresses it well. The full itinerary is stored only on the newest record for
each route — the only one anything reads it from. Expect roughly 7 MB/year of
raw text for a handful of routes; the workflow passes `--keep-days 180` to cap
it. The SQLite file itself is never committed; it's rebuilt on each run.

You can move history between machines the same way:

```bash
node bin/flight-tracker.js export data/history.ndjson
```

### Viewing prices from your phone

`.github/workflows/pages.yml` publishes a **read-only** viewer to GitHub Pages —
route cards, price history charts with the target marked, and a link straight to
the booking page. No laptop needed to look at it.

It rebuilds whenever the tracker commits new prices. Enable it once under
Settings → Pages → **Source: GitHub Actions**, and it lands at
`https://<user>.github.io/<repo>/`.

The full dashboard can't be published this way, and it's worth understanding
why: it's a client for a local API that writes `watches.json`, runs searches and
holds your Pushover credentials. Static hosting can provide none of that, and a
browser can't call Google Flights directly (no CORS headers). So the published
page is a pure renderer — the deep links and stats are computed at build time by
`flight-tracker site-data` and baked into one JSON file.

**On a public repo the page is public too.** It shows your routes, dates and
recorded prices. No credentials are ever included, but if you'd rather not
publish that, make the repo private (Actions minutes then apply) or drop
`.github/workflows/pages.yml`.

### Sharing it with friends

Have them **fork the repo**. A fork carries its own secrets, so their
`PUSHOVER_TOKEN` and `PUSHOVER_USER_KEY` are theirs — alerts go to their phone,
not yours, with nothing shared between you. They edit their own `watches.json`
and point their own cron job at their own fork.

Each person needs their own Pushover application token (free to register) and
their own scheduler job. If you'd rather run one repo for a group, that needs
per-watch routing of alerts to different Pushover user keys — the config would
need a `pushoverUser` field per watch, which isn't built yet.

## Tests

```bash
npm test
```

135 tests. Parsing runs against a real captured Google Flights response (`test/fixtures/`), so a change in Google's markup fails the suite rather than silently producing no prices. The server tests boot the real HTTP server on an ephemeral port and include the Host/Origin guards.

## How it works

Google Flights encodes a search into a `tfs` query parameter: a protobuf message, base64url-encoded. `src/tfs.js` builds that message directly, so a search is one plain `fetch` — no browser, no API key, no third-party scraping service.

The dashboard is `node:http` plus vanilla JS — no framework, no build step, no
bundler. Charts are hand-drawn SVG. The only external resource the page loads is
a webfont; everything else is served locally.

`src/google-flights.js` parses the response using **ARIA labels** rather than CSS class names. Each result row carries a self-contained label:

> "From 189 US dollars. Nonstop flight with Delta. Leaves Luis Munoz Marin International Airport at 7:30 AM on Saturday, August 15 and arrives at John F. Kennedy International Airport at 11:25 AM…"

Google's class names are minified and rotate often; the accessibility labels are user-facing contract and change far more slowly. Flight numbers and CO2 come from the embedded Travel Impact Model links.

## Caveats

This reads Google Flights' public web page. That means:

- **Be reasonable with intervals.** The 5-minute floor is deliberate. Every request is jittered, staggered across watches, and rotates its user-agent. A handful of routes at 20–30 minutes is unremarkable traffic; polling every route every minute is not, and will get you rate-limited.
- **Google can change the markup.** If they do, the parser breaks — you'll get a "checks failing" push rather than silence, and `npm test` will point at what changed.
- **Prices are Google's, not a booking guarantee.** Fares move between search and checkout. The notification links straight back to the exact search so you can confirm before booking.

## License

MIT — see [LICENSE](LICENSE). Use it, fork it, change it.

The license covers this code only. It says nothing about Google's terms for the
page it reads; that's between you and Google.
