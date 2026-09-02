import { CurrentAbortSignal } from 'better-effect'
import type {
  EffectError,
  EffectRequirements,
  EffectSuccess,
  Program,
  Service
} from 'better-effect'
import { Err, Ok, Result } from 'better-result'
import type { Kysely, Transaction, TransactionBuilder } from 'kysely'

import { KyselyTransactionError } from './errors'
import type { KyselyOperation } from './operation'
import type { KyselyTransactionOptions } from './transaction-options'

import type { BodyOutcome } from './internal/transaction-outcome'

type AnyKysely = Kysely<any>
type DatabaseOf<Database extends AnyKysely> = Database extends Kysely<infer DB> ? DB : never
type AnyTransactionProgram = Program<any, any, Service.Any>
type TransactionBody<Database extends AnyKysely, Body extends AnyTransactionProgram> = (
  transaction: Transaction<NoInfer<DatabaseOf<Database>>>
) => Body

type RollbackSentinel = Readonly<{
  readonly marker: 'rollback'
}>

interface CombinedFailureCauses {
  readonly bodyCause: unknown
  readonly nativeCause: unknown
}

const internalStateFailure = (kind: BodyOutcome<unknown, unknown>['kind']): TypeError =>
  new TypeError(`Kysely transaction completed with an invalid body state: ${kind}`)

const combineFailures = ({ bodyCause, nativeCause }: CombinedFailureCauses): AggregateError =>
  new AggregateError(
    [bodyCause, nativeCause],
    'Kysely transaction body and native cleanup both failed.'
  )

const runBody = async <Database extends AnyKysely, Body extends AnyTransactionProgram>(
  signal: AbortSignal,
  body: TransactionBody<Database, Body>,
  transaction: Transaction<DatabaseOf<Database>>,
  rollbackSentinel: RollbackSentinel,
  setOutcome: (outcome: BodyOutcome<EffectSuccess<Body>, EffectError<Body>>) => void
): Promise<EffectSuccess<Body>> => {
  if (signal.aborted) {
    const reason = signal.reason
    setOutcome({ kind: 'aborted', reason })
    throw rollbackSentinel
  }

  try {
    // SAFETY: runNativeTransaction recovers the same schema from the validated Kysely input.
    const typedBody = body as (transaction: Transaction<DatabaseOf<Database>>) => Body
    const program = typedBody(transaction)
    const result = await program()

    if (result instanceof Err) {
      setOutcome({ kind: 'failure', error: result.error })
      throw rollbackSentinel
    }

    if (!(result instanceof Ok)) {
      throw new TypeError('Kysely transaction Program must return a better-result Result')
    }

    if (signal.aborted) {
      const reason = signal.reason
      setOutcome({ kind: 'aborted', reason })
      throw rollbackSentinel
    }

    const value = result.value
    setOutcome({ kind: 'success', value })
    return value
  } catch (cause) {
    if (cause === rollbackSentinel) {
      throw cause
    }

    setOutcome({ kind: 'defect', cause })
    throw rollbackSentinel
  }
}

const applyTransactionOptions = <DB>(
  builder: TransactionBuilder<DB>,
  options: KyselyTransactionOptions | undefined
): TransactionBuilder<DB> => {
  let configured = builder

  if (options?.isolationLevel !== undefined) {
    configured = configured.setIsolationLevel(options.isolationLevel)
  }

  if (options?.accessMode !== undefined) {
    configured = configured.setAccessMode(options.accessMode)
  }

  return configured
}

const runNativeTransaction = async <Database extends AnyKysely, Body extends AnyTransactionProgram>(
  database: Database,
  options: KyselyTransactionOptions | undefined,
  signal: AbortSignal,
  body: TransactionBody<Database, Body>,
  rollbackSentinel: RollbackSentinel,
  setOutcome: (outcome: BodyOutcome<EffectSuccess<Body>, EffectError<Body>>) => void
): Promise<void> => {
  let builder = applyTransactionOptions(database.transaction(), options)

  await builder.execute(async (transaction) => {
    setOutcome({ kind: 'running' })
    return await runBody(signal, body, transaction, rollbackSentinel, setOutcome)
  })
}

