/**
 * alexa-notifier — speak, announce, notify, and set reminders on your Echo / Alexa
 * devices. A small, modern, Promise-first TypeScript wrapper that uses
 * {@link https://www.npmjs.com/package/alexa-remote2 | alexa-remote2} only as the
 * transport. Mirrors the ergonomics of `google-home-notifier` so you get
 * symmetric tools for both ecosystems.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import AlexaRemote from 'alexa-remote2'

export interface AlexaNotifierOptions {
  /** A previously captured cookie string or saved registration object. */
  cookie?: string | Record<string, unknown>
  /** Amazon domain, e.g. `amazon.com` (default), `amazon.de`, `amazon.co.uk`. */
  amazonPage?: string
  /** Alexa service host, e.g. `pitangui.amazon.com` (NA), `layla.amazon.com` (EU). */
  alexaServiceHost?: string
  /** Where to persist auth state so you only log in once. Default `~/.alexa-notifier/state.json`. Pass `false` to disable. */
  statePath?: string | false
  /** Use the interactive proxy login flow (handles MFA). `true`, or `{ host, port }`. */
  proxy?: boolean | { host?: string; port?: number }
  /** Called with the proxy login URL when interactive sign-in is required. */
  onProxyUrl?: (url: string) => void
  /** Max time to wait for `connect()` (e.g. for interactive login). Default: no limit. */
  connectTimeoutMs?: number
  /** Extra options passed straight through to alexa-remote2's `init`. */
  init?: Record<string, unknown>
  /** Bring your own pre-configured alexa-remote2 instance (also used for testing). */
  client?: AlexaClient
}

export interface DeviceInfo {
  name: string
  serialNumber: string
  deviceType: string
  online: boolean
  family?: string
}

export type DeviceResult =
  | { device: string; result: string }
  | { device: string; error: string }

export type NotifyResult = string | DeviceResult[]

/** The slice of alexa-remote2 we depend on (kept tiny + swappable for tests). */
export interface AlexaClient {
  init(options: unknown, callback: (err?: Error | null) => void): void
  sendSequenceCommand(
    serialOrName: string,
    command: string,
    value: unknown,
    overrideCustomerId: unknown,
    callback: (err?: Error | null, res?: unknown) => void,
  ): void
  setReminder(
    serialOrName: string,
    timestamp: number,
    label: string,
    callback: (err?: Error | null, res?: unknown) => void,
  ): void
  on?(event: string, listener: (...args: unknown[]) => void): void
  serialNumbers?: Record<string, RawDevice>
  cookieData?: unknown
  cookie?: string
}

interface RawDevice {
  accountName?: string
  serialNumber?: string
  deviceType?: string
  online?: boolean
  deviceFamily?: string
  capabilities?: string[]
}

const SUCCESS = 'ok'

// --- pure helpers (exported for testing) ----------------------------------

/** Turn alexa-remote2's `serialNumbers` map into a clean device list. */
export function normalizeDevices(serialNumbers: Record<string, RawDevice> = {}): DeviceInfo[] {
  return Object.values(serialNumbers)
    .filter((d) => d && d.serialNumber && d.accountName)
    .map((d) => ({
      name: d.accountName!,
      serialNumber: d.serialNumber!,
      deviceType: d.deviceType ?? '',
      online: !!d.online,
      family: d.deviceFamily,
    }))
}

/**
 * Shape per-target outcomes: a single target collapses to its status string (or
 * throws), while multiple targets resolve to an array that never rejects on one
 * failure — so an offline Echo can't block the rest.
 */
