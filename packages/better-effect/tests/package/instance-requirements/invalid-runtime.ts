import { Result } from 'better-result'

import { Effect, Runtime, Service } from 'better-effect'

class Database extends Service<Database>()('Database') {}
class Logger extends Service<Logger>()('Logger') {}
class Cache extends Service<Cache>()('Cache') {}

const program = () =>
  Effect.gen(async function* () {
    const logger = yield* Logger
    const cache = yield* Cache

    return Result.ok({ logger, cache })
  })

declare const runtime: Runtime<Database>

void runtime.run(program)
