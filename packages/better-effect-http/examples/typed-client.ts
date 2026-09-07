import { Effect, Runtime } from 'better-effect'
import { Schema } from 'better-effect-schema'
import { Result } from 'better-result'
import { HttpClient } from 'better-effect-http'

import { object, schema, string, withLocalServer } from './support'

const userWire = schema((value) => {
  const record = object(value)
  const id = string(record?.['id'])
  const name = string(record?.['name'])
  return id === undefined || name === undefined ? undefined : { id, name }
})
const userProps = schema((value) => {
  const record = object(value)
  const id = string(record?.['id'])
  const name = string(record?.['name'])
  return id === undefined || name === undefined ? undefined : { id, name }
})

class User extends Schema.Class<User>('better-effect-http-example/User')({
  schema: userWire,
  propsSchema: userProps,
  encodedSchema: userWire,
  encode: (value: { readonly id: string; readonly name: string }) => ({
    id: value.id,
    name: value.name
  })
}) {
  greet(): string {
    return `Hello ${this.name}`
  }
}

const notFound = schema((value) => {
  const record = object(value)
  const reason = string(record?.['reason'])
  return reason === undefined ? undefined : { reason }
})

const invalid = schema((value) => {
  const record = object(value)
  const field = string(record?.['field'])
  return field === undefined ? undefined : { field }
})

const responseFor = (request: Request): Response => {
  const url = new URL(request.url)
  if (request.method === 'GET' && url.pathname === '/users/missing')
    return Response.json({ reason: 'not found' }, { status: 404 })
  if (request.method === 'POST' && url.pathname === '/users')
    return Response.json({ id: 'u-1', name: 'Ada' }, { status: 201 })
  return Response.json({ field: 'name' }, { status: 422 })
}

await withLocalServer(responseFor, async (baseURL) => {
  const runtime = await Runtime.make(HttpClient.layer({ baseURL }))
  try {
    const result = await runtime.run(
      Effect.fn(async function* () {
        const http = yield* HttpClient
        const found = yield* http.get('/users/missing', {
          responses: { 404: notFound, 422: invalid }
        })
        if (found.status !== 404) return Result.err(new Error('unexpected status'))

        const created = yield* http.post('/users', {
          body: { name: 'Ada' },
          responses: { 201: User, 422: invalid }
        })
        if (created.status !== 201) return Result.err(new Error('unexpected status'))
        return Result.ok({ found: found.data.reason, created: created.data.greet() })
      })
    )

    if (Result.isError(result)) throw result.error
    if (result.value.created !== 'Hello Ada') throw new Error('class output was not preserved')
    console.log(JSON.stringify(result.value))
  } finally {
    await runtime.dispose()
  }
})
