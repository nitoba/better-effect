import { Effect, Layer, Runtime, Service } from 'better-effect'
import { Result, TaggedError } from 'better-result'
import { HttpClient } from 'better-effect-http'

import { object, schema, string, withLocalServer } from './support'

class PersistFailed extends TaggedError('PersistFailed')<{
  readonly id: string
}> {}

type User = Readonly<{ id: string }>
const userSchema = schema((value): User | undefined => {
  const id = string(object(value)?.['id'])
  return id === undefined ? undefined : { id }
})

class UserRepository extends Service<UserRepository>()('@example/ndjson/UserRepository') {
  readonly saved: string[] = []

  async save(user: User) {
    if (user.id === 'u-2') return Result.err(new PersistFailed({ id: user.id }))
    this.saved.push(user.id)
    return Result.ok(undefined)
  }
}

const repository = new UserRepository()
await withLocalServer(
  () =>
    new Response('{"id":"u-1"}\n{"id":"u-2"}\n', {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' }
    }),
  async (baseURL) => {
    const runtime = await Runtime.make(
      Layer.merge(HttpClient.layer({ baseURL }), Layer.succeed(UserRepository, repository))
    )
    try {
      const result = await runtime.run(
        Effect.fn(async function* () {
          const http = yield* HttpClient
          const users = http.ndjson('/users', { schema: userSchema, retry: false })
          yield* users.forEach((user) =>
            Effect.fn(async function* () {
              yield* Result.await(repository.save(user))
              return Result.ok(undefined)
            })
          )
          return Result.ok(repository.saved)
        })
      )

      if (!Result.isError(result)) throw new Error('the typed persistence error was lost')
      if (!(result.error instanceof PersistFailed)) throw result.error
      if (repository.saved.join(',') !== 'u-1') throw new Error('records were not sequential')
      console.log(JSON.stringify({ saved: repository.saved, error: result.error._tag }))
    } finally {
      await runtime.dispose()
    }
  }
)