export function shapeResults(
  labels: string[],
  settled: PromiseSettledResult<string>[],
): NotifyResult {
  if (labels.length === 1) {
    const only = settled[0]
    if (only.status === 'rejected') throw only.reason
    return only.value
  }
  return settled.map((r, i) =>
    r.status === 'fulfilled'
      ? { device: labels[i], result: r.value }
      : { device: labels[i], error: errMessage(r.reason) },
  )
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** alexa-remote2 reports the proxy login prompt as an "error" — detect it. */
export function isProxyPrompt(message: string): boolean {
  return /open .*http.*browser|login to amazon|proxy/i.test(message)
}

/** Pull the first http(s) URL out of a message. */
export function extractUrl(message: string): string | undefined {
  const m = message.match(/https?:\/\/[^\s'"]+/)
  return m ? m[0] : undefined
}

function defaultStatePath(): string {
  return join(homedir(), '.alexa-notifier', 'state.json')
}

// --- the notifier ----------------------------------------------------------

export class AlexaNotifier {
  private opts: AlexaNotifierOptions
  private client: AlexaClient | null
  private connected: boolean
  private targets: string[] | null = null // null = all devices
  private statePath: string | false

  constructor(opts: AlexaNotifierOptions = {}) {
    this.opts = opts
    this.client = opts.client ?? null
    this.connected = !!opts.client
    this.statePath = opts.statePath ?? defaultStatePath()
  }

  /** Authenticate (reusing saved state when possible) and load devices. Idempotent. */
  async connect(): Promise<this> {
    if (this.connected && this.client) return this
    const client = (this.client ?? new (AlexaRemote as unknown as new () => AlexaClient)())
    this.client = client

    const saved = this.loadState()
    const proxy = this.opts.proxy
    const proxyCfg = typeof proxy === 'object' ? proxy : {}
    const initOptions: Record<string, unknown> = {
      cookie: saved ?? this.opts.cookie,
      amazonPage: this.opts.amazonPage ?? 'amazon.com',
      alexaServiceHost: this.opts.alexaServiceHost,
      useWsMqtt: false,
      cookieRefreshInterval: 7 * 24 * 60 * 60 * 1000,
      ...(proxy
        ? {
            proxyOnly: true,
            proxyOwnIp: proxyCfg.host ?? '127.0.0.1',
            proxyPort: proxyCfg.port ?? 3456,
          }
        : {}),
      ...this.opts.init,
    }

    // Persist refreshed auth so subsequent runs skip the login dance.
    client.on?.('cookie', () => this.saveState(client.cookieData ?? client.cookie))

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const done = (err?: Error) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        err ? reject(err) : resolve()
      }
      const timer =
        this.opts.connectTimeoutMs != null
          ? setTimeout(() => done(new Error(`connect timed out after ${this.opts.connectTimeoutMs}ms`)), this.opts.connectTimeoutMs)
          : null
      if (timer && typeof timer.unref === 'function') timer.unref()

      // Successful auth is signalled by the 'ready' event.
      client.on?.('ready', () => done())

      client.init(initOptions, (err) => {
        if (!err) return done() // cookie/state path: authenticated immediately
        const msg = err.message || String(err)
        // Proxy mode: this "error" is just the prompt to open the login URL.
        if (isProxyPrompt(msg)) {
          const url = extractUrl(msg) ?? msg
          if (this.opts.onProxyUrl) this.opts.onProxyUrl(url)
          else console.log(`[alexa-notifier] Open this URL and sign in: ${url}`)
          return // keep waiting for 'ready'
        }
        done(err)
      })
    })
    this.saveState(client.cookieData ?? client.cookie)
    this.connected = true
    return this
  }

  /** The underlying alexa-remote2 instance — for the full API beyond this facade. */
  get raw(): AlexaClient {
    if (!this.client) throw new Error('not connected — call connect() first')
    return this.client
  }

  /** List all known Alexa devices on the account. */
  async getDevices(): Promise<DeviceInfo[]> {
    await this.connect()
    return normalizeDevices(this.client!.serialNumbers)
  }

  /** Target a single device by name (or serial). Chainable. */
  device(nameOrSerial: string): this {
    this.targets = [nameOrSerial]
    return this
  }

  /** Target several devices. Chainable. */
  devices(namesOrSerials: string[]): this {
    if (!Array.isArray(namesOrSerials)) throw new TypeError('devices() expects an array')
    this.targets = namesOrSerials.slice()
    return this
  }

  /** Target every device on the account. Chainable. */
  all(): this {
    this.targets = null
    return this
  }

  /** Speak text on the target device(s) (plain TTS, no chime). */
  speak(text: string): Promise<NotifyResult> {
    return this.sequence('speak', text)
  }

  /** Announce text on the target device(s) (Amazon "Announcement": chime + speech). */
  announce(text: string): Promise<NotifyResult> {
    return this.sequence('announcement', text)
  }

  /** Alias of {@link announce} — the headline "notify my Echo" verb. */
  notify(text: string): Promise<NotifyResult> {
    return this.announce(text)
  }

  /** Create a reminder on the target device(s). `when` defaults to one minute out. */
  reminder(text: string, when?: Date | number): Promise<NotifyResult> {
    const timestamp = when instanceof Date ? when.getTime() : (when ?? Date.now() + 60_000)
    return this.fanOut(
      (serial) =>
        new Promise<string>((resolve, reject) =>
          this.client!.setReminder(serial, timestamp, text, (err) =>
            err ? reject(err) : resolve(SUCCESS),
          ),
        ),
    )
  }

  // --- internals ----------------------------------------------------------

  private sequence(command: string, value: string): Promise<NotifyResult> {
    return this.fanOut(
      (serial) =>
        new Promise<string>((resolve, reject) =>
          this.client!.sendSequenceCommand(serial, command, value, undefined, (err) =>
            err ? reject(err) : resolve(SUCCESS),
          ),
        ),
    )
  }

  private async fanOut(action: (target: string) => Promise<string>): Promise<NotifyResult> {
    await this.connect()
    const labels = this.resolveTargets()
    if (!labels.length) throw new Error('No devices found — set device()/devices() or check the account')
    const settled = await Promise.allSettled(labels.map((t) => action(t)))
    return shapeResults(labels, settled)
  }

  private resolveTargets(): string[] {
    if (this.targets && this.targets.length) return this.targets
    // "all": use serials so we never depend on display-name uniqueness
    return normalizeDevices(this.client?.serialNumbers).map((d) => d.serialNumber)
  }

  private loadState(): Record<string, unknown> | undefined {
    if (this.statePath === false || !existsSync(this.statePath)) return undefined
    try {
      return JSON.parse(readFileSync(this.statePath, 'utf8'))
    } catch {
      return undefined
    }
  }

  private saveState(data: unknown): void {
    if (this.statePath === false || data == null) return
    try {
      mkdirSync(dirname(this.statePath), { recursive: true })
      writeFileSync(this.statePath, JSON.stringify(data, null, 2))
      chmodSync(this.statePath, 0o600)
    } catch {
      /* best effort */
    }
  }
}

export default AlexaNotifier
