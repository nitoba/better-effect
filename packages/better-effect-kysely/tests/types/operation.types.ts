import { expectTypeOf } from 'bun:test'

import { Effect, Service } from 'better-effect'
import { Result, TaggedError } from 'better-result'
import type { Compilable, CompiledQuery, Kysely, QueryResult, SelectQueryBuilder } from 'kysely'
import type { InflightQueryAbortStrategy } from 'kysely'

import { KyselyEffect, KyselyQueryError, KyselyTransactionError } from '../../src'
import type {
  KyselyExecutable,
  KyselyExecutionOptions,
  KyselyOperation,
  KyselyQueryOperation,
  KyselyTakeFirstExecutable
} from '../../src'

class QueryFailure extends TaggedError('QueryFailure')<{
  readonly message: string
}> {}

class AuditService extends Service<AuditService>()('@types/AuditService') {}

declare const operation: KyselyOperation<number, QueryFailure>
declare const dependentOperation: KyselyOperation<string, QueryFailure, AuditService>

const queryProgram = Effect.fn(async function* () {
  const value = yield* operation
  return Result.ok(value)
})

const dependentProgram = Effect.fn(async function* () {
  const value = yield* dependentOperation
  return Result.ok(value)
})

expectTypeOf<Effect.Success<ReturnType<typeof queryProgram>>>().toEqualTypeOf<number>()
expectTypeOf<Effect.Error<ReturnType<typeof queryProgram>>>().toEqualTypeOf<QueryFailure>()
expectTypeOf<Effect.Requirements<ReturnType<typeof queryProgram>>>().toBeNever()
expectTypeOf<Effect.Success<ReturnType<typeof dependentProgram>>>().toEqualTypeOf<string>()
expectTypeOf<Effect.Error<ReturnType<typeof dependentProgram>>>().toEqualTypeOf<QueryFailure>()
expectTypeOf<
  Effect.Requirements<ReturnType<typeof dependentProgram>>
>().toEqualTypeOf<AuditService>()

expectTypeOf<KyselyEffect.Operation<number, QueryFailure>>().toEqualTypeOf<
  KyselyOperation<number, QueryFailure>
>()
expectTypeOf<KyselyEffect.Operation<string, QueryFailure, AuditService>>().toEqualTypeOf<
  KyselyOperation<string, QueryFailure, AuditService>
>()

expectTypeOf<KyselyQueryOperation>().toEqualTypeOf<
  'execute' | 'executeTakeFirst' | 'executeQuery'
>()
type Strategy = NonNullable<KyselyExecutionOptions['inflightQueryAbortStrategy']>
expectTypeOf<Strategy>().toEqualTypeOf<InflightQueryAbortStrategy>()

const validOptions: KyselyExecutionOptions = {
  inflightQueryAbortStrategy: 'kill session'
}
const queryError = new KyselyQueryError({
  cause: new Error('driver failure'),
  operation: 'executeQuery'
})
const transactionError = new KyselyTransactionError({ cause: new Error('native failure') })

expectTypeOf(validOptions).toMatchTypeOf<KyselyExecutionOptions>()
expectTypeOf(queryError.cause).toEqualTypeOf<unknown>()
expectTypeOf(queryError.toJSON()).toEqualTypeOf<{
  readonly _tag: 'KyselyQueryError'
  readonly name: 'KyselyQueryError'
  readonly message: string
  readonly operation: KyselyQueryOperation
}>()
expectTypeOf(transactionError.bodyFailure).toEqualTypeOf<unknown>()
expectTypeOf(transactionError.toJSON()).toEqualTypeOf<{
  readonly _tag: 'KyselyTransactionError'
  readonly name: 'KyselyTransactionError'
  readonly message: string
}>()

interface TerminalDatabase {
  users: {
    id: number
    email: string | null
  }
}

declare const executable: KyselyExecutable<readonly string[]>
declare const firstExecutable: KyselyTakeFirstExecutable<
  | {
      readonly id: number
    }
  | undefined
>
declare const queryBuilder: SelectQueryBuilder<
  TerminalDatabase,
  'users',
  { readonly id: number; readonly email: string | null }
