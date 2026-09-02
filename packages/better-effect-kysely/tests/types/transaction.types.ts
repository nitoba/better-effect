// oxlint-disable require-yield -- These type fixtures intentionally use pure lazy generators.

import { expectTypeOf } from 'bun:test'
import { Effect, Service } from 'better-effect'
import { Result, TaggedError } from 'better-result'
import type { Compilable, Kysely, Transaction } from 'kysely'

import { KyselyEffect, KyselyQueryError, KyselyTransactionError } from '../../src'
import type { KyselyOperation, KyselyServiceInstance, KyselyTransactionOptions } from '../../src'

interface User {
  readonly id: number
  readonly email: string
}

interface DatabaseSchema {
  users: User
}

class BodyFailure extends TaggedError('BodyFailure')<{
  readonly message: string
}> {}

class AuditClock extends Service<AuditClock>()('@types/TransactionAuditClock') {
  now(): number {
    return 1
  }
}

declare const database: Kysely<DatabaseSchema>
const transactionOptions: KyselyTransactionOptions = {
  isolationLevel: 'serializable',
  accessMode: 'read write'
}

const successOperation = KyselyEffect.transaction(database, (transaction) => {
  expectTypeOf(transaction).toEqualTypeOf<Transaction<DatabaseSchema>>()

  return Effect.fn(async function* () {
    return Result.ok({ id: 1 })
  })
})

const configuredOperation = KyselyEffect.transaction(
  database,
  transactionOptions,
  (transaction) => {
    expectTypeOf(transaction).toEqualTypeOf<Transaction<DatabaseSchema>>()

    return Effect.fn(async function* () {
      return Result.ok('configured')
    })
  }
)

const explicitlyTypedOperation = KyselyEffect.transaction<
  DatabaseSchema,
  number,
  BodyFailure,
  AuditClock
>(database, (_transaction) =>
  Effect.fn(async function* () {
    const clock = yield* AuditClock
    return Result.ok(clock.now())
  })
)

const failureOperation = KyselyEffect.transaction(database, (_transaction) =>
  Effect.fn(async function* () {
    return Result.err(new BodyFailure({ message: 'failed' }))
  })
)

const queryOperation = KyselyEffect.transaction(database, (transaction) =>
  Effect.fn(async function* () {
    const query = transaction.selectFrom('users').selectAll()
    const rows = yield* query.$call(KyselyEffect.execute)
    return Result.ok(rows)
  })
)

const queryWithServiceOperation = KyselyEffect.transaction(database, (_transaction) =>
  Effect.fn(async function* () {
    const clock = yield* AuditClock
    return Result.ok(clock.now())
  })
)

const outerProgram = Effect.fn(async function* () {
  const databaseService = yield* Database
  const value = yield* KyselyEffect.transaction(databaseService, (_transaction) =>
    Effect.fn(async function* () {
      const clock = yield* AuditClock
      return Result.ok(clock.now())
    })
  )

  return Result.ok(value)
})

const Database = KyselyEffect.service<DatabaseSchema>()('@types/TransactionDatabase')
type DatabaseInstance = KyselyServiceInstance<'@types/TransactionDatabase', DatabaseSchema>

expectTypeOf(successOperation).toEqualTypeOf<
  KyselyOperation<{ id: number }, KyselyTransactionError>
>()
expectTypeOf(configuredOperation).toEqualTypeOf<KyselyOperation<string, KyselyTransactionError>>()
expectTypeOf(explicitlyTypedOperation).toEqualTypeOf<
  KyselyOperation<number, BodyFailure | KyselyTransactionError, AuditClock>
>()
expectTypeOf(failureOperation).toEqualTypeOf<
  KyselyOperation<never, BodyFailure | KyselyTransactionError>
>()
const expectedQueryOperation: KyselyOperation<User[], KyselyQueryError | KyselyTransactionError> =
  queryOperation
void expectedQueryOperation
expectTypeOf(queryWithServiceOperation).toEqualTypeOf<
  KyselyOperation<number, KyselyTransactionError, AuditClock>
>()
expectTypeOf<Effect.Requirements<typeof outerProgram>>().toEqualTypeOf<
  DatabaseInstance | AuditClock
>()
expectTypeOf<Effect.Error<typeof outerProgram>>().toEqualTypeOf<KyselyTransactionError>()

expectTypeOf<KyselyEffect.TransactionOptions>().toEqualTypeOf<KyselyTransactionOptions>()
expectTypeOf<KyselyEffect.Operation<number, BodyFailure, AuditClock>>().toEqualTypeOf<
  KyselyOperation<number, BodyFailure, AuditClock>
>()

declare const serviceDatabase: DatabaseInstance
const serviceOperation = KyselyEffect.transaction(serviceDatabase, (_transaction) =>
  Effect.fn(async function* () {
    return Result.ok(true)
  })
)
expectTypeOf(serviceOperation).toEqualTypeOf<KyselyOperation<boolean, KyselyTransactionError>>()

const compilable: Compilable<{ readonly id: number }> = {
  compile: () => {
    throw new Error('not used')
  }
}
void compilable

// @ts-expect-error Transaction bodies must be lazy Programs, not a Promise of a Result.
KyselyEffect.transaction(database, (_transaction) => Promise.resolve(Result.ok(1)))

const startedEffect = Effect.gen(function* () {
  return Result.ok(1)
})

// @ts-expect-error Transaction bodies must return a Program, not an already-built Effect.
KyselyEffect.transaction(database, (_transaction) => startedEffect)

// @ts-expect-error Transaction bodies must return a Program, not a raw Result.
KyselyEffect.transaction(database, (_transaction) => Result.ok(1))

// @ts-expect-error Transaction settings use Kysely's literal isolation levels.
KyselyEffect.transaction(database, { isolationLevel: 'invalid' }, (_transaction) =>
  Effect.fn(async function* () {
    return Result.ok(1)
  })
)

// @ts-expect-error Transaction settings use Kysely's literal access modes.
KyselyEffect.transaction(database, { accessMode: 'invalid' }, (_transaction) =>
  Effect.fn(async function* () {
    return Result.ok(1)
  })
)

void serviceOperation