const interpretNativeRejection = <A, E>(
  cause: unknown,
  rollbackSentinel: RollbackSentinel,
  outcome: BodyOutcome<A, E>
):
  | { readonly kind: 'throw'; readonly cause: unknown }
  | { readonly kind: 'failure'; readonly error: E | KyselyTransactionError } => {
  if (cause === rollbackSentinel) {
    switch (outcome.kind) {
      case 'failure':
        return { kind: 'failure', error: outcome.error }
      case 'defect':
        return { kind: 'throw', cause: outcome.cause }
      case 'aborted':
        return { kind: 'throw', cause: outcome.reason }
      default:
        return { kind: 'throw', cause: internalStateFailure(outcome.kind) }
    }
  }

  switch (outcome.kind) {
    case 'failure':
      return {
        kind: 'failure',
        error: new KyselyTransactionError({ cause, bodyFailure: outcome.error })
      }
    case 'defect':
      return {
        kind: 'throw',
        cause: combineFailures({ bodyCause: outcome.cause, nativeCause: cause })
      }
    case 'aborted':
      return {
        kind: 'throw',
        cause: combineFailures({ bodyCause: outcome.reason, nativeCause: cause })
      }
    default:
      return { kind: 'failure', error: new KyselyTransactionError({ cause }) }
  }
}

const makeTransactionOperation = <Database extends AnyKysely, Body extends AnyTransactionProgram>(
  database: Database,
  options: KyselyTransactionOptions | undefined,
  body: TransactionBody<Database, Body>
): KyselyOperation<
  EffectSuccess<Body>,
  EffectError<Body> | KyselyTransactionError,
  EffectRequirements<Body>
> =>
  (async function* () {
    const signal = yield* CurrentAbortSignal

    if (signal.aborted) {
      throw signal.reason
    }

    const rollbackSentinel: RollbackSentinel = Object.freeze({ marker: 'rollback' })
    let outcome: BodyOutcome<EffectSuccess<Body>, EffectError<Body>> = {
      kind: 'not-started'
    }
    const setOutcome = (next: BodyOutcome<EffectSuccess<Body>, EffectError<Body>>): void => {
      outcome = next
    }
    const getOutcome = (): BodyOutcome<EffectSuccess<Body>, EffectError<Body>> => outcome

    try {
      await runNativeTransaction(database, options, signal, body, rollbackSentinel, setOutcome)
    } catch (cause) {
      const interpreted = interpretNativeRejection(cause, rollbackSentinel, getOutcome())

      if (interpreted.kind === 'throw') {
        throw interpreted.cause
      }

      return yield* Result.err(interpreted.error)
    }

    const finalOutcome = getOutcome()

    if (finalOutcome.kind !== 'success') {
      throw internalStateFailure(finalOutcome.kind)
    }

    return yield* Result.ok(finalOutcome.value)
  })()

export function transaction<Database extends AnyKysely, Body extends AnyTransactionProgram>(
  database: Database,
  body: TransactionBody<Database, Body>
): KyselyOperation<
  EffectSuccess<Body>,
  EffectError<Body> | KyselyTransactionError,
  EffectRequirements<Body>
>

export function transaction<Database extends AnyKysely, Body extends AnyTransactionProgram>(
  database: Database,
  options: KyselyTransactionOptions,
  body: TransactionBody<Database, Body>
): KyselyOperation<
  EffectSuccess<Body>,
  EffectError<Body> | KyselyTransactionError,
  EffectRequirements<Body>
>

export function transaction<DB, A, E, R extends Service.Any = never>(
  database: Kysely<DB>,
  body: (transaction: Transaction<DB>) => Program<A, E, R>
): KyselyOperation<A, E | KyselyTransactionError, R>

export function transaction<DB, A, E, R extends Service.Any = never>(
  database: Kysely<DB>,
  options: KyselyTransactionOptions,
  body: (transaction: Transaction<DB>) => Program<A, E, R>
): KyselyOperation<A, E | KyselyTransactionError, R>

export function transaction<Database extends AnyKysely, Body extends AnyTransactionProgram>(
  database: Database,
  optionsOrBody: KyselyTransactionOptions | TransactionBody<Database, Body>,
  maybeBody?: TransactionBody<Database, Body>
): KyselyOperation<
  EffectSuccess<Body>,
  EffectError<Body> | KyselyTransactionError,
  EffectRequirements<Body>
> {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- overload dispatch distinguishes options from the required body factory.
  if (typeof optionsOrBody === 'function') {
    return makeTransactionOperation(database, undefined, optionsOrBody)
  }

  if (maybeBody === undefined) {
    throw new TypeError('Kysely transaction body is required')
  }

  return makeTransactionOperation(database, optionsOrBody, maybeBody)
}
