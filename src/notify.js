/**
 * Pushover delivery.
 *
 * Notifications carry a deep link straight back to the Google Flights search
 * that produced the price, so acting on an alert is one tap rather than a
 * re-search from scratch.
 */

const ENDPOINT = 'https://api.pushover.net/1/messages.json';

export class NotifyError extends Error {
  constructor(message, { errors = [] } = {}) {
    super(message);
    this.name = 'NotifyError';
    this.errors = errors;
  }
}

export class PushoverNotifier {
  #token;
  #user;
  #device;
  #sounds;

  constructor({ token, user, device = null, sounds = {} }) {
    if (!token || !user) {
      throw new NotifyError(
        'Pushover requires PUSHOVER_TOKEN and PUSHOVER_USER_KEY (see .env.example)',
      );
    }
    this.#token = token;
    this.#user = user;
    this.#device = device;
    this.#sounds = sounds;
  }

  get name() {
    return 'pushover';
  }

  /**
   * @param {object} msg
   * @param {string} msg.title
   * @param {string} msg.message  may contain Pushover's limited HTML subset
   * @param {number} [msg.priority] -2..1 (2 is deliberately never used)
   * @param {string} [msg.url]
   * @param {string} [msg.urlTitle]
   * @param {string} [msg.reason] selects a per-reason sound if configured
   */
  async send({ title, message, priority = 0, url, urlTitle, reason, timestamp }) {
    const body = new URLSearchParams({
      token: this.#token,
      user: this.#user,
      title,
      message,
      priority: String(priority),
      html: '1',
    });

    if (this.#device) body.set('device', this.#device);
    if (url) body.set('url', url);
    if (urlTitle) body.set('url_title', urlTitle);
    if (timestamp) body.set('timestamp', String(Math.floor(timestamp / 1000)));

    const sound = reason ? this.#sounds[reason] : null;
    if (sound) body.set('sound', sound);

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    let payload;
    try {
      payload = await res.json();
    } catch {
      throw new NotifyError(`Pushover returned HTTP ${res.status} with a non-JSON body`);
    }

    if (!res.ok || payload.status !== 1) {
      throw new NotifyError(
        `Pushover rejected the request (HTTP ${res.status}): ${(payload.errors ?? []).join('; ') || 'unknown error'}`,
        { errors: payload.errors ?? [] },
      );
    }

    return { request: payload.request };
  }
}

/** Stand-in used by `--dry-run` and by anyone who hasn't set up Pushover yet. */
export class ConsoleNotifier {
  #log;

  constructor(log = console.log) {
    this.#log = log;
  }

  get name() {
    return 'console';
  }

  async send({ title, message, priority = 0, url }) {
    const plain = message.replace(/<[^>]+>/g, '');
    this.#log(
      `\n  ┌─ [would push · priority ${priority}]\n  │ ${title}\n${plain
        .split('\n')
        .map((l) => `  │ ${l}`)
        .join('\n')}\n  └─ ${url ?? ''}`,
    );
    return { request: 'dry-run' };
  }
}

export function createNotifier({ dryRun = false, env = process.env, sounds = {} } = {}) {
  if (dryRun) return new ConsoleNotifier();
  return new PushoverNotifier({
    token: env.PUSHOVER_TOKEN,
    user: env.PUSHOVER_USER_KEY,
    device: env.PUSHOVER_DEVICE || null,
    sounds,
  });
}
