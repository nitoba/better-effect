// oxlint-disable typescript/await-thenable -- bun:test's rejects matcher is awaited to execute the assertion.
import { expect, test } from 'bun:test'
import { controlledStream, HttpTest } from '../src/testing.ts'

test('sequences are isolated and record matched requests by attempt', async () => {
  const first = HttpTest.sequence([
    HttpTest.response(200, { id: 'u1' }, { match: { method: 'GET', url: /users\/u1/u } }),
    HttpTest.response(200, { id: 'u2' }, { match: { method: 'GET', url: /users\/u2/u } })
  ])
  const second = HttpTest.sequence([HttpTest.text(200, 'independent')])

  const response = await first.fetch('https://example.test/users/u1')
  expect(await response.json()).toEqual({ id: 'u1' })
  expect(first.history).toMatchObject([
    {
      method: 'GET',
      url: 'https://example.test/users/u1',
      index: 0,
      outcome: 'response'
    }
  ])

  await expect(first.fetch('https://example.test/other')).rejects.toThrow('mismatch')
  expect(first.history.at(-1)?.outcome).toBe('error')
  expect(first.remaining).toBe(0)

  const independent = await second.fetch('https://example.test/health')
  expect(await independent.text()).toBe('independent')
  expect(second.calls).toBe(1)
  expect(first.calls).toBe(2)
})

test('response factories cover JSON, text, bytes, no-content, and network errors', async () => {
  const cause = new Error('offline')
  const scenario = HttpTest.sequence([
    HttpTest.response(200, { ok: true }, { headers: { 'x-request-id': 'one' } }),
    HttpTest.text(200, 'plain'),
    HttpTest.bytes(200, new Uint8Array([1, 2, 3])),
    HttpTest.response(204, undefined, { headers: { 'x-empty': 'yes' } }),
    HttpTest.error(cause)
  ])

  const json = await scenario.fetch('https://example.test/json')
  expect(json.headers.get('x-request-id')).toBe('one')
  expect(await json.json()).toEqual({ ok: true })
  expect(await (await scenario.fetch('https://example.test/text')).text()).toBe('plain')
  expect([
    ...new Uint8Array(await (await scenario.fetch('https://example.test/bytes')).arrayBuffer())
  ]).toEqual([1, 2, 3])
  const empty = await scenario.fetch('https://example.test/empty')
  expect(empty.status).toBe(204)
  expect(empty.body).toBeNull()
  expect(empty.headers.get('x-empty')).toBe('yes')
  await expect(scenario.fetch('https://example.test/offline')).rejects.toBe(cause)
  expect(scenario.history.map(({ outcome }) => outcome)).toEqual([
    'response',
    'response',
    'response',
    'response',
    'error'
  ])
})

test('controlled streams expose demand, chunks, EOF, late failures, and cancellation', async () => {
  const stream = controlledStream()
  const scenario = HttpTest.sequence([HttpTest.stream(stream)])
  const response = await scenario.fetch('https://example.test/stream')
  const reader = response.body?.getReader()
  expect(reader).toBeDefined()
  if (reader === undefined) return

  const first = reader.read()
  stream.releaseHeaders()
  stream.push('hello')
  expect(await first).toMatchObject({ done: false, value: new TextEncoder().encode('hello') })

  const pending = reader.read()
  stream.push(new Uint8Array([33]))
  expect(await pending).toMatchObject({ done: false, value: new Uint8Array([33]) })

  const end = reader.read()
  stream.end()
  expect(await end).toMatchObject({ done: true, value: undefined })

  const cancellationStream = controlledStream()
  const cancellationResponse = await HttpTest.sequence([HttpTest.stream(cancellationStream)]).fetch(
    'https://example.test/cancel'
  )
  const cancellationReader = cancellationResponse.body?.getReader()
  expect(cancellationReader).toBeDefined()
  if (cancellationReader === undefined) return
  cancellationStream.releaseHeaders()
  const cancellation = cancellationReader.read()
  await cancellationReader.cancel('stop')
  await cancellation
  expect(cancellationStream.stats.cancels).toBe(1)

  const failedStream = controlledStream()
  const failedResponse = await HttpTest.sequence([HttpTest.stream(failedStream)]).fetch(
    'https://example.test/failure'
  )
  const failedReader = failedResponse.body?.getReader()
  expect(failedReader).toBeDefined()
  if (failedReader === undefined) return
  const failure = new Error('late stream failure')
  const failedRead = failedReader.read()
  failedStream.releaseHeaders()
  failedStream.fail(failure)
  await expect(failedRead).rejects.toBe(failure)
})

test('an exhausted sequence fails explicitly instead of falling back to network', async () => {
  const scenario = HttpTest.sequence([])
  await expect(scenario.fetch('https://example.test/unconfigured')).rejects.toThrow('exhausted')
  expect(scenario.calls).toBe(1)
  expect(scenario.history[0]?.outcome).toBe('error')
  expect(scenario.remaining).toBe(-1)
})
