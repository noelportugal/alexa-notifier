/**
 * alexa-notifier — speak, announce, notify, and set reminders on your Echo / Alexa
 * devices. Zero runtime dependencies: it talks to Amazon's Alexa endpoints directly
 * with `fetch`. Interactive login is optional and only pulls in `alexa-cookie2`
 * if you ask for it.
 *
 * Mirrors the ergonomics of `google-home-notifier` so you get symmetric tools for
 * both ecosystems.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const OFFICIAL_UA =
  'AppleWebKit PitanguiBridge/2.2.595606.0-[HARDWARE=iPhone14_7][SOFTWARE=17.4.1][DEVICE=iPhone]'

export interface AlexaNotifierOptions {
  /** A cookie string, or a saved registration object (with `localCookie`/`csrf`). */
  cookie?: string | Registration
  /** Amazon domain, e.g. `amazon.com` (default), `amazon.de`, `amazon.co.uk`. */
  amazonPage?: string
  /** API host override. Default `alexa.<amazonPage>`. */
  alexaServiceHost?: string
  /** Locale used for TTS/announcement payloads + `Accept-Language`. Default `en-US`. */
  language?: string
  /** Where to persist the session so you only log in once. Default `~/.alexa-notifier/state.json`. `false` disables. */
  statePath?: string | false
  /** Interactive login (handles MFA). Requires the optional `alexa-cookie2` package. */
  proxy?: boolean | { host?: string; port?: number }
  /** Called with the proxy login URL when interactive sign-in is required. */
  onProxyUrl?: (url: string) => void
  /** Inject a `fetch` implementation (defaults to global `fetch`; handy for tests). */
  fetch?: FetchLike
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

export interface Registration {
  localCookie?: string
  csrf?: string
  [key: string]: unknown
}

type FetchLike = (url: string, init?: {
  method?: string
  headers?: Record<string, string>
  body?: string
}) => Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }>

interface RawDevice {
  accountName?: string
  serialNumber?: string
  deviceType?: string
  online?: boolean
  deviceFamily?: string
  deviceOwnerCustomerId?: string
}

const SUCCESS = 'ok'
const SEQUENCE_TYPE = 'com.amazon.alexa.behaviors.model.Sequence'
const OPAQUE_NODE = 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode'

// --- pure helpers (exported for testing) ----------------------------------

/** Pull the csrf token out of a cookie string. */
export function extractCsrf(cookie: string): string | undefined {
  const m = /csrf=([^;]+)/.exec(cookie || '')
  return m ? m[1] : undefined
}

/** alexa-cookie2 reports the proxy login prompt as an "error" — detect it. */
export function isProxyPrompt(message: string): boolean {
  return /open .*http.*browser|login to amazon|proxy/i.test(message)
}

