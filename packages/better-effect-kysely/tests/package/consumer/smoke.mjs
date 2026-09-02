import { Effect, Layer, Runtime, ServiceRuntime } from 'better-effect'
import { Result } from 'better-result'
import { PGlite } from '@electric-sql/pglite'
import {
  CompiledQuery,
  DummyDriver,
  Kysely,
  PGliteDialect,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql
} from 'kysely'
import packageJson from 'better-effect-kysely/package.json' with { type: 'json' }

class CountingDriver extends DummyDriver {
  initCalls = 0

  async init() {
    this.initCalls += 1
  }
}

const probeDriver = new CountingDriver()
const probeDatabase = new Kysely({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => probeDriver,
    createIntrospector: (database) => new PostgresIntrospector(database),
    createQueryCompiler: () => new PostgresQueryCompiler()
  }
})
const probeQuery = probeDatabase.selectFrom('users').selectAll()
const probePrototypes = [
  Object.getPrototypeOf(probeDatabase),
  Object.getPrototypeOf(probeDatabase.schema),
  Object.getPrototypeOf(probeQuery)
]
const probeDescriptors = probePrototypes.map((prototype) =>
  Object.getOwnPropertyDescriptors(prototype)
)
const KyselyEffect = await import('better-effect-kysely')

if (KyselyEffect.KyselyEffect.transaction === undefined) {
  throw new Error('The packed Kysely transaction helper is missing')
}

for (const [index, prototype] of probePrototypes.entries()) {
  if (
    JSON.stringify(Object.getOwnPropertyDescriptors(prototype)) !==
    JSON.stringify(probeDescriptors[index])
  ) {
    throw new Error('Importing better-effect-kysely changed a Kysely prototype')
  }
}
if (
  probeDriver.initCalls !== 0 ||
  Symbol.iterator in probeQuery ||
  Symbol.asyncIterator in probeQuery
) {
  throw new Error('Importing better-effect-kysely created driver work or iterator patches')
}
const nativeProbeExecution = probeQuery.execute()
if (!(nativeProbeExecution instanceof Promise)) {
  throw new Error('Native Kysely execution no longer returns a Promise')
}
await nativeProbeExecution.catch(() => undefined)

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

const ownedPglite = await PGlite.create('memory://')
const ownedDatabase = new Kysely({
  dialect: new PGliteDialect({ pglite: ownedPglite })
})
const OwnedDatabase = KyselyEffect.KyselyEffect.service()('@external/OwnedDatabase')
const ownedRuntime = await Runtime.make(OwnedDatabase.layer(() => ownedDatabase))
const ownedResult = await ownedRuntime.run(
  Effect.fn(async function* () {
    const database = yield* OwnedDatabase
    yield* database.schema
      .createTable('users')
      .addColumn('id', 'integer', (column) => column.primaryKey())
      .addColumn('email', 'text', (column) => column.notNull())
      .$call(KyselyEffect.KyselyEffect.execute)
    const inserted = yield* database
      .insertInto('users')
      .values({ id: 1, email: 'external@example.test' })
      .returningAll()
      .$call(KyselyEffect.KyselyEffect.execute)
    const raw = yield* KyselyEffect.KyselyEffect.executeQuery(database, sql`select ${1} as value`)
    const committed = yield* KyselyEffect.KyselyEffect.transaction(database, (transaction) =>
      Effect.fn(async function* () {
        yield* transaction
          .insertInto('users')
          .values({ id: 2, email: 'committed@example.test' })
          .$call(KyselyEffect.KyselyEffect.execute)
        return Result.ok('committed')
      })
    )
    return Result.ok({ inserted, committed, raw })
  })
)

if (
  !Result.isOk(ownedResult) ||
  ownedResult.value.inserted[0]?.email !== 'external@example.test' ||
  ownedResult.value.committed !== 'committed' ||
  String(ownedResult.value.raw.rows[0]?.value) !== '1'
) {
  throw new Error('The packed PGlite consumer did not execute its transaction')
}

const rollbackFailure = { type: 'external-rollback' }
const rollbackResult = await ownedRuntime.run(
  Effect.fn(async function* () {
    const database = yield* OwnedDatabase
    yield* KyselyEffect.KyselyEffect.transaction(database, (transaction) =>
      Effect.fn(async function* () {
        yield* transaction
          .insertInto('users')
          .values({ id: 3, email: 'rolled-back@example.test' })
          .$call(KyselyEffect.KyselyEffect.execute)
        return Result.err(rollbackFailure)
      })
    )
    return Result.ok('unreachable')
  })
)

if (!Result.isError(rollbackResult) || rollbackResult.error !== rollbackFailure) {
  throw new Error('The packed PGlite consumer did not preserve transaction rollback')
}

const persistedRows = await ownedDatabase.selectFrom('users').selectAll().orderBy('id').execute()
if (persistedRows.length !== 2 || persistedRows.some((row) => row.id === 3)) {
  throw new Error('The packed PGlite consumer committed a rolled-back write')
}
await ownedRuntime.dispose()
if (!ownedPglite.closed) {
  throw new Error('The packed owned PGlite database was not destroyed')
}

const borrowedPglite = await PGlite.create('memory://')
const borrowedDatabase = new Kysely({
  dialect: new PGliteDialect({ pglite: borrowedPglite })
})
const BorrowedDatabase = KyselyEffect.KyselyEffect.service()('@external/BorrowedDatabase')
const borrowedRuntime = await Runtime.make(BorrowedDatabase.succeed(borrowedDatabase))
await borrowedRuntime.run(async () => {
  const database = await ServiceRuntime.resolve(BorrowedDatabase)
  await database.executeQuery(CompiledQuery.raw('select 1'))
})
await borrowedRuntime.dispose()
if (borrowedPglite.closed) {
  throw new Error('The packed borrowed PGlite database was destroyed by Runtime')
}
await borrowedDatabase.destroy()

const cause = new Error('consumer driver failure with secret SQL')
const queryError = new KyselyEffect.KyselyQueryError({ cause, operation: 'execute' })
if (queryError.cause !== cause || JSON.stringify(queryError).includes('secret SQL')) {
  throw new Error('The packed Kysely query error did not preserve safe error semantics')
}

if (packageJson.name !== 'better-effect-kysely' || packageJson.version !== '0.1.0') {
  throw new Error('The packed Kysely package metadata is incorrect')
}

console.log('better-effect-kysely external consumer smoke passed')
