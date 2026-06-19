import { describe, it, expect } from 'vitest'
import { AlexaNotifier, normalizeDevices, shapeResults, type AlexaClient } from '../src/index'

function mockClient(): AlexaClient & { calls: any[] } {
  return {
    calls: [] as any[],
    serialNumbers: {
      S1: { accountName: 'Living Room', serialNumber: 'S1', deviceType: 'AB', online: true },
      S2: { accountName: 'Kitchen', serialNumber: 'S2', deviceType: 'AB', online: false },
      bad: { serialNumber: 'S3' }, // missing accountName -> filtered
    },
    init(_o: unknown, cb: (e?: Error | null) => void) { cb(null) },
    on() {},
    sendSequenceCommand(serial, command, value, _oc, cb) {
      ;(this as any).calls.push({ serial, command, value })
      if (serial === 'FAIL') return cb(new Error('boom'))
      cb(null, 'done')
    },
    setReminder(serial, timestamp, label, cb) {
      ;(this as any).calls.push({ serial, timestamp, label, reminder: true })
      cb(null)
    },
  }
}

describe('normalizeDevices', () => {
  it('maps and filters the serialNumbers map', () => {
    const list = normalizeDevices(mockClient().serialNumbers)
    expect(list).toHaveLength(2) // "bad" (no accountName) dropped
    expect(list[0]).toMatchObject({ name: 'Living Room', serialNumber: 'S1', online: true })
    expect(list[1].online).toBe(false)
  })
  it('handles empty/undefined input', () => {
    expect(normalizeDevices()).toEqual([])
  })
})

describe('shapeResults', () => {
  it('single target collapses to a string', () => {
    expect(shapeResults(['A'], [{ status: 'fulfilled', value: 'ok' }])).toBe('ok')
  })
  it('single target rethrows on failure', () => {
    expect(() => shapeResults(['A'], [{ status: 'rejected', reason: new Error('nope') }])).toThrow('nope')
  })
  it('multiple targets resolve an array and never throw on one failure', () => {
    const out = shapeResults(
      ['A', 'B'],
      [
        { status: 'fulfilled', value: 'ok' },
        { status: 'rejected', reason: new Error('boom') },
      ],
    ) as any[]
    expect(out).toEqual([
      { device: 'A', result: 'ok' },
      { device: 'B', error: 'boom' },
    ])
  })
})

describe('AlexaNotifier', () => {
  const make = () => {
    const client = mockClient()
    return { client, alexa: new AlexaNotifier({ client, statePath: false }) }
  }

  it('speak() targets one device and resolves a status string', async () => {
    const { client, alexa } = make()
    const res = await alexa.device('Living Room').speak('hello')
    expect(res).toBe('ok')
    expect(client.calls[0]).toEqual({ serial: 'Living Room', command: 'speak', value: 'hello' })
  })

  it('notify() is an announcement', async () => {
    const { client, alexa } = make()
    await alexa.device('Kitchen').notify('dinner')
    expect(client.calls[0]).toMatchObject({ command: 'announcement', value: 'dinner' })
  })

  it('devices() fans out; one failure does not block the rest', async () => {
    const { alexa } = make()
    const res = (await alexa.devices(['Living Room', 'FAIL']).speak('hi')) as any[]
    expect(res).toEqual([
      { device: 'Living Room', result: 'ok' },
      { device: 'FAIL', error: 'boom' },
    ])
  })

  it('all() resolves to every device serial', async () => {
    const { client, alexa } = make()
    await alexa.all().speak('everywhere')
    expect(client.calls.map((c) => c.serial).sort()).toEqual(['S1', 'S2'])
  })

  it('reminder() calls setReminder with a timestamp', async () => {
    const { client, alexa } = make()
    const when = new Date('2030-01-01T08:00:00Z')
    await alexa.device('Living Room').reminder('wake up', when)
    expect(client.calls[0]).toMatchObject({ reminder: true, label: 'wake up', timestamp: when.getTime() })
  })

  it('devices() validates its argument', () => {
    const { alexa } = make()
    expect(() => alexa.devices('nope' as any)).toThrow(TypeError)
  })
})
