import { Result } from 'better-result'

import { Effect, Layer, Runtime, Service, type LayerBackend } from 'better-effect'

class Database extends Service<Database>()('Database') {}
class Cache extends Service<Cache>()('Cache') {}

const DatabaseLive = Layer.succeed(Database, new Database())

declare const backend: LayerBackend

const needsCache = () =>
  Effect.gen(async function* () {
    const cache = yield* Cache

    return Result.ok(cache)
  })

void Runtime.run(DatabaseLive, backend, needsCache)
