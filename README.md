# alexa-notifier

Speak, **announce**, notify, and set **reminders** on your Amazon Echo / Alexa
devices — a small, modern, **Promise-first TypeScript** notifier.

It's the Alexa counterpart to
[`google-home-notifier`](https://github.com/noelportugal/google-home-notifier):
the same ergonomic `device()` / `devices()` / `notify()` shape, so you get
symmetric tools for both ecosystems.

- 🧊 **Tiny, focused surface** — `speak` · `announce` · `notify` · `reminder` · `getDevices`. Not a 150-method kitchen sink.
- ⛓️ **Promise-first** — `await alexa.notify('…')`. No callbacks.
- 🟦 **TypeScript**, shipped as **dual ESM + CJS** with types.
- 🔁 **Multi-device fan-out** — broadcast to many; one offline Echo never blocks the rest.
- 🔐 **Login once** — auth state is persisted and reused automatically.

> Built on [`alexa-remote2`](https://www.npmjs.com/package/alexa-remote2) — works
> with your existing Amazon account, no Alexa skill or developer setup required.

## Install

```sh
npm install alexa-notifier
```

## Quick start

```ts
import { AlexaNotifier } from 'alexa-notifier'

const alexa = new AlexaNotifier({ proxy: true }); // interactive login (handles MFA)
await alexa.connect();                            // prints a URL to open once; then cached

await alexa.device('Living Room').announce('Dinner is ready');
await alexa.device('Office').speak('Build finished ✅');
await alexa.device('Bedroom').reminder('Take meds', new Date(Date.now() + 3600_000));
```

After the first login, the auth state is saved to `~/.alexa-notifier/state.json`
and reused — subsequent runs connect silently.

## Multiple devices

```ts
await alexa.devices(['Living Room', 'Kitchen']).announce('Leaving in 5 minutes');
// or every device on the account:
await alexa.all().announce('Good morning!');

// Multi-target calls resolve a per-device array (never throw on one offline speaker):
// [ { device: 'Living Room', result: 'ok' }, { device: 'Kitchen', error: '…' } ]
```

## Discover devices

```ts
const list = await alexa.getDevices();
// → [ { name: 'Living Room', serialNumber: '…', deviceType: '…', online: true }, … ]
```

## API

| Method | Description |
| --- | --- |
| `new AlexaNotifier(options?)` | See options below. |
| `connect()` | Authenticate (reusing saved state) + load devices. Idempotent; called automatically. |
| `getDevices()` | `Promise<DeviceInfo[]>` — every device on the account. |
| `device(name)` / `devices(names)` / `all()` | Choose targets. Chainable. |
| `speak(text)` | Plain TTS (no chime). |
| `announce(text)` | Amazon "Announcement" (chime + speech). |
| `notify(text)` | Alias of `announce` — the headline verb. |
| `reminder(text, when?)` | Create a reminder (`when` defaults to +1 min). |

Single-target calls resolve a status string and reject on failure. Multi-target
calls (`devices()`/`all()`) resolve a `DeviceResult[]` and never reject because of
one device.

### Options

| Option | Description |
| --- | --- |
| `proxy` | `true` or `{ host, port }` — interactive proxy login (handles 2FA). |
| `cookie` | A previously captured cookie string / registration object. |
| `statePath` | Where to persist auth (default `~/.alexa-notifier/state.json`; `false` to disable). |
| `amazonPage` | Amazon domain, e.g. `amazon.com`, `amazon.de`. |
| `alexaServiceHost` | e.g. `pitangui.amazon.com` (NA), `layla.amazon.com` (EU). |
| `client` | Bring your own configured `alexa-remote2` instance. |
| `init` | Extra options passed straight to `alexa-remote2`'s `init`. |

## Notes & gotchas

- **Do Not Disturb silences announcements.** If a call returns `ok` but you hear
  nothing, check whether the device has DND on — Amazon still accepts the command,
  it just won't play. You can toggle it through the underlying client:
  ```ts
  const alexa = new AlexaNotifier(/* … */)
  await alexa.connect()
  alexa.raw.setDoNotDisturb('Bedroom', false, () => {}) // raw = full alexa-remote2 API
  ```
- **First login:** use the `proxy` flow on a **desktop browser** (a phone may
  deep-link into the Alexa app), and open the exact `http://<ip>:<port>` URL it
  prints — it must match `proxy.host`. After that, the saved session is reused.
- `.raw` exposes the underlying `alexa-remote2` instance for anything outside this
  facade (volumes, routines, smart-home, etc.).

## How is this different from alexa-remote2?

`alexa-remote2` is a powerful, low-level, callback-based client exposing ~150
methods. `alexa-notifier` is a thin, opinionated facade over it for one job —
**getting messages onto your speakers** — with a Promise API, types, multi-device
fan-out, and automatic auth persistence. Reach for `alexa-remote2` directly if you
need the full surface; reach for this when you just want to notify.

## License

MIT © Noel Portugal
