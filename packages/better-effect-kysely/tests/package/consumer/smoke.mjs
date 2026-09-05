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
import { PGlite } from '@electric-sql/pglite'
import { Effect, Layer, Runtime, Service, ServiceRuntime } from 'better-effect'
import { Result } from 'better-result'
import packageJson from 'better-effect-kysely/package.json' with { type: 'json' }

class CountingDriver extends DummyDriver {
  initCalls = 0

  async init() {
    this.initCalls += 1
  }
}

const makeDummyDialect = (driver) => ({
  createAdapter: () => new PostgresAdapter(),
  createDriver: () => driver,
  createIntrospector: (database) => new PostgresIntrospector(database),
  createQueryCompiler: () => new PostgresQueryCompiler()
})

const probeDriver = new CountingDriver()
const probeDatabase = new Kysely({ dialect: makeDummyDialect(probeDriver) })
const probeQuery = probeDatabase.selectFrom('users').selectAll()
const probePrototypes = [
  Object.getPrototypeOf(probeDatabase),
  Object.getPrototypeOf(probeDatabase.schema),
  Object.getPrototypeOf(probeQuery)
]
const probeDescriptors = probePrototypes.map((prototype) =>
  Object.getOwnPropertyDescriptors(prototype)
)
const kyselyEffect = await import('better-effect-kysely')
const KyselyEffect = kyselyEffect.KyselyEffect
const KyselyQueryError = kyselyEffect.KyselyQueryError
if (KyselyEffect.transaction === undefined) {
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

const Database = KyselyEffect.service()('@external/Database')
class Audit extends Service()('@external/Audit') {
  constructor() {
    super()
    this.events = []
  }

  record(event) {
    this.events.push(event)
  }
}

const audit = new Audit()
const ownedPglite = await PGlite.create('memory://')
const ownedDatabase = new Kysely({
  dialect: new PGliteDialect({ pglite: ownedPglite })
})
const ownedRuntime = await Runtime.make(
  Layer.merge(
    Database.scoped(() => ownedDatabase),
    Layer.succeed(Audit, audit)
  )
)

const ownedResult = await ownedRuntime.run(
  Effect.fn(async function* () {
    const database = yield* Database
    yield* database.schema
      .createTable('users')
      .addColumn('id', 'integer', (column) => column.primaryKey())
      .addColumn('email', 'text', (column) => column.notNull())
      .$call(KyselyEffect.execute)

    const inserted = yield* database
      .insertInto('users')
      .values({ id: 1, email: 'external@example.test' })
      .returningAll()
      .$call(KyselyEffect.execute)
    const projected = yield* database
      .selectFrom('users')
      .select(['id', 'email'])
      .$call(KyselyEffect.execute)
    const missing = yield* database
      .selectFrom('users')
      .selectAll()
      .where('id', '=', 999)
      .$call(KyselyEffect.executeTakeFirst)
    const compiled = database.selectFrom('users').select(['id', 'email']).compile()
    const compiledResult = yield* KyselyEffect.executeQuery(database, compiled)
    const raw = yield* KyselyEffect.executeQuery(database, sql`select ${1} as value`)
    const committed = yield* KyselyEffect.transaction(database, (transaction) =>
      Effect.fn(async function* () {
        const context = yield* Audit
        context.record('transaction')
        yield* transaction
          .insertInto('users')
          .values({ id: 2, email: 'committed@example.test' })
          .$call(KyselyEffect.execute)
        return Result.ok('committed')
      })
    )

    return Result.ok({ inserted, projected, missing, compiledResult, raw, committed })
  })
)

if (
  !Result.isOk(ownedResult) ||
  ownedResult.value.inserted[0]?.email !== 'external@example.test' ||
  ownedResult.value.projected.length !== 1 ||
  ownedResult.value.missing !== undefined ||
  ownedResult.value.compiledResult.rows.length !== 1 ||
  String(ownedResult.value.raw.rows[0]?.value) !== '1' ||
  ownedResult.value.committed !== 'committed' ||
  audit.events.join(',') !== 'transaction'
) {
  throw new Error('The packed PGlite consumer did not execute its complete smoke program')
}

const missingError = new Error('external missing user')
const missingResult = await ownedRuntime.run(
  Effect.fn(async function* () {
    const database = yield* Database
    yield* database
      .selectFrom('users')
      .selectAll()
      .where('id', '=', 999)
      .$call(KyselyEffect.executeTakeFirstOrFail(() => missingError))
    return Result.ok('unreachable')
  })
)
if (!Result.isError(missingResult) || missingResult.error !== missingError) {
  throw new Error('The packed consumer did not preserve the first-row domain error')
}

const rollbackFailure = { type: 'external-rollback' }
const rollbackResult = await ownedRuntime.run(
  Effect.fn(async function* () {
    const database = yield* Database
    yield* KyselyEffect.transaction(database, (transaction) =>
      Effect.fn(async function* () {
        yield* transaction
          .insertInto('users')
          .values({ id: 3, email: 'rolled-back@example.test' })
          .$call(KyselyEffect.execute)
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
if (
  persistedRows.length !== 2 ||
  persistedRows.some((row) => row.id === 3) ||
  persistedRows.some((row) => Object.getPrototypeOf(row) !== Object.prototype)
) {
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
const BorrowedDatabase = KyselyEffect.service()('@external/BorrowedDatabase')
const borrowedRuntime = await Runtime.make(BorrowedDatabase.borrowed(() => borrowedDatabase))
await borrowedRuntime.run(async () => {
  const database = await ServiceRuntime.resolve(BorrowedDatabase)
  await database.executeQuery(CompiledQuery.raw('select 1'))
})
await borrowedRuntime.dispose()
if (borrowedPglite.closed) {
  throw new Error('The packed borrowed PGlite database was destroyed by Runtime')
}
await borrowedDatabase.destroy()
if (!borrowedPglite.closed) {
  throw new Error('The caller did not destroy the borrowed PGlite database')
}

const cause = new Error('consumer driver failure with secret SQL')
const queryError = new KyselyQueryError({ cause, operation: 'execute' })
if (queryError.cause !== cause || JSON.stringify(queryError).includes('secret SQL')) {
  throw new Error('The packed Kysely query error did not preserve safe error semantics')
}

if (packageJson.name !== 'better-effect-kysely' || packageJson.version !== '0.1.0') {
  throw new Error('The packed Kysely package metadata is incorrect')
}

console.log('better-effect-kysely external consumer smoke passed')
