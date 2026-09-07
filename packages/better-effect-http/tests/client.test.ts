import { expect, test } from 'bun:test'
import { executeRequest } from '../src/internal/ofetch-transport.ts'
import { linkSignals } from '../src/internal/signals.ts'

test('composed signals preserve the first abort reason and clean up listeners', () => {
  const first = new AbortController()
  const second = new AbortController()
  const linked = linkSignals(first.signal, second.signal)
  const reason = new Error('caller')
  first.abort(reason)
  expect(linked.signal.aborted).toBe(true)
  expect(linked.signal.reason).toBe(reason)
  linked.dispose()
  second.abort(new Error('other'))
  expect(linked.signal.reason).toBe(reason)
})

test('transport uses an injected fetch once when consumed', async () => {
  let calls = 0
  const fetch = Object.assign(
    async (
      _input: Parameters<typeof globalThis.fetch>[0],
      _init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      calls++
      return new Response('{"ok":true}', { status: 200 })
    },
    { preconnect: () => {} }
  )
  expect(calls).toBe(0)
  const response = await executeRequest({ fetch }, { method: 'GET', path: 'https://example.test' })
  expect(calls).toBe(1)
  expect(response.status).toBe(200)
})
