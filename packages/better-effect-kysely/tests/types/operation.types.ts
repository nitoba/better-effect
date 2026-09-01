import { expectTypeOf } from 'bun:test'

import { Effect, Service } from 'better-effect'
import { Result, TaggedError } from 'better-result'
import type { InflightQueryAbortStrategy } from 'kysely'

import { KyselyQueryError, KyselyTransactionError } from '../../src'
import type {
  KyselyEffect,
  KyselyExecutionOptions,
  KyselyOperation,
  KyselyQueryOperation
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