>
declare const database: Kysely<TerminalDatabase>
declare const compiledQuery: CompiledQuery<{ readonly id: number }>
declare const compilableQuery: Compilable<{ readonly id: number }>

const builderProgram = Effect.fn(async function* () {
  const rows = yield* queryBuilder.$call(KyselyEffect.execute)
  return Result.ok(rows)
})

const executableProgram = Effect.fn(async function* () {
  const rows = yield* KyselyEffect.execute(executable)
  return Result.ok(rows)
})

const firstProgram = Effect.fn(async function* () {
  const row = yield* KyselyEffect.executeTakeFirst(firstExecutable)
  return Result.ok(row)
})

const firstOrFailProgram = Effect.fn(async function* () {
  const row = yield* KyselyEffect.executeTakeFirstOrFail(
    () => new QueryFailure({ message: 'missing' })
  )(firstExecutable)
  return Result.ok(row)
})

const rawQueryProgram = Effect.fn(async function* () {
  const result = yield* KyselyEffect.executeQuery(database, compiledQuery)
  return Result.ok(result)
})

const compilableQueryOperation = KyselyEffect.executeQuery(database, compilableQuery)

expectTypeOf<Effect.Success<ReturnType<typeof builderProgram>>>().toEqualTypeOf<
  { readonly id: number; readonly email: string | null }[]
>()
expectTypeOf<Effect.Requirements<ReturnType<typeof builderProgram>>>().toBeNever()
expectTypeOf<Effect.Success<ReturnType<typeof executableProgram>>>().toEqualTypeOf<
  readonly string[]
>()
expectTypeOf<Effect.Error<ReturnType<typeof executableProgram>>>().toEqualTypeOf<KyselyQueryError>()
expectTypeOf<Effect.Success<ReturnType<typeof firstProgram>>>().toEqualTypeOf<
  { readonly id: number } | undefined
>()
expectTypeOf<Effect.Success<ReturnType<typeof firstOrFailProgram>>>().toEqualTypeOf<{
  readonly id: number
}>()
expectTypeOf<Effect.Error<ReturnType<typeof firstOrFailProgram>>>().toEqualTypeOf<
  QueryFailure | KyselyQueryError
>()
expectTypeOf<Effect.Success<ReturnType<typeof rawQueryProgram>>>().toEqualTypeOf<
  QueryResult<{ readonly id: number }>
>()
expectTypeOf<Effect.Requirements<ReturnType<typeof rawQueryProgram>>>().toBeNever()
expectTypeOf(compilableQueryOperation).toEqualTypeOf<
  KyselyOperation<QueryResult<{ readonly id: number }>, KyselyQueryError>
>()

// The structural terminals accept the exact native Kysely boundaries.
const terminalOptions: KyselyExecutionOptions = {
  inflightQueryAbortStrategy: 'cancel query'
}
const executeWithOperation = KyselyEffect.executeWith(terminalOptions)(executable)
const firstWithOperation = KyselyEffect.executeTakeFirstWith(terminalOptions)(firstExecutable)
const firstOrFailWithOperation = KyselyEffect.executeTakeFirstOrFailWith(
  terminalOptions,
  () => new QueryFailure({ message: 'missing' })
)(firstExecutable)

expectTypeOf(executeWithOperation).toEqualTypeOf<
  KyselyOperation<readonly string[], KyselyQueryError>
>()
expectTypeOf(firstWithOperation).toEqualTypeOf<
  KyselyOperation<{ readonly id: number } | undefined, KyselyQueryError>
>()
expectTypeOf(firstOrFailWithOperation).toEqualTypeOf<
  KyselyOperation<{ readonly id: number }, QueryFailure | KyselyQueryError>
>()

// @ts-expect-error Runtime owns the signal; callers may only provide Kysely's strategy option.
const invalidOptions: KyselyExecutionOptions = { signal: new AbortController().signal }

// @ts-expect-error Query error messages are fixed by the integration boundary.
new KyselyQueryError({ cause: new Error(), message: 'custom message', operation: 'execute' })

// @ts-expect-error Query operation names are a closed public union.
const invalidOperation: KyselyQueryOperation = 'custom'

void invalidOptions
void invalidOperation
void queryError
void transactionError
