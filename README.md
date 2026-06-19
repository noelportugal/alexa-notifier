# alexa-notifier

Speak, **announce**, notify, and set **reminders** on your Amazon Echo / Alexa
devices — a small, modern, **Promise-first TypeScript** notifier with
**zero runtime dependencies**.

It's the Alexa counterpart to
[`google-home-notifier`](https://github.com/noelportugal/google-home-notifier):
the same ergonomic `device()` / `devices()` / `notify()` shape, so you get
symmetric tools for both ecosystems.

- 📦 **Zero runtime dependencies** — talks to Amazon's Alexa API directly with `fetch`.
- 🧊 **Tiny, focused surface** — `speak` · `announce` · `notify` · `reminder` · `setDoNotDisturb` · `getDevices`.
- ⛓️ **Promise-first** — `await alexa.notify('…')`. No callbacks.
- 🟦 **TypeScript**, shipped as **dual ESM + CJS** with types.
- 🔁 **Multi-device fan-out** — broadcast to many; one offline Echo never blocks the rest.
- 🔐 **Login once** — works with your existing Amazon account (no skill/developer setup); session is cached and reused.

## Install

```sh
npm install alexa-notifier
```

## Quick start

```ts
import { AlexaNotifier } from 'alexa-notifier'

const alexa = new AlexaNotifier({ proxy: true }); // interactive login (handles MFA)
await alexa.connect();                            // prints a URL to open once; then cached
// (proxy login uses the optional `alexa-cookie2` package: `npm i alexa-cookie2`)

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
| `setDoNotDisturb(enabled)` | Toggle DND on the target device(s). |

Single-target calls resolve a status string and reject on failure. Multi-target
calls (`devices()`/`all()`) resolve a `DeviceResult[]` and never reject because of
one device.

### Options

| Option | Description |
| --- | --- |
| `cookie` | A cookie string, or a saved registration object — skips login entirely (zero-dep path). |
| `proxy` | `true` or `{ host, port }` — interactive login (handles 2FA). Needs the optional `alexa-cookie2` package. |
| `statePath` | Where to persist the session (default `~/.alexa-notifier/state.json`; `false` to disable). |
| `amazonPage` | Amazon domain, e.g. `amazon.com` (default), `amazon.de`. |
| `alexaServiceHost` | API host override. Default `alexa.<amazonPage>`. |
| `language` | Locale for TTS/announcement payloads + `Accept-Language`. Default `en-US`. |
| `onProxyUrl` | Callback invoked with the proxy login URL when interactive sign-in is needed. |
| `fetch` | Inject a `fetch` implementation (defaults to global `fetch`). |

## Notes & gotchas

- **Do Not Disturb silences announcements.** If a call returns `ok` but you hear
  nothing, the device almost certainly has DND on — Amazon accepts the command, it
  just won't play. Toggle it directly:
  ```ts
  await alexa.device('Bedroom').setDoNotDisturb(false)
  await alexa.device('Bedroom').announce('You can hear me now')
  await alexa.device('Bedroom').setDoNotDisturb(true)
  ```
- **First login:** use the `proxy` flow on a **desktop browser** (a phone may
  deep-link into the Alexa app), and open the exact `http://<ip>:<port>` URL it
  prints — it must match `proxy.host`. After that, the saved session is reused.

## Dependencies & how it works

The published package has **zero runtime dependencies** — it calls Amazon's Alexa
endpoints directly (`/api/devices-v2/device`, `/api/behaviors/preview`,
`/api/notifications`, `/api/dnd/status`) with `fetch`, using a session cookie.

The only hard part of Alexa automation is **login + token refresh**, which is
exactly why this library makes it optional: pass a `cookie`/saved session and it
works dependency-free, or install [`alexa-cookie2`](https://www.npmjs.com/package/alexa-cookie2)
to enable the interactive `proxy` login. Unlike wrappers around `alexa-remote2`,
the actual functionality here is its own small, self-contained code.

## License

MIT © Noel Portugal
