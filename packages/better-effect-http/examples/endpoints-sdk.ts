import { Effect, Runtime } from 'better-effect'
import { Result } from 'better-result'
import { HttpClient, HttpEndpoint } from 'better-effect-http'

import { boolean, object, schema, string, withLocalServer } from './support'

const pathParams = schema((value) => {
  const id = string(object(value)?.['id'])
  return id === undefined ? undefined : { id }
})
const query = schema((value) => {
  const includeDetails = boolean(object(value)?.['includeDetails'])
  return includeDetails === undefined ? undefined : { includeDetails }
})
type Profile = Readonly<{ displayName: string; active: boolean }>
const profile = schema((value): Profile | undefined => {
  const record = object(value)
  const displayName = string(record?.['displayName'])
  const active = boolean(record?.['active'])
  return displayName === undefined || active === undefined ? undefined : { displayName, active }
})
const profileWire = schema((value) => {
  const record = object(value)
  const displayName = string(record?.['display_name'])
  const active = boolean(record?.['active'])
  return displayName === undefined || active === undefined
    ? undefined
    : { display_name: displayName, active }
})

const profileCodec = {
  schema: profile,
  encodedSchema: profileWire,
  encode(value: Profile) {
    return Result.ok({ display_name: value.displayName, active: value.active })
  }
}

const apiDefinition = {
  find: HttpEndpoint.get('/profiles/:id', {
    params: pathParams,
    query,
    schema: profile
  }),
  save: HttpEndpoint.post('/profiles', {
    bodyCodec: profileCodec,
    schema: profile
  })
}

await withLocalServer(
  async (request) => {
    const url = new URL(request.url)
    if (request.method === 'GET')
      return Response.json({ displayName: url.pathname.split('/').at(-1), active: true })
    const body = object(await request.json())
    return Response.json(
      { displayName: string(body?.['display_name']), active: boolean(body?.['active']) },
      { status: 201 }
    )
  },
  async (baseURL) => {
    const runtime = await Runtime.make(HttpClient.layer({ baseURL }))
    try {
      const result = await runtime.run(
        Effect.fn(async function* () {
          const http = yield* HttpClient
          const api = http.endpoints(apiDefinition)
          const found = yield* api.find({
            params: { id: 'ada/lovelace' },
            query: { includeDetails: true }
          })
          const saved = yield* api.save({
            body: { displayName: 'Ada Lovelace', active: true }
          })
          return Result.ok({
            found: string(object(found.data)?.['displayName']),
            saved: string(object(saved.data)?.['displayName'])
          })
        })
      )

      if (Result.isError(result)) throw result.error
      if (result.value.found !== 'ada%2Flovelace') {
        throw new Error('path parameters were not encoded')
      }
      if (result.value.saved !== 'Ada Lovelace') {
        throw new Error('domain body was not encoded explicitly')
      }
      console.log(JSON.stringify(result.value))
    } finally {
      await runtime.dispose()
    }
  }
)
