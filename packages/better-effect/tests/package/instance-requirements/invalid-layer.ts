import { Result } from 'better-result'

import { Effect, Layer, Runtime, Service, type LayerBackend } from 'better-effect'

class Database extends Service<Database>()('Database') {}

class Repository extends Service<Repository>()('Repository') {
  load() {
    return Effect.gen(async function* () {
      const database = yield* Database

      return Result.ok(database)
    })
  }
}

const RepositoryLive = Layer.make(Repository)
declare const backend: LayerBackend

void Runtime.make(RepositoryLive, backend)
