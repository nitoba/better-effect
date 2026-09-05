import { Result } from 'better-result'

import { Effect, Layer, Runtime, Service } from 'better-effect'

class Database extends Service<Database>()('Database') {}
class Cache extends Service<Cache>()('Cache') {}

const DatabaseLive = Layer.succeed(Database, new Database())

const needsCache = () =>
  Effect.gen(async function* () {
    const cache = yield* Cache

    return Result.ok(cache)
  })

void Runtime.run(DatabaseLive, needsCache)
