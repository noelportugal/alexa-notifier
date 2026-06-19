import { describe, it, expect } from 'vitest'
import {
  AlexaNotifier,
  normalizeDevices,
  shapeResults,
  extractCsrf,
  speakNode,
  announceNode,
  buildPreviewBody,
  reminderObject,
} from '../src/index'

const DEVICES = {
  devices: [
    { accountName: 'Living Room', serialNumber: 'S1', deviceType: 'AB', online: true, deviceOwnerCustomerId: 'C1', deviceFamily: 'ECHO' },
    { accountName: 'Kitchen', serialNumber: 'S2', deviceType: 'AB', online: false, deviceOwnerCustomerId: 'C1' },
    { serialNumber: 'S3' }, // no accountName -> filtered from getDevices()
  ],
}

// A fetch stub that records calls and routes by URL.
function fakeFetch(routes: Record<string, { ok?: boolean; status?: number; body?: unknown }>) {
  const calls: { url: string; init: any }[] = []
  const fn = async (url: string, init?: any) => {
    calls.push({ url, init })
    const key = Object.keys(routes).find((k) => url.includes(k)) ?? '__default__'
    const r = routes[key] ?? { body: {} }
    return {
      ok: r.ok !== false,
      status: r.status ?? 200,
      statusText: 'OK',
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})),
    }
  }
  return { fn, calls }
}

const COOKIE = 'session-id=123; csrf=TOKEN123; ubid=x'

function make(routeOverrides: Record<string, any> = {}) {
  const { fn, calls } = fakeFetch({
    '/api/devices-v2/device': { body: DEVICES },
    '/api/behaviors/preview': { body: {} },
    '/api/notifications/null': { body: {} },
    '/api/dnd/status': { body: {} },
    ...routeOverrides,
  })
  const alexa = new AlexaNotifier({ cookie: COOKIE, statePath: false, fetch: fn as any })
  return { alexa, calls }
}

describe('pure helpers', () => {
  it('extractCsrf pulls the token from a cookie', () => {
    expect(extractCsrf(COOKIE)).toBe('TOKEN123')
    expect(extractCsrf('no-token-here')).toBeUndefined()
  })
  it('normalizeDevices filters incomplete entries', () => {
    const list = normalizeDevices(DEVICES.devices)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ name: 'Living Room', serialNumber: 'S1', online: true })
  })
  it('shapeResults: single string, single throw, multi array', () => {
    expect(shapeResults(['A'], [{ status: 'fulfilled', value: 'ok' }])).toBe('ok')
    expect(() => shapeResults(['A'], [{ status: 'rejected', reason: new Error('x') }])).toThrow('x')
    expect(
      shapeResults(['A', 'B'], [
        { status: 'fulfilled', value: 'ok' },
        { status: 'rejected', reason: new Error('boom') },
      ]),
    ).toEqual([{ device: 'A', result: 'ok' }, { device: 'B', error: 'boom' }])
  })
  it('speakNode/announceNode/reminderObject build the right payloads', () => {
    const dev = { serialNumber: 'S1', deviceType: 'AB', deviceOwnerCustomerId: 'C1' }
    const sn: any = speakNode(dev, 'hi', 'en-US')
    expect(sn.type).toBe('Alexa.Speak')
    expect(sn.operationPayload).toMatchObject({ textToSpeak: 'hi', deviceSerialNumber: 'S1', customerId: 'C1' })
    const an: any = announceNode(dev, 'yo', 'en-US')
    expect(an.type).toBe('AlexaAnnouncement')
    expect(an.operationPayload.target.devices[0]).toEqual({ deviceSerialNumber: 'S1', deviceTypeId: 'AB' })
    const body = buildPreviewBody(sn)
    expect(body.behaviorId).toBe('PREVIEW')
    expect(JSON.parse(body.sequenceJson).startNode.type).toBe('Alexa.Speak')
    const rem: any = reminderObject(dev, 'meds', new Date('2030-01-02T03:04:05'))
    expect(rem).toMatchObject({ type: 'Reminder', status: 'ON', reminderLabel: 'meds', originalDate: '2030-01-02' })
  })
})

describe('AlexaNotifier (native, injected fetch)', () => {
  it('connect() loads devices and getDevices() returns them', async () => {
    const { alexa, calls } = make()
    const list = await alexa.getDevices()
    expect(list).toHaveLength(2)
    expect(calls[0].url).toContain('/api/devices-v2/device')
    // auth headers present
    expect(calls[0].init.headers.csrf).toBe('TOKEN123')
    expect(calls[0].init.headers.Cookie).toBe(COOKIE)
  })

  it('speak() posts a preview with the right device + text', async () => {
    const { alexa, calls } = make()
    const res = await alexa.device('Living Room').speak('hello there')
    expect(res).toBe('ok')
    const preview = calls.find((c) => c.url.includes('/api/behaviors/preview'))!
    const seq = JSON.parse(JSON.parse(preview.init.body).sequenceJson)
    expect(seq.startNode.operationPayload).toMatchObject({ textToSpeak: 'hello there', deviceSerialNumber: 'S1' })
  })

  it('notify() is an announcement', async () => {
    const { alexa, calls } = make()
    await alexa.device('Kitchen').notify('dinner')
    const preview = calls.find((c) => c.url.includes('/api/behaviors/preview'))!
    const seq = JSON.parse(JSON.parse(preview.init.body).sequenceJson)
    expect(seq.startNode.type).toBe('AlexaAnnouncement')
  })

  it('all() fans out to every device', async () => {
    const { alexa, calls } = make()
    const res = (await alexa.all().speak('hey')) as any[]
    expect(res).toHaveLength(2)
    expect(calls.filter((c) => c.url.includes('/api/behaviors/preview'))).toHaveLength(2)
  })

  it('one failing device does not block the rest', async () => {
    // Make the preview endpoint fail; with two targets we should get a per-device array.
    const { alexa } = make({ '/api/behaviors/preview': { ok: false, status: 500, body: { message: 'nope' } } })
    const res = (await alexa.devices(['Living Room', 'Kitchen']).speak('hi')) as any[]
    expect(res).toHaveLength(2)
    expect(res.every((r) => 'error' in r)).toBe(true)
  })

  it('reminder() PUTs to the notifications endpoint', async () => {
    const { alexa, calls } = make()
    await alexa.device('Living Room').reminder('stretch', new Date('2030-01-01T09:00:00'))
    const put = calls.find((c) => c.url.includes('/api/notifications/null'))!
    expect(put.init.method).toBe('PUT')
    expect(JSON.parse(put.init.body)).toMatchObject({ type: 'Reminder', reminderLabel: 'stretch' })
  })

  it('setDoNotDisturb() PUTs dnd status', async () => {
    const { alexa, calls } = make()
    await alexa.device('Living Room').setDoNotDisturb(false)
    const put = calls.find((c) => c.url.includes('/api/dnd/status'))!
    expect(JSON.parse(put.init.body)).toEqual({ deviceSerialNumber: 'S1', deviceType: 'AB', enabled: false })
  })

  it('devices() validates input', () => {
    const { alexa } = make()
    expect(() => alexa.devices('nope' as any)).toThrow(TypeError)
  })
})
