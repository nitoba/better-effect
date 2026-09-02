import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from 'kysely'
import * as KyselyEffect from 'better-effect-kysely'
import packageJson from 'better-effect-kysely/package.json' with { type: 'json' }

if (KyselyEffect.KyselyEffect.transaction === undefined) {
  throw new Error('The packed Kysely transaction helper is missing')
}

const Database = KyselyEffect.KyselyEffect.service()('@external/Database')
const dialect = {
  createAdapter: () => new PostgresAdapter(),
  createDriver: () => new DummyDriver(),
  createIntrospector: (database) => new PostgresIntrospector(database),
  createQueryCompiler: () => new PostgresQueryCompiler()
}
const raw = new Kysely({ dialect })
const runtime = await Runtime.make(Layer.merge(Database.succeed(raw)))
const resolved = await runtime.run(() => ServiceRuntime.resolve(Database))

if (resolved !== raw) {
  throw new Error('The external consumer did not receive the original Kysely instance')
}

await runtime.dispose()

const cause = new Error('consumer driver failure with secret SQL')
const queryError = new KyselyEffect.KyselyQueryError({ cause, operation: 'execute' })
if (queryError.cause !== cause || JSON.stringify(queryError).includes('secret SQL')) {
  throw new Error('The packed Kysely query error did not preserve safe error semantics')
}

if (packageJson.name !== 'better-effect-kysely' || packageJson.version !== '0.1.0') {
  throw new Error('The packed Kysely package metadata is incorrect')
}

console.log('better-effect-kysely external consumer smoke passed')
