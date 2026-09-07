import { expect, test } from 'bun:test'
import { executeRequest } from '../src/internal/ofetch-transport.ts'

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