/** Pull the first http(s) URL out of a message. */
export function extractUrl(message: string): string | undefined {
  const m = message.match(/https?:\/\/[^\s'"]+/)
  return m ? m[0] : undefined
}

/** Clean the raw `/api/devices-v2/device` list into a stable shape. */
export function normalizeDevices(devices: RawDevice[] = []): DeviceInfo[] {
  return devices
    .filter((d) => d && d.serialNumber && d.accountName)
    .map((d) => ({
      name: d.accountName!,
      serialNumber: d.serialNumber!,
      deviceType: d.deviceType ?? '',
      online: !!d.online,
      family: d.deviceFamily,
    }))
}

/** Collapse per-target outcomes: single → string (or throw); many → array (never throws on one). */
export function shapeResults(labels: string[], settled: PromiseSettledResult<string>[]): NotifyResult {
  if (labels.length === 1) {
    const only = settled[0]
    if (only.status === 'rejected') throw only.reason
    return only.value
  }
  return settled.map((r, i) =>
    r.status === 'fulfilled'
      ? { device: labels[i], result: r.value }
      : { device: labels[i], error: r.reason instanceof Error ? r.reason.message : String(r.reason) },
  )
}

/** Build the `/api/behaviors/preview` body for a speak/announcement node. */
export function buildPreviewBody(node: object): { behaviorId: string; sequenceJson: string; status: string } {
  return {
    behaviorId: 'PREVIEW',
    sequenceJson: JSON.stringify({ '@type': SEQUENCE_TYPE, startNode: node }),
    status: 'ENABLED',
  }
}

export function speakNode(dev: RawDevice, text: string, locale: string): object {
  return {
    '@type': OPAQUE_NODE,
    type: 'Alexa.Speak',
    skillId: 'amzn1.ask.1p.saysomething',
    operationPayload: {
      deviceType: dev.deviceType,
      deviceSerialNumber: dev.serialNumber,
      locale,
      customerId: dev.deviceOwnerCustomerId,
      textToSpeak: text,
    },
  }
}

export function announceNode(dev: RawDevice, text: string, locale: string): object {
  return {
    '@type': OPAQUE_NODE,
    type: 'AlexaAnnouncement',
    skillId: 'amzn1.ask.1p.routines.messaging',
    operationPayload: {
      customerId: dev.deviceOwnerCustomerId,
      expireAfter: 'PT5S',
      content: [
        {
          locale,
          display: { title: 'alexa-notifier', body: text },
          speak: { type: 'text', value: text },
        },
      ],
      target: {
        customerId: dev.deviceOwnerCustomerId,
        devices: [{ deviceSerialNumber: dev.serialNumber, deviceTypeId: dev.deviceType }],
      },
    },
  }
}

export function reminderObject(dev: RawDevice, label: string, when: Date): object {
  const _00 = (n: number) => String(n).padStart(2, '0')
  return {
    type: 'Reminder',
    status: 'ON',
    alarmTime: when.getTime(),
    createdDate: Date.now(),
    deviceSerialNumber: dev.serialNumber,
    deviceType: dev.deviceType,
    reminderLabel: label,
    originalDate: `${when.getFullYear()}-${_00(when.getMonth() + 1)}-${_00(when.getDate())}`,
    originalTime: `${_00(when.getHours())}:${_00(when.getMinutes())}:${_00(when.getSeconds())}.000`,
    id: null,
    isRecurring: false,
    recurringPattern: null,
    timeZoneId: null,
    reminderIndex: null,
  }
}

function defaultStatePath(): string {
  return join(homedir(), '.alexa-notifier', 'state.json')
}

// --- the notifier ----------------------------------------------------------

export class AlexaNotifier {
  private opts: AlexaNotifierOptions
  private fetchImpl: FetchLike
  private amazonPage: string
  private baseHost: string
  private language: string
  private statePath: string | false
  private cookie = ''
  private csrf = ''
  private connected = false
  private targets: string[] | null = null
  private bySerial = new Map<string, RawDevice>()
  private byName = new Map<string, RawDevice>()

  constructor(opts: AlexaNotifierOptions = {}) {
    this.opts = opts
    this.fetchImpl = (opts.fetch ?? (globalThis.fetch as unknown as FetchLike))
    this.amazonPage = opts.amazonPage ?? 'amazon.com'
    this.baseHost = opts.alexaServiceHost ?? `alexa.${this.amazonPage}`
    this.language = opts.language ?? 'en-US'
    this.statePath = opts.statePath ?? defaultStatePath()
  }

  /** Authenticate (reusing a saved session when possible) and load devices. Idempotent. */
  async connect(): Promise<this> {
    if (this.connected) return this
    if (!this.fetchImpl) throw new Error('No fetch available — Node 18+ or pass options.fetch')

    let reg: string | Registration | undefined = this.opts.cookie ?? this.loadState()
    if (!this.applyAuth(reg)) {
      if (this.opts.proxy) {
        reg = await this.proxyLogin()
        this.saveState(reg)
        this.applyAuth(reg)
      } else {
        throw new Error(
          'No session — pass `cookie`, a saved state file, or `proxy: true` (needs the optional alexa-cookie2 package).',
        )
      }
    }
    await this.loadDevices()
    this.connected = true
    return this
  }

  /** Every Alexa device on the account. */
  async getDevices(): Promise<DeviceInfo[]> {
    await this.connect()
    return normalizeDevices([...this.bySerial.values()])
  }

  device(nameOrSerial: string): this {
    this.targets = [nameOrSerial]
    return this
  }

  devices(namesOrSerials: string[]): this {
    if (!Array.isArray(namesOrSerials)) throw new TypeError('devices() expects an array')
    this.targets = namesOrSerials.slice()
    return this
  }

  all(): this {
    this.targets = null
    return this
  }

  /** Plain TTS (no chime). */
  speak(text: string): Promise<NotifyResult> {
    return this.fanOut((dev) =>
      this.preview(buildPreviewBody(speakNode(dev, text, this.language))),
    )
  }

  /** Amazon "Announcement" (chime + speech). */
  announce(text: string): Promise<NotifyResult> {
    if (!text || !text.trim()) return Promise.reject(new Error('announce(text) needs a non-empty string'))
    return this.fanOut((dev) =>
      this.preview(buildPreviewBody(announceNode(dev, text, this.language))),
    )
  }

  /** Alias of {@link announce}. */
  notify(text: string): Promise<NotifyResult> {
    return this.announce(text)
  }

  /** Create a reminder. `when` defaults to one minute out. */
  reminder(text: string, when?: Date | number): Promise<NotifyResult> {
    const date = when instanceof Date ? when : new Date(when ?? Date.now() + 60_000)
    return this.fanOut(async (dev) => {
      await this.api('/api/notifications/null', 'PUT', reminderObject(dev, text, date))
      return SUCCESS
    })
  }

  /** Toggle Do Not Disturb on the target device(s). Note: DND silences announcements. */
  setDoNotDisturb(enabled: boolean): Promise<NotifyResult> {
    return this.fanOut(async (dev) => {
      await this.api('/api/dnd/status', 'PUT', {
        deviceSerialNumber: dev.serialNumber,
        deviceType: dev.deviceType,
        enabled,
      })
      return SUCCESS
    })
  }

  // --- internals ----------------------------------------------------------

  private async preview(body: object): Promise<string> {
    await this.api('/api/behaviors/preview', 'POST', body)
    return SUCCESS
  }

  private async fanOut(action: (dev: RawDevice) => Promise<string>): Promise<NotifyResult> {
    await this.connect()
    const devs = this.resolveTargets()
    if (!devs.length) throw new Error('No matching devices — check device()/devices() names or the account')
    const labels = devs.map((d) => d.accountName ?? d.serialNumber ?? 'device')
    const settled = await Promise.allSettled(devs.map((d) => action(d)))
    return shapeResults(labels, settled)
  }

  private resolveTargets(): RawDevice[] {
    if (!this.targets) return [...this.bySerial.values()]
    const out: RawDevice[] = []
    for (const t of this.targets) {
      const dev = this.bySerial.get(t) ?? this.byName.get(t.toLowerCase())
      if (dev) out.push(dev)
    }
    return out
  }

  private applyAuth(reg?: string | Registration): boolean {
    if (!reg) return false
    if (typeof reg === 'string') {
      this.cookie = reg
      this.csrf = extractCsrf(reg) ?? ''
    } else if (reg.localCookie) {
      this.cookie = reg.localCookie
      this.csrf = reg.csrf || extractCsrf(reg.localCookie) || ''
    }
    return !!this.cookie && !!this.csrf
  }

  private async api(path: string, method: string, body?: object): Promise<unknown> {
    const headers: Record<string, string> = {
      'User-Agent': OFFICIAL_UA,
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json; charset=utf-8',
      'Accept-Language': this.language,
      Referer: `https://alexa.${this.amazonPage}/spa/index.html`,
      Origin: `https://alexa.${this.amazonPage}`,
      csrf: this.csrf,
      Cookie: this.cookie,
    }
    const res = await this.fetchImpl(`https://${this.baseHost}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let data: unknown = null
    if (text) {
      try { data = JSON.parse(text) } catch { data = text }
    }
    if (!res.ok) {
      const msg = (data && typeof data === 'object' && 'message' in data && (data as any).message) || res.statusText
      const err = new Error(`Alexa API ${res.status}: ${msg}`) as Error & { status?: number }
      err.status = res.status
      throw err
    }
    return data
  }

  private async loadDevices(): Promise<void> {
    const data = (await this.api('/api/devices-v2/device?cached=true', 'GET')) as { devices?: RawDevice[] }
    this.bySerial.clear()
    this.byName.clear()
    for (const d of data?.devices ?? []) {
      if (!d.serialNumber || !d.accountName) continue // skip phantom/unaddressable entries
      this.bySerial.set(d.serialNumber, d)
      this.byName.set(d.accountName.toLowerCase(), d)
    }
  }

  private async proxyLogin(): Promise<Registration> {
    const proxy = this.opts.proxy
    const cfg = typeof proxy === 'object' ? proxy : {}
    let mod: any
    try {
      const spec = 'alexa-cookie2'
      mod = await import(spec)
    } catch {
      throw new Error('Interactive login needs the optional package: `npm i alexa-cookie2`')
    }
    const alexaCookie = mod.default ?? mod
    return new Promise<Registration>((resolve, reject) => {
      let settled = false
      const options = {
        setupProxy: true,
        proxyOwnIp: cfg.host ?? '127.0.0.1',
        proxyPort: cfg.port ?? 0,
        proxyListenBind: '0.0.0.0',
        amazonPage: this.amazonPage,
      }
      alexaCookie.generateAlexaCookie(null, null, options, (err: Error | null, result?: Registration) => {
        if (result && result.localCookie) {
          settled = true
          try { alexaCookie.stopProxyServer() } catch { /* noop */ }
          resolve(result)
          return
        }
        if (err) {
          const msg = err.message || String(err)
          if (isProxyPrompt(msg)) {
            const url = extractUrl(msg)
            if (url) (this.opts.onProxyUrl ?? ((u: string) => console.log(`[alexa-notifier] Open this URL and sign in: ${u}`)))(url)
          } else if (!settled) {
            reject(new Error(msg))
          }
        }
      })
    })
  }

  private loadState(): Registration | undefined {
    if (this.statePath === false || !existsSync(this.statePath)) return undefined
    try { return JSON.parse(readFileSync(this.statePath, 'utf8')) } catch { return undefined }
  }

  private saveState(data: unknown): void {
    if (this.statePath === false || data == null) return
    try {
      mkdirSync(dirname(this.statePath), { recursive: true })
      writeFileSync(this.statePath, JSON.stringify(data, null, 2))
      chmodSync(this.statePath, 0o600)
    } catch { /* best effort */ }
  }
}

export default AlexaNotifier
