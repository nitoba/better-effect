/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-runtime-typeof, eslint(no-unused-vars), eslint(require-yield) -- test schema and transport doubles intentionally erase their runtime contracts. */
import { expect, test } from 'bun:test'
import { bindEndpoints, HttpEndpoint } from '../src/endpoints.ts'

const schema = <T>(check: (value: unknown) => value is T) => ({
  '~standard': {
    version: 1 as const,
    vendor: 'test',
    validate: (value: unknown) => (check(value) ? { value } : { issues: [{ message: 'invalid' }] })
  }
})

test('declarative endpoints validate and encode path parameters at consumption time', async () => {
  let request: { path: string; options: Record<string, unknown> } | undefined
  const client = {
    request: (method: string, path: string, options: Record<string, unknown>) => {
      request = { path: `${method} ${path}`, options }
      return (async function* () {
        yield* []
        return {
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          url: path,
          data: { id: 'ok' }
        }
      })()
    }
  } as never
  const endpoints = bindEndpoints(client, {
    find: HttpEndpoint.get('/users/:id', {
      params: schema((v): v is { id: string } => !!v && typeof v === 'object' && 'id' in v)
    })
  })
  const operation = endpoints.find({ params: { id: 'a/b?x#y' } })
  expect(request).toBeUndefined()
  const result = await operation.next()
  expect(result.done).toBe(true)
  expect(request?.path).toBe('GET /users/a%2Fb%3Fx%23y')
})
