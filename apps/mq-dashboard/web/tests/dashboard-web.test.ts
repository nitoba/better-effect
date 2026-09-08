import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'

import { appendEventToBuffer, eventStreamPath, type CursorEvent } from '../src/lib/event-tail'

const event = (cursor: string): CursorEvent => ({ cursor })

test('keeps the live tail bounded and reports every dropped event', () => {
  const emptyEvents: readonly CursorEvent[] = []
  let state = { events: emptyEvents, dropped: 0 }

  for (let index = 1; index <= 205; index += 1) {
    state = appendEventToBuffer(state.events, event(`event-${index}`), state.dropped)
  }

  expect(state.events).toHaveLength(200)
  expect(state.events[0]?.cursor).toBe('event-6')
  expect(state.events.at(-1)?.cursor).toBe('event-205')
  expect(state.dropped).toBe(5)
})

test('coalesces duplicate durable cursors without growing the bounded buffer', () => {
  const first = appendEventToBuffer([], event('event-1'))
  const second = appendEventToBuffer(first.events, event('event-1'), first.dropped)

  expect(second.events).toHaveLength(1)
  expect(second.events[0]?.cursor).toBe('event-1')
  expect(second.coalesced).toBe(1)
})

test('builds a reconnect URL from the durable cursor and filters', () => {
  const url = new URL(
    `http://dashboard.test${eventStreamPath({
      after: 'cursor 2',
      queue: 'email/priority',
      type: 'job-completed'
    })}`
  )

  expect(url.pathname).toBe('/api/events/stream')
  expect(url.searchParams.get('after')).toBe('cursor 2')
  expect(url.searchParams.get('queue')).toBe('email/priority')
  expect(url.searchParams.get('type')).toBe('job-completed')
  expect(url.searchParams.get('limit')).toBe('50')
  expect(url.searchParams.get('heartbeatMs')).toBe('15000')
})

test('keeps status labels accessible and does not expose proxy secrets in the client source', async () => {
  const appSource = await Bun.file(new URL('../src/App.tsx', import.meta.url)).text()
  const statusSource = await Bun.file(
    new URL('../src/components/status-badge.tsx', import.meta.url)
  ).text()

  expect(appSource).toContain('aria-label="Filtrar por fila"')
  expect(appSource).toContain('role="status"')
  expect(appSource).toContain('Last-Event-ID')
  expect(appSource).toContain('source.onerror')
  expect(appSource).toContain('Perdas de lease')
  expect(appSource).toContain('Stalled recoveries')
  expect(appSource).toContain('Wake / awaitEvents')
  expect(appSource).toContain('Fallback para polling')
  expect(statusSource).toContain('aria-label=')
  expect(appSource).not.toContain('MQ_DASHBOARD_TOKEN')
  expect(statusSource).not.toContain('MQ_DASHBOARD_TOKEN')
})

test('does not embed the dashboard token or proxy configuration in built client assets', async () => {
  const assetsDirectory = new URL('../dist/assets/', import.meta.url)
  const assetNames = (await readdir(assetsDirectory.pathname)).filter((name) =>
    name.endsWith('.js')
  )
  expect(assetNames.length).toBeGreaterThan(0)

  const bundle = await Promise.all(
    assetNames.map((name) => Bun.file(join(assetsDirectory.pathname, name)).text())
  ).then((chunks) => chunks.join('\n'))

  expect(bundle).not.toContain('MQ_DASHBOARD_TOKEN')
  expect(bundle).not.toContain('x-dashboard-csrf')
  expect(bundle).not.toContain('local-dev-token')
})
